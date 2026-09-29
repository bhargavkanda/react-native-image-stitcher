// SPDX-License-Identifier: Apache-2.0
//
// panoPlusAndroid — the module resolver and the envelope every entry returns.
//
// What these pin, and the failure each one prevents:
//
//   1. DEGRADATION, NOT CRASH. iOS, a jest env, and an Android build whose
//      autolinking did not pick the package up all have no
//      `RNSSweepTools`. Every entry must resolve into something the
//      panel can render. The panel is the ONLY instrument this device-less
//      port has; one that can crash is one that is unavailable exactly when it
//      is needed.
//   2. THE RAW JSON SURVIVES. The native reports carry ~70 fields and the
//      operator reads them off a desk after pulling them with adb. A mapper
//      that kept only what it understood would make the instrument report less
//      than it measured — the `poseSource` incident in panoPlusNative.ts is
//      this exact mistake, already paid for once.
//   3. UNPARSEABLE ≠ SILENT. Malformed JSON is most likely under memory
//      pressure, i.e. when the answer matters most. It must be REPORTED, with
//      the raw string kept.
//   4. PER-METHOD PROBING. A module object existing is not evidence its
//      methods are linked (the standing typeof-probe rule).
//   5. `start` REJECTS, `stop` NEVER DOES. A permission failure the operator
//      must act on must not be laundered into a resolved envelope; a stop that
//      can reject leaves the camera open with the UI believing it closed.

import { NativeModules } from 'react-native';

import {
  panoPlusAndroidArCoreBasisRun,
  panoPlusAndroidDeriveBasis,
  panoPlusAndroidEngineInfo,
  panoPlusAndroidIsAvailable,
  panoPlusAndroidMeasureSensorRates,
  panoPlusAndroidProbe,
  panoPlusAndroidRecordingStatus,
  panoPlusAndroidReplayPack,
  panoPlusAndroidStartRecording,
  panoPlusAndroidStopRecording,
  panoPlusAndroidUnavailableReason,
} from '../panoPlusAndroid';

const NM = NativeModules as Record<string, unknown>;

/** A module whose three probed methods exist, with overridable behaviour. */
function fakeModule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engineInfo: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: '{}' })),
    deriveBasis: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: '{}' })),
    arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: '{}' })),
    replayPack: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: '{}' })),
    probe: jest.fn(() => Promise.resolve({ ok: true })),
    measureSensorRates: jest.fn(() => Promise.resolve({ ok: true })),
    startRecording: jest.fn(() => Promise.resolve({ sessionDir: '/d' })),
    stopRecording: jest.fn(() => Promise.resolve({ wasRecording: true })),
    recordingStatus: jest.fn(() => Promise.resolve({ running: true })),
    ...over,
  };
}

afterEach(() => {
  delete NM.RNSSweepTools;
  jest.clearAllMocks();
});

describe('availability', () => {
  it('is false with no module linked', () => {
    expect(panoPlusAndroidIsAvailable()).toBe(false);
  });

  it('resolves per CALL, not per import', () => {
    expect(panoPlusAndroidIsAvailable()).toBe(false);
    NM.RNSSweepTools = fakeModule();
    expect(panoPlusAndroidIsAvailable()).toBe(true);
  });

  it('rejects a module object whose methods are missing', () => {
    // A registered-but-unlinked module is the failure a bare null check misses.
    NM.RNSSweepTools = { engineInfo: () => Promise.resolve({}) };
    expect(panoPlusAndroidIsAvailable()).toBe(false);
  });

  it('names the platform rather than blaming the build, off Android', () => {
    // The jest RN mock reports iOS. "Wrong platform" and "Android but the
    // module did not register" are different faults: the second is a BUILD
    // problem, and rendering both as "unavailable" is how a broken Android
    // build gets mistaken for an iPhone.
    const reason = panoPlusAndroidUnavailableReason();
    expect(reason).toContain('Android-only');
    expect(reason).toContain('ios');
  });

  it('has no reason once the module is there', () => {
    NM.RNSSweepTools = fakeModule();
    expect(panoPlusAndroidUnavailableReason()).toBeNull();
  });
});

