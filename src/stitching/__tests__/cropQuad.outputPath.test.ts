// SPDX-License-Identifier: Apache-2.0
/**
 * `cropQuad`'s destination, and the silent failure it must not have.
 *
 * ⚠ THE OLD CONTRACT THREW ON ANY `outPath` THAT DIFFERED FROM `imagePath`,
 * with the note "the native crop overwrites in place; fail loudly rather
 * than silently writing to imagePath and returning a path the file isn't
 * at". That instinct is right and the throw was the wrong place for it: it
 * disabled the crop editor on the SWEEP engine altogether, because a pano+
 * canvas is referenced by its pack and cannot be overwritten — so the
 * operator got a crop preview on one engine and a bare image on the other.
 *
 * Both natives now take an `outputPath`. The loud failure MOVES rather than
 * disappearing: an older native ignores the key and writes in place, and
 * this layer has to catch that rather than report a path with no file at it.
 */
import { NativeModules } from 'react-native';

import { cropQuad } from '../cropQuad';

type Bag = { imagePath: string; quad: number[]; quality: number; outputPath?: string };
const calls: Bag[] = [];
/** What the fake native echoes back — swapped per case. */
let echoOutputPath = true;
/**
 * Does the fake native carry the MARKER method?
 *
 * `false` models a build that predates `outputPath` — the routine state when
 * JS reloads through Metro and native does not. `cropQuad` must refuse
 * BEFORE calling, because a stale native writes in place and the file it
 * destroys on the sweep path is the pack's canvas.
 */
let hasMarker = true;

const NM = NativeModules as Record<string, unknown>;

/** Rebuild the fake module — call after flipping `hasMarker`. */
function installNative(): void {
  NM.BatchStitcher = {
    ...(hasMarker
      ? { cropToQuadAcceptsOutputPath: () => Promise.resolve(true) }
      : {}),
    cropToQuad: (o: Bag) => {
      calls.push(o);
      const landed = (o.outputPath != null && o.outputPath !== '')
        ? o.outputPath
        : o.imagePath;
      return Promise.resolve({
        width: 100,
        height: 50,
        ...(echoOutputPath ? { outputPath: landed } : {}),
      });
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  echoOutputPath = true;
  hasMarker = true;
  installNative();
});
afterEach(() => { delete NM.BatchStitcher; });

const QUAD = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
] as const;

describe('cropQuad destination', () => {
  it('omitted ⇒ IN PLACE, and the key is not even sent', async () => {
    // A native build that predates the option must see the exact bag it has
    // always seen — an unknown key in a ReadableMap is harmless on both
    // platforms, but "byte-identical for every pre-existing caller" is a
    // claim worth being literally true.
    const r = await cropQuad('/d/pano.jpg', QUAD as never);
    expect(calls[0]).not.toHaveProperty('outputPath');
    expect(r.outputPath).toBe('/d/pano.jpg');
  });

  it('equal to the source ⇒ also in place, also not sent', async () => {
    const r = await cropQuad('/d/pano.jpg', QUAD as never, '/d/pano.jpg');
    expect(calls[0]).not.toHaveProperty('outputPath');
    expect(r.outputPath).toBe('/d/pano.jpg');
  });

  it('different ⇒ sent, and the result names where it landed', async () => {
    const r = await cropQuad(
      '/d/pp_1/canvas.jpg', QUAD as never, '/d/pp_1/canvas.cropped.jpg',
    );
    expect(calls[0]!.outputPath).toBe('/d/pp_1/canvas.cropped.jpg');
    expect(r.outputPath).toBe('/d/pp_1/canvas.cropped.jpg');
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
  });

  it('⚑ an OLDER native REFUSES BEFORE THE WRITE, not after it', async () => {
    // ⚠ THE ORDER IS THE WHOLE FINDING. The first cut checked native's echo
    // in the RESULT — correct, and too late: native had already ignored the
    // unknown key and rewritten `imagePath` in place, and on the sweep path
    // that file is the pack's `canvas.jpg`. JS newer than native is the
    // routine state here (a Metro reload without a rebuild), so it is not a
    // rare race.
    //
    // The marker method's PRESENCE is the preflight. `calls` empty is the
    // assertion that matters: native was never asked.
    hasMarker = false;
    echoOutputPath = false;
    installNative();
    await expect(cropQuad(
      '/d/pp_1/canvas.jpg', QUAD as never, '/d/pp_1/canvas.cropped.jpg',
    )).rejects.toThrow(/does not honour outputPath/);
    expect(calls).toHaveLength(0);
  });

  it('⚑ …and the post-hoc echo check is still there as a belt', async () => {
    // A native that HAS the marker but still fails to honour the key — a
    // half-applied patch, a build where only one platform was updated — is
    // caught by the result check. Keeping both is cheap; the preflight is
    // the one that saves the file, this one is the one that stops a lie.
    hasMarker = true;
    echoOutputPath = false;
    installNative();
    await expect(cropQuad(
      '/d/pp_1/canvas.jpg', QUAD as never, '/d/pp_1/canvas.cropped.jpg',
    )).rejects.toThrow(/wrote IN PLACE/);
  });

  it('…and an older native is FINE for an in-place caller', async () => {
    // Negative control: the guard above must key on the REQUEST, not on the
    // echo, or every pre-existing caller on an older native would start
    // throwing.
    hasMarker = false;
    echoOutputPath = false;
    installNative();
    const r = await cropQuad('/d/pano.jpg', QUAD as never);
    expect(r.outputPath).toBe('/d/pano.jpg');
    expect(calls).toHaveLength(1);        // …and it really did run
  });
});
