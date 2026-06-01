---
id: recipes
title: Recipes
sidebar_position: 7
---

# Recipes

Common configurations, copy-paste ready. All assume permission is already
resolved (see [Getting started](./getting-started.md)).

## Photo-only camera (no panorama)

```tsx
<Camera enablePanoramaMode={false} onCapture={onCapture} />
```

## Panorama-only (no single photo)

```tsx
<Camera enablePhotoMode={false} onCapture={onCapture} />
```

## AR-only capture

Hides the AR toggle (nothing to switch to) and the lens chooser (AR is
1×-only):

```tsx
<Camera captureSources="ar" onCapture={onCapture} />
```

## Non-AR (vision-camera) only

Hides the AR toggle; keeps the 0.5×/1× chooser:

```tsx
<Camera captureSources="non-ar" onCapture={onCapture} />
```

## Save outputs to a specific directory

```tsx
import { Paths } from 'expo-file-system'; // or your path util

<Camera
  outputDir={`${Paths.document.uri}/captures`}
  onCapture={(r) => console.log('saved at', r.uri)}
/>
```

## Header with a back button

```tsx
<Camera
  headerTitle="Scan shelf"
  headerGuidance="Hold and pan across the shelf."
  headerBackLabel="Cancel"
  onHeaderBack={() => navigation.goBack()}
/>
```

## Capture history + tap-to-preview

```tsx
const [thumbnails, setThumbnails] = useState<CaptureThumbnailItem[]>([]);

<Camera
  thumbnails={thumbnails}
  thumbnailsMin={3}
  thumbnailsMax={12}
  onCapture={(r) =>
    setThumbnails((t) => [
      ...t,
      { id: String(Date.now()), uri: r.uri, width: r.width, height: r.height },
    ])
  }
/>
```

## Post-stitch preview with actions

```tsx
const [preview, setPreview] = useState<CameraCaptureResult | null>(null);

<Camera
  onCapture={setPreview}
  capturePreview={preview ? { imageUri: preview.uri, title: 'Review' } : undefined}
  capturePreviewActions={[
    { label: 'Retake', onPress: () => setPreview(null) },
    { label: 'Use photo', onPress: () => { save(preview!); setPreview(null); } },
  ]}
  onCapturePreviewClose={() => setPreview(null)}
/>
```

## Controlled flash mirrored from app state

```tsx
const [flash, setFlash] = useState<'on' | 'off'>('off');

<Camera flash={flash} onFlashChange={setFlash} />
```

## Handling errors by class

```tsx
<Camera
  onError={(err) => {
    switch (err.code) {
      case 'CAMERA_PERMISSION_DENIED':
        return promptForSettings();
      case 'STITCH_NEED_MORE_IMGS':
        return toast('Pan a bit more next time.');
      case 'STITCH_OOM':
        return toast('Ran low on memory — try a shorter pan.');
      default:
        return report(err);
    }
  }}
/>
```
