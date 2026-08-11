// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.graphics.Color
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import java.util.concurrent.atomic.AtomicReference

/**
 * 0.20.0 — Android twin of the shared `AROverlay` data model
 * (TS: `src/stitching/AROverlay.ts`; iOS: `AROverlay.swift`).
 *
 * One immutable description of a 2D annotation to render ON TOP of the AR
 * camera preview, anchored to a WORLD position (or explicit world corners)
 * and reprojected to screen every AR frame from the live camera pose +
 * intrinsics (see [AROverlayRenderer]).
 *
 * Mirrors the TS contract EXACTLY:
 *
 *   interface AROverlay {
 *     id: string;
 *     worldPosition?: [x, y, z];      // world metres (billboard marker/box)
 *     sizeMeters?: [w, h];            // box extent at worldPosition
 *     worldQuad?: Array<[x, y, z]>;   // 3-4 explicit world corners
 *     shape?: 'box' | 'outline';      // default 'outline'
 *     fillAlpha?: number;             // 0..1; default 0.22 (box fill opacity)
 *     strokeAlpha?: number;           // 0..1; default 1 (opaque outline)
 *     label?: string;
 *     imageUri?: string;              // image badge inside a box
 *     color?: string;                 // hex; default a theme colour
 *     mode?: '2d' | '3d';             // default '2d'; '3d' is SCAFFOLD ONLY
 *   }
 *
 * A valid overlay carries EITHER a [worldPosition] (with optional
 * [sizeMeters]) OR a [worldQuad] of 3-4 corners.  [worldQuad] wins when
 * both are present (the renderer projects the explicit corners directly).
 *
 * PUBLIC because it is part of the native-plugin SPI: a host app constructs
 * [AROverlayData] instances and hands them to [RNSARPluginRegistry.setOverlays]
 * (native→native overlay placement).  JS callers never touch this type — they
 * pass plain maps via the bridge, parsed by [fromReadableMap].
 */
