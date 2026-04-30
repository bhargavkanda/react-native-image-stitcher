// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensPacketDetectorBridge as the
// "RetaiLensPacketDetector" RN module — JS imports it via
// NativeModules.RetaiLensPacketDetector.

#import <React/RCTBridgeModule.h>

// REMAP — the Swift detector class `RetaiLensPacketDetector` already
// takes the @objc name "RetaiLensPacketDetector"; the bridge is
// `RetaiLensPacketDetectorBridge`.  Same fix + rationale as
// ARSessionBridge.m / MeasureBridge.m.
@interface RCT_EXTERN_REMAP_MODULE(RetaiLensPacketDetector, RetaiLensPacketDetectorBridge, NSObject)

RCT_EXTERN_METHOD(isAvailable:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(runPacketDetection:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
