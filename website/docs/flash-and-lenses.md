---
id: flash-and-lenses
title: Flash & lenses
sidebar_position: 6
---

# Flash & lenses

How the lens chooser, device capability, and flash interact — and why
flash sometimes hides on the ultra-wide.

## The 0.5× chooser appears only when usable

`<Camera>` detects the device's real camera inventory (via
vision-camera's device list) and shows the 1×/0.5× chooser **only when an
ultra-wide is actually reachable**. On wide-only devices the chooser is
hidden — no dead "0.5×" button.

Two hardware shapes exist, and the SDK handles both:

| Device shape | Mode | 0.5× behaviour | Flash on 0.5× |
|---|---|---|---|
| Ultra-wide bundled in a **multi-camera** device (most iPhones) | `multicam` | Reached via **zoom** on one device | **Works** (that device carries the torch) |
| Ultra-wide is a **standalone** camera (many Androids) | `standalone-uw` | Reached by **swapping** to the ultra-wide device | **Hidden** (the standalone ultra-wide has no torch) |

This is automatic; you don't choose the mode.

## Why flash hides on some 0.5× captures

Flash is a single hardware LED, physically tied to the **wide-angle**
camera. vision-camera's `torch` prop only controls the **currently
mounted** device. So:

- **Multi-camera devices:** the mounted device spans both lenses and
  carries the torch → flash works at 0.5× and 1×.
- **Standalone-ultra-wide devices:** selecting 0.5× mounts the ultra-wide,
  which has **no torch** → `<Camera>` hides the flash pill (showing it
  would throw `flash-not-available`). Flash returns on 1×.

This matches native camera apps (Apple/Samsung also disable flash on the
ultra-wide).

## Lens ↔ AR interaction

ARKit/ARCore can't use the ultra-wide, so the lens and AR controls
interact. With `captureSources="both"`:

| Action | AR preference | Lens | UI |
|---|---|---|---|
| Initial mount (defaults) | on | `1×` | AR pill ON |
| Switch to 0.5× | unchanged | `0.5×` | AR pill HIDDEN; capture forced non-AR |
| Switch back to 1× | unchanged | `1×` | AR pill at its previous state |
| Tap AR pill off (on 1×) | off | `1×` | AR pill OFF |

When `captureSources` is `'ar'`, both the AR toggle and the lens chooser
are hidden (AR is 1×-only). When `'non-ar'`, the AR toggle is hidden but
the lens chooser stays.

## Controlled vs uncontrolled flash

```tsx
// Uncontrolled — <Camera> owns flash state, button toggles it:
<Camera showFlashButton />

// Controlled — you own the value:
const [flash, setFlash] = useState<'on' | 'off'>('off');
<Camera flash={flash} onFlashChange={setFlash} />
```
