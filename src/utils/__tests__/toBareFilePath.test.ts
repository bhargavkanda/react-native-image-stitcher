// SPDX-License-Identifier: Apache-2.0
/**
 * `toBareFilePath` must turn every uri `<Camera>` emits back into a readable
 * path — including the crop editor's `file://…?t=<ms>` cache-buster, which
 * `rectCrop` (on by default since 2026-09-23) puts in most hosts' hands — and
 * must not damage a path whose NAME contains `#` or `?`: the library's own
 * `toFileUri` never percent-encodes, so those characters are part of the name.
 */
import * as fs from 'fs';
import * as path from 'path';

import { stripCropCacheBuster, toBareFilePath, toFileUri } from '../paths';

describe('toBareFilePath', () => {
  it('strips the scheme', () => {
    expect(toBareFilePath('file:///data/p/pano.jpg')).toBe('/data/p/pano.jpg');
  });

  it("drops the crop editor's trailing ?t=<ms> cache-buster", () => {
    expect(toBareFilePath('file:///data/p/pano.jpg?t=1790172614759'))
      .toBe('/data/p/pano.jpg');
  });

  it('round-trips toFileUri for names containing # or ? (a host outputDir like "Store #12/")', () => {
    for (const p of ['/docs/Store #12/panorama-1.jpg', '/docs/what?.jpg',
                     '/docs/a?b=1/c.jpg']) {
      expect(toBareFilePath(toFileUri(p))).toBe(p);
    }
    // …including when the crop editor's cache-buster is then appended.
    expect(toBareFilePath(`${toFileUri('/docs/Store #12/p.jpg')}?t=42`))
      .toBe('/docs/Store #12/p.jpg');
  });

  it('leaves a BARE path alone', () => {
    expect(toBareFilePath('/data/p/what?.jpg')).toBe('/data/p/what?.jpg');
  });

  it('is idempotent and total', () => {
    const once = toBareFilePath('file:///a/b.jpg?t=2');
    expect(toBareFilePath(once)).toBe(once);
    expect(toBareFilePath('')).toBe('');
    expect(toBareFilePath(null)).toBe('');
    expect(toBareFilePath(undefined)).toBe('');
  });

  it('is public — the documented way to read the Crop uri must be importable', () => {
    // Read as SOURCE: the index pulls in the whole native surface, which this
    // pure project cannot load.
    const index = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf8');
    expect(index).toMatch(/export\s*\{\s*toBareFilePath\s*\}\s*from\s*'\.\/utils\/paths'/);
  });
});

describe('stripCropCacheBuster', () => {
  it('keeps the scheme and drops only the trailing ?t=<ms>', () => {
    expect(stripCropCacheBuster('file:///d/p.jpg?t=7')).toBe('file:///d/p.jpg');
    expect(stripCropCacheBuster('file:///d/Store #12/p.jpg')).toBe('file:///d/Store #12/p.jpg');
    expect(stripCropCacheBuster('file:///d/p.jpg?tag=x')).toBe('file:///d/p.jpg?tag=x');
    expect(stripCropCacheBuster(undefined)).toBe('');
  });
});
