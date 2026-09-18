// SPDX-License-Identifier: Apache-2.0
/**
 * nativeDocumentDirectory.test.ts — the sweep must not need Expo.
 *
 * ── WHAT WENT WRONG, AND WHY THESE CASES ────────────────────────────────
 * pano+ moved into this Apache-2.0 package still reading its base directory
 * from `expo-file-system`, a module this package does not depend on and does
 * not declare.  On a host without Expo — including this repo's own example
 * app — `loadVideoFileSystem()` returned null, the surface's
 * `available` term went false, and the operator was shown "pano+ is not
 * available", a sentence about the BUILD.  The build was correct.  Every
 * native symbol was present and the session module was registered; the probe
 * `panoPlusIsAvailable()` returned true on the device that showed the card.
 *
 * So the cases below pin the three things that failure needed, all at once:
 *   1. the directory resolves with NO expo-file-system present at all;
 *   2. a host that HAS expo keeps its own directory, unchanged — this fix
 *      must not relocate one byte of an existing host's data;
 *   3. absence is reported as null rather than as a stub object, because a
 *      partial filesystem is how `undefined is not a function` gets shipped.
 */
import { NativeModules } from 'react-native';

import { nativeDocumentDirectory } from '../fileSystem';

type Mods = Record<string, unknown>;
const mods = NativeModules as Mods;

describe('nativeDocumentDirectory — the sweep does not need Expo', () => {
  const saved: Mods = {};
  const NAMES = ['RNSSweepSession', 'RNISPanoPlus'];

  beforeEach(() => {
    for (const n of NAMES) saved[n] = mods[n];
    for (const n of NAMES) delete mods[n];
  });
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete mods[n];
      else mods[n] = saved[n];
    }
  });

  it('reads the directory off the registered session module', () => {
    mods.RNSSweepSession = { documentDirectory: 'file:///data/u/0/app/files/' };
    expect(nativeDocumentDirectory()).toBe('file:///data/u/0/app/files/');
  });

  it('accepts the pre-rename module name too', () => {
    // Same dual-name contract as `panoPlusNative.ts`: this package and its
    // hosts do not release atomically, so a device can run an older binary
    // against newer JS.
    mods.RNISPanoPlus = { documentDirectory: 'file:///var/Documents/' };
    expect(nativeDocumentDirectory()).toBe('file:///var/Documents/');
  });

  it('prefers the new name when a binary somehow carries both', () => {
    mods.RNSSweepSession = { documentDirectory: 'file:///new/' };
    mods.RNISPanoPlus = { documentDirectory: 'file:///old/' };
    expect(nativeDocumentDirectory()).toBe('file:///new/');
  });

  it('reads it through getConstants() when the property is not merged', () => {
    // ⚠ THIS IS THE BRIDGELESS CASE, AND IT IS NOT HYPOTHETICAL. Measured on
    // a Galaxy A35 on the New Architecture: the constant is compiled into
    // classes2.dex, `RNSSweepSession` resolves, and the direct property read
    // still comes back undefined — the legacy interop layer exposes
    // constants only behind `getConstants()`. Supporting the direct read
    // alone meant supporting the OLD architecture only, and failing on the
    // new one with a null that reads exactly like "old binary".
    mods.RNSSweepSession = {
      getConstants: () => ({ documentDirectory: 'file:///data/u/0/app/files/' }),
    };
    expect(nativeDocumentDirectory()).toBe('file:///data/u/0/app/files/');
  });

  it('prefers the merged property when a module offers both', () => {
    mods.RNSSweepSession = {
      documentDirectory: 'file:///direct/',
      getConstants: () => ({ documentDirectory: 'file:///viaConstants/' }),
    };
    expect(nativeDocumentDirectory()).toBe('file:///direct/');
  });

  it('survives a module whose getConstants throws', () => {
    // Falling through to the next name beats taking the whole sweep surface
    // down over a module that cannot describe itself.
    mods.RNSSweepSession = {
      getConstants: () => { throw new Error('bridge is gone'); },
    };
    mods.RNISPanoPlus = { documentDirectory: 'file:///fallback/' };
    expect(nativeDocumentDirectory()).toBe('file:///fallback/');
  });

  it('returns null when the module is registered but predates the constant', () => {
    // The whole point of the null: an OLD binary is registered and usable for
    // everything else, and reporting its missing constant as an empty string
    // would send the engine a session path of `/`.
    mods.RNSSweepSession = { start: () => {}, stop: () => {} };
    expect(nativeDocumentDirectory()).toBeNull();
  });

  it('returns null when nothing is registered at all', () => {
    expect(nativeDocumentDirectory()).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a number', 12],
    ['null', null],
    ['an object', { path: '/x' }],
  ])('refuses %s rather than passing it to the engine', (_label, value) => {
    // ⚠ TWO DIFFERENT GUARDS, AND ONLY ONE OF THEM IS THE INTERESTING ONE.
    // `''` and `null` are refused by plain truthiness. The NUMBER and the
    // OBJECT are what the `typeof dir === 'string'` check is for: a naive
    // `if (dir) return dir` hands either one straight to the engine as a
    // path prefix, and `${12}session-1` is a directory name a filesystem
    // will accept. Verified: those two cases, and only those two, go red
    // against the truthiness-only version.
    mods.RNSSweepSession = { documentDirectory: value };
    expect(nativeDocumentDirectory()).toBeNull();
  });
});
