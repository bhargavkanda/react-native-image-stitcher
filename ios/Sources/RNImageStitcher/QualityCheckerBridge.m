//
// QualityCheckerBridge.m
//
// Obj-C glue that registers the Swift `RetaiLensQualityCheckerBridge`
// class with the React Native module map.  React Native's
// `RCT_EXTERN_MODULE` and `RCT_EXTERN_METHOD` are C macros — they
// can't be invoked from Swift directly — so a `.m` shim is required
// even though the actual implementation is Swift.
//
// The first arg to RCT_EXTERN_MODULE is the Obj-C-visible class name.
// Marking the Swift class `@objc(RetaiLensQualityChecker)` aliases it
// to the same name on the Obj-C side, which means the JS layer sees
// `NativeModules.RetaiLensQualityChecker` regardless of the Swift
// class's actual Swift-side name.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RetaiLensQualityChecker, NSObject)

RCT_EXTERN_METHOD(measure:(NSString *)imagePath
                  resolver:(RCTPromiseResolveBlock)resolver
                  rejecter:(RCTPromiseRejectBlock)rejecter)

@end
