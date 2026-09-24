// SPDX-License-Identifier: Apache-2.0
/**
 * KEY PARITY — every key the TypeScript reads from a sweep's live status and
 * result summary is emitted by BOTH native producers.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * iOS does not use the shared C++ producer: `RNISPanoCore.mm` hand-builds its
 * own copy of the status and summary. A key one producer omits is not an
 * error anywhere — `coercePanoPlusStatus` / `coercePanoPlusSummary` substitute
 * a default and the result looks complete. Commit dc0c98d found fields that
 * had reached ZERO iPhone packs that way, and the same gap ran the other way:
 * the Android summary carried no `gain` or `lens` block at all, and half of
 * `seam` and `projection` (canvasJogP50Px, jogDriftPx, subjectDistanceFitM…).
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 *
 * 1. WHAT THE TS READS is enumerated by running the two readers over a
 *    recording Proxy — every property access is a key path — not by a regex
 *    over the source, which can quietly match nothing. A floor and named
 *    spot-checks are the negative control.
 * 2. ANDROID: the shared C++ producer's key paths are snapshotted by
 *    `PanoLiveSession.KeyParityFixtureMatchesTheProducer` (which fails when
 *    the snapshot goes stale), plus the few keys the Kotlin layer adds, each
 *    of which must be spelled in the Kotlin file named.
 * 3. iOS: every read key's FULL PATH must be a key of the producer's own
 *    dictionary literal — `status = @{…}` for the status; the success
 *    `summary = @{…}` for the summary, with nested paths resolved through the
 *    sub-dictionary literal each key names (`@"seam": seam` → `NSDictionary
 *    *seam = @{…}`) and `statsDict`. The camera-lock and ARKit exposure-probe
 *    blocks are built at run time in Swift, so their keys are checked in THEIR
 *    producer files only. This proves a key is in the literal, not that every
 *    path reaches it — the device pack is the final guard (DR-1a: iPhone packs
 *    parse with zero defaulted fields). A leaf-name check across the directory
 *    — this file's first version — passed with whole blocks deleted.
 * 4. Exceptions are EXPLICIT and carry a reason. A key that is legitimately
 *    one platform's (the ARKit exposure probe) is listed as such; nothing is
 *    skipped silently.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  coercePanoPlusStatus,
  coercePanoPlusSummary,
  panoPlusErrorInfo,
} from '../panoPlusModel';

const ROOT = path.resolve(__dirname, '../../..');

/** Every key path a reader touches on `raw`. `hints` pins the few type guards. */
function readPaths(
  read: (raw: unknown) => unknown, hints: Record<string, unknown> = {},
): string[] {
  const paths = new Set<string>();
  const rec = (prefix: string): unknown => new Proxy({}, {
    get(_t, k) {
      if (typeof k === 'symbol') return undefined;
      const p = prefix ? `${prefix}.${String(k)}` : String(k);
      paths.add(p);
      return p in hints ? hints[p] : rec(p);
    },
  });
  read(rec(''));
  return [...paths].sort();
}

// `coercePanoPlusStatus` returns null unless `running` is a boolean.
const STATUS_READ = readPaths(coercePanoPlusStatus, { running: true });
const SUMMARY_READ = readPaths(coercePanoPlusSummary);

const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'cpp/tests/panoplus/fixtures/panoplus_live_keys.json'), 'utf8',
)) as { status: string[]; summary: string[] };

/**
 * Keys the Kotlin layer adds on top of the C++ producer: EVERY link of the
 * chain that carries each one to JS, as [file, function, exact form]. A bare
 * literal anywhere in a file is not enough — `"poseSourceRan"` also appears
 * in the start result and in an `optStr`, so deleting the two lines that put
 * it in the live status left a file-wide check green.
 */
