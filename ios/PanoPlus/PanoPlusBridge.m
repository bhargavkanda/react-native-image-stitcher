// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusBridge.m
//
// RN bridge declaration for the Swift `PanoPlusBridge`
// (@objc(RNSSweepSession)).  Same pattern as this pod's
// StitchPluginsBridge.m: without this file the JS side's
// `NativeModules.RNSSweepSession` would resolve to `undefined`, because RN's
// module map is populated by RCT_EXTERN_* macros, not by Swift @objc
// decorators alone.
//
// DELIBERATELY a second module rather than more methods on
// `HostStitchPlugins`: pano+ is a capture SESSION with a lifecycle
// (start → many frames → stop), while that module's contract is "one call,
// one render".  Separate names also mean a host can probe for pano+ support
// with a plain `typeof NativeModules.RNSSweepSession?.start === 'function'`.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RNSSweepSession, NSObject)

// Begin a sweep.  options: { sessionDir (required), preferHighFps?, and every
// rnis::pano::Config / pack knob — see RNISPanoCore.h }.
RCT_EXTERN_METHOD(start:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Finish: drain, lead-out tail flush, write canvas.jpg + meta.json, resolve
// the summary.  A sweep that painted nothing rejects `panoplus-empty` with the
// counters + sessionDir on error.userInfo (the pod's D2 pattern).
RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Abandon the sweep and delete its session directory.
RCT_EXTERN_METHOD(cancel:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Poll fallback for the live status (the primary channel is the AR plugin's
// SYNC return, riding onArFrame.plugins["sweep"]).
RCT_EXTERN_METHOD(getStatus:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// v12 — idle viewfinder for the decoupled arm: run the arm's own
// AVCaptureSession input-only so RNISPanoSourceView has a live feed BEFORE the
// sweep.  A module method so it serializes with start/stop on this module's
// one method queue; resolves { on, reason? } and never rejects.
RCT_EXTERN_METHOD(setIdlePreview:(nonnull NSNumber *)on
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