data class AROverlayData(
    val id: String,
    /// Single world anchor point [x,y,z] in metres, or null when a
    /// [worldQuad] is supplied instead.
    val worldPosition: FloatArray?,
    /// Box extent [width, height] in metres at [worldPosition]; defaults
    /// to a small marker ([DEFAULT_MARKER_SIZE_M]) when omitted.
    val sizeMeters: FloatArray,
    /// Explicit world corners (3-4 points, each [x,y,z]), or null when a
    /// [worldPosition] is supplied instead.
    val worldQuad: Array<FloatArray>?,
    /// 'box' (filled translucent + stroked) or 'outline' (stroked only).
    val shape: String,
    /// Optional text drawn near the overlay's screen centroid.
    val label: String?,
    /// ARGB int parsed from the hex `color` string (default theme cyan).
    val colorArgb: Int,
    /// '2d' (rendered) or '3d' (SCAFFOLD ONLY this release — treated as
    /// '2d' with a one-time warning; see [AROverlayRenderer]).
    val mode: String,
    /// Opacity (0..1) of the 'box' fill face; ignored by 'outline' (no fill).
    /// Trailing + defaulted ON PURPOSE: this constructor is native-plugin SPI,
    /// so pre-existing callers keep compiling AND keep the legacy ~22% fill.
    /// Always read it through [AROverlayRenderer]'s byte conversion, which
    /// re-applies [sanitizeFillAlpha] — a plugin can bypass [fromReadableMap]
    /// and hand us a NaN here.
    val fillAlpha: Float = DEFAULT_FILL_ALPHA,
    /// Stroke (outline) opacity 0..1.  Default 1 = the historical fully-opaque
    /// outline.  0 ⇒ FILL-ONLY, so adjacent tiled quads read as ONE continuous
    /// region (no internal seams).  Sanitised like [fillAlpha].
    val strokeAlpha: Float = DEFAULT_STROKE_ALPHA,
    /// Optional IMAGE drawn INSIDE the box, anchored bottom-left and inset,
    /// so it annotates without covering what the box marks.  A local
    /// `file://` path; [AROverlayRenderer] decodes and CACHES it by URI and
    /// ignores an undecodable file.  Trailing + defaulted like the alphas
    /// above, so native-plugin SPI callers keep compiling.
    val imageUri: String? = null,
) {
    // data class with array fields — override equals/hashCode by `id` only.
    // Identity for diffing the declarative `overlays` prop / imperative set
    // is purely by `id` (the contract diffs "by id"); two overlays with the
    // same id are considered the same slot regardless of field contents.
    override fun equals(other: Any?): Boolean =
        this === other || (other is AROverlayData && other.id == id)

    override fun hashCode(): Int = id.hashCode()

    companion object {
        /// Default box extent (metres) for a [worldPosition]-only overlay
        /// with no [sizeMeters] — a small ~6 cm marker.
        const val DEFAULT_MARKER_SIZE_M = 0.06f

        /// Default overlay colour when `color` is absent / unparseable —
        /// the theme cyan used across the SDK's AR UI.
        const val DEFAULT_COLOR_ARGB = 0xFF00E5FF.toInt()

        /// Default 'box' fill opacity when `fillAlpha` is absent / unusable.
        /// EXACTLY reproduces the legacy hardcoded byte: Math.round(0.22f *
        /// 255f) == 56 == 0x38 (the old AROverlayRenderer.BOX_FILL_ALPHA), so
        /// every pre-`fillAlpha` caller renders the identical pixel.  Matches
        /// iOS `RNISAROverlay.defaultFillAlpha`.
        const val DEFAULT_FILL_ALPHA = 0.22f

        /// Default stroke opacity when `strokeAlpha` is absent / unusable:
        /// fully opaque — every shape was unconditionally stroked before the
        /// field existed, so pre-`strokeAlpha` callers stay pixel-identical.
        /// Matches iOS `RNISAROverlay.defaultStrokeAlpha`.
        const val DEFAULT_STROKE_ALPHA = 1.0f

        /**
         * Coerce a caller-supplied alpha to the honoured range.  Anything
         * non-finite (NaN / ±Inf) or outside 0..1 falls back to [fallback]
         * rather than being silently clipped — a nonsense value means the
         * caller is confused, and the safest read of "I asked for an alpha"
         * is the documented default, not "invisible" (0) or "opaque" (1).
         *
         * MUST run before the *255 byte conversion: NaN would round to 0 (an
         * invisible fill / erased outline) and a huge value would overflow
         * the byte and wrap.
         */
        @JvmStatic
        fun sanitizeAlpha(raw: Float, fallback: Float): Float =
            if (!raw.isFinite() || raw < 0f || raw > 1f) fallback else raw

        /// [sanitizeAlpha] bound to the fill default.  Public because the
        /// native-plugin SPI may legitimately want the same coercion.
        @JvmStatic
        fun sanitizeFillAlpha(raw: Float): Float = sanitizeAlpha(raw, DEFAULT_FILL_ALPHA)

        /// [sanitizeAlpha] bound to the stroke default — nonsense falls back
        /// to OPAQUE, so a malformed value can never silently erase an
        /// outline.
        @JvmStatic
        fun sanitizeStrokeAlpha(raw: Float): Float = sanitizeAlpha(raw, DEFAULT_STROKE_ALPHA)

        /**
         * Read an alpha key (`fillAlpha` / `strokeAlpha`) → a SANITISED 0..1
         * float, or null when the key is absent / not a number (the caller
         * keeps whatever value it already had).  A present-but-out-of-range /
         * non-finite number is sanitised HERE against [fallback] — JS is
         * never trusted to be in range.
         *
         * The [ReadableType.Number] gate also rejects a JS BOOLEAN, which
         * would otherwise read as 1.0/0.0 and land inside 0..1 untouched
         * (`fillAlpha: true` ⇒ an opaque fill hiding the camera feed;
         * `fillAlpha: cond && 0.5` ⇒ the invisible fill this field exists to
         * prevent).  iOS's `numeric` rejects `__NSCFBoolean` for the same
         * reason, so both platforms land on the same default.
         *
         * `internal`, not `private`: [AROverlayStore.applyPatch] reuses it so
         * the parse rule exists in exactly one place.  Kept out of the public
         * plugin SPI (unlike [sanitizeFillAlpha] / [sanitizeStrokeAlpha],
         * which plugin code may legitimately want).
         */
        internal fun readAlpha(map: ReadableMap, key: String, fallback: Float): Float? {
            if (!map.hasKey(key) || map.getType(key) != ReadableType.Number) return null
            return sanitizeAlpha(map.getDouble(key).toFloat(), fallback)
        }

        /**
         * Parse one [ReadableMap] (the JS `AROverlay` shape) into an
         * [AROverlayData], or null when it carries neither a usable
         * `worldPosition` nor a 3-4-point `worldQuad`, or has no `id`.
         *
         * Defensive on every field — a malformed entry is dropped (returns
         * null) rather than crashing the bridge call.
         */
        fun fromReadableMap(map: ReadableMap?): AROverlayData? {
            if (map == null) return null
            val id = if (map.hasKey("id") && map.getType("id") == ReadableType.String)
                map.getString("id") else null
            if (id.isNullOrEmpty()) return null

            val worldQuad = readQuad(map)
            val worldPosition = if (worldQuad == null) readVec3(map, "worldPosition") else null
            // Must anchor to SOMETHING — drop entries with neither.
            if (worldQuad == null && worldPosition == null) return null

            val sizeMeters = readVec2(map, "sizeMeters")
                ?: floatArrayOf(DEFAULT_MARKER_SIZE_M, DEFAULT_MARKER_SIZE_M)

            val shape = if (map.hasKey("shape") && map.getType("shape") == ReadableType.String) {
                when (map.getString("shape")) {
                    "box" -> "box"
                    else -> "outline"
                }
            } else "outline"

            val label = if (map.hasKey("label") && map.getType("label") == ReadableType.String)
                map.getString("label") else null

            // Empty string -> null: JS clearing the badge image sends '' on
            // some paths, and an empty path must read as "no image", not a
            // failure.
            val imageUri = if (map.hasKey("imageUri") &&
                map.getType("imageUri") == ReadableType.String
            ) map.getString("imageUri")?.takeIf { it.isNotEmpty() } else null

            val colorArgb = if (map.hasKey("color") && map.getType("color") == ReadableType.String)
                parseColor(map.getString("color")) else DEFAULT_COLOR_ARGB

            val mode = if (map.hasKey("mode") && map.getType("mode") == ReadableType.String) {
                when (map.getString("mode")) {
                    "3d" -> "3d"
                    else -> "2d"
                }
            } else "2d"

            val fillAlpha =
                readAlpha(map, "fillAlpha", DEFAULT_FILL_ALPHA) ?: DEFAULT_FILL_ALPHA
            val strokeAlpha =
                readAlpha(map, "strokeAlpha", DEFAULT_STROKE_ALPHA) ?: DEFAULT_STROKE_ALPHA

            return AROverlayData(
                id = id,
                worldPosition = worldPosition,
                sizeMeters = sizeMeters,
                worldQuad = worldQuad,
                shape = shape,
                label = label,
                colorArgb = colorArgb,
                mode = mode,
                fillAlpha = fillAlpha,
                strokeAlpha = strokeAlpha,
                imageUri = imageUri,
            )
        }

        /// Parse a whole [ReadableArray] of overlay maps, dropping any
        /// malformed entries.  Returns an empty list for a null/empty array.
        fun fromReadableArray(arr: ReadableArray?): List<AROverlayData> {
            if (arr == null || arr.size() == 0) return emptyList()
            val out = ArrayList<AROverlayData>(arr.size())
            for (i in 0 until arr.size()) {
                if (arr.getType(i) != ReadableType.Map) continue
                fromReadableMap(arr.getMap(i))?.let { out.add(it) }
            }
            return out
        }

        /// Read a length-3 number array under [key] → FloatArray[3], or null.
        private fun readVec3(map: ReadableMap, key: String): FloatArray? {
            if (!map.hasKey(key) || map.getType(key) != ReadableType.Array) return null
            val a = map.getArray(key) ?: return null
            if (a.size() < 3) return null
            return floatArrayOf(
                a.getDouble(0).toFloat(),
                a.getDouble(1).toFloat(),
                a.getDouble(2).toFloat(),
            )
        }

        /// Read a length-2 number array under [key] → FloatArray[2], or null.
        private fun readVec2(map: ReadableMap, key: String): FloatArray? {
            if (!map.hasKey(key) || map.getType(key) != ReadableType.Array) return null
            val a = map.getArray(key) ?: return null
            if (a.size() < 2) return null
            return floatArrayOf(a.getDouble(0).toFloat(), a.getDouble(1).toFloat())
        }

        /// Read `worldQuad` → Array of 3-4 FloatArray[3] corners, or null
        /// when absent / fewer than 3 valid corners.
        private fun readQuad(map: ReadableMap): Array<FloatArray>? {
            if (!map.hasKey("worldQuad") || map.getType("worldQuad") != ReadableType.Array) {
                return null
            }
            val outer = map.getArray("worldQuad") ?: return null
            if (outer.size() < 3) return null
            val corners = ArrayList<FloatArray>(outer.size())
            for (i in 0 until outer.size()) {
                if (outer.getType(i) != ReadableType.Array) continue
                val c = outer.getArray(i) ?: continue
                if (c.size() < 3) continue
                corners.add(
                    floatArrayOf(
                        c.getDouble(0).toFloat(),
                        c.getDouble(1).toFloat(),
                        c.getDouble(2).toFloat(),
                    ),
                )
            }
            // Cap at 4 corners (the contract says 3-4); ignore extras.
            return if (corners.size < 3) null
            else corners.take(4).toTypedArray()
        }

        /**
         * Parse a hex colour string (`#RGB`, `#RRGGBB`, `#AARRGGBB`, or any
         * form [Color.parseColor] accepts) → ARGB int.  Falls back to the
         * theme default on any parse failure.
         */
        private fun parseColor(hex: String?): Int {
            if (hex.isNullOrBlank()) return DEFAULT_COLOR_ARGB
            return try {
                Color.parseColor(hex.trim())
            } catch (_: Throwable) {
                DEFAULT_COLOR_ARGB
            }
        }
    }
}

