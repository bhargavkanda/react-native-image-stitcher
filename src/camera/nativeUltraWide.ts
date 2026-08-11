// SPDX-License-Identifier: Apache-2.0
/**
 * nativeUltraWide — decide whether to offer the "open the OS camera for 0.5×"
 * affordance on a device whose ultra-wide is unreachable in-app.
 *
 * WHY THIS EXISTS: on some Android devices (proven on the Samsung Galaxy A34,
 * SM-A346x) the ultra-wide is a **system-only** physical camera — invisible
 * and unopenable to any third-party app (`getCameraCharacteristics` throws
 * `Unknown camera ID`; `getCameraIdList` omits it). `selectCaptureDevice`
 * correctly returns `has0_5x=false` (no in-app 0.5×), and there is NO Camera2
 * path to recover it. The only way an operator can capture a 0.5× shot on such
 * a device is the OEM camera app (which has privileged access). This helper
 * gates a "0.5× ⤢" fallback affordance that hands off to that OS camera.
 *
 * Pure + host-agnostic. The affordance is shown only when ALL hold:
 *   - platform is Android (iOS virtual devices already span the ultra-wide;
 *     the fallback is never needed there),
 *   - the in-app pick found NO ultra-wide (`hasInAppUltraWide === false`), and
 *   - the running device's model/manufacturer matches the host-supplied list.
 *
 * The list is host-supplied (see `<Camera nativeUltraWideModels>`) — the
 * library ships no device knowledge; the consuming app maintains which models
 * hide the ultra-wide.  An empty/absent list disables the feature entirely
 * (default OFF).
 */

/** Inputs to {@link shouldOfferNativeUltraWide}. */
export interface NativeUltraWideDecisionInput {
  /** `selectCaptureDevice(...).has0_5x` — whether an IN-APP 0.5× exists. */
  hasInAppUltraWide: boolean;
  /** Host-supplied match list (see match rules below). Absent/empty → off. */
  models?: readonly string[];
  /** `Platform.OS`. */
  platformOS: string;
  /** `Platform.constants.Model` on Android (e.g. `"SM-A346B"`). */
  deviceModel?: string;
  /** `Platform.constants.Manufacturer` on Android (e.g. `"samsung"`). */
  deviceManufacturer?: string;
}

/**
 * A list entry matches the current device when, case-insensitively:
 *   - it is `manufacturer:<name>` and `<name>` equals the device manufacturer
 *     (a broad brand rule, e.g. `manufacturer:samsung`), OR
 *   - it is a plain string that is a PREFIX of the device model — so a single
 *     `"SM-A346"` entry covers every A34 SKU (`SM-A346B`, `SM-A346E`, …)
 *     without listing each. Exact model strings also match (a string is a
 *     prefix of itself).
 * Empty entries never match.
 */
function modelMatches(
  entry: string,
  deviceModel: string | undefined,
  deviceManufacturer: string | undefined,
): boolean {
  const e = entry.trim().toLowerCase();
  if (e.length === 0) return false;
  const wildcard = 'manufacturer:';
  if (e.startsWith(wildcard)) {
    const brand = e.slice(wildcard.length);
    // trim() the device value too (some OEMs pad Build.MANUFACTURER) so a
    // clean list entry still matches — the entry is already trimmed above.
    return (
      brand.length > 0 &&
      (deviceManufacturer ?? '').trim().toLowerCase() === brand
    );
  }
  const model = (deviceModel ?? '').trim().toLowerCase();
  return model.length > 0 && model.startsWith(e);
}

/**
 * Whether to render the native-camera 0.5× fallback affordance.  See the
 * module doc for the full gate.  Pure; safe with undefined inputs.
 */
export function shouldOfferNativeUltraWide(
  input: NativeUltraWideDecisionInput,
): boolean {
  if (input.platformOS !== 'android') return false;
  if (input.hasInAppUltraWide) return false;
  const models = input.models;
  if (!models || models.length === 0) return false;
  return models.some((m) =>
    modelMatches(m, input.deviceModel, input.deviceManufacturer),
  );
}
