// SPDX-License-Identifier: Apache-2.0
//
// stitcher_frame_data_test.cpp — v0.10.0 audit #9A
//
// Sanity coverage for the `StitcherFrameData` POD payload + the
// `PixelBufferReader` interface contract.  The shared C++
// `StitcherFrameData` is constructed by both the iOS Obj-C++ side
// (`StitcherFrameHostObject.mm`) and the Android JNI side
// (`stitcher_frame_jni.cpp`); these tests pin the default-construction
// invariants both sides depend on (e.g. `hasTranslation=false`,
// `qw=1.0`).
//
// The `PixelBufferReader` tests use a fake-buffer implementation
// (`FakePixelBufferReader`) to validate the `copyTo` clipping
// behaviour the docstring promises.

#include "stitcher_frame_data.hpp"

#include <gtest/gtest.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

using retailens::PixelBufferReader;
using retailens::StitcherFrameData;

namespace {

/// Minimal fake reader — backs a fixed byte vector.  Used by the
/// `PixelBufferReader` contract tests below to verify
/// `copyTo` clips at the smaller of (maxBytes, byteSize).
class FakePixelBufferReader : public PixelBufferReader {
 public:
  explicit FakePixelBufferReader(std::vector<uint8_t> bytes)
      : _bytes(std::move(bytes)) {}

  std::size_t byteSize() const override { return _bytes.size(); }

  std::size_t copyTo(uint8_t* dst, std::size_t maxBytes) override {
    const std::size_t n =
        maxBytes < _bytes.size() ? maxBytes : _bytes.size();
    std::memcpy(dst, _bytes.data(), n);
    return n;
  }

 private:
  std::vector<uint8_t> _bytes;
};

}  // namespace

// ─── StitcherFrameData default-construction invariants ─────────────

TEST(StitcherFrameDataTest, DefaultsAreSafeForJSIDispatch) {
  // The JSI host object's `get()` dispatch keys off these defaults to
  // expose `undefined` for unset fields.  In particular:
  //   - `hasTranslation == false`  →  pose.translation === undefined
  //   - `arTrackingState.empty()`  →  arTrackingState === undefined
  //   - `qw == 1.0` with rest zero →  identity rotation (safe default
  //     for non-AR mode where rotation is unknown)
  StitcherFrameData d;
  EXPECT_EQ(d.width, 0);
  EXPECT_EQ(d.height, 0);
  EXPECT_TRUE(d.source.empty());
  EXPECT_TRUE(d.pixelFormat.empty());
  EXPECT_TRUE(d.orientation.empty());
  EXPECT_DOUBLE_EQ(d.timestampNs, 0.0);
  EXPECT_DOUBLE_EQ(d.qx, 0.0);
  EXPECT_DOUBLE_EQ(d.qy, 0.0);
  EXPECT_DOUBLE_EQ(d.qz, 0.0);
  EXPECT_DOUBLE_EQ(d.qw, 1.0);  // identity rotation
  EXPECT_DOUBLE_EQ(d.tx, 0.0);
  EXPECT_DOUBLE_EQ(d.ty, 0.0);
  EXPECT_DOUBLE_EQ(d.tz, 0.0);
  EXPECT_FALSE(d.hasTranslation);
  EXPECT_TRUE(d.arTrackingState.empty());
  EXPECT_EQ(d.pixelReader, nullptr);
}

TEST(StitcherFrameDataTest, IsCopyable) {
  // `StitcherFrameData` is documented as "value-typed (cheap to copy;
  // ~100 bytes)".  Copy needs to deep-copy the strings + bump the
  // pixelReader shared_ptr refcount.
  StitcherFrameData a;
  a.source = "ar";
  a.width = 1920;
  a.height = 1080;
  a.pixelReader = std::make_shared<FakePixelBufferReader>(
      std::vector<uint8_t>{1, 2, 3});

  StitcherFrameData b = a;
  EXPECT_EQ(b.source, "ar");
  EXPECT_EQ(b.width, 1920);
  EXPECT_EQ(b.height, 1080);
  ASSERT_NE(b.pixelReader, nullptr);
  EXPECT_EQ(b.pixelReader.use_count(), 2);  // both a and b hold a ref
  EXPECT_EQ(b.pixelReader->byteSize(), 3u);
}

// ─── PixelBufferReader contract ────────────────────────────────────

TEST(PixelBufferReaderTest, CopyToReturnsAllBytesWhenMaxBytesExceedsSize) {
  FakePixelBufferReader reader({0x11, 0x22, 0x33});
  uint8_t buf[8] = {0};
  const std::size_t written = reader.copyTo(buf, sizeof(buf));
  EXPECT_EQ(written, 3u);
  EXPECT_EQ(buf[0], 0x11);
  EXPECT_EQ(buf[1], 0x22);
  EXPECT_EQ(buf[2], 0x33);
  EXPECT_EQ(buf[3], 0u);  // untouched tail
}

TEST(PixelBufferReaderTest, CopyToClipsWhenMaxBytesIsSmaller) {
  // Contract per stitcher_frame_data.hpp: "Implementations MUST handle
  // the case where maxBytes < byteSize() (clip silently)."
  FakePixelBufferReader reader({0xAA, 0xBB, 0xCC, 0xDD});
  uint8_t buf[2] = {0};
  const std::size_t written = reader.copyTo(buf, sizeof(buf));
  EXPECT_EQ(written, 2u);
  EXPECT_EQ(buf[0], 0xAA);
  EXPECT_EQ(buf[1], 0xBB);
}

TEST(PixelBufferReaderTest, CopyToWithZeroMaxBytesReturnsZero) {
  FakePixelBufferReader reader({0x01, 0x02, 0x03});
  uint8_t dummy = 0xFF;
  const std::size_t written = reader.copyTo(&dummy, 0);
  EXPECT_EQ(written, 0u);
  EXPECT_EQ(dummy, 0xFF);  // dst untouched when maxBytes == 0
}
