// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensARSessionBridge as the
// "RetaiLensARSession" RN native module — this is what JS
// imports as `NativeModules.RetaiLensARSession`.

#import <React/RCTBridgeModule.h>

// REMAP form, NOT EXTERN_MODULE.  The Swift singleton in
// RetaiLensARSession.swift takes the @objc name "RetaiLensARSession"
// for itself (so ARSessionDelegate dispatch works against a stable
// ObjC name).  Our RN-facing bridge class is `RetaiLensARSessionBridge`.
// `RCT_EXTERN_MODULE(RetaiLensARSession, ...)` would attach the
// bridge category to the singleton class — RN would then invoke
// selectors like `takePhoto:resolver:rejecter:` on the singleton,
// which doesn't have them, and silently drop the calls.
//
// REMAP_MODULE keeps the JS-visible module name as
// "RetaiLensARSession" but tells RN to instantiate
// `RetaiLensARSessionBridge` and dispatch methods against THAT
// class — where takePhoto / startRecording / stopRecording etc.
// actually live.
@interface RCT_EXTERN_REMAP_MODULE(RetaiLensARSession, RetaiLensARSessionBridge, NSObject)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(start:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolver
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
