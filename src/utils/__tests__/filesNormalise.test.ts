// SPDX-License-Identifier: Apache-2.0
/**
 * `copyFile` / `moveFile` hand native a readable path whatever uri shape the
 * host passes — in particular the crop editor's `file://…jpg?t=<ms>`, which
 * `rectCrop` (on by default since 2026-09-23) now puts in most hosts' hands.
 * Native's own `stripFileScheme` removes only `file://`, so without this the
 * copy looked for a file literally named `…jpg?t=<ms>`.
 */
const mockCalls: Array<[string, string, string]> = [];
jest.mock('react-native', () => ({
  NativeModules: {
    RNImageStitcherFileUtils: {
      copyFile: async (from: string, to: string) => { mockCalls.push(['copy', from, to]); return to; },
      moveFile: async (from: string, to: string) => { mockCalls.push(['move', from, to]); return to; },
      defaultCaptureDir: async () => '/cap',
    },
  },
}));

// eslint-disable-next-line import/first
import { copyFile, moveFile } from '../files';

beforeEach(() => { mockCalls.length = 0; });

describe('copyFile / moveFile normalise both paths', () => {
  it("strip the scheme and the crop editor's cache-buster from `from` AND `to`", async () => {
    await copyFile('file:///d/p.jpg?t=1790172614759', 'file:///out/p.jpg');
    await moveFile('file:///d/q.jpg?t=5', '/out/q.jpg');
    expect(mockCalls).toEqual([
      ['copy', '/d/p.jpg', '/out/p.jpg'],
      ['move', '/d/q.jpg', '/out/q.jpg'],
    ]);
  });

  it('leave a name containing # or ? intact', async () => {
    await copyFile('file:///docs/Store #12/p.jpg', '/docs/what?.jpg');
    expect(mockCalls).toEqual([['copy', '/docs/Store #12/p.jpg', '/docs/what?.jpg']]);
  });
});