describe('unavailable degradation', () => {
  it('every diagnostic entry resolves with a parseable envelope', async () => {
    const results = await Promise.all([
      panoPlusAndroidEngineInfo(),
      panoPlusAndroidDeriveBasis({ sensorOrientationDeg: 90 }),
      panoPlusAndroidReplayPack({ packDir: '/p' }),
    ]);
    for (const r of results) {
      expect(r.nativeAvailable).toBe(false);
      expect(typeof r.loadError).toBe('string');
      // The envelope must carry JSON on EVERY path so a missing .so cannot be
      // mistaken for a corrupt report.
      expect(() => JSON.parse(r.json)).not.toThrow();
    }
  });

  it('probe and sensor rates resolve null rather than throwing', async () => {
    await expect(panoPlusAndroidProbe()).resolves.toBeNull();
    await expect(panoPlusAndroidMeasureSensorRates(1000)).resolves.toBeNull();
  });

  it('stop and status resolve the not-running shape', async () => {
    await expect(panoPlusAndroidStopRecording()).resolves.toEqual({ wasRecording: false });
    await expect(panoPlusAndroidRecordingStatus()).resolves.toEqual({ running: false });
  });

  it('start REJECTS with a classifiable code', async () => {
    // Unlike the diagnostics, a failed start is something the operator must
    // act on. Laundering it into a resolved envelope makes a permission
    // problem look like a hardware one.
    await expect(panoPlusAndroidStartRecording()).rejects.toMatchObject({
      code: 'panoplus-android-unavailable',
    });
  });
});

describe('engineInfo', () => {
  it('narrows the self-test fields and keeps the raw json', async () => {
    const json = JSON.stringify({
      ok: true,
      engineVersion: 13,
      outcomeProbe: 'painted',
      basisCandidateCount: 24,
      basisSelfTestIndex: 8,
      basisSelfTestExpected: 8,
      basisSelfTestPassed: true,
      somethingTheMapperDoesNotKnow: 'kept',
    });
    NM.RNSSweepTools = fakeModule({
      engineInfo: jest.fn(() => Promise.resolve({ nativeAvailable: true, json })),
    });

    const r = await panoPlusAndroidEngineInfo();
    expect(r.nativeAvailable).toBe(true);
    expect(r.engineVersion).toBe(13);
    expect(r.outcomeProbe).toBe('painted');
    expect(r.basisSelfTestPassed).toBe(true);
    // THE FIELD THE MAPPER DOES NOT KNOW MUST SURVIVE — both in the raw string
    // and in `parsed`.
    expect(r.json).toBe(json);
    expect(r.parsed?.somethingTheMapperDoesNotKnow).toBe('kept');
  });

  it('reports a failed basis self-test rather than defaulting it true', async () => {
    // A device answering anything but 8 has a toolchain difference the host
    // tests cannot see. `undefined` from a partial build must not read as pass.
    NM.RNSSweepTools = fakeModule({
      engineInfo: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        json: '{"basisSelfTestIndex":11,"basisSelfTestExpected":8,"basisSelfTestPassed":false}',
      })),
    });
    const r = await panoPlusAndroidEngineInfo();
    expect(r.basisSelfTestPassed).toBe(false);
    expect(r.basisSelfTestIndex).toBe(11);
  });

  it('reports unparseable JSON and still keeps the raw string', async () => {
    NM.RNSSweepTools = fakeModule({
      engineInfo: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        json: '{"truncated":',
      })),
    });
    const r = await panoPlusAndroidEngineInfo();
    expect(r.parsed).toBeNull();
    expect(r.error).toContain('parse');
    expect(r.json).toBe('{"truncated":');
  });

  it('turns a bridge rejection into an envelope instead of throwing', async () => {
    NM.RNSSweepTools = fakeModule({
      engineInfo: jest.fn(() => Promise.reject(new Error('boom'))),
    });
    const r = await panoPlusAndroidEngineInfo();
    expect(r.nativeAvailable).toBe(false);
    expect(r.error).toBe('boom');
    expect(() => JSON.parse(r.json)).not.toThrow();
  });
});

