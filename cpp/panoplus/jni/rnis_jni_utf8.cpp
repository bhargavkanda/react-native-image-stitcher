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

#include "rnis_jni_utf8.hpp"

namespace rnis {
namespace jniutil {

std::string sanitizeForModifiedUtf8(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    size_t i = 0;
    while (i < in.size()) {
        const unsigned char c = (unsigned char)in[i];
        // An embedded NUL terminates a C string early, so the Java side would
        // silently receive a TRUNCATED report rather than a wrong character.
        if (c == 0) { out += '?'; ++i; continue; }
        if (c < 0x80) { out += (char)c; ++i; continue; }
        size_t len = 0;
        if ((c & 0xE0) == 0xC0) len = 2;
        else if ((c & 0xF0) == 0xE0) len = 3;
        else len = 0;   // a 4-byte lead, or a stray continuation byte
        if (len == 0 || i + len > in.size()) { out += '?'; ++i; continue; }
        bool wellFormed = true;
        for (size_t k = 1; k < len; ++k) {
            if (((unsigned char)in[i + k] & 0xC0) != 0x80) { wellFormed = false; break; }
        }
        if (!wellFormed) { out += '?'; ++i; continue; }
        out.append(in, i, len);
        i += len;
    }
    return out;
}

}  // namespace jniutil
}  // namespace rnis
