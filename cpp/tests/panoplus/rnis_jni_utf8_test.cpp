// SPDX-License-Identifier: Apache-2.0
//
// ⚠ APACHE-2.0 IN AN OTHERWISE PROPRIETARY PACKAGE, DELIBERATELY. This
// file is COPIED rather than moved into the public stitcher: both halves
// compile it, and deleting the private copy would drop the guard that
// prevents a CheckJNI ABORT — an app kill — on a non-UTF-8 payload. Both
// copies carry the same licence so they can be byte-compared with no
// exemption; a CI parity gate depends on that. See LICENSING.md.
//
// The JNI modified-UTF-8 guard, tested where BOTH halves can reach it.
//
// ⚠ THESE ASSERTIONS MOVED HERE WITH THE FUNCTION, they were not rewritten.
// They were rnis_pano_android_report_test.cpp's `AndroidReportUtf8` suite; the
// sanitiser was `rnis::pano::android::` then, and another consumer's JSON path
// reached across into it. The function is now `rnis::jniutil::`, owned by
// neither caller — but the guard it provides is
// unchanged, so the coverage must be too. A weaker suite here would mean the
// package split quietly reduced the protection against a CheckJNI ABORT.
//
// The one assertion left behind is the integration one — that a real generated
// basis report passes through untouched — because it needs pano types.

#include "rnis_jni_utf8.hpp"

#include <gtest/gtest.h>

#include <string>

namespace u8 = rnis::jniutil;

TEST(JniUtf8, PassesAsciiThroughUnchanged) {
    const std::string s = "{\"path\":\"/sdcard/Android/data/pack-01\"}";
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(s), s);
}

TEST(JniUtf8, KeepsWellFormedTwoAndThreeByteSequences) {
    // Modified UTF-8 encodes these IDENTICALLY to standard UTF-8, so they must
    // survive byte-for-byte — replacing them would corrupt every non-English
    // path for no safety gain.
    const std::string two = "caf\xC3\xA9";                 // é  (U+00E9)
    const std::string three = "\xE2\x82\xAC";              // €  (U+20AC)
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(two), two);
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(three), three);
}

TEST(JniUtf8, ReplacesTheFourByteSequenceThatWouldAbortTheRuntime) {
    // U+1F600 (an emoji) — legal in an Android directory name, and the case
    // that makes NewStringUTF undefined. Each of its four bytes becomes '?'
    // (the lead is refused, then each continuation byte is a stray).
    const std::string emoji = "pack\xF0\x9F\x98\x80";
    const std::string out = u8::sanitizeForModifiedUtf8(emoji);
    EXPECT_EQ(out, "pack????");
    for (const char c : out) {
        EXPECT_LT((unsigned char)c, 0x80u) << "a non-ASCII byte survived";
    }
}

TEST(JniUtf8, ReplacesTruncatedAndStrayBytesWithoutReadingPastTheEnd) {
    // A truncated sequence at the very end is the buffer-overread case. The
    // result matters less than the fact that it terminates and stays in bounds.
    EXPECT_EQ(u8::sanitizeForModifiedUtf8("a\xC3"), "a?");
    EXPECT_EQ(u8::sanitizeForModifiedUtf8("a\xE2\x82"), "a??");
    EXPECT_EQ(u8::sanitizeForModifiedUtf8("\x80\x80"), "??");
    EXPECT_EQ(u8::sanitizeForModifiedUtf8("a\xC3\x28"), "a?(");
}

TEST(JniUtf8, ReplacesAnEmbeddedNulRatherThanTruncatingTheReport) {
    // A NUL would end the C string early, so Java would receive a SILENTLY
    // TRUNCATED report — worse than a wrong character, because it looks valid.
    const std::string s = std::string("a\0b", 3);
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(s), "a?b");
}

TEST(JniUtf8, IsIdempotentAndHandlesTheEmptyString) {
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(""), "");
    const std::string once = u8::sanitizeForModifiedUtf8("x\xF0\x9F\x98\x80y");
    EXPECT_EQ(u8::sanitizeForModifiedUtf8(once), once);
}
