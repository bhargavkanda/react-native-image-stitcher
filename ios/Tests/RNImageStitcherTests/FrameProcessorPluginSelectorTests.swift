// SPDX-License-Identifier: Apache-2.0
//
// FrameProcessorPluginSelectorTests — compile-time selector guard
// for the Swift⇄ObjC++ contract that KeyframeGateFrameProcessor.mm
// depends on.
//
// Background (adversarial-review H2): the .mm file forward-declares
// `IncrementalStitcher` instead of importing the auto-generated
// `RNImageStitcher-Swift.h` (which would force this TU to also import
// React + ARKit).  Forward declarations bypass the type-checker for
// the actual Swift method; if someone renames or repacks the
// arguments of `consumeFrameFromPlugin(pixelBuffer:tx:…:trackingStateRaw:)`,
// the .mm compiles cleanly, links cleanly, and **crashes at runtime**
// on the very first non-AR frame with
// `NSInvalidArgumentException: unrecognized selector sent to instance`.
//
// This test forces the Swift compiler to resolve the exact selector
// the .mm relies on.  If anyone changes the Swift signature in a way
// that breaks the .mm's ObjC interop, the test fails to compile and
// they see the breakage immediately — no runtime surprise.
//
// Failure mode: rename a parameter label, add an argument, etc. →
// this file stops compiling.  Fix: update the .mm's forward
// declaration and its call site, then update the test.

import XCTest
@testable import RNImageStitcher

final class FrameProcessorPluginSelectorTests: XCTestCase {

    /// Compile-time check that the exact selector the .mm dispatches
    /// is in fact what Swift exports.  If this stops compiling, the
    /// .mm's `[IncrementalStitcher.shared consumeFrameFromPluginWith…]`
    /// call will start raising `unrecognized selector` at runtime.
    func testConsumeFrameFromPluginSelectorIsStable() {
        let sel = #selector(IncrementalStitcher.consumeFrameFromPlugin(
            pixelBuffer:
            tx: ty: tz:
            qx: qy: qz: qw:
            fx: fy: cx: cy:
            imageWidth: imageHeight:
            timestampMs:
            trackingStateRaw:))
        // The literal selector string the .mm relies on.
        let expected =
            "consumeFrameFromPluginWithPixelBuffer:tx:ty:tz:"
            + "qx:qy:qz:qw:fx:fy:cx:cy:"
            + "imageWidth:imageHeight:timestampMs:trackingStateRaw:"
        XCTAssertEqual(NSStringFromSelector(sel), expected,
            "If this assertion fails, the Swift method signature "
            + "drifted from what KeyframeGateFrameProcessor.mm "
            + "expects.  Update the .mm's forward declaration and "
            + "call site, then update `expected` here.")
    }

    /// Same idea, narrower scope: the `shared` singleton accessor
    /// the .mm uses must remain `+ (instancetype)shared`.
    func testSharedAccessorSelectorIsStable() {
        let sel = #selector(getter: IncrementalStitcher.shared)
        XCTAssertEqual(NSStringFromSelector(sel), "shared")
    }
}
