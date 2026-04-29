// SPDX-License-Identifier: UNLICENSED
//
// ObjC shim that registers RetaiLensARSessionBridge as the
// "RetaiLensARSession" RN native module — this is what JS
// imports as `NativeModules.RetaiLensARSession`.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RetaiLensARSession, NSObject)

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

@end
