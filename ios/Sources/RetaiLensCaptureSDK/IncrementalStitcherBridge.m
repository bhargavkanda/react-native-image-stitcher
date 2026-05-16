// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensIncrementalStitcherBridge as the
// "RetaiLensIncrementalStitcher" RN module.  REMAP form, same
// rationale as ARSessionBridge.m: the Swift singleton already takes
// the @objc name "RetaiLensIncrementalStitcher" so attaching the
// bridge category to that class would shadow the singleton's
// methods.  REMAP_MODULE keeps the JS-visible name stable while
// telling RN to instantiate the bridge class.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_REMAP_MODULE(
    RetaiLensIncrementalStitcher,
    RetaiLensIncrementalStitcherBridge,
    RCTEventEmitter
)

RCT_EXTERN_METHOD(start:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(finalize:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(cancel:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(appendDebugLog:(NSString *)message
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// V15.0e — JS poll for ARKit plane detection state.
RCT_EXTERN_METHOD(getARPlaneStatus:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// V15.0g — relatch the AR plane to the camera's current aim, picking
// the largest plane that passes the alignment threshold.
RCT_EXTERN_METHOD(relatchARPlane:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// V16 — pose-based keyframe gate: arm the next ARFrame to be
// force-accepted, used on shutter release so the trailing edge of
// the scan isn't truncated.
RCT_EXTERN_METHOD(markNextFrameAsLastKeyframe:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// V16 Phase 1b.fix2 — JS-callable poll for process phys_footprint MB.
// Backs the on-screen memory debug overlay; same metric iOS jetsam
// evaluates against.
RCT_EXTERN_METHOD(getMemoryFootprintMB:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// 2026-05-16 — realtime+batch fusion (Option A "Replace on completion").
// Run the shared C++ stitcher over a caller-supplied list of keyframe
// JPEG paths and write a refined panorama to `outputPath`.  See JS
// `IncrementalRefineOptions` / `IncrementalRefineResult` types and the
// design doc 2026-05-14-realtime-batch-fusion.md.
RCT_EXTERN_METHOD(refinePanorama:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
