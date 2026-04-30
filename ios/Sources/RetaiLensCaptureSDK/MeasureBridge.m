// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensMeasureBridge as the
// "RetaiLensMeasure" RN native module — JS imports it as
// NativeModules.RetaiLensMeasure.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RetaiLensMeasure, NSObject)

RCT_EXTERN_METHOD(measureDistance:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(measureRegion:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