describe('deriveBasis', () => {
  it('sends only the keys the caller chose', async () => {
    const mod = fakeModule();
    NM.RNSSweepTools = mod;
    await panoPlusAndroidDeriveBasis({
      sensorOrientationDeg: 90,
      lensFacing: 1,
      mirrored: undefined,
    });
    const sent = (mod.deriveBasis as jest.Mock).mock.calls[0][0];
    expect(sent).toEqual({ sensorOrientationDeg: 90, lensFacing: 1 });
    // `undefined` must not cross as a key: native distinguishes "absent" from
    // a supplied value, and sensorOrientationDeg's absence is a REFUSAL case.
    expect('mirrored' in sent).toBe(false);
  });

  it('does not strip an explicit false', async () => {
    const mod = fakeModule();
    NM.RNSSweepTools = mod;
    await panoPlusAndroidDeriveBasis({ sensorOrientationDeg: 0, mirrored: false });
    expect((mod.deriveBasis as jest.Mock).mock.calls[0][0]).toEqual({
      sensorOrientationDeg: 0,
      mirrored: false,
    });
  });

  it('surfaces a refusal with its name, not as a silent failure', async () => {
    NM.RNSSweepTools = fakeModule({
      deriveBasis: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        json: '{"ok":false,"basisIndex":-1,"refusal":"mirrored-buffer-is-a-reflection"}',
      })),
    });
    const r = await panoPlusAndroidDeriveBasis({ sensorOrientationDeg: 90, mirrored: true });
    expect(r.ok).toBe(false);
    expect(r.basisIndex).toBe(-1);
    expect(r.refusal).toBe('mirrored-buffer-is-a-reflection');
  });

  it('carries lensPoseSupplied so an absent block is not read as a refusal', async () => {
    NM.RNSSweepTools = fakeModule({
      deriveBasis: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        lensPoseSupplied: false,
        json: '{"ok":true,"basisIndex":8,"haveLensPose":false}',
      })),
    });
    const r = await panoPlusAndroidDeriveBasis({ sensorOrientationDeg: 90 });
    expect(r.lensPoseSupplied).toBe(false);
    expect(r.basisIndex).toBe(8);
  });
});

describe('replayPack', () => {
  it('forwards the options and narrows the throughput answer', async () => {
    const json = JSON.stringify({
      ok: true,
      framesIngested: 412,
      msP50: 7.5,
      msP95: 19.2,
      painted: 380,
      holes: 0,
      haveOracle: true,
      outcomeAgree: 400,
      outcomeDisagree: 12,
    });
    const mod = fakeModule({
      replayPack: jest.fn(() => Promise.resolve({
        nativeAvailable: true, json, wallMs: 41234,
      })),
    });
    NM.RNSSweepTools = mod;

    const r = await panoPlusAndroidReplayPack({
      packDir: '/sdcard/pack',
      maxFrames: 50,
      configOverrides: { d8JogGuard: true },
    });
    expect((mod.replayPack as jest.Mock).mock.calls[0][0]).toEqual({
      packDir: '/sdcard/pack',
      maxFrames: 50,
      configOverrides: { d8JogGuard: true },
    });
    expect(r.msP50).toBe(7.5);
    expect(r.framesIngested).toBe(412);
    expect(r.wallMs).toBe(41234);
  });

  it('keeps haveOracle false distinct from zero disagreement', async () => {
    // NOT MEASURED must never render as agreement. A pack with no ledger has
    // outcomeDisagree 0 for the trivial reason that nothing was compared.
    NM.RNSSweepTools = fakeModule({
      replayPack: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        json: '{"ok":true,"haveOracle":false,"outcomeAgree":0,"outcomeDisagree":0}',
      })),
    });
    const r = await panoPlusAndroidReplayPack({ packDir: '/p' });
    expect(r.haveOracle).toBe(false);
    expect(r.outcomeDisagree).toBe(0);
  });

  it('keeps every unmapped report field in parsed', async () => {
    NM.RNSSweepTools = fakeModule({
      replayPack: jest.fn(() => Promise.resolve({
        nativeAvailable: true,
        json: '{"ok":true,"fidelityNote":"jpeg vs nv12","firstDivergenceSeq":91}',
      })),
    });
    const r = await panoPlusAndroidReplayPack({ packDir: '/p' });
    expect(r.parsed?.fidelityNote).toBe('jpeg vs nv12');
    expect(r.parsed?.firstDivergenceSeq).toBe(91);
  });
});

