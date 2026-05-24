module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // react-native-worklets-core/plugin must be LAST in the plugins
  // array — it transforms functions tagged with `'worklet'` into
  // hoisted, serialisable closures that the worklet runtime can hand
  // off to the camera producer thread.  Listing it after any other
  // transforms ensures it sees the already-lowered JSX/TS output.
  // Required by react-native-vision-camera v4 frame processors.  See
  // docs/f8-frame-processor-plan.md.
  plugins: ['react-native-worklets-core/plugin'],
};
