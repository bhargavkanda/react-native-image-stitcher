# Contributing to react-native-image-stitcher

Thanks for considering a contribution!  This document describes the
expectations for issues, pull requests, and the contributor agreement.

## Issues

Open issues at
https://github.com/bhargavkanda/react-native-image-stitcher/issues.

Useful information to include:

- Device + OS version (e.g., "iPhone 16 Pro / iOS 26.4.2",
  "Samsung Galaxy A35 / Android 14").
- The React Native + Expo versions in your host app
  (`react-native --version`, `expo --version`).
- A minimal `<Camera>` props snippet reproducing the issue.
- For panorama-stitch failures: the captured input frames (or a
  representative sample) — the stitcher's failure mode is highly
  scene-dependent.

## Pull requests

1. Fork → branch (`feature/short-description` or
   `fix/short-description`).
2. Run the relevant verification from the cloned repo root:
   - `npm run build` for TypeScript changes (rebuilds `dist/`).
   - For native iOS changes: `cd example/ios && pod install`, then
     open `example/ios/RNImageStitcherExample.xcworkspace` in Xcode
     and build the example app on a connected device or simulator.
   - For native Android changes: `cd example && npx react-native run-android`
     against an attached device or emulator.
3. Open the PR against `main`.  Include a "Test plan" checklist —
   anything you exercised manually on a real device.
4. CI runs the same builds.  If CI fails, the build log links from
   the PR checks tab.

## Contributor License Agreement (CLA)

Before we can merge your first PR, you need to sign the project CLA.
It grants the project the right to relicense your contributions
under a different open-source license in the future (e.g., Apache 2.0
→ MIT) without needing to re-collect permission from every
contributor.

Without the CLA we can't accept code changes — only issue reports +
documentation fixes that don't touch copyrighted material.

The bot will prompt you to sign automatically on your first PR.
One signature covers all future contributions.

## Code style

- TypeScript: strict mode, no `any` in the public API surface.
- Swift: standard SwiftLint defaults (the project doesn't enforce
  beyond that).
- Kotlin: standard ktlint defaults.
- C++: clang-format with the project's `.clang-format` (LLVM style).

## Testing

The library has minimal unit-test coverage today — most verification
is done on-device via the example app under `example/`.  PRs that
add features should include either:

- A new step in `example/App.tsx` exercising the feature, OR
- A note in the PR's Test Plan describing how you validated it
  on-device.

## Release process

(For maintainers — contributors don't need to follow this.)

1. Bump `package.json#version`.
2. Tag `v<version>` and push.
3. GitHub Actions `release-binaries.yml` runs, builds OpenCV
   binaries for iOS + Android, attaches them to the matching GH
   Release.
4. `npm publish` from local (or via CI once `NPM_TOKEN` is wired).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.
