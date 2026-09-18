// SPDX-License-Identifier: Apache-2.0
//
// ⚠ APACHE-2.0 IN AN OTHERWISE PROPRIETARY PACKAGE, DELIBERATELY. This
// file is COPIED rather than moved into the public stitcher: both halves
// compile it, and deleting the private copy would drop the guard that
// prevents a CheckJNI ABORT — an app kill — on a non-UTF-8 payload. Both
// copies carry the same licence so they can be byte-compared with no
// exemption; a CI parity gate depends on that. See LICENSING.md.
//
// rnis_jni_utf8 — the JNI modified-UTF-8 guard, owned by NEITHER half.
//
// ⚠ IT LIVES HERE BECAUSE IT IS OWNED BY NEITHER CONSUMER. It used to be
// `rnis::pano::android::sanitizeForModifiedUtf8`, sitting inside a pano
// translation unit while ANOTHER consumer's entire JSON return path called it
// — so that consumer's correctness ran through pano code. That single edge is
// what made separating the two not a text operation.
//
// The two alternatives were both worse:
//   · let the private target keep linking the pano object — not self-contained
//     (rnis_pano_android_report.cpp pulls rnis_pano_attitude.cpp in through
//     basisMatrix/basisLabel), and it leaves real `rnis::pano` symbols in the
//     private library, which is the exact thing the boundary proof forbids;
//   · copy it into each half — two implementations of a CheckJNI-ABORT guard,
//     in two repositories after the pano half goes public, with nothing keeping
//     them in sync and no compiler between them.
//
// So it MOVED, whole, into a namespace that belongs to neither side, with its
// tests. One definition, one test suite, no cross-half link.
//
// ⚠ NOTHING pano-specific may be added here, and nothing private either. The
// moment this file needs a type from either half it stops being neutral and the
// edge is back.

#pragma once

#include <string>

namespace rnis {
namespace jniutil {

/// Make a UTF-8 string safe to hand to JNI's `NewStringUTF`.
///
/// ── WHY THIS IS HERE AND NOT IN THE JNI SHIM ────────────────────────────────
///
/// `NewStringUTF` wants MODIFIED UTF-8, which differs from standard UTF-8 in
/// two ways that matter: supplementary-plane characters are encoded as
/// 4-byte sequences in standard UTF-8 and as surrogate PAIRS of 3-byte
/// sequences in the modified form, and an embedded NUL is `0xC0 0x80` rather
/// than `0x00`. Handing a raw 4-byte sequence or malformed bytes to
/// `NewStringUTF` is undefined, and under CheckJNI it ABORTS THE RUNTIME — an
/// app kill in place of a diagnostic.
///
/// Every string this file produces is machine-generated JSON, but it ECHOES
/// filesystem paths the operator chose, and an Android session directory can
/// legally carry an emoji. So this must be right, and "must be right" plus
/// "lives in a translation unit that only compiles under the NDK" is the exact
/// combination this file exists to avoid — see the header comment. It is a pure
/// string function; it belongs where a host test can reach it.
///
/// Policy: ASCII and well-formed 2-/3-byte sequences pass through unchanged
/// (modified UTF-8 encodes those identically); anything else — a 4-byte
/// sequence, a stray continuation byte, a truncated sequence, an embedded NUL
/// — becomes a single `'?'`. LOSSY ON PURPOSE, and only ever in the echo of a
/// path: a report that renders one character wrong is strictly better than a
/// process that dies rendering it.
std::string sanitizeForModifiedUtf8(const std::string& in);

}  // namespace jniutil
}  // namespace rnis
