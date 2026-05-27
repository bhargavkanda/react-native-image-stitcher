// SPDX-License-Identifier: Apache-2.0
//
// jsi.h — TEST-ONLY stub of facebook::jsi types.
//
// The real jsi.h ships with React Native and pulls in a large surface
// area (Runtime, Value, Object, Function, HostObject, HostFunction,
// Array, ArrayBuffer, PropNameID, …) along with the build infra to
// link them.  For pure-C++ unit tests that exercise data-structure
// invariants of code that REFERENCES jsi types but never CALLS into
// them (e.g. `StitcherWorkletRegistry` storing a `shared_ptr` and
// forwarding `Runtime&` to a constructor stub), we only need the
// types to be NAMED so headers compile.
//
// Pattern: this stub is placed first on the test target's include
// path so `#include <jsi/jsi.h>` resolves here instead of to RN's
// real header.  Production builds NEVER see this file — it lives
// only under `cpp/tests/stubs/`, which is referenced exclusively by
// `cpp/tests/CMakeLists.txt`.
//
// Tests that need to actually CONSTRUCT or CALL into JSI types should
// not use this stub — they should run against a real JSI runtime (a
// future v0.11.0+ test target that links Hermes).

#pragma once

namespace facebook {
namespace jsi {

class Runtime {};
class Value {};

}  // namespace jsi
}  // namespace facebook
