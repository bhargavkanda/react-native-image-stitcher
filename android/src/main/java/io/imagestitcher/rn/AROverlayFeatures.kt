// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * The OPTIONAL AR overlay fields this native build honours — what
 * `RNSARSession.overlayFeatures()` resolves (pure Kotlin, no React Native or
 * Android types, so the JVM test pins the exact report the bridge sends).
 *
 * WHY. An optional overlay field is silently ignored by a native build that
 * predates it: an app whose JS asks for `imageScale: 2` on an older native
 * side draws the badge at 1×, and a record that copies the JS request says 2.
 * JS newer than native is routine (a Metro reload without a rebuild). With
 * this report the host can record what native actually honours:
 *
 *   * method ABSENT (a build before the report)        ⇒ unknown;
 *   * resolves, `features` includes the field          ⇒ honoured;
 *   * resolves, `features` does not include the field  ⇒ NOT honoured.
 *
 * Resolved shape (the same on iOS):
 *
 *   {
 *     contract: 'arOverlayFeatures/1',
 *     platform: 'android',
 *     features: ['imageScale'],
 *     imageScale: { min: 0.25, max: 2.5, default: 1 },
 *   }
 *
 * `features` lists only the OPTIONAL fields added since the overlay contract
 * first shipped — each future one appends its name here in the commit that
 * makes the parser AND the renderer honour it, never before. A field listed
 * here is parsed ([AROverlayData.fromReadableMap], the patch path) AND drawn
 * ([AROverlayRenderer]). `imageScale` carries its honoured range: a value
 * outside it renders at `default`, not clipped ([AROverlayImageScale]).
 */
object AROverlayFeatures {
    const val CONTRACT = "arOverlayFeatures/1"
    const val PLATFORM = "android"
    const val IMAGE_SCALE = "imageScale"

    /** The optional fields this build honours, in the order they shipped. */
    @JvmField
    val FEATURES: List<String> = listOf(IMAGE_SCALE)

    /** The resolve, as plain Kotlin values (the bridge converts it). */
    @JvmStatic
    fun describe(): Map<String, Any> = linkedMapOf(
        "contract" to CONTRACT,
        "platform" to PLATFORM,
        "features" to FEATURES,
        IMAGE_SCALE to linkedMapOf(
            "min" to AROverlayImageScale.MIN.toDouble(),
            "max" to AROverlayImageScale.MAX.toDouble(),
            "default" to AROverlayImageScale.DEFAULT.toDouble(),
        ),
    )
}
