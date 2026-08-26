// SPDX-License-Identifier: Apache-2.0
/**
 * Geometry tests for the AR absolute cross-pan drift guard.
 *
 * The load-bearing property is that a CLEAN PIVOT PAN reads ~0 no matter how
 * far it sweeps or how long the operator's arms are.  That is what the IMU
 * guard cannot do, and what the panorama/SCANS resolver got wrong (its `ratio`
 * reduces to `r/(r+0.10)`, so the pan angle cancels and every hand-held pan
 * looks like translation).  These tests synthesise real pivot arcs and assert
 * the arc contributes nothing.
 */

jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gravity: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: {
    accelerometer: 'accelerometer', gravity: 'gravity', gyroscope: 'gyroscope',
  },
}));

// eslint-disable-next-line import/first
import {
  _rotateByQuat, _lateralAxis, _lateralDriftMetres,
  _lateralRotationRad, _forwardOf,
  _freshArDriftState, _advanceArDrift,
  type Quat, type Vec3,
} from '../arLateralDrift';

/** Quaternion for a rotation of `rad` about a unit axis, packed [x,y,z,w]. */
function quat(axis: Vec3, rad: number): Quat {
  const h = rad / 2; const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
const IDENT: Quat = [0, 0, 0, 1];

describe('quaternion rotation', () => {
  it('leaves vectors alone under the identity', () => {
    const v = _rotateByQuat(IDENT, [1, 2, 3]);
    expect(v[0]).toBeCloseTo(1); expect(v[1]).toBeCloseTo(2); expect(v[2]).toBeCloseTo(3);
  });

  it('rotates +X onto -Z for a +90 deg yaw about world Y', () => {
    // Right-handed, Y up: +90 deg about +Y takes +X to -Z.
    const v = _rotateByQuat(quat([0, 1, 0], Math.PI / 2), [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0); expect(v[1]).toBeCloseTo(0); expect(v[2]).toBeCloseTo(-1);
  });

  it('preserves length', () => {
    const v = _rotateByQuat(quat([0.577, 0.577, 0.577], 1.1), [3, -4, 12]);
    expect(Math.hypot(...v)).toBeCloseTo(13);
  });
});

describe('cross-pan axis selection', () => {
  it("horizontal pans measure drift along world UP", () => {
    // A yaw sweep lies in the horizontal plane, so vertical is the axis it
    // cannot contaminate.
    expect(_lateralAxis(quat([0, 1, 0], 0.9), 'horizontal')).toEqual([0, 1, 0]);
  });

  it('vertical pans measure a HORIZONTAL axis, even when the phone is pitched', () => {
    // Pitch the camera 30 deg (a vertical sweep in progress).  The lateral
    // axis must stay perfectly horizontal.
    const axis = _lateralAxis(quat([1, 0, 0], Math.PI / 6), 'vertical')!;
    expect(axis).not.toBeNull();
    expect(axis[1]).toBeCloseTo(0);            // no vertical component
    expect(Math.hypot(...axis)).toBeCloseTo(1); // unit length
  });

  it('reports degeneracy rather than guessing when rolled on edge', () => {
    // Rolled 90 deg about the view axis: camera-right points at gravity, so
    // there is no horizontal projection to speak of.
    expect(_lateralAxis(quat([0, 0, 1], Math.PI / 2), 'vertical')).toBeNull();
  });
});

describe('a clean pivot pan reads ~zero drift', () => {
  /** Camera positions along an arc of radius `r` about a pivot behind the lens. */
  function arc(r: number, sweepRad: number, steps: number, mode: 'pitch' | 'yaw') {
    const out: Array<{ q: Quat; t: Vec3 }> = [];
    for (let i = 0; i <= steps; i++) {
      const a = (sweepRad * i) / steps;
      if (mode === 'yaw') {
        // Pivot about a point r behind the lens, rotating about world Y.
        out.push({ q: quat([0, 1, 0], a), t: [r * Math.sin(a), 0, r * (1 - Math.cos(a))] });
      } else {
        // Pitch: the arc lies in a VERTICAL plane (Y/Z), no X component.
        out.push({ q: quat([1, 0, 0], a), t: [0, r * Math.sin(a), r * (1 - Math.cos(a))] });
      }
    }
    return out;
  }

  it.each([0.15, 0.30, 0.60])(
    'vertical pan, pivot radius %s m — arc contributes no lateral drift',
    (r) => {
      const path = arc(r, 0.8, 40, 'pitch');
      const start = path[0];
      for (const p of path) {
        const d = _lateralDriftMetres(start.q, start.t, p.t, 'vertical')!;
        expect(Math.abs(d)).toBeLessThan(0.005);   // < 5 mm over the whole sweep
      }
    },
  );

  it.each([0.15, 0.30, 0.60])(
    'horizontal pan, pivot radius %s m — arc contributes no lateral drift',
    (r) => {
      const path = arc(r, 0.8, 40, 'yaw');
      const start = path[0];
      for (const p of path) {
        const d = _lateralDriftMetres(start.q, start.t, p.t, 'horizontal')!;
        expect(Math.abs(d)).toBeLessThan(0.005);
      }
    },
  );
});

describe('real lateral movement IS measured, at any speed', () => {
  it('a 30 cm sideways step reads 30 cm', () => {
    const d = _lateralDriftMetres(IDENT, [0, 0, 0], [0.30, 0, 0], 'vertical')!;
    expect(Math.abs(d)).toBeCloseTo(0.30, 3);
  });

  it('SLOW drift is caught — the case the IMU guard structurally cannot see', () => {
    // 25 cm over 20 s at 10 Hz.  Every IMU high-pass removes this; a position
    // measurement simply reports it.
    const s = _freshArDriftState();
    let now = 0; let latchedAt: number | null = null;
    for (let i = 0; i <= 200; i++) {
      const x = (0.25 * i) / 200;
      _advanceArDrift(s, IDENT, [x, 0, 0], 'normal', 'vertical', 0.15, 500, now);
      if (s.exceeded && latchedAt === null) latchedAt = now;
      now += 100;
    }
    expect(s.peakM).toBeCloseTo(0.25, 2);
    expect(latchedAt).not.toBeNull();
  });

  it('does not latch below budget however long the capture runs', () => {
    const s = _freshArDriftState();
    let now = 0;
    for (let i = 0; i <= 600; i++) {   // 60 s
      _advanceArDrift(s, IDENT, [0.10, 0, 0], 'normal', 'vertical', 0.15, 500, now);
      now += 100;
    }
    expect(s.exceeded).toBe(false);
  });
});

describe('tracking-state and seeding discipline', () => {
  it('does not seed the origin from a non-normal pose', () => {
    const s = _freshArDriftState();
    // Relocalising frames that jump metres — the shape a capture opens with,
    // because finalize restarts the AR session.
    _advanceArDrift(s, IDENT, [5, 5, 5], 'limited', 'vertical', 0.15, 500, 0);
    _advanceArDrift(s, IDENT, [9, 9, 9], 'notAvailable', 'vertical', 0.15, 500, 100);
    expect(s.startT).toBeNull();
    expect(s.untrackedCount).toBe(2);
    // First trusted frame becomes the origin, so no phantom drift at t=0.
    _advanceArDrift(s, IDENT, [1, 0, 0], 'normal', 'vertical', 0.15, 500, 200);
    expect(s.startT).toEqual([1, 0, 0]);
    expect(s.peakM).toBe(0);
  });

  it('budget <= 0 keeps measuring but never latches', () => {
    const s = _freshArDriftState();
    let now = 0;
    for (let i = 0; i <= 50; i++) {
      _advanceArDrift(s, IDENT, [i * 0.02, 0, 0], 'normal', 'vertical', 0, 500, now);
      now += 100;
    }
    expect(s.peakM).toBeGreaterThan(0.9);   // still tracked
    expect(s.exceeded).toBe(false);          // but disabled
  });

  it('a degenerate roll is counted, not silently treated as zero drift', () => {
    const s = _freshArDriftState();
    const rolled = quat([0, 0, 1], Math.PI / 2);
    _advanceArDrift(s, rolled, [0, 0, 0], 'normal', 'vertical', 0.15, 500, 0);
    _advanceArDrift(s, rolled, [9, 0, 0], 'normal', 'vertical', 0.15, 500, 100);
    expect(s.degenerateCount).toBe(1);
    expect(s.exceeded).toBe(false);
  });
});

/**
 * ABSOLUTE cross-pan ROTATION — the slow-pivot hole.
 *
 * The gyro trigger is a RATE gate (0.15 rad/s = 8.6 deg/s), so a slow pivot
 * never trips it however far it turns: 6 deg/s reaches 90 DEGREES of yaw in
 * 15 s and stays under threshold the whole time.  Pose-derived angle has no
 * such blind spot — it measures how far you HAVE turned, not how fast.
 */
describe('absolute cross-pan rotation', () => {
  function quat2(axis: Vec3, rad: number): Quat {
    const h = rad / 2; const s = Math.sin(h);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
  }
  const I: Quat = [0, 0, 0, 1];

  it('the intended SWEEP contributes no lateral rotation, at any extent', () => {
    // Vertical mode: pitching is the sweep.  Pitch far and lateral stays ~0.
    for (const deg of [10, 30, 60, 80]) {
      const q = quat2([1, 0, 0], (deg * Math.PI) / 180);
      expect(Math.abs(_lateralRotationRad(I, q, 'vertical'))).toBeLessThan(0.02);
    }
    // Horizontal mode: yawing is the sweep.
    for (const deg of [10, 45, 90, 150]) {
      const q = quat2([0, 1, 0], (deg * Math.PI) / 180);
      expect(Math.abs(_lateralRotationRad(I, q, 'horizontal'))).toBeLessThan(0.02);
    }
  });

  it('a sideways PIVOT is measured, in the mode where it is lateral', () => {
    const yaw30 = quat2([0, 1, 0], Math.PI / 6);
    const r = _lateralRotationRad(I, yaw30, 'vertical');
    expect(Math.abs(r * 180 / Math.PI)).toBeCloseTo(30, 0);
  });

  it('ROLL about the view axis contributes nothing', () => {
    // Roll is what corrupted the accelerometer guard; it must not be
    // double-counted here.  It does not change where the camera POINTS.
    for (const deg of [10, 30, 60]) {
      const q = quat2([0, 0, 1], (deg * Math.PI) / 180);
      expect(Math.abs(_lateralRotationRad(I, q, 'vertical'))).toBeLessThan(0.02);
    }
  });

  it('catches a SLOW pivot the rate gate cannot see', () => {
    // 6 deg/s for 15 s = 90 deg of yaw.  crossEma peaks at 0.105 rad/s,
    // permanently under the 0.15 threshold, so the gyro trigger never fires.
    const s = _freshArDriftState();
    let now = 0; let latchedAt: number | null = null;
    const budgetRad = (25 * Math.PI) / 180;
    for (let i = 0; i <= 150; i++) {
      const deg = 6 * (i / 10);               // 10 Hz
      const q = quat2([0, 1, 0], (deg * Math.PI) / 180);
      _advanceArDrift(s, q, [0, 0, 0], 'normal', 'vertical', 0.08, 500, now, budgetRad);
      if (s.exceeded && latchedAt === null) latchedAt = now;
      now += 100;
    }
    expect(s.peakRotRad * 180 / Math.PI).toBeCloseTo(90, 0);
    expect(latchedAt).not.toBeNull();
    expect(s.latchedBy).toBe('rotation');     // and it says WHICH channel
  });

  it('reports drift vs rotation separately — they have different remedies', () => {
    const s = _freshArDriftState();
    let now = 0;
    for (let i = 0; i <= 60; i++) {
      _advanceArDrift(s, I, [0.006 * i, 0, 0], 'normal', 'vertical',
                      0.08, 500, now, (25 * Math.PI) / 180);
      now += 100;
    }
    expect(s.exceeded).toBe(true);
    expect(s.latchedBy).toBe('drift');
  });

  it('rotBudget <= 0 keeps measuring but never latches on rotation', () => {
    const s = _freshArDriftState();
    let now = 0;
    for (let i = 0; i <= 100; i++) {
      const q = quat2([0, 1, 0], (i * Math.PI) / 180);   // up to 100 deg
      _advanceArDrift(s, q, [0, 0, 0], 'normal', 'vertical', 0.08, 500, now, 0);
      now += 100;
    }
    expect(s.peakRotRad * 180 / Math.PI).toBeGreaterThan(80);
    expect(s.exceeded).toBe(false);
  });
});
