// SPDX-License-Identifier: Apache-2.0
//
// ObjC shim that registers RNSARSessionBridge as the
// "RNSARSession" RN native module — this is what JS
// imports as `NativeModules.RNSARSession`.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// REMAP form, NOT EXTERN_MODULE.  The Swift singleton in
// RNSARSession.swift takes the @objc name "RNSARSession"
// for itself (so ARSessionDelegate dispatch works against a stable
// ObjC name).  Our RN-facing bridge class is `RNSARSessionBridge`.
// `RCT_EXTERN_MODULE(RNSARSession, ...)` would attach the
// bridge category to the singleton class — RN would then invoke
// selectors like `takePhoto:resolver:rejecter:` on the singleton,
// which doesn't have them, and silently drop the calls.
//
// REMAP_MODULE keeps the JS-visible module name as
// "RNSARSession" but tells RN to instantiate
// `RNSARSessionBridge` and dispatch methods against THAT
// class — where takePhoto / startRecording / stopRecording etc.
// actually live.
//
// v0.18.0 — base class is now `RCTEventEmitter` (was `NSObject`) so the
// "RNSARSession" module can emit the `RNImageStitcherARFrame` device
// event for the `onArFrame` channel.  RN auto-provides the
// `addListener:` / `removeListeners:` emitter selectors for a module
// whose remap base is RCTEventEmitter; the Swift class supplies
// `supportedEvents` / `startObserving` / `stopObserving`.
@interface RCT_EXTERN_REMAP_MODULE(RNSARSession, RNSARSessionBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(start:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(setSceneReconstructionEnabled:(nonnull NSNumber *)enabled
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(setPlaneDetection:(nonnull NSString *)mode
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// v0.18.0 — toggle the onArFrame LIGHT-metadata channel + its throttle.
RCT_EXTERN_METHOD(setArFrameMetaEnabled:(nonnull NSNumber *)enabled
                  intervalMs:(nonnull NSNumber *)intervalMs
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// v0.20.0 — AR overlay renderer.  Replace the entire JS-set overlay
// collection (the shared arOverlayController sends the full array every
// mutation).  Native merges with the namespaced plugin-overlay set + the
// RNSARCameraView draw view reprojects them each ARFrame.
RCT_EXTERN_METHOD(setOverlays:(nonnull NSArray *)overlays
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// v0.20.0 — raycast from the crosshair (screen centre) to the first real
// surface hit → { worldPosition: [x,y,z] } or null.  Used to place an
// overlay ON the aimed surface (then anchor it), vs a guessed distance ahead.
RCT_EXTERN_METHOD(raycast:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(snapshotPoseLog:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(clearPoseLog:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// Phase 5 AR-backed photo + video capture
RCT_EXTERN_METHOD(takePhoto:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(startRecording:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(stopRecording:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
