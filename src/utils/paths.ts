// SPDX-License-Identifier: Apache-2.0
/**
 * Path normalisation helpers.  Internal — NOT re-exported from
 * `src/index.ts`; the public surface intentionally doesn't promise
 * these utilities to consumers (every host app has its own copy).
 *
 * Two shapes a file path can take when crossing the JS / native /
 * React layers in this library:
 *
 *   - **`file://`-prefixed URI** — what RN's `<Image source={{ uri }}>`
 *     (Android strict, iOS lenient) and `expo-file-system` APIs
 *     accept.  Whenever this library emits a path to JS (via
 *     `onCapture`, the `IncrementalStateUpdate` event, etc.) it
 *     should be in this form so consumers can render it directly.
 *
 *   - **Bare path** — what `fs`-style native APIs (`cv::imwrite`,
 *     `NSFileManager`, `BitmapFactory.decodeFile`) accept.  These
 *     treat a `file://` prefix as part of the literal filename and
 *     fail to open it.  Native bridges expect bare paths in.
 *
 * Both helpers are pure and idempotent.  No-op on the empty string.
 *
 * (The Swift and Kotlin sides have their own `stripFileScheme` —
 * cross-language sharing isn't worth a small helper.  Keeping the
 * JS copy here just centralises the rule for the TS surface.)
 */

/** Add the `file://` scheme to a bare path, idempotently. */
export function toFileUri(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('file://') || path.startsWith('content://') || path.startsWith('http')) {
    return path;
  }
  return `file://${path}`;
}

/** Strip the `file://` scheme from a URI, idempotently. */
export function toBareFilePath(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('file://')) return path.slice('file://'.length);
  return path;
}
