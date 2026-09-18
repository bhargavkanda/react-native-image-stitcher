// SPDX-License-Identifier: Apache-2.0
//
// THE LIVE PREVIEW'S WIRING, MOUNTED FOR REAL.
//
// ── The gap this closes ───────────────────────────────────────────────────
//
// `panoPlusPreviewSource` and `panoPlusPreviewBudget` are unit-tested next
// door, and neither proves the SURFACE points an `<Image>` at what native
// published, refuses to point at a file that has not been written yet, or puts
// the platform's memory budget in the bag that crosses the bridge.
//
// That is the class of defect this whole arm exists because of. The operator's
// report on 2026-08-23 was "I do not see a live preview of the image growing";
// the preview was being produced the whole time, and the wiring between it and
// his screen was wrong. Nothing that cannot render could have said so.
//
// The property under test throughout: WHAT IS ON SCREEN MATCHES WHAT NATIVE
// SAID, and the Android arm pays a bounded, declared amount of memory for it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: () => Promise.resolve(),
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import { holdShutter, releaseShutter, shutterState } from './shutterGestures';
import {
  PANO_PLUS_STATUS_POLL_MS,
  PANO_PLUS_SWAP_GRACE_MS,
} from '../panoPlusModel';
// The budget lives with the ARM TABLE, not here: it is keyed on the arm
// CONTRACT (`android-sensor` vs `android-arcore`), which is a finer question
// than `Platform.OS`. This suite imports the constants rather than the
// literals so it pins the WIRING — that the bag reaches `start()` — and never
// re-asserts numbers their own suite already owns.
import {
  PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS,
  PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG,
  PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS,
} from '../panoPlusAndroidArm';

const NM = NativeModules as Record<string, unknown>;

/** The options bag the last `start()` received — the thing that matters. */
let startedWith: Record<string, unknown> | null = null;
/** What `getStatus()` answers on the next poll. Mutated per test. */
let statusReply: Record<string, unknown> = { running: false };

/** A plausible mid-sweep status carrying a PUBLISHED preview. */
function sweepingStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    running: true,
    seq: 40,
    phase: 'sweeping',
    previewPath: '/var/mobile/Documents/pano_1/preview.jpg',
    previewSeq: 7,
    previewW: 1200,
    previewH: 384,
    previewRenders: 9,
    previewFails: 0,
    previewSkips: 2,
    ...over,
  };
}

function installNative(): void {
  startedWith = null;
  statusReply = { running: false };
  NM.RNISPanoPlus = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/var/mobile/Documents/pano_1',
        startedAtMs: 1,
        pluginAvailable: true,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve(statusReply),
  };
}

interface Rig {
  root: ReactTestRenderer['root'];
  has: (testID: string) => boolean;
  propsOf: (testID: string) => Record<string, unknown> | null;
  tap: (testID: string) => void;
  /** Pano's shutter held past the threshold — the sweep starts (2026-09-03). */
  hold: () => void;
  /** …and released — the sweep finishes, pack kept. */
  release: () => void;
  /** What Pano's shutter would paint. */
  shutter: () => { disabled: boolean; busy: boolean };
  unmount: () => void;
}

function mount(): Rig {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PanoPlusCaptureSurface
        onComplete={() => undefined}
        onCancel={() => undefined}
      />,
    );
  });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
  const find = (testID: string): ReactTestInstance | null =>
    renderer.root.findAllByProps({ testID })[0] ?? null;
  return {
    root: renderer.root,
    has: (testID) => find(testID) != null,
    propsOf: (testID) =>
      (find(testID)?.props as Record<string, unknown> | undefined) ?? null,
    tap: (testID) => {
      const node = find(testID);
      const onPress = node?.props?.onPress as (() => void) | undefined;
      if (onPress == null) throw new Error(`no onPress on ${testID}`);
      act(() => { onPress(); });
    },
    hold: () => holdShutter(renderer.root),
    release: () => releaseShutter(renderer.root),
    shutter: () => shutterState(renderer.root),
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Run one status poll and let its promise resolve into state. */
async function poll(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS + 1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
});
afterEach(() => {
  jest.useRealTimers();
  Platform.OS = 'ios';
  delete NM.RNISPanoPlus;
});