const KOTLIN_CHAINS: Record<'status' | 'summary', Record<string, Array<[string, string, string]>>> = {
  status: {
    viewfinderAttached: [
      ['PanoPlusLiveNative.kt', 'withViewfinder', '\\"viewfinderAttached\\":'],
    ],
    viewfinderNote: [
      ['PanoPlusLiveNative.kt', 'withViewfinder', '\\"viewfinderNote\\":'],
    ],
    poseSourceRan: [
      ['PanoPlusAndroidRecorder.kt', 'statusMap', 'putString("poseSourceRan"'],
      ['PanoPlusLiveModule.kt', 'getStatus', 'copyString(rec, out, "poseSourceRan")'],
    ],
    arTrackingFailure: [
      ['PanoPlusAndroidRecorder.kt', 'statusMap', 'putString("arTrackingFailure"'],
      ['PanoPlusLiveModule.kt', 'getStatus', 'copyString(rec, out, "arTrackingFailure")'],
    ],
  },
  summary: {},
};
const KOTLIN_ADDED: Record<'status' | 'summary', Record<string, true>> = {
  status: Object.fromEntries(Object.keys(KOTLIN_CHAINS.status).map((k) => [k, true])),
  summary: Object.fromEntries(Object.keys(KOTLIN_CHAINS.summary).map((k) => [k, true])),
};

const KOTLIN_DIR = path.join(ROOT, 'android/src/main/java/io/imagestitcher/rn/panoplus');

/** The body of `fun name(` in `file`, up to the next member at the same indent. */
function kotlinFunctionBody(file: string, name: string): string {
  const src = fs.readFileSync(path.join(KOTLIN_DIR, file), 'utf8');
  const m = new RegExp(`\\n(\\s*)(?:[a-z]+ )*fun ${name}\\(`).exec(src);
  if (m == null) throw new Error(`no fun ${name} in ${file}`);
  const indent = m[1]!.replace('\n', '');
  const rest = src.slice(m.index + m[0].length);
  const next = new RegExp(`\\n${indent}(?:@ReactMethod|(?:[a-z]+ )*fun |[a-z]+ (?:val|var) )`).exec(rest);
  return next == null ? rest : rest.slice(0, next.index);
}

/**
 * Read keys Android does not produce, BY DESIGN, with the reason. A prefix
 * covers the block below it.
 */
const ANDROID_NOT_APPLICABLE: Record<string, string> = {
  'exposure.ar':
    'the ARKit exposure probe (ARCamera exposure vs the locked AVCaptureDevice) — an iOS ARKit-arm '
    + 'measurement with no Android counterpart. The reader records the block as absent '
    + '(`exposure.ar.present`) and, with no camera-lock report either, prints no ARKit line',
  'exposure.lock':
    'the iOS camera-lock report (AVCaptureDevice lock/restore). Android reports its own lock through '
    + 'the recorder pack; the vision-camera arm\'s AE/AWB lock report lands with M4',
};

/** Read keys iOS does not produce, BY DESIGN, with the reason. */
const IOS_NOT_APPLICABLE: Record<string, string> = {
  viewfinderAttached:
    "the Android Camera2 idle viewfinder's attach state — iOS has no such view (and the Camera2 "
    + 'viewfinder is deleted with pano+\'s own Android camera, M6b); the reader treats false as '
    + '"not reported"',
  viewfinderNote: 'as viewfinderAttached',
  arTrackingFailure:
    "ARCore's TrackingFailureReason label (INSUFFICIENT_LIGHT, …), which is what the reader switches "
    + "on. ARKit's limited-state reasons are a different set and reach the iOS status only as "
    + '`tracking`; an absent label falls back to the generic guidance',
};

function covered(key: string, exceptions: Record<string, string>): boolean {
  return Object.keys(exceptions).some((p) => key === p || key.startsWith(`${p}.`));
}

