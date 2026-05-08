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

@end