describe('the growing canvas reaches the screen', () => {
  it('points the panel at the published file, cache-busted by the seq', async () => {
    // `previewSeq` IS the cache-bust and it is load-bearing: native rewrites
    // the SAME path every tick (tmp + atomic rename, so JS can never read a
    // half file), so without the query RN's image cache would show frame 1 for
    // the whole sweep.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus();
    await poll();

    const img = r.propsOf('panoplus-preview');
    expect(img).not.toBeNull();
    expect((img?.source as { uri: string }).uri).toBe(
      'file:///var/mobile/Documents/pano_1/preview.jpg?v=7',
    );
    r.unmount();
  });

  it('does not draw a preview native has rendered but not written', async () => {
    // THE ELEVEN-DAY DEFECT'S SHAPE. A publisher that cannot write leaves
    // `previewRenders > 0` with `previewSeq == 0`; pointing an `<Image>` at
    // that path would show either nothing or, worse, a stale file from a
    // previous sweep in the same directory.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus({ previewSeq: 0, previewRenders: 9, previewFails: 9 });
    await poll();

    expect(r.has('panoplus-preview')).toBe(false);
    // And the frame itself is still there, carrying the reason — an empty
    // screen is the bug being fixed, so "nothing has arrived" is a report.
    expect(r.has('panoplus-preview-frame')).toBe(true);
    r.unmount();
  });

  it('asks Fresco to decode at panel size, not at file size', async () => {
    // ANDROID-ONLY, IGNORED ON iOS, and the larger half of the preview's
    // memory fix: Fresco keys its bitmap cache by the URI INCLUDING `?v=`, so
    // every publish is a new retained ARGB_8888 entry. `resize` decodes to the
    // view's size; `auto` (the default) would only do that above a threshold
    // this image sits under.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus();
    await poll();

    expect(r.propsOf('panoplus-preview')?.resizeMethod).toBe('resize');
    // `contain` stays: a first frame whose aspect has not settled must not be
    // stretched to fill the panel.
    expect(r.propsOf('panoplus-preview')?.resizeMode).toBe('contain');
    r.unmount();
  });
});

describe('a black viewfinder is explained rather than left to guess at', () => {
  it('names the reason native gave, and only when native gave one', async () => {
    // THE HEADLESS SWEEP. A Camera2 session whose preview Surface arrived
    // after `createCaptureSession` records perfectly and shows nothing. The
    // operator's evidence for "the camera is broken" and for "the camera is
    // fine, the panel is behind" is the same black rectangle — and the two have
    // opposite correct responses.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus({
      viewfinderAttached: false,
      viewfinderNote: 'no preview surface was offered before start()',
    });
    await poll();

    expect(r.has('panoplus-viewfinder-note')).toBe(true);
    r.unmount();
  });

  it('says nothing when the feed is attached', async () => {
    // A live feed explains itself; a permanent caption over it is clutter.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus({
      viewfinderAttached: true,
      viewfinderNote: 'preview claimed at 1920x1080',
    });
    await poll();

    expect(r.has('panoplus-viewfinder-note')).toBe(false);
    r.unmount();
  });

  it('says nothing on a build that does not track it', async () => {
    // iOS, and every Android binary older than the field. ABSENCE OF AN ANSWER
    // IS NOT A FAILURE — a notice here would be permanent and false on the one
    // platform where the preview is proven.
    const r = mount();
    await settle();
    r.hold();
    await settle();
    statusReply = sweepingStatus();
    await poll();

    expect(r.has('panoplus-viewfinder-note')).toBe(false);
    r.unmount();
  });
});

describe('the memory budget crosses the bridge', () => {
  it('sends NOTHING extra on iOS, where the preview is proven', async () => {
    const r = mount();
    await settle();
    r.hold();
    await settle();
    expect(startedWith).not.toBeNull();
    expect(startedWith).not.toHaveProperty('previewMaxAlong');
    expect(startedWith).not.toHaveProperty('previewMaxCross');
    expect(startedWith).not.toHaveProperty('canvasMaxPixels');
    r.unmount();
  });

  it('bounds the preview and the canvas on Android', async () => {
    // The A35 idles at 733 MB RSS and has peaked at 1.33 GB. Native's own
    // defaults — a 2000x800 preview and an 18 MP canvas (72 MB steady, 126 MB
    // transient through a grow) — are a bet this phone should not be asked to
    // take on its first live sweep.
    Platform.OS = 'android';
    const r = mount();
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.previewMaxAlong).toBe(PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG);
    expect(startedWith?.previewMaxCross).toBe(PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS);
    expect(startedWith?.canvasMaxPixels).toBe(PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS);
    r.unmount();
  });
});
