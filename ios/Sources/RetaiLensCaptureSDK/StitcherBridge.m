//
// StitcherBridge.m
//
// RN bridge declaration for the Swift `RetaiLensStitcherBridge`.
// Same pattern as `QualityCheckerBridge.m`.  Without this file the
// JS side's `NativeModules.RetaiLensStitcher` would resolve to
// `undefined` because RN's module map is populated by RCT_EXTERN_*
// macros, not Swift @objc decorators alone.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RetaiLensStitcher, NSObject)

RCT_EXTERN_METHOD(stitch:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(stitchVideo:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(normaliseOrientation:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