/**
 * 0.20.0 — process-wide store of [AROverlayData] split into two namespaces:
 *
 *  - **JS overlays** — set/added/updated/removed via the JS imperative API
 *    (`RNSARSession.setOverlays(...)`) or the declarative `overlays` prop.
 *  - **Plugin overlays** — placed directly by native plugins via
 *    [RNSARPluginRegistry.setOverlays] (zero JS latency, native→native).
 *
 * The renderer draws the **UNION** of both sets, so a JS `setOverlays`
 * never clobbers plugin-placed overlays and vice-versa (the spec's
 * "namespace plugin overlays" requirement).  Within a namespace, overlays
 * are keyed by `id`; a later set/add with an existing id REPLACES it.
 *
 * ## Threading
 *
 * Both namespaces are held as immutable lists behind [AtomicReference]s;
 * writes (JS bridge thread or a plugin's queue) swap in a fresh list,
 * reads (the GL render thread, once per frame, via [snapshot]) take the
 * current references.  The union list is computed lazily on read.  No
 * locks; the AtomicReferences give a consistent per-namespace snapshot.
 *
 * A [version] counter bumps on every mutation so the renderer can cheaply
 * detect "did the overlay SET change since I last rebuilt" without diffing
 * lists (the per-frame reprojection always runs regardless; this is only
 * used to skip the list rebuild when nothing changed).
 *
 * PUBLIC because [RNSARCameraView.overlayStore] (a public val on the public
 * view) exposes it to the native-plugin path; host plugin code never
 * constructs one directly (the SDK owns the single instance per view).
 */
