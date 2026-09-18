// SPDX-License-Identifier: Apache-2.0
/**
 * ipBoundary.test.ts — the publication guard.
 *
 * This package is Apache-2.0 and public.  It is built alongside a private
 * native overlay that is NOT, and source moves between the two.  Every
 * assertion here answers one question: *did something that belongs on the
 * private side land in this tree?*  There is no other check — no licence-header
 * lint, no export review, no publish-time diff.  A leak that gets past this
 * file gets past everything and is then in a public git history permanently.
 *
 * ── WHY IT LIVES HERE, AND NOT IN scripts/ ───────────────────────────────
 * `jest.config.js` matches `<rootDir>/src/** /__tests__/** /*.test.(ts|tsx)`.
 * A guard placed anywhere else is never executed by `npm test`, and `npm test`
 * is what CI runs and what `prepublishOnly` runs.  A guard that does not run
 * is worse than no guard: it reads as coverage.
 *
 * ── WHY IT WALKS THE FILESYSTEM RATHER THAN grep-ing A FILE LIST ─────────
 * A list goes stale silently.  The walk covers whatever is on disk under the
 * four source roots, so a new file is covered the moment it is written.  The
 * two vendored trees are skipped by name because both are gitignored and
 * npmignored — they are third-party binaries, not this project's source, and
 * neither is published.  A NEW vendored tree with no skip entry turns this
 * suite RED, which is the correct direction to fail in.
 *
 * ── THE SELF-CHECK IS LOAD-BEARING ──────────────────────────────────────
 * `collect()` asserts a floor on the number of files it found.  A guard whose
 * file list comes back empty passes every single assertion and reports green.
 * That failure mode has bitten this project before, in a survey that silently
 * grepped nothing.  The floor makes it impossible.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Repo root: this file is at <root>/src/__tests__/. */
const ROOT = path.resolve(__dirname, '../..');

/** Source roots the boundary applies to. */
const ROOTS = ['cpp', 'ios', 'android/src', 'src'];

/**
 * Directories never descended into.
 *
 * `ios/Frameworks` and `android/src/main/jniLibs` hold the vendored OpenCV
 * distribution — third-party source under OpenCV's own licence, gitignored
 * (.gitignore:18,28) and npmignored (.npmignore:22,26).  Applying this
 * project's SPDX rule to them would be both wrong and impossible.
 */
const SKIP_DIRS = new Set([
  '.build',
  '.git',
  'build',
  'node_modules',
  'Pods',
  'Frameworks', // ios/Frameworks — vendored opencv2.xcframework
  'jniLibs', // android/src/main/jniLibs — vendored OpenCV Android SDK
]);

/** Extensions that carry a source licence header. */
const SOURCE_EXT = new Set([
  '.cpp',
  '.hpp',
  '.h',
  '.mm',
  '.m',
  '.swift',
  '.kt',
  '.ts',
  '.tsx',
]);

/** Extensions scanned for leaked tokens (a superset: build files too). */
const SCAN_EXT = new Set([...SOURCE_EXT, '.gradle', '.txt', '.json', '.podspec']);

interface Entry {
  rel: string;
  abs: string;
  ext: string;
}

function walk(dir: string, out: Entry[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // a root that does not exist yet is not a failure
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow: swift-tests symlinks back into ios/
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(abs, out);
      continue;
    }
    out.push({ rel: path.relative(ROOT, abs), abs, ext: path.extname(name) });
  }
}

/**
 * Every file under the four roots, with a floor on the count.
 *
 * The floor is deliberately far below the real number (measured 454 source
 * files before pano+ lands) so ordinary deletions do not trip it, while an
 * empty or near-empty walk — a moved root, a typo in ROOTS, a bad cwd — fails
 * loudly instead of reporting a vacuous green.
 */
const MIN_FILES_EXPECTED = 100;

