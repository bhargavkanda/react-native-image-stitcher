// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensMeasureBridge as the
// "RetaiLensMeasure" RN native module — JS imports it as
// NativeModules.RetaiLensMeasure.

#import <React/RCTBridgeModule.h>

// REMAP — the Swift math class `RetaiLensMeasure` already takes
// the @objc name "RetaiLensMeasure"; our bridge is
// `RetaiLensMeasureBridge`.  REMAP keeps the JS module name
// "RetaiLensMeasure" but instantiates the bridge class so the
// `:resolver:rejecter:` selectors are findable.  See ARSessionBridge.m
// for the same fix and rationale.
@interface RCT_EXTERN_REMAP_MODULE(RetaiLensMeasure, RetaiLensMeasureBridge, NSObject)

RCT_EXTERN_METHOD(measureDistance:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(measureRegion:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