describe('recorder passthrough', () => {
  it('start forwards options and resolves the native map', async () => {
    const mod = fakeModule();
    NM.RNSSweepTools = mod;
    await expect(panoPlusAndroidStartRecording({ jpegQuality: 88, cameraId: undefined }))
      .resolves.toEqual({ sessionDir: '/d' });
    expect((mod.startRecording as jest.Mock).mock.calls[0][0]).toEqual({ jpegQuality: 88 });
  });

  it('start propagates a native rejection (permission is actionable)', async () => {
    NM.RNSSweepTools = fakeModule({
      startRecording: jest.fn(() => Promise.reject(new Error('permission-denied'))),
    });
    await expect(panoPlusAndroidStartRecording()).rejects.toThrow('permission-denied');
  });

  it('stop resolves even when native rejects', async () => {
    NM.RNSSweepTools = fakeModule({
      stopRecording: jest.fn(() => Promise.reject(new Error('camera gone'))),
    });
    const r = await panoPlusAndroidStopRecording();
    expect(r.wasRecording).toBe(false);
    expect(r.error).toBe('camera gone');
  });

  it('status resolves not-running when native rejects', async () => {
    NM.RNSSweepTools = fakeModule({
      recordingStatus: jest.fn(() => Promise.reject(new Error('nope'))),
    });
    await expect(panoPlusAndroidRecordingStatus()).resolves.toEqual({ running: false });
  });

  it('probe resolves the tree as-is, without narrowing it', async () => {
    const tree = { device: { model: 'SM-A356B' }, cameras: [{ id: '0' }] };
    NM.RNSSweepTools = fakeModule({
      probe: jest.fn(() => Promise.resolve(tree)),
    });
    await expect(panoPlusAndroidProbe()).resolves.toEqual(tree);
  });
});

