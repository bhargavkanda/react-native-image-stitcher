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

const NM = NativeModules as Record<string, unknown>;

beforeEach(() => {
  calls.length = 0;
  echoOutputPath = true;
  NM.BatchStitcher = {
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

  it('⚑ an OLDER native that ignored the key THROWS, rather than lying', async () => {
    // The silent failure the old throw existed to prevent, in the one form
    // it can still take. Native ignored `outputPath`, wrote over
    // `canvas.jpg`, and echoed no path — so this layer must not report a
    // destination that has no file at it, and must not let a caller believe
    // the pack's canvas survived. It did not.
    echoOutputPath = false;
    await expect(cropQuad(
      '/d/pp_1/canvas.jpg', QUAD as never, '/d/pp_1/canvas.cropped.jpg',
    )).rejects.toThrow(/wrote IN PLACE/);
  });

  it('…and an older native is FINE for an in-place caller', async () => {
    // Negative control: the guard above must key on the REQUEST, not on the
    // echo, or every pre-existing caller on an older native would start
    // throwing.
    echoOutputPath = false;
    const r = await cropQuad('/d/pano.jpg', QUAD as never);
    expect(r.outputPath).toBe('/d/pano.jpg');
  });
});
