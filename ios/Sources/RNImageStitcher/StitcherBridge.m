// SPDX-License-Identifier: Apache-2.0
//
// StitcherBridge.m
//
// RN bridge declaration for the Swift `StitcherBridge`.
// Same pattern as `QualityCheckerBridge.m`.  Without this file the
// JS side's `NativeModules.BatchStitcher` would resolve to
// `undefined` because RN's module map is populated by RCT_EXTERN_*
// macros, not Swift @objc decorators alone.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(BatchStitcher, NSObject)

RCT_EXTERN_METHOD(stitch:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(stitchVideo:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(normaliseOrientation:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(applyOutputControls:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

// v0.15 debug harness (inscribed-rect visualisation in the example app).
RCT_EXTERN_METHOD(computeInscribedRect:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(cropToRect:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
