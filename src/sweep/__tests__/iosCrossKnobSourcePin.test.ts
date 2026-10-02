// SPDX-License-Identifier: Apache-2.0
/**
 * SOURCE PIN — the low-light registration gate (`Config::crossResidualGate`)
 * on the iOS arm. THIS IS A TEXT CHECK, NOT A RUN: it proves the bridge source
 * says the right things, not that an iPhone ledgered a single row. The device
 * proof is a pano+ pack from an iPhone with `crossResidualGate: 1` whose
 * `ledger.jsonl` rows carry the cross block and whose `meta.json` config
 * echoes the knob.
 *
 * ── Why a source pin ───────────────────────────────────────────────────────
 *
 * Android runs the shared C++ writer (`replay::appendLedgerLine`, called from
 * `rnis_pano_live.cpp`) and the shared knob table (`applyConfigOverride`), so
 * the gate's knobs, ledger block and config echo exist there by construction.
 * iOS does not: `RNISPanoCore.mm` marshals every knob by name, hand-builds its
 * own ledger row and its own config dictionary. Until this pin, none of the
 * three mentioned the gate, so a host's `crossResidualGate: 1` armed the
 * log-only pass on Android and was dropped on iOS with nothing reported — an
 * inert knob on the platform that ships pano+ in production. Nothing in a JS
 * test can run the bridge, and the C++ suite runs the engine without it.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 *
 * 1. The KNOB SET is read from the replay knob table's gate block, not typed
 *    here, and must be the seven names below (negative control: a knob added
 *    to the gate without reaching this list fails).
 * 2. Each knob is MARSHALLED in `startWithOptions` (`c.<k> = … numOr(options,
 *    @"<k>"`), ECHOED in `panoConfigDict` (`@"<k>": @(c.<k>)`), forwarded flat
 *    by Android's `engineKnobKeys`, and TYPED on `PanoPlusEngineOptions`.
 * 3. The iOS ledger's cross block has the shared writer's GUARD
 *    (`row.crossStatsComputed`), its KEYS in its ORDER, reads the same
 *    `FrameOutcome` fields, and sits at the same place in the row (after
 *    `crossAvgDeltaPx`, before `expGain`) — so the row is byte-identical with
 *    the knob at 0 and diffs key for key against the replay twin at 1.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'latin1');

const CORE_MM = read('ios/PanoPlus/RNISPanoCore.mm');
const REPLAY_CPP = read('cpp/panoplus/rnis_pano_replay.cpp');
const LIVE_KT = read('android/src/main/java/io/imagestitcher/rn/panoplus/PanoPlusLiveModule.kt');
const TYPES_TS = read('src/sweep/panoPlusTypes.ts');

const GATE_KNOBS = [
  'crossResidualGate',
  'crossTextureMinVar',
  'crossPeakMinPSR',
  'crossPeakMinMass',
  'crossPeriodGuard',
  'crossPeriodMaxFrac',
  'crossPeakSecondaryFrac',
];

const LEDGER_KEYS = [
  'crossGated',
  'crossTextureVar',
  'crossPeakPSR',
  'crossPeakMass',
  'crossDominantPeriodPx',
  'crossPeakSecondary',
  'crossResidualRawPx',
];

const squeeze = (s: string): string => s.replace(/\s+/g, '');

/** `src` from the first `start` to the first `end` after it (exclusive). */
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found after ${start}: ${end}`);
  return src.slice(i, j);
}

/** The body of the first `if (row.crossStatsComputed) { … }` after `from`. */
function guardedBlock(src: string, from: number): { body: string; at: number } {
  const open = src.indexOf('if (row.crossStatsComputed) {', from);
  if (open < 0) throw new Error('no crossStatsComputed guard');
  let depth = 0;
  for (let k = src.indexOf('{', open); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) {
      return { body: src.slice(open, k + 1), at: open };
    }
  }
  throw new Error('unbalanced crossStatsComputed block');
}

/** Ledger keys in order (`"\"key\":"` inside a C++ string literal). */
const ledgerKeys = (s: string): string[] =>
  [...s.matchAll(/\\"([A-Za-z0-9_]+)\\":/g)].map((m) => m[1]!);
/** FrameOutcome fields read, in order. */
const rowFields = (s: string): string[] =>
  [...s.matchAll(/\brow\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!)
    .filter((f) => f !== 'crossStatsComputed');

// The two writers' row bodies.
const REPLAY_ROW = between(
  REPLAY_CPP, 'void appendLedgerLine(std::string& out, const FrameOutcome& row) {',
  'out += "}\\n";',
);
const IOS_ROW = between(CORE_MM, 'ledgerLine = "{\\"seq\\":"', 'ledgerLine += "}\\n";');

describe('SOURCE PIN (text, not a device run) — the iOS cross-gate knobs', () => {
  it('the knob set is the replay table’s gate block, exactly (negative control)', () => {
    const block = between(
      REPLAY_CPP, '// The low-light registration gate (2026-09-07)', '{"gainLeak"',
    );
    const names = [...block.matchAll(/\{"([A-Za-z0-9_]+)",/g)].map((m) => m[1]!);
    expect(names).toEqual(GATE_KNOBS);
  });

  const START = squeeze(between(
    CORE_MM, '+ (BOOL)startWithOptions:', 'if (!S->engine.configure(c, &cfgErr))',
  ));
  const CONFIG_DICT = squeeze(between(
    CORE_MM, 'static NSDictionary *panoConfigDict(const rnis::pano::Config &c,',
    '@"pack": @{',
  ));
  const KNOB_KEYS = between(LIVE_KT, 'private val engineKnobKeys = listOf(', '\n    )');
  const ENGINE_OPTIONS = between(
    TYPES_TS, 'export interface PanoPlusEngineOptions {', '\n}\n',
  );

  for (const k of GATE_KNOBS) {
    it(`${k}: marshalled, echoed, forwarded on Android, typed`, () => {
      expect(START).toMatch(new RegExp(`c\\.${k}=[^;]*numOr\\(options,@"${k}"`));
      expect(CONFIG_DICT).toContain(`@"${k}":@(c.${k}),`);
      expect(KNOB_KEYS).toContain(`"${k}"`);
      expect(ENGINE_OPTIONS).toMatch(new RegExp(`\\n  ${k}\\?: number;`));
    });
  }
});

describe('SOURCE PIN (text, not a device run) — the iOS ledger cross block', () => {
  const replay = guardedBlock(REPLAY_ROW, 0);
  const ios = guardedBlock(IOS_ROW, 0);

  it('the shared writer still has the block this pin mirrors (negative control)', () => {
    expect(ledgerKeys(replay.body)).toEqual(LEDGER_KEYS);
  });

  it('iOS writes the same keys, in the same order, from the same row fields', () => {
    expect(ledgerKeys(ios.body)).toEqual(ledgerKeys(replay.body));
    expect(rowFields(ios.body)).toEqual(rowFields(replay.body));
    // crossGated is the reason BITMASK — an integer on both writers.
    expect(squeeze(ios.body)).toContain('appendInt(ledgerLine,row.crossGated)');
    expect(squeeze(replay.body)).toContain('appendInt(out,row.crossGated)');
  });

  it('iOS places the block where the shared writer does', () => {
    const around = (row: string, at: number, body: string) => {
      const keys = ledgerKeys(row);
      const before = ledgerKeys(row.slice(0, at));
      return {
        prev: before[before.length - 1],
        next: keys[before.length + ledgerKeys(body).length],
      };
    };
    const r = around(REPLAY_ROW, replay.at, replay.body);
    const i = around(IOS_ROW, ios.at, ios.body);
    expect(r).toEqual({ prev: 'crossAvgDeltaPx', next: 'expGain' });
    expect(i).toEqual(r);
  });

  it('no cross key is written outside the guard — knob 0 rows are byte-identical', () => {
    const outside = IOS_ROW.slice(0, ios.at) + IOS_ROW.slice(ios.at + ios.body.length);
    for (const k of LEDGER_KEYS) expect(ledgerKeys(outside)).not.toContain(k);
    // …and the whole file writes the cross keys exactly once (no second,
    // unguarded copy elsewhere in the bridge).
    for (const k of LEDGER_KEYS) {
      expect(CORE_MM.split(`\\"${k}\\":`).length - 1).toBe(1);
    }
  });
});