class AROverlayStore {

    private val jsOverlays = AtomicReference<List<AROverlayData>>(emptyList())
    private val pluginOverlays = AtomicReference<List<AROverlayData>>(emptyList())

    @Volatile
    var version: Long = 0L
        private set

    private fun bump() { version++ }

    // ── JS namespace ────────────────────────────────────────────────────

    /// Replace the ENTIRE JS overlay set (declarative prop / imperative
    /// `setOverlays`).  Plugin overlays are untouched.
    fun setJsOverlays(overlays: List<AROverlayData>) {
        jsOverlays.set(overlays.toList())
        bump()
    }

    /// Add or replace one JS overlay by id.
    fun addJsOverlay(overlay: AROverlayData) {
        jsOverlays.updateAndGet { cur -> upsert(cur, overlay) }
        bump()
    }

    /// Patch one JS overlay's fields by id (no-op if the id is unknown).
    /// `patch` carries only the fields the caller wants to change; absent
    /// fields keep their current value.
    fun updateJsOverlay(id: String, patch: ReadableMap) {
        jsOverlays.updateAndGet { cur ->
            val idx = cur.indexOfFirst { it.id == id }
            if (idx < 0) cur
            else {
                val merged = applyPatch(cur[idx], patch)
                cur.toMutableList().also { it[idx] = merged }
            }
        }
        bump()
    }

