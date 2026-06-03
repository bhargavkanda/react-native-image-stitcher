// SPDX-License-Identifier: Apache-2.0
//
// stitcher_proxy_jsi.cpp — shared C++ JSI host object that exposes
// the v0.8.0 `__stitcherProxy` API to JS.  See header for the
// surface + threading rules.

#include "stitcher_proxy_jsi.hpp"

#include "stitcher_worklet_registry.hpp"

#include <memory>
#include <string>
#include <vector>

namespace retailens {

namespace {

class StitcherProxyHostObject : public facebook::jsi::HostObject {
 public:
  facebook::jsi::Value get(facebook::jsi::Runtime& rt,
                            const facebook::jsi::PropNameID& propName) override {
    using facebook::jsi::Function;
    using facebook::jsi::JSError;
    using facebook::jsi::PropNameID;
    using facebook::jsi::String;
    using facebook::jsi::Value;

    const std::string name = propName.utf8(rt);

    if (name == "install") {
      // install(workletFn) → string ID.  The host function captures
      // nothing; the registry is a process-scope singleton.
      auto fn = [](facebook::jsi::Runtime& runtime,
                   const Value& /*thisVal*/, const Value* args,
                   size_t count) -> Value {
        if (count < 1) {
          throw JSError(runtime,
              "[StitcherProxy] install() requires 1 argument (worklet "
              "function); got 0");
        }
        if (!args[0].isObject() ||
            !args[0].getObject(runtime).isFunction(runtime)) {
          throw JSError(runtime,
              "[StitcherProxy] install() argument must be a function "
              "decorated with 'worklet'");
        }
        // The WorkletInvoker ctor extracts the worklet metadata
        // (`__workletHash` etc.) and throws if absent.  Propagate
        // to JS so misuse fails loudly.
        std::string id =
            StitcherWorkletRegistry::shared().install(runtime, args[0]);
        return String::createFromUtf8(runtime, id);
      };
      return Function::createFromHostFunction(
          rt, PropNameID::forUtf8(rt, "install"), 1, std::move(fn));
    }

    if (name == "uninstall") {
      auto fn = [](facebook::jsi::Runtime& runtime,
                   const Value& /*thisVal*/, const Value* args,
                   size_t count) -> Value {
        if (count < 1 || !args[0].isString()) {
          // No throw — match the JS-side registry's permissive
          // uninstall semantics; missing/bad ID is a no-op.
          return Value::undefined();
        }
        std::string id = args[0].getString(runtime).utf8(runtime);
        StitcherWorkletRegistry::shared().uninstall(id);
        return Value::undefined();
      };
      return Function::createFromHostFunction(
          rt, PropNameID::forUtf8(rt, "uninstall"), 1, std::move(fn));
    }

    if (name == "count") {
      auto fn = [](facebook::jsi::Runtime& runtime,
                   const Value& /*thisVal*/, const Value* /*args*/,
                   size_t /*count*/) -> Value {
        return Value(static_cast<double>(
            StitcherWorkletRegistry::shared().count()));
      };
      return Function::createFromHostFunction(
          rt, PropNameID::forUtf8(rt, "count"), 0, std::move(fn));
    }

    return Value::undefined();
  }

  std::vector<facebook::jsi::PropNameID> getPropertyNames(
      facebook::jsi::Runtime& rt) override {
    std::vector<facebook::jsi::PropNameID> names;
    names.push_back(facebook::jsi::PropNameID::forUtf8(rt, "install"));
    names.push_back(facebook::jsi::PropNameID::forUtf8(rt, "uninstall"));
    names.push_back(facebook::jsi::PropNameID::forUtf8(rt, "count"));
    return names;
  }
};

}  // namespace

void installStitcherProxy(facebook::jsi::Runtime& runtime) {
  auto proxy = std::make_shared<StitcherProxyHostObject>();
  runtime.global().setProperty(
      runtime, "__stitcherProxy",
      facebook::jsi::Object::createFromHostObject(runtime, proxy));
}

}  // namespace retailens