function literalsIn(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(f, 'latin1');
    for (const m of src.matchAll(/@?"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(m[1]!);
  }
  return out;
}

// ── A small reader for Objective-C dictionary literals ────────────────────

type ObjcValue =
  | { kind: 'dict'; entries: Map<string, ObjcValue> }
  | { kind: 'ident'; name: string }
  | { kind: 'stats' }
  | { kind: 'other' };

/** Skip a string, char literal or comment starting at `i`; return the index after it, or -1. */
function skipLexeme(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const e = src.indexOf('\n', i);
    return e < 0 ? src.length : e + 1;
  }
  if (c === '/' && src[i + 1] === '*') {
    const e = src.indexOf('*/', i + 2);
    return e < 0 ? src.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let k = i + 1;
    while (k < src.length && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
    return k + 1;
  }
  return -1;
}

/** Parse the `@{ … }` whose `@` is at `at`. */
function parseObjcDict(src: string, at: number): ObjcValue & { kind: 'dict' } {
  if (src.slice(at, at + 2) !== '@{') throw new Error(`no @{ at ${at}`);
  const entries = new Map<string, ObjcValue>();
  let i = at + 2;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      if ((src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) { i = skipLexeme(src, i); continue; }
      break;
    }
  };
  for (;;) {
    ws();
    if (src[i] === '}') return { kind: 'dict', entries };
    // key: @"name" (or `@"a" @"b"` concatenation, not used for keys)
    const km = /^@"([^"]*)"/.exec(src.slice(i));
    if (km == null) throw new Error(`expected a key at ${i}: ${src.slice(i, i + 40)}`);
    const key = km[1]!;
    i += km[0].length;
    ws();
    if (src[i] !== ':') throw new Error(`expected ':' after @"${key}"`);
    i += 1;
    ws();
    // value: read to the next top-level ',' or the closing '}'
    const start = i;
    let depth = 0;
    let value: ObjcValue | null = null;
    while (i < src.length) {
      const skip = skipLexeme(src, i);
      if (skip >= 0) { i = skip; continue; }
      const c = src[i]!;
      if (depth === 0 && c === '@' && src[i + 1] === '{' && src.slice(start, i).trim() === '') {
        value = parseObjcDict(src, i);
        // advance past the nested literal's closing brace
        let d = 0;
        for (let k = i + 1; k < src.length; k += 1) {
          const sk = skipLexeme(src, k);
          if (sk >= 0) { k = sk - 1; continue; }
          if (src[k] === '{') d += 1;
          else if (src[k] === '}') { d -= 1; if (d === 0) { i = k + 1; break; } }
        }
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ',' && depth === 0) break;
      i += 1;
    }
    if (value == null) {
      const text = src.slice(start, i).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) value = { kind: 'ident', name: text };
      else if (/^statsDict\(/.test(text)) value = { kind: 'stats' };
      else value = { kind: 'other' };
    }
    entries.set(key, value);
    ws();
    if (src[i] === ',') { i += 1; continue; }
    if (src[i] === '}') return { kind: 'dict', entries };
  }
}

/**
 * Every key path a dictionary literal produces. An `ident` value is resolved
 * through the LAST `NSDictionary *ident = @{` before `before` (the sub-dicts
 * the summary is assembled from); `statsDict(…)` yields p50/p99/max/n.
 */
function objcPaths(src: string, dict: ObjcValue & { kind: 'dict' }, before: number, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [key, v] of dict.entries) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.add(p);
    if (v.kind === 'dict') {
      for (const q of objcPaths(src, v, before, p)) out.add(q);
    } else if (v.kind === 'stats') {
      for (const k of ['p50', 'p99', 'max', 'n']) out.add(`${p}.${k}`);
    } else if (v.kind === 'ident') {
      const decl = `NSDictionary *${v.name} = @{`;
      const at = src.lastIndexOf(decl, before);
      if (at >= 0) {
        const sub = parseObjcDict(src, at + decl.length - 2);
        for (const q of objcPaths(src, sub, at, p)) out.add(q);
      }
    }
  }
  return out;
}

const CORE_MM = path.join(ROOT, 'ios/PanoPlus/RNISPanoCore.mm');

