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

/**
 * The sibling a CROP is written to, beside the image it came from.
 *
 * `/…/pp_1/canvas.jpg` → `/…/pp_1/canvas.cropped.jpg`
 *
 * ⚠ IT IS NOT A TEMP FILE AND NOT A SUFFIXED COPY OF THE URI. The crop is a
 * DELIVERABLE — the host receives its path through `onCapture` and may
 * upload it — so it belongs beside the original with a name that says what
 * it is. A temp directory would be collected out from under a host that had
 * only been handed the path.
 *
 * Why a sibling at all, rather than the in-place overwrite every other
 * engine uses: a pano+ canvas is referenced by its pack
 * (`sessionDir/canvas.jpg`), and overwriting it leaves every offline
 * harness reading a pack whose seam residuals, coverage mask and ledger
 * describe a panorama that no longer exists on disk.
 *
 * STABLE FOR A GIVEN SOURCE, deliberately: a second crop of the same canvas
 * replaces the first rather than accumulating one file per attempt inside
 * the pack the operator has to ship. The emitted uri carries a cache-busting
 * query, so `<Image>` still reloads it.
 *
 * Any query or fragment on the input is dropped — this is a filesystem path,
 * not a URI.
 */
export function cropSiblingPath(path: string | null | undefined): string {
  const bare = toBareFilePath(path).split(/[?#]/)[0] ?? '';
  if (bare === '') return '';
  const slash = bare.lastIndexOf('/');
  const dir = slash >= 0 ? bare.slice(0, slash + 1) : '';
  const name = slash >= 0 ? bare.slice(slash + 1) : bare;
  const dot = name.lastIndexOf('.');
  // A dotfile (`.canvas`) has no extension to preserve — `lastIndexOf`
  // would answer 0 and split it into an empty stem.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '.jpg';
  return `${dir}${stem}.cropped${ext}`;
}
