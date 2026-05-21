// SPDX-License-Identifier: Apache-2.0
//
// FileBridge.m — Obj-C side of the React Native module registration
// for `FileBridge.swift`.  Required because RN's bridge discovery
// scans for `@interface RCT_EXTERN_MODULE(...)` blocks via Obj-C
// runtime introspection; Swift-only modules aren't visible.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RNImageStitcherFileUtils, NSObject)

RCT_EXTERN_METHOD(moveFile:(NSString *)from
                  to:(NSString *)to
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

RCT_EXTERN_METHOD(defaultCaptureDir:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