/** The iOS producer's key paths, from the source text (a parameter so a test can mutate it). */
function iosProducedPaths(src: string): { status: Set<string>; summary: Set<string> } {
  const statusDecl = 'NSDictionary *status = @{';
  const sAt = src.indexOf(statusDecl);
  if (sAt < 0) throw new Error('no status literal');
  const status = objcPaths(src, parseObjcDict(src, sAt + statusDecl.length - 2), sAt);
  // The SUCCESS summary is the LAST `summary = @{` in the file (the first is
  // the nothing-painted one, which carries only the counters).
  const sumDecl = 'summary = @{';
  const uAt = src.lastIndexOf(sumDecl);
  if (uAt < 0) throw new Error('no summary literal');
  const summary = objcPaths(src, parseObjcDict(src, uAt + sumDecl.length - 2), uAt);
  // …plus what finalize adds to the mutable copy.
  for (const m of src.slice(uAt).matchAll(/out\[@"([A-Za-z_][A-Za-z0-9_]*)"\]\s*=/g)) summary.add(m[1]!);
  return { status, summary };
}

/** Blocks built at run time in Swift: checked by leaf, in their own producer only. */
const IOS_RUNTIME_BLOCKS: Record<string, string> = {
  'exposure.lock': 'ios/PanoPlus/RNISPanoCameraLock.swift',
  'exposure.ar.probe': 'ios/PanoPlus/RNISArExposureProbe.swift',
};

function iosMissing(read: string[], produced: Set<string>): string[] {
  return read.filter((k) => {
    if (covered(k, IOS_NOT_APPLICABLE)) return false;
    const block = Object.keys(IOS_RUNTIME_BLOCKS).find((b) => k.startsWith(`${b}.`));
    if (block != null) {
      return !literalsIn([path.join(ROOT, IOS_RUNTIME_BLOCKS[block]!)]).has(k.split('.').pop()!);
    }
    return !produced.has(k);
  });
}

const CORE_SRC = fs.readFileSync(CORE_MM, 'latin1');
const IOS_PRODUCED = iosProducedPaths(CORE_SRC);

describe('what the TypeScript reads is enumerated, not guessed', () => {
  it('finds the whole status and summary surface (negative control)', () => {
    expect(STATUS_READ.length).toBeGreaterThanOrEqual(75);
    expect(SUMMARY_READ.length).toBeGreaterThanOrEqual(200);
    for (const k of ['running', 'painted', 'previewSeq', 'poseSourceRan']) {
      expect(STATUS_READ).toContain(k);
    }
    for (const k of [
      'counts.painted', 'seam.canvasJogP50Px', 'seam.jogDriftPx',
      'projection.subjectDistanceFitM', 'gain.cumEnd', 'lens.gate', 'latch.latched',
    ]) {
      expect(SUMMARY_READ).toContain(k);
    }
  });
});

describe('Android — the shared C++ producer plus the Kotlin layer', () => {
  for (const kind of ['status', 'summary'] as const) {
    it(`emits every ${kind} key the TypeScript reads`, () => {
      const produced = new Set(fixture[kind]);
      const missing = (kind === 'status' ? STATUS_READ : SUMMARY_READ).filter(
        (k) => !produced.has(k)
          && !(k in KOTLIN_ADDED[kind])
          && !covered(k, ANDROID_NOT_APPLICABLE),
      );
      expect(missing).toEqual([]);
    });
  }

  it('every Kotlin-added key is carried by EVERY link of its chain', () => {
    for (const kind of ['status', 'summary'] as const) {
      for (const [key, chain] of Object.entries(KOTLIN_CHAINS[kind])) {
        for (const [file, fn, form] of chain) {
          expect({ key, file, fn, found: kotlinFunctionBody(file, fn).includes(form) })
            .toEqual({ key, file, fn, found: true });
        }
      }
    }
  });

  it('⚑ NEGATIVE CONTROL — the function slicer does not see past its function', () => {
    // `"poseSourceRan"` also appears in the recorder's START result; the
    // statusMap body must not contain that one.
    expect(kotlinFunctionBody('PanoPlusAndroidRecorder.kt', 'statusMap'))
      .not.toContain('poseSourceRequested');
  });

  it('an exception is never used for a key the producer DOES emit (stale exceptions)', () => {
    for (const kind of ['status', 'summary'] as const) {
      const produced = new Set(fixture[kind]);
      const stale = Object.keys(ANDROID_NOT_APPLICABLE).filter((p) => produced.has(p));
      expect({ kind, stale }).toEqual({ kind, stale: [] });
    }
  });
});