    /// Remove one JS overlay by id (no-op if unknown).
    fun removeJsOverlay(id: String) {
        jsOverlays.updateAndGet { cur -> cur.filterNot { it.id == id } }
        bump()
    }

    /// Clear ALL JS overlays (plugin overlays untouched).
    fun clearJsOverlays() {
        jsOverlays.set(emptyList())
        bump()
    }

    // ── Plugin namespace ────────────────────────────────────────────────

    fun setPluginOverlays(overlays: List<AROverlayData>) {
        pluginOverlays.set(overlays.toList())
        bump()
    }

    fun addPluginOverlay(overlay: AROverlayData) {
        pluginOverlays.updateAndGet { cur -> upsert(cur, overlay) }
        bump()
    }

    fun removePluginOverlay(id: String) {
        pluginOverlays.updateAndGet { cur -> cur.filterNot { it.id == id } }
        bump()
    }

    fun clearPluginOverlays() {
        pluginOverlays.set(emptyList())
        bump()
    }

    // ── Read ────────────────────────────────────────────────────────────

    /**
     * The UNION of JS + plugin overlays for this frame's draw.  JS overlays
     * come first, then plugin overlays; if an id collides across namespaces
     * BOTH are kept (different namespaces own independent slots — collisions
     * are a host bug but we don't silently drop either).
     */
    fun snapshot(): List<AROverlayData> {
        val js = jsOverlays.get()
        val plugin = pluginOverlays.get()
        if (js.isEmpty()) return plugin
        if (plugin.isEmpty()) return js
        val out = ArrayList<AROverlayData>(js.size + plugin.size)
        out.addAll(js)
        out.addAll(plugin)
        return out
    }

    /// True when BOTH namespaces are empty — cheap fast-path for the
    /// renderer / per-frame matrix snapshot to skip all work.
    fun isEmpty(): Boolean = jsOverlays.get().isEmpty() && pluginOverlays.get().isEmpty()

