// SPDX-License-Identifier: Apache-2.0
//
// ExposureBurstBridge.m — Obj-C side of the React Native module
// registration for `ExposureBurst.swift` (same pattern as
// `FileBridge.m`: RN's bridge discovery scans for RCT_EXTERN_MODULE
// blocks via Obj-C runtime introspection; Swift-only modules aren't
// visible).

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RNISExposureBurst, NSObject)

RCT_EXTERN_METHOD(capture:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
