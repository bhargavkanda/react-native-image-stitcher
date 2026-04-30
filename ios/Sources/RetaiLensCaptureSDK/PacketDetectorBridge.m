// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensPacketDetectorBridge as the
// "RetaiLensPacketDetector" RN module — JS imports it via
// NativeModules.RetaiLensPacketDetector.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RetaiLensPacketDetector, NSObject)

RCT_EXTERN_METHOD(isAvailable:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(runPacketDetection:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