    companion object {
        /// Upsert by id into an immutable list, returning a new list.
        private fun upsert(
            cur: List<AROverlayData>,
            overlay: AROverlayData,
        ): List<AROverlayData> {
            val idx = cur.indexOfFirst { it.id == overlay.id }
            return if (idx < 0) cur + overlay
            else cur.toMutableList().also { it[idx] = overlay }
        }

        /// Merge a partial `patch` map onto an existing overlay, keeping
        /// the prior value for every field the patch omits.  `id` is never
        /// changed (the patch targets an existing id).
        private fun applyPatch(base: AROverlayData, patch: ReadableMap): AROverlayData {
            // Re-parse the patch as a full overlay re-using the base id, but
            // fall back to each base field when the patch omits it.  This
            // keeps the parsing rules (vec3/quad/colour) in ONE place
            // (AROverlayData.fromReadableMap) without duplicating them here.
            val hasQuad = patch.hasKey("worldQuad") &&
                patch.getType("worldQuad") == ReadableType.Array
            val hasPos = patch.hasKey("worldPosition") &&
                patch.getType("worldPosition") == ReadableType.Array

            // If the patch supplies a new anchor (quad or position), parse it
            // through the full parser (which also re-reads size/shape/etc from
            // the patch where present).  Otherwise patch individual fields.
            val parsed = if (hasQuad || hasPos) {
                AROverlayData.fromReadableMap(withId(patch, base.id))
            } else null

            if (parsed != null) {
                // Anchor changed; for fields the patch omitted, prefer base.
                return parsed.copy(
                    sizeMeters = if (patchHasVec2(patch, "sizeMeters")) parsed.sizeMeters else base.sizeMeters,
                    shape = if (patch.hasKey("shape")) parsed.shape else base.shape,
                    label = if (patch.hasKey("label")) parsed.label else base.label,
                    colorArgb = if (patch.hasKey("color")) parsed.colorArgb else base.colorArgb,
                    mode = if (patch.hasKey("mode")) parsed.mode else base.mode,
                    // Without these an anchor-moving patch would silently
                    // reset the alphas/badge to their defaults (the re-parse
                    // can't know the base's values) — which for a fill-only
                    // tiled quad means its outline comes BACK on the next
                    // move, the exact seams `strokeAlpha` exists to remove.
                    // Same hasKey rule as their siblings.
                    fillAlpha = if (patch.hasKey("fillAlpha")) parsed.fillAlpha else base.fillAlpha,
                    strokeAlpha =
                        if (patch.hasKey("strokeAlpha")) parsed.strokeAlpha else base.strokeAlpha,
                    imageUri = if (patch.hasKey("imageUri")) parsed.imageUri else base.imageUri,
                )
            }

            // No anchor change — patch the scalar/array fields individually.
            val size = if (patchHasVec2(patch, "sizeMeters"))
                floatArrayOf(
                    patch.getArray("sizeMeters")!!.getDouble(0).toFloat(),
                    patch.getArray("sizeMeters")!!.getDouble(1).toFloat(),
                )
            else base.sizeMeters

            val shape = if (patch.hasKey("shape") && patch.getType("shape") == ReadableType.String)
                (if (patch.getString("shape") == "box") "box" else "outline")
            else base.shape

            val label = if (patch.hasKey("label")) {
                if (patch.getType("label") == ReadableType.String) patch.getString("label") else null
            } else base.label

            val color = if (patch.hasKey("color") && patch.getType("color") == ReadableType.String)
                AROverlayData.fromReadableMap(colorOnly(patch.getString("color")))?.colorArgb
                    ?: base.colorArgb
            else base.colorArgb

            val mode = if (patch.hasKey("mode") && patch.getType("mode") == ReadableType.String)
                (if (patch.getString("mode") == "3d") "3d" else "2d")
            else base.mode

            // Reuses AROverlayData's parse+sanitise so the rules live in ONE
            // place; null (absent / not a number) keeps the base value, which
            // is this branch's "present AND right type wins" convention.
            val fillAlpha = AROverlayData.readAlpha(
                patch, "fillAlpha", AROverlayData.DEFAULT_FILL_ALPHA,
            ) ?: base.fillAlpha
            val strokeAlpha = AROverlayData.readAlpha(
                patch, "strokeAlpha", AROverlayData.DEFAULT_STROKE_ALPHA,
            ) ?: base.strokeAlpha
            val imageUri = if (patch.hasKey("imageUri") &&
                patch.getType("imageUri") == ReadableType.String
            ) patch.getString("imageUri")?.takeIf { it.isNotEmpty() } else base.imageUri

            return base.copy(
                sizeMeters = size,
                shape = shape,
                label = label,
                colorArgb = color,
                mode = mode,
                fillAlpha = fillAlpha,
                strokeAlpha = strokeAlpha,
                imageUri = imageUri,
            )
        }

        private fun patchHasVec2(patch: ReadableMap, key: String): Boolean {
            if (!patch.hasKey(key) || patch.getType(key) != ReadableType.Array) return false
            val a = patch.getArray(key) ?: return false
            return a.size() >= 2
        }

        /// Wrap a patch map so the full parser sees the right `id`.  RN's
        /// ReadableMap is read-only, so we route through a tiny JavaOnlyMap
        /// copy with the id forced in.
        private fun withId(patch: ReadableMap, id: String): ReadableMap {
            val m = com.facebook.react.bridge.JavaOnlyMap()
            m.merge(patch)
            m.putString("id", id)
            return m
        }

        /// Build a minimal map carrying just `id` + `color` so we can reuse
        /// the parser's colour logic for a colour-only patch.
        private fun colorOnly(color: String?): ReadableMap {
            val m = com.facebook.react.bridge.JavaOnlyMap()
            m.putString("id", "_")
            // Give it a dummy anchor so the parser accepts it.
            val pos = com.facebook.react.bridge.JavaOnlyArray()
            pos.pushDouble(0.0); pos.pushDouble(0.0); pos.pushDouble(0.0)
            m.putArray("worldPosition", pos)
            if (color != null) m.putString("color", color)
            return m
        }
    }
}
