// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — the settings modal knows the engine. Its frame-selection and stitcher
 * sections tune the KEYFRAME engine only; on the sweep they would be switches
 * that change nothing, so they give way to one line saying where the sweep's
 * options live. Debug applies to both.
 */
import React from 'react';
import { act, create } from 'react-test-renderer';

import { PanoramaSettingsModal } from '../PanoramaSettingsModal';
import { DEFAULT_PANORAMA_SETTINGS } from '../PanoramaSettings';

const texts = (engine: 'keyframe' | 'sweep'): string[] => {
  let t!: ReturnType<typeof create>;
  act(() => {
    t = create(
      <PanoramaSettingsModal
        visible
        settings={DEFAULT_PANORAMA_SETTINGS}
        onChange={() => undefined}
        onClose={() => undefined}
        engine={engine}
      />,
    );
  });
  const out = t.root.findAll((n) => typeof n.props?.title === 'string').map((n) => n.props.title as string);
  if (t.root.findAll((n) => n.props?.testID === 'settings-sweep-note').length > 0) out.push('#sweep-note');
  act(() => { t.unmount(); });
  return out;
};

describe('PanoramaSettingsModal — engine (M8)', () => {
  it('the keyframe engine gets its frame-selection and stitcher knobs', () => {
    const k = texts('keyframe');
    expect(k).toContain('Frame selection (KeyframeGate)');
    expect(k).toContain('Stitcher (cv::Stitcher knobs)');
    expect(k).not.toContain('#sweep-note');
  });
  it('⚑ the sweep gets the note instead — and keeps Debug', () => {
    const s = texts('sweep');
    expect(s).not.toContain('Frame selection (KeyframeGate)');
    expect(s).not.toContain('Stitcher (cv::Stitcher knobs)');
    expect(s).toContain('#sweep-note');
    expect(s).toContain('Debug');
  });
});
