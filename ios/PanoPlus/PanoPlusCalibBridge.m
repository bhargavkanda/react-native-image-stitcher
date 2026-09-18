// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusCalibBridge.m
//
// RN bridge declaration for the Swift `PanoPlusCalibBridge`
// (@objc(RNSSweepCalibration)).  Same pattern as this pod's PanoPlusBridge.m and
// StitchPluginsBridge.m: without this file the JS side's
// `NativeModules.RNSSweepCalibration` would resolve to `undefined`, because RN's
// module map is populated by RCT_EXTERN_* macros, not by Swift @objc decorators
// alone.
//
// DELIBERATELY a third module rather than more methods on `RNSSweepSession`:
// a calibration is a different lifecycle from a sweep (gesture → reduction →
// verdict → a decision about whether to KEEP the number), and a host can probe
// for it with a plain
// `typeof NativeModules.RNSSweepCalibration?.startBasisCalibration === 'function'`
// — which is how a build that has not been re-podded announces itself instead
// of failing at the first call.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RNSSweepCalibration, NSObject)

// ── The basis gesture ─────────────────────────────────────────────────────
// Requires the AR camera to be MOUNTED (the reference is the same
// `RNISARFrameContext.poseRotation` the engine consumes) and refuses while a
// pano+ sweep is running.
RCT_EXTERN_METHOD(startBasisCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// The live coaching read — per-axis turning, what is still missing, and how
// far along the gesture is.  Cached; poll it at a few Hz.
RCT_EXTERN_METHOD(basisCalibrationStatus:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Stop and SOLVE.  options: { tauS? }.
RCT_EXTERN_METHOD(stopBasisCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Re-reduce the SAME recording at a different tau, with no new gesture.
RCT_EXTERN_METHOD(resolveBasisCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(discardBasisCalibration:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// ── tau ───────────────────────────────────────────────────────────────────
// Combine repeated capture-clock measurements into one number WITH a stated
// uncertainty.  The gate is the STANDARD ERROR, never |tau|.
RCT_EXTERN_METHOD(combineTauRuns:(NSArray *)runs
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(calibrationPolicy:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// The lens + format an IMU sweep WOULD open on this body, and the tau key that
// follows from it.  `ok:false` carries the hardware reason instead.  Opens no
// capture session, so it is safe to call while ARKit holds the camera.
RCT_EXTERN_METHOD(plannedCaptureFormat:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// ── Persistence ───────────────────────────────────────────────────────────
// getCalibration options: { lens?, width?, height?, fps? } — the tau key parts.
RCT_EXTERN_METHOD(getCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// saveTauCalibration options: { fit, lens?, width?, height?, fps?, extra? }.
// REJECTS `calibration-not-persistable` when the fit did not pass its own gate.
RCT_EXTERN_METHOD(saveTauCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// saveBasisCalibration options: { solve, extra? }.  Same refusal rule.
RCT_EXTERN_METHOD(saveBasisCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// clearCalibration options: { scope: "tau" | "basis" | "all", …key parts }.
RCT_EXTERN_METHOD(clearCalibration:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