describe('arcoreBasisRun', () => {
  /** A pack whose reference series measured basis 8 and whose derivation said
   *  the same — the shape the S1 runner emits (cpp/rnis_pano_android_s1). */
  const agreeing = JSON.stringify({
    ok: true,
    reason: 'ok',
    sensorsFound: true,
    arcoreFound: true,
    report: {
      basisVerdict: {
        ok: true, index: 8, label: '-y+x+z', unique: true,
        marginDeg: 12.4, rmsDeg: 0.41, pairs: 178, runnerUpIndex: 20,
      },
      agreement: {
        compared: true, agree: true, withheld: '',
        relativeAngleDeg: 0, diagnosis: 'agree',
      },
      excitation: {
        verdict: {
          sufficient: true, reason: 'ok', exercisedAxes: 3,
          needMore: [
            { axis: 'tilt', needMore: false, deg: 61 },
            { axis: 'pan', needMore: false, deg: 140 },
            { axis: 'roll', needMore: false, deg: 44 },
          ],
        },
      },
    },
  });

  it('narrows the measurement, the falsification and the coaching', async () => {
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({
        nativeAvailable: true, json: agreeing, derivedIndexSupplied: true,
      })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p', derivedBasisIndex: 8 });
    expect(r.ok).toBe(true);
    expect(r.measuredIndex).toBe(8);
    expect(r.measuredLabel).toBe('-y+x+z');
    expect(r.unique).toBe(true);
    expect(r.runnerUpIndex).toBe(20);
    expect(r.agreementCompared).toBe(true);
    expect(r.agree).toBe(true);
    expect(r.excitationSufficient).toBe(true);
    expect(r.needMoreAxes).toEqual([]);
    expect(r.derivedIndexSupplied).toBe(true);
    // The raw report survives whole — the S1 payload is ~60 fields and the
    // operator reads it off a desk.
    expect(r.json).toBe(agreeing);
  });

  it('renders a 4-way tie as NOT compared, never as agreement', async () => {
    // The documented single-axis degeneracy. `ranked[0]` exists and is an
    // arbitrary member of the tie; a panel that showed it beside the derived
    // index would manufacture a falsification that never happened.
    const tie = JSON.stringify({
      ok: false,
      reason: 'ambiguous-axis',
      sensorsFound: true,
      arcoreFound: true,
      report: {
        basisVerdict: { ok: false, index: 20, unique: false, pairs: 178 },
        agreement: { compared: false, withheld: 'measured-winner-not-unique' },
        excitation: {
          verdict: {
            sufficient: false, reason: 'single-axis', exercisedAxes: 1,
            needMore: [
              { axis: 'tilt', needMore: true, deg: 2 },
              { axis: 'pan', needMore: false, deg: 140 },
              { axis: 'roll', needMore: true, deg: 1 },
            ],
          },
        },
      },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: tie })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p', derivedBasisIndex: 8 });
    expect(r.unique).toBe(false);
    expect(r.agreementCompared).toBe(false);
    expect(r.agree).toBeUndefined();
    expect(r.agreementWithheld).toBe('measured-winner-not-unique');
    // …and the panel is told exactly which axes to coach.
    expect(r.needMoreAxes).toEqual(['tilt', 'roll']);
  });

  it('distinguishes a pack with no sidecar from a failed measurement', async () => {
    // The COMMON case: the reference channel is off by default. Rendering it
    // as a failure would make the port look broken on every ordinary pack.
    const none = JSON.stringify({
      ok: false, reason: 'arcore-jsonl-missing', sensorsFound: true, arcoreFound: false,
      report: { series: { imu: { accepted: 1204 } } },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: none })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.arcoreFound).toBe(false);
    expect(r.sensorsFound).toBe(true);
    expect(r.reason).toBe('arcore-jsonl-missing');
    expect(r.measuredIndex).toBeUndefined();
  });

  it('drops undefined options rather than sending them across the bridge', async () => {
    const spy = jest.fn(() => Promise.resolve({ nativeAvailable: true, json: '{}' }));
    NM.RNSSweepTools = fakeModule({ arcoreBasisRun: spy });
    await panoPlusAndroidArCoreBasisRun({
      packDir: '/p', imuType: undefined, derivedBasisIndex: 8,
    });
    expect(spy).toHaveBeenCalledWith({ packDir: '/p', derivedBasisIndex: 8 });
  });

  it('survives a native payload that is not an object at any level', async () => {
    // Every level of the S1 report can be absent on a refusal path, and a
    // diagnostic panel that throws on one is unavailable exactly when it is
    // needed.
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({
        nativeAvailable: true, json: '{"ok":false,"report":null}',
      })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.ok).toBe(false);
    expect(r.measuredIndex).toBeUndefined();
    expect(r.needMoreAxes).toEqual([]);
  });

  it('is unavailable-but-parseable when the method is not linked', async () => {
    // An older native half that has every OTHER entry: the per-method probe is
    // what stops that reading as a crash.
    NM.RNSSweepTools = fakeModule({ arcoreBasisRun: undefined });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.nativeAvailable).toBe(false);
    expect(() => JSON.parse(r.json)).not.toThrow();
  });
});