function collect(): Entry[] {
  const out: Entry[] = [];
  for (const r of ROOTS) walk(path.join(ROOT, r), out);
  if (out.length < MIN_FILES_EXPECTED) {
    throw new Error(
      `ipBoundary self-check FAILED: walked only ${out.length} files under ` +
        `${ROOTS.join(', ')} from ${ROOT} (expected >= ${MIN_FILES_EXPECTED}). ` +
        `Every assertion below would have passed vacuously. Fix the walk, ` +
        `do not lower the floor.`,
    );
  }
  return out;
}

const ALL = collect();
const SCANNED = ALL.filter((e) => SCAN_EXT.has(e.ext));
const SOURCES = ALL.filter((e) => SOURCE_EXT.has(e.ext));

/**
 * This file. Excluded from every token scan below, and necessarily so: it
 * spells out each forbidden token verbatim, so a scan that included it would
 * report itself and could never be green. The exclusion is one exact path,
 * not a pattern — the guard is short, reviewed, and contains no other source.
 * It stays IN the SPDX pools, so its own licence header is still checked.
 */
const SELF = path.relative(ROOT, __filename);

/** Files whose text contains `needle`, as "rel:line  <trimmed line>". */
function hits(needle: string, pool: Entry[] = SCANNED): string[] {
  const found: string[] = [];
  for (const e of pool) {
    if (e.rel === SELF) continue;
    let text: string;
    try {
      text = fs.readFileSync(e.abs, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(needle)) continue;
    text.split('\n').forEach((line, i) => {
      if (line.includes(needle)) found.push(`${e.rel}:${i + 1}  ${line.trim()}`);
    });
  }
  return found;
}

function report(label: string, found: string[]): string {
  return (
    `${label}\n  ` +
    found.slice(0, 20).join('\n  ') +
    (found.length > 20 ? `\n  … and ${found.length - 20} more` : '')
  );
}

describe('IP boundary: nothing from the private overlay is in this package', () => {
  it('walked a plausible number of files', () => {
    // Redundant with collect()'s throw, and intentionally so: this is the one
    // assertion a reader checks first when the suite is suspiciously green.
    expect(ALL.length).toBeGreaterThanOrEqual(MIN_FILES_EXPECTED);
    expect(SOURCES.length).toBeGreaterThanOrEqual(MIN_FILES_EXPECTED);
  });

  /**
   * Tier 1 — bare tokens.
   *
   * Each of these was measured non-zero on the private half and zero across
   * the entire pano+ set that moves here, so a bare substring match carries no
   * false positives.  Do NOT add a token that also occurs in pano+ source; use
   * a narrowed declaration site (tier 2) for those.
   */
  describe.each([
    ['host::plane', 'the private plane-solve namespace'],
    ['paintPlaneMosaic', 'the private mosaic painter entry point'],
    ['seamCompositor', 'the private seam compositor'],
    ['.depthsidecar', 'the private depth-sidecar file format'],
    ['solvePlane', 'the private plane solver'],
  ])('private token %s', (token, what) => {
    it(`does not appear (${what})`, () => {
      const found = hits(token);
      expect(report(`"${token}" leaked into the public package:`, found)).toBe(
        `"${token}" leaked into the public package:\n  `,
      );
    });
  });

  /**
   * Tier 2 — narrowed declaration sites.
   *
   * The bare class names `HostStitchPlugins` and `HostPlaneSolve`
   * are referenced from pano+ comments and would be red here for the wrong
   * reason.  What must never appear is the DECLARATION — the place a private
   * React Native module is registered.
   */
  describe.each([
    ['getName(): String = "HostStitchPlugins"', 'Android registration of the private module'],
    ['@objc(HostStitchPlugins)', 'iOS registration of the private module'],
    ['getName(): String = "HostPlaneSolve"', 'Android registration of the private plane solver'],
    ['@objc(HostPlaneSolve)', 'iOS registration of the private plane solver'],
  ])('private module declaration %s', (decl, what) => {
    it(`is not declared here (${what})`, () => {
      const found = hits(decl);
      expect(report(`private module declared in the public package:`, found)).toBe(
        `private module declared in the public package:\n  `,
      );
    });
  });

  /**
   * Tier 3 — sibling first-party plugins in the host's private camera SDK.
   *
   * These are not this package's concern at all; a mention here means a
   * comment came across un-redacted and names software the public reader has
   * no way to see.
   */
  describe.each([
    ['HostArDoc', 'a private document-scanning AR plugin'],
    ['HostScenePlugin', 'a private scene-model AR plugin'],
    ['hostSceneLiveness', 'a private AR plugin registry key'],
  ])('private sibling %s', (token, what) => {
    it(`is not named (${what})`, () => {
      const found = hits(token);
      expect(report(`"${token}" leaked into the public package:`, found)).toBe(
        `"${token}" leaked into the public package:\n  `,
      );
    });
  });

  /**
   * Tier 4 — the licence triple.
   *
   * This is the ONLY licence check in the repository.  There is no CI header
   * lint.  A file that arrives from the private overlay still headed
   * `UNLICENSED`, or carrying that overlay's copyright line, ships in the npm
   * tarball and in public git history exactly as written.
   */
  describe('SPDX', () => {
    it('no file is marked UNLICENSED', () => {
      const found = hits('UNLICENSED', ALL);
      expect(report('UNLICENSED file in an Apache-2.0 package:', found)).toBe(
        'UNLICENSED file in an Apache-2.0 package:\n  ',
      );
    });

    it('no file carries an SPDX-FileCopyrightText line', () => {
      // Attribution lives once, in LICENSE and NOTICE. Zero of this package's
      // files carry a per-file copyright line; the private overlay's all do.
      const found = hits('SPDX-FileCopyrightText', ALL);
      expect(report('per-file copyright line (attribution belongs in NOTICE):', found)).toBe(
        'per-file copyright line (attribution belongs in NOTICE):\n  ',
      );
    });

    it('every source file declares Apache-2.0 in its opening comment', () => {
      // Within the first 3 lines rather than strictly line 1: a SwiftPM
      // manifest must open with `// swift-tools-version:`, and a script may
      // open with a shebang. Three lines is enough for those and tight enough
      // that the identifier is still in the file's header comment.
      const missing = SOURCES.filter((e) => {
        let head: string;
        try {
          head = fs.readFileSync(e.abs, 'utf8').split('\n').slice(0, 3).join('\n');
        } catch {
          return true;
        }
        return !head.includes('SPDX-License-Identifier: Apache-2.0');
      }).map((e) => e.rel);
      expect(report('source file with no Apache-2.0 SPDX header:', missing)).toBe(
        'source file with no Apache-2.0 SPDX header:\n  ',
      );
    });
  });

  /**
   * Tier 5 — the self-import trap.
   *
   * pano+ was written as a SEPARATE pod that imported this one, so its Swift
   * is full of `#if canImport(RNImageStitcher)` and `import RNImageStitcher`.
   * Once those files compile INTO this module, `canImport(RNImageStitcher)` is
   * a self-import and evaluates FALSE — the guarded class compiles out
   * entirely, every caller is itself guarded, and there is no compiler error,
   * no link error and no pod-install error.  The AR frame plugin would simply
   * never register and every sweep would receive zero frames, silently.
   *
   * `import RNImageStitcher` is the loud half of the same mistake (Swift
   * rejects a self-import), so it is caught at compile time — it is asserted
   * here anyway so both halves are visible in one place.
   */
  describe('no self-import of this module', () => {
    // Everything under ios/ that is COMPILED INTO the module. ios/Tests/ is a
    // separate XCTest target and `@testable import RNImageStitcher` is how it
    // reaches the module under test — required there, fatal anywhere else.
    const iosFiles = ALL.filter(
      (e) => e.rel.startsWith('ios/') && !e.rel.startsWith(path.join('ios', 'Tests') + path.sep),
    );

    it('ios/ contains no canImport(RNImageStitcher)', () => {
      const found = hits('canImport(RNImageStitcher)', iosFiles);
      expect(
        report('self-import guard — compiles the code OUT with no error:', found),
      ).toBe('self-import guard — compiles the code OUT with no error:\n  ');
    });

    it('ios/ contains no import RNImageStitcher', () => {
      const found = hits('import RNImageStitcher', iosFiles);
      expect(report('self-import:', found)).toBe('self-import:\n  ');
    });
  });
});
