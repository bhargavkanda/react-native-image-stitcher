// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the v0.8.0 Phase 4b `ensureStitcherProxyInstalled`
 * helper.  The native install path can't be exercised in jest (no
 * JSI runtime), so these tests cover only the JS-side branches:
 *
 *   - Idempotency (second call short-circuits).
 *   - "module missing" path returns false + warns once.
 *   - "install returns false" path returns false + warns once.
 *   - "install throws" path returns false + warns once.
 *   - "install succeeds" path returns true + caches.
 *
 * NativeModules is stubbed via the jest mock at
 * `jest.mocks/react-native.js`; per-test customization swaps in a
 * scenario-specific module.
 */

import { NativeModules } from 'react-native';

import {
  _resetStitcherProxyInstallStateForTests,
  ensureStitcherProxyInstalled,
} from '../ensureStitcherProxyInstalled';

type MutableGlobal = Record<string, unknown>;

describe('ensureStitcherProxyInstalled', () => {
  beforeEach(() => {
    _resetStitcherProxyInstallStateForTests();
    // Clear any previous __stitcherProxy from prior test cases so the
    // module's "already installed" fast-path doesn't bypass our
    // scenario-specific NativeModules stub.
    delete (globalThis as MutableGlobal).__stitcherProxy;
    // Wipe the NativeModules.StitcherJsiInstaller entry so each test
    // starts with a clean slate (the mock module is a shared object
    // across the whole test file).
    (NativeModules as MutableGlobal).StitcherJsiInstaller = undefined;
  });

  it('returns false when the native module is missing', () => {
    expect(ensureStitcherProxyInstalled()).toBe(false);
  });

  it('returns true when install() returns true', () => {
    const install = jest.fn(() => true);
    (NativeModules as MutableGlobal).StitcherJsiInstaller = { install };
    expect(ensureStitcherProxyInstalled()).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('returns false when install() returns false', () => {
    const install = jest.fn(() => false);
    (NativeModules as MutableGlobal).StitcherJsiInstaller = { install };
    expect(ensureStitcherProxyInstalled()).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('returns false when install() throws', () => {
    const install = jest.fn(() => {
      throw new Error('boom');
    });
    (NativeModules as MutableGlobal).StitcherJsiInstaller = { install };
    expect(ensureStitcherProxyInstalled()).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second call short-circuits without re-invoking install()', () => {
    const install = jest.fn(() => true);
    (NativeModules as MutableGlobal).StitcherJsiInstaller = { install };
    expect(ensureStitcherProxyInstalled()).toBe(true);
    expect(ensureStitcherProxyInstalled()).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('short-circuits if __stitcherProxy is already on globalThis (e.g., other consumer installed it first)', () => {
    // Simulate a different SDK instance having installed the proxy.
    (globalThis as MutableGlobal).__stitcherProxy = {
      install: jest.fn(),
      uninstall: jest.fn(),
      count: jest.fn(() => 0),
    };
    const install = jest.fn();
    (NativeModules as MutableGlobal).StitcherJsiInstaller = { install };
    expect(ensureStitcherProxyInstalled()).toBe(true);
    // We did NOT call our own native install — we accepted the
    // already-installed proxy.
    expect(install).not.toHaveBeenCalled();
  });

  it('treats `install: undefined` as a missing module (not a crash)', () => {
    (NativeModules as MutableGlobal).StitcherJsiInstaller = {};
    expect(ensureStitcherProxyInstalled()).toBe(false);
  });
});
