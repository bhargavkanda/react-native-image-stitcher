---
id: orientation
title: Orientation
sidebar_position: 5
---

# Orientation

:::tip Recommended: portrait
`<Camera>` is designed and tuned for **portrait** capture, and that is
the recommended way to use it on both platforms. Landscape is supported
on iOS for hosts that need it; on Android the camera is always portrait.
:::

## Android — always portrait (SDK-enforced)

On Android, `<Camera>` locks its host Activity to portrait while mounted
(via `Activity.setRequestedOrientation`), **regardless of the host app's
`AndroidManifest` `screenOrientation`**. Even a fully landscape or
unlocked host gets a portrait camera screen. The Activity's prior
orientation is captured on mount and restored on unmount, so the rest of
your app keeps its own orientation.

- No host setup required.
- No opt-out — Android capture is portrait-only by design.
- Covers both the AR (ARCore) and non-AR (vision-camera) paths.

## iOS — host-controlled (recommend portrait)

iOS supported orientations are owned by the host's `Info.plist`
(`UISupportedInterfaceOrientations`); the SDK does **not** override them.

### Portrait-only host (recommended)

```xml
<key>UISupportedInterfaceOrientations</key>
<array>
  <string>UIInterfaceOrientationPortrait</string>
</array>
```

The screen stays portrait; the SDK uses sensor-derived orientation for
capture-mode selection and overlay layout. Simplest, most predictable.

### Non-locked host (supported)

If your app has other landscape-friendly screens, you can allow all four
orientations:

```xml
<key>UISupportedInterfaceOrientations</key>
<array>
  <string>UIInterfaceOrientationPortrait</string>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
  <string>UIInterfaceOrientationPortraitUpsideDown</string>
</array>
```

The screen rotates with the device. `<Camera>`'s controls (shutter, lens
chip, AR/flash pills) and the live thumbnail strip/band anchor to the
home-indicator edge so they stay within thumb reach. Built-in modals
declare all four orientations so they rotate with the interface.

## Mid-capture rotation safety

The incremental engine can't mix orientations within one capture (a
portrait capture's keyframes can't combine with landscape-pan frames). If
the user rotates **mid-capture**, `<Camera>`:

1. auto-abandons via `incremental.cancel()`,
2. fires `onCaptureAbandoned('orientation-drift')` (if you wired it),
3. shows an explanatory modal.

There is no "continue past drift" — continuing produces malformed output.

:::note One modal at a time (0.25.1)
While that explanatory modal is up, a post-capture review surface
(`rectCrop` / `showPreview`) from an **earlier** capture will not mount over
it — it waits and mounts when the modal is dismissed. Two React Native
`<Modal>`s cannot be presented at once on iOS; attempting it leaves an
invisible window that swallows touches. The pending result is held in state
meanwhile, so nothing is lost. See [what shows after a lateral-drift
stop](./camera-api.md#what-shows-after-a-lateral-drift-stop).
:::

## Summary

| Platform | Control | Result |
|---|---|---|
| **Android** | SDK forces portrait (unconditional) | Always portrait; host manifest irrelevant |
| **iOS** | Host `Info.plist` | Portrait recommended; landscape supported |
