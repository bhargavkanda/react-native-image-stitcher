// SPDX-License-Identifier: Apache-2.0
//
// CameraFrameHostObject.h — Obj-C facade for the v0.8.0
// `StitcherFrame` JSI host object.  Header is intentionally
// Obj-C-only (no `<jsi/jsi.h>` import) so this can land in the
// public CocoaPods umbrella without breaking `use_frameworks!` hosts
// (same rationale as `KeyframeGateBridge.h`).
//
// The C++ JSI host object class lives in the .mm; this facade
// exposes only what cross-module callers need:
//
//   - Factory `+ fromARFrame:pose:` that the AR worklet runtime
//     calls per ARFrame to construct a host object backed by the
//     current AR session's frame.
//   - Opaque accessor `- (void *)jsiHostObjectPtr` returning the
//     `std::shared_ptr<facebook::jsi::HostObject> *` (boxed) that
//     the worklet runtime hands to `jsi::Object::createFromHostObject`.
//
// Lifetime: the Obj-C wrapper holds the C++ shared_ptr; ARC frees
// the wrapper when nothing references it.  Worklet runtime
// invalidates the underlying ARFrame retain when the dispatch
// returns; after invalidation, JSI access throws.

#pragma once

#import <Foundation/Foundation.h>
#import <ARKit/ARKit.h>

@class RNSARFramePose;

NS_ASSUME_NONNULL_BEGIN

NS_SWIFT_NAME(CameraFrameHostObject)
@interface CameraFrameHostObject : NSObject

/// Construct a host object backed by the supplied ARFrame + pose.
/// Retains the ARFrame for the host object's lifetime — caller can
/// safely release their reference.
///
/// Thread: safe to call from the ARSession delegate queue; the
/// resulting host object's JSI access must happen on the worklet
/// runtime's thread (separate queue).
+ (instancetype)fromARFrame:(ARFrame *)arFrame pose:(RNSARFramePose *)pose;

/// Mark the host object's underlying ARFrame as no longer accessible.
/// Subsequent JSI property reads return `undefined` or throw,
/// depending on the property.  Idempotent.
- (void)invalidate;

/// Opaque pointer to a `std::shared_ptr<facebook::jsi::HostObject>`.
/// The worklet runtime (Obj-C++ context with JSI available) casts
/// this back via `*reinterpret_cast<std::shared_ptr<facebook::jsi::HostObject>*>(ptr)`
/// to hand to `jsi::Object::createFromHostObject`.
///
/// Returns `NULL` if the host object has been invalidated.
- (nullable void *)jsiHostObjectPtr;

/// Build the LIGHT per-frame AR metadata dictionary for the `onArFrame`
/// callback (the `ARFrameMeta` TS shape).  Distinct from the full
/// host-object factory above: this copies NO pixel / vertex / face bytes
/// — only scalars, dimensions, anchor transforms, and mesh COUNTS — so
/// it's cheap enough to run at the throttled `onArFrame` cadence.
///
/// Gating mirrors the full extraction path: `depth` only when the JS
/// `enableDepth` flag is on (read from the shared C++ extraction config),
/// `anchors` only when `enableAnchors`, `mesh` (counts) only when
/// `enableMesh`.  `intrinsics` / `pose` / `trackingState` / `timestamp`
/// are always populated.  `intrinsics` is `NSNull` only when the frame
/// reported a degenerate (zero) resolution.
///
/// Returns a JSON-safe `NSDictionary` (NSNumber / NSString / NSArray /
/// NSDictionary / NSNull leaves) ready to hand to
/// `bridge.enqueueJSCall("RCTDeviceEventEmitter", "emit", ...)`.
///
/// Thread: safe to call from the ARSession delegate queue (reads the
/// frame synchronously; copies nothing that outlives the call).
+ (NSDictionary *)lightArFrameMetaFromARFrame:(ARFrame *)arFrame
                                         pose:(RNSARFramePose *)pose
    NS_SWIFT_NAME(lightArFrameMeta(from:pose:));

@end

NS_ASSUME_NONNULL_END
