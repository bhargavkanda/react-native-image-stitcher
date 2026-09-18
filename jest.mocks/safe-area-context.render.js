// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native-safe-area-context` mock for the RENDER project.
 *
 * The pano+ surface reads `SafeAreaInsetsContext` (never the hook — the hook
 * throws without a provider) to keep its live-preview panel clear of the
 * landscape sensor housing. The package is a PEER dependency, so it does not
 * resolve from this package's own node_modules; jest maps this file in.
 *
 * A REAL React context, so `useContext` behaves exactly as it does in the app
 * — including the `null` default, which is the no-provider case the surface
 * must survive. `__setInsets` lets a test put the housing on a chosen edge.
 */
const React = require('react');

const SafeAreaInsetsContext = React.createContext(null);
const SafeAreaFrameContext = React.createContext(null);

let insets = null;
// The surface reads the context; a test drives it by swapping the context's
// default value, which is what `useContext` falls back to with no Provider.
Object.defineProperty(SafeAreaInsetsContext, '_currentValue', {
  get: () => insets,
  set: (v) => {
    insets = v;
  },
  configurable: true,
});
Object.defineProperty(SafeAreaInsetsContext, '_currentValue2', {
  get: () => insets,
  set: (v) => {
    insets = v;
  },
  configurable: true,
});

module.exports = {
  SafeAreaInsetsContext,
  SafeAreaFrameContext,
  SafeAreaProvider: 'SafeAreaProvider',
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => insets ?? { top: 0, left: 0, right: 0, bottom: 0 },
  __setInsets: (v) => {
    insets = v;
  },
};
