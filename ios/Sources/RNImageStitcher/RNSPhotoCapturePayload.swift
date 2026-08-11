// SPDX-License-Identifier: Apache-2.0
//
// RNSPhotoCapturePayload — the pure merge rule for photo-capture-plugin
// result payloads.
//
// `RNSARSession.takePhoto` builds its result dictionary, then hands it here
// together with whatever the registered `RNSPhotoCapturePlugin`s returned.
// This file owns ONLY the merge semantics; the plugin protocol + registry
// live in `RNSPhotoCapturePlugin.swift` (ARKit-dependent, iOS-only).
//
// Kept Foundation-only ON PURPOSE so the SwiftPM macOS test target
// (`cd ios && swift test`) can unit-test the merge without ARKit — the same
// pattern `PhotoDepthSidecar.swift` uses for its container codec.

import Foundation

enum RNSPhotoCapturePayload {

    /// Merge plugin payloads into a takePhoto result dictionary.
    ///
    /// Rules (the whole contract):
    ///   1. `result`'s own keys ALWAYS win — a plugin can never clobber the
    ///      library's core fields (`path`, `width`, `height`, `isMirrored`,
    ///      `isRawPhoto`, `pose`, …).
    ///   2. Payloads apply in registration order; on a key collision BETWEEN
    ///      plugins the FIRST plugin to claim the key wins (consistent with
    ///      rule 1: whoever wrote the key first keeps it).
    ///   3. No payloads ⇒ the EXACT same dictionary comes back — the
    ///      zero-plugin path adds, removes, and reorders nothing.
    static func merge(
        result: [String: Any],
        payloads: [[String: Any]]
    ) -> [String: Any] {
        var out = result
        for payload in payloads {
            for (key, value) in payload where out[key] == nil {
                out[key] = value
            }
        }
        return out
    }
}
