// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review (20) — THE SETTINGS GEAR OPENS THE SETTINGS MODAL ON BOTH ENGINES.
 *
 * `<Camera>` has two gears, and which one is drawn depends on `headerTitle`:
 *
 *   headerTitle | showSettingsButton | gear drawn                         | press
 *   ------------+--------------------+------------------------------------+-------------------
 *   unset       | true               | standalone `SettingsButton`         | modal visible
 *   set         | true               | `CaptureHeader`'s `onSettingsPress` | modal visible
 *   unset       | false              | none                               | —
 *   set         | false              | none (the header draws a spacer)   | —
 *
 * Before M8 the sweep engine returned its own screen early, so none of this
 * existed there. Now both engines share one tree and one gear, and the modal
 * is told which engine it is tuning (M8f: its keyframe-only sections give way
 * to a note on the sweep). This suite pins that the gear is REACHABLE and
 * WORKS on every engine × chrome × capture-source cell: pressing it flips
 * `<PanoramaSettingsModal visible>` from false to true, the modal's `engine`
 * is the selected one, and its `onClose` puts it away again.
 *
 * ⚑ NEGATIVE CONTROL: `showSettingsButton={false}` draws no gear on either
 * engine or chrome, and the modal stays hidden.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Documents/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: () => Promise.resolve(),
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
}), { virtual: true });

import { Camera } from '../Camera';
import { PanoramaSettingsModal } from '../PanoramaSettingsModal';

type Engine = 'keyframe' | 'sweep';
type Source = 'ar' | 'non-ar';
type Chrome = 'SettingsButton' | 'CaptureHeader';

/** The accessibility label each gear carries — the only public handle on it. */
const GEAR_LABEL: Record<Chrome, string> = {
  SettingsButton: 'Open camera settings',
  CaptureHeader: 'Open panorama settings',
};

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount(engine: Engine, source: Source, chrome: Chrome, showSettingsButton: boolean) {
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Camera
        engine={engine}
        defaultCaptureSource={source}
        captureSources="both"
        enablePanoramaMode
        panMode="both"
        rectCrop={false}
        showSettingsButton={showSettingsButton}
        headerTitle={chrome === 'CaptureHeader' ? 'Aisle 4' : undefined}
      />,
    );
  });
  await settle();
  return t;
}

/** Every pressable gear on screen, of either kind. */
const gears = (t: ReactTestRenderer) => t.root.findAll(
  // `Pressable` is a host string in the render project's RN mock.
  (n) => (n.type as unknown) === 'Pressable'
    &&(n.props.accessibilityLabel === GEAR_LABEL.SettingsButton
      || n.props.accessibilityLabel === GEAR_LABEL.CaptureHeader),
);
const modal = (t: ReactTestRenderer) => t.root.findByType(PanoramaSettingsModal);

const CELLS: Array<{ engine: Engine; source: Source; chrome: Chrome }> = [];
for (const engine of ['keyframe', 'sweep'] as const) {
  for (const chrome of ['SettingsButton', 'CaptureHeader'] as const) {
    for (const source of ['non-ar', 'ar'] as const) CELLS.push({ engine, source, chrome });
  }
}

describe('M8 review (20) — the gear opens <PanoramaSettingsModal> on both engines', () => {
  for (const { engine, source, chrome } of CELLS) {
    it(`${engine} / ${source} / ${chrome}: one gear, and pressing it shows the modal`, async () => {
      const t = await mount(engine, source, chrome, true);
      // Exactly ONE gear, and it is this chrome's (the header absorbs the
      // standalone one; the two never stack).
      const found = gears(t);
      expect(found).toHaveLength(1);
      expect(found[0].props.accessibilityLabel).toBe(GEAR_LABEL[chrome]);
      expect(modal(t).props.visible).toBe(false);

      act(() => { found[0].props.onPress(); });
      expect(modal(t).props.visible).toBe(true);
      // The modal is tuning the SELECTED engine (M8f).
      expect(modal(t).props.engine).toBe(engine);

      act(() => { modal(t).props.onClose(); });
      expect(modal(t).props.visible).toBe(false);
      act(() => { t.unmount(); });
    });
  }

  describe('⚑ NEGATIVE CONTROL — showSettingsButton={false} draws no gear', () => {
    for (const engine of ['keyframe', 'sweep'] as const) {
      for (const chrome of ['SettingsButton', 'CaptureHeader'] as const) {
        it(`${engine} / ${chrome}: no gear, modal hidden`, async () => {
          const t = await mount(engine, 'non-ar', chrome, false);
          expect(gears(t)).toHaveLength(0);
          expect(modal(t).props.visible).toBe(false);
          act(() => { t.unmount(); });
        });
      }
    }
  });
});