describe('arcoreBasisRun — series counts', () => {
  it('an empty reference series is reported as such, not as a bad gesture', async () => {
    // ⚠ THE MISATTRIBUTION THIS PINS. An empty reference series ALSO makes
    // excitationReason read `too-few-samples`, so a caller that checks
    // excitation first renders "the gesture cannot identify a basis" for a
    // pack whose real fault was that ARCore never tracked — measured on the
    // A35: 850 pose rows, 0 of them TRACKING, all INSUFFICIENT_LIGHT. The
    // counts have to reach the caller so it can tell the two apart.
    const empty = JSON.stringify({
      ok: false,
      reason: 'no-reference-samples',
      sensorsFound: true,
      arcoreFound: true,
      report: {
        series: {
          imu: { accepted: 3722, linesTotal: 7443, wrongType: 3721 },
          reference: { accepted: 0, linesTotal: 850, wrongType: 850 },
        },
        excitation: { verdict: { sufficient: false, reason: 'too-few-samples' } },
      },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: empty })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.reason).toBe('no-reference-samples');
    expect(r.arcoreFound).toBe(true);
    expect(r.refLinesTotal).toBe(850);
    expect(r.refRowsAccepted).toBe(0);
    expect(r.refRowsWrongType).toBe(850);
    expect(r.imuRowsAccepted).toBe(3722);
    // The excitation verdict is still present and still says too-few-samples —
    // which is why the counts, not that field, must drive the headline.
    expect(r.excitationSufficient).toBe(false);
    expect(r.excitationReason).toBe('too-few-samples');
  });
});

describe('arcoreBasisRun — the clock the fit was made under', () => {
  // The run joins sensors.jsonl (SensorEvent.timestamp) to
  // attitude_arcore.jsonl (Camera2 SENSOR_TIMESTAMP) at tau = 0, and 0 is right
  // only on the elapsedRealtime clock. Native reads
  // device.json -> clocks.cameraTimestampSource; if the SDK drops it on the
  // floor the caller renders a confident measured index with no way to know
  // what it was fitted across.
  it('surfaces a confirmed REALTIME clock', async () => {
    const js = JSON.stringify({
      ok: true,
      reason: 'ok',
      sensorsFound: true,
      arcoreFound: true,
      deviceJsonFound: true,
      cameraTimestampSource: 'REALTIME',
      clockAssumption: 'confirmed-realtime',
      report: { basisVerdict: { index: 8, unique: true } },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: js })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.clockAssumption).toBe('confirmed-realtime');
    expect(r.cameraTimestampSource).toBe('REALTIME');
    expect(r.deviceJsonFound).toBe(true);
  });

  it('surfaces a clock that was NOT confirmed rather than defaulting it', async () => {
    const js = JSON.stringify({
      ok: true,
      reason: 'ok',
      sensorsFound: true,
      arcoreFound: true,
      deviceJsonFound: true,
      cameraTimestampSource: 'UNKNOWN',
      clockAssumption: 'not-realtime',
      report: { basisVerdict: { index: 8, unique: true } },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: js })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.clockAssumption).toBe('not-realtime');
    expect(r.cameraTimestampSource).toBe('UNKNOWN');
    // The measured index still reaches the caller — the caveat is provenance,
    // not a refusal.
    expect(r.measuredIndex).toBe(8);
  });

  it('a pack with no device.json reports unconfirmed, never REALTIME', async () => {
    const js = JSON.stringify({
      ok: true,
      reason: 'ok',
      sensorsFound: true,
      arcoreFound: true,
      deviceJsonFound: false,
      cameraTimestampSource: '',
      clockAssumption: 'unconfirmed',
      report: { basisVerdict: { index: 8, unique: true } },
    });
    NM.RNSSweepTools = fakeModule({
      arcoreBasisRun: jest.fn(() => Promise.resolve({ nativeAvailable: true, json: js })),
    });
    const r = await panoPlusAndroidArCoreBasisRun({ packDir: '/p' });
    expect(r.clockAssumption).toBe('unconfirmed');
    expect(r.deviceJsonFound).toBe(false);
  });
});
