// SPDX-License-Identifier: Apache-2.0
/**
 * `cropSiblingPath` — where a pano+ crop lands.
 *
 * ⚠ THIS IS NOT A STRING-FORMATTING TEST. The reason this function exists is
 * that the alternative — the in-place overwrite every other engine uses — is
 * DESTRUCTIVE for a sweep: a pano+ canvas is referenced by its pack
 * (`sessionDir/canvas.jpg`), and overwriting it leaves every offline harness
 * reading a pack whose seam residuals, coverage mask and ledger describe a
 * panorama that is no longer on disk. The pack still looks complete, which
 * is what makes it dangerous.
 *
 * So the property under test is "the answer is never the input", and the
 * cases below are the shapes that could violate it.
 */
import { cropSiblingPath } from '../paths';

describe('cropSiblingPath', () => {
  it('puts the crop beside the canvas, keeping the extension', () => {
    expect(cropSiblingPath('/d/pp_1/canvas.jpg'))
      .toBe('/d/pp_1/canvas.cropped.jpg');
    expect(cropSiblingPath('/d/pp_1/canvas.png'))
      .toBe('/d/pp_1/canvas.cropped.png');
  });

  it('strips the file:// scheme — native writers take a bare path', () => {
    expect(cropSiblingPath('file:///d/pp_1/canvas.jpg'))
      .toBe('/d/pp_1/canvas.cropped.jpg');
  });

  it('drops a cache-busting query — this is a path, not a URI', () => {
    // `<Camera>` emits `…canvas.jpg?t=…` so `<Image>` reloads it, and that
    // string can come back in as the source of a SECOND crop. A destination
    // ending in `.jpg?t=123.cropped.jpg` is a file nothing can find.
    expect(cropSiblingPath('/d/pp_1/canvas.jpg?t=1699999999'))
      .toBe('/d/pp_1/canvas.cropped.jpg');
    expect(cropSiblingPath('/d/pp_1/canvas.jpg#frag'))
      .toBe('/d/pp_1/canvas.cropped.jpg');
  });

  it('is STABLE — a second crop replaces the first, it does not accumulate', () => {
    // One file per attempt would pile up inside the pack the operator has to
    // ship us, and the emitted uri carries its own cache-buster, so nothing
    // needs the name to change.
    const once = cropSiblingPath('/d/pp_1/canvas.jpg');
    expect(cropSiblingPath(once)).toBe('/d/pp_1/canvas.cropped.cropped.jpg');
    expect(cropSiblingPath('/d/pp_1/canvas.jpg')).toBe(once);
  });

  it('never answers the input — the destructive case', () => {
    for (const p of [
      '/d/pp_1/canvas.jpg',
      'canvas.jpg',
      '/d/pp_1/canvas',
      '/d/pp_1/.canvas',
      'file:///d/pp_1/canvas.jpeg',
    ]) {
      expect(cropSiblingPath(p)).not.toBe(p);
      expect(cropSiblingPath(p)).toContain('.cropped');
    }
  });

  it('handles a bare name, a missing extension and a dotfile', () => {
    expect(cropSiblingPath('canvas.jpg')).toBe('canvas.cropped.jpg');
    // No extension → assume the JPEG the crop re-encodes to, rather than
    // writing an extensionless file native has to sniff.
    expect(cropSiblingPath('/d/pp_1/canvas')).toBe('/d/pp_1/canvas.cropped.jpg');
    // A leading dot is not an extension: `lastIndexOf('.')` answers 0 and
    // would otherwise split this into an EMPTY stem (`.cropped.canvas`).
    expect(cropSiblingPath('/d/pp_1/.canvas')).toBe('/d/pp_1/.canvas.cropped.jpg');
  });

  it('is empty for an empty input, like its neighbours in this file', () => {
    expect(cropSiblingPath('')).toBe('');
    expect(cropSiblingPath(null)).toBe('');
    expect(cropSiblingPath(undefined)).toBe('');
  });
});
