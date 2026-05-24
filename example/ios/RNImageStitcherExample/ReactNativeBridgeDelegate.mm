// SPDX-License-Identifier: Apache-2.0
//
// Implementation — see ReactNativeBridgeDelegate.h for the why.

#import "ReactNativeBridgeDelegate.h"
// `CoreModulesPlugins.h` is exposed by the prebuilt React.xcframework
// under both `React_CoreModules` and `React_Core` module names — use
// `React_CoreModules` for naming clarity (matches the header subdir).
#import <React_CoreModules/CoreModulesPlugins.h>

@implementation ReactNativeBridgeDelegate

// Override the C++-gated `getModuleClassFromName:` to bridge through
// to RCTCoreModulesClassProvider, which is exported by the prebuilt
// React.framework and knows about every core ObjC module
// (PlatformConstants → RCTPlatform, RCTNetworking, RCTSettings, etc.)
// — keyed by their `RCT_EXPORT_MODULE(...)` name.
//
// Called by RCTTurboModuleManager during bridgeless TurboModule
// resolution.  When this returns a non-nil Class, the manager wraps
// the class instance into an Obj-C TurboModule via its standard
// pipeline.  When it returns nil, the manager continues its existing
// fallback chain (default delegate's getTurboModule:jsInvoker:, then
// DefaultTurboModules::getTurboModule, etc.) — so this override is
// strictly additive, never blocking.
//
// Returning nil for unknown names is safe: the manager treats nil
// as "I don't know, ask the next link in the chain".
- (Class)getModuleClassFromName:(const char *)name
{
  if (name == nullptr) {
    return nil;
  }
  Class cls = RCTCoreModulesClassProvider(name);
  return cls;
}

@end