describe('iOS — RNISPanoCore.mm\'s own dictionary literals', () => {
  it('emits every status key the TypeScript reads', () => {
    expect(iosMissing(STATUS_READ, IOS_PRODUCED.status)).toEqual([]);
  });

  it('emits every summary key the TypeScript reads', () => {
    expect(iosMissing(SUMMARY_READ, IOS_PRODUCED.summary)).toEqual([]);
  });

  it('⚑ NEGATIVE CONTROL — blanking the status literal fails it', () => {
    const decl = 'NSDictionary *status = @{';
    const at = CORE_SRC.indexOf(decl);
    const close = CORE_SRC.indexOf('};', at);
    const mutated = CORE_SRC.slice(0, at + decl.length) + '\n    ' + CORE_SRC.slice(close);
    expect(iosMissing(STATUS_READ, iosProducedPaths(mutated).status).length)
      .toBeGreaterThan(STATUS_READ.length - 10);
  });

  it('⚑ NEGATIVE CONTROL — dropping `@"seam": seam` from the summary fails it', () => {
    const at = CORE_SRC.lastIndexOf('summary = @{');
    const head = CORE_SRC.slice(0, at);
    const tail = CORE_SRC.slice(at).replace(/\n\s*@"seam":\s*seam,/, '\n');
    expect(tail).not.toBe(CORE_SRC.slice(at));
    const missing = iosMissing(SUMMARY_READ, iosProducedPaths(head + tail).summary);
    expect(missing).toContain('seam.canvasJogP50Px');
    expect(missing.every((k) => k === 'seam' || k.startsWith('seam.'))).toBe(true);
  });

  it('⚑ the parser reads nested literals and resolves named sub-dicts (spot checks)', () => {
    expect(IOS_PRODUCED.summary.has('projection.subjectDistanceFit.rawM')).toBe(true);
    expect(IOS_PRODUCED.summary.has('engineMs.p99')).toBe(true);
    expect(IOS_PRODUCED.summary.has('counts.painted')).toBe(true);
    expect(IOS_PRODUCED.summary.has('finalizeMs')).toBe(true);
    expect(IOS_PRODUCED.status.has('running')).toBe(true);
  });
});

describe('the stop REJECTION payload (`panoPlusErrorInfo`) — both producers', () => {
  // The same class of gap, on the failure path: `panoPlusErrorInfo` reads
  // `userInfo.sessionDir / counts / abort`. iOS rejects with the whole
  // summary; Android built its no-finalize and unreadable-summary rejections
  // by hand and carried no `sessionDir`, so a failed Android sweep lost the
  // location of the pack it had written.
  const READ = readPaths((raw) => panoPlusErrorInfo({ code: 'x', message: 'y', userInfo: raw }))
    .filter((k) => !k.includes('.'));

  it('reads what it is expected to (negative control)', () => {
    expect(READ).toEqual(expect.arrayContaining(['sessionDir', 'counts', 'abort']));
  });

  it('iOS: the summary it rejects with carries every top-level key read', () => {
    for (const k of READ) expect({ k, has: IOS_PRODUCED.summary.has(k) }).toEqual({ k, has: true });
  });

  it('Android: every hand-built rejection carries `sessionDir`', () => {
    const shim = fs.readFileSync(path.join(KOTLIN_DIR, 'PanoPlusLiveModule.kt'), 'utf8');
    const body = shim.slice(shim.indexOf('private inner class StopShim'));
    const handBuilt = (body.match(/val info = WritableNativeMap\(\)/g) ?? []).length;
    const withDir = (body.match(/info\.putString\("sessionDir"/g) ?? []).length;
    expect(handBuilt).toBeGreaterThanOrEqual(2);
    expect(withDir).toBe(handBuilt);
    // …and the one built from the C++ summary carries it through the fixture.
    expect(fixture.summary).toContain('sessionDir');
  });
});
