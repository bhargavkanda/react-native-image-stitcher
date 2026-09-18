// SPDX-License-Identifier: Apache-2.0
//
// Setup for the RENDER jest project (jest.config.js `render.setupFiles`).
//
// react-test-renderer is deprecated in React 19 and prints a console.error on
// every mount. It is still the lightest way to drive a component off-DOM (no
// jsdom), and the deprecation does not affect what these tests assert — so
// filter JUST that one line, and let every OTHER console.error through
// unchanged (a real error in a HUD test must still be loud).
const realError = console.error;
console.error = (...args) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.includes('react-test-renderer is deprecated')) return;
  realError(...args);
};

// react-test-renderer keys "is this an act() environment" off this global.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
