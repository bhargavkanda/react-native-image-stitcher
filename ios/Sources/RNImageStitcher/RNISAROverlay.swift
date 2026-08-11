// SPDX-License-Identifier: Apache-2.0
//
// RNISAROverlay — v0.20.0 AR overlay / annotation data model + store.
//
// An "overlay" is a 2D annotation (outline, box, or marker + label)
// anchored to a WORLD position (or explicit world corners) and
// reprojected to screen EVERY AR frame from the current camera
// pose+intrinsics.  This file owns ONLY the data model + a process-wide
// store; the actual drawing + per-frame reprojection lives in
// `RNSARCameraView` (`AROverlayDrawView`).
//
// Mirrors the shared TS contract (`src/stitching/AROverlay.ts`):
//
//   interface AROverlay {
//     id: string;
//     worldPosition?: [number, number, number];   // world metres
//     sizeMeters?: [number, number];               // box extent at worldPosition
//     worldQuad?: Array<[number, number, number]>; // 3-4 explicit world corners
//     shape?: 'box' | 'outline';                   // default 'outline'
//     fillAlpha?: number;                          // 0..1; default 0.22 (box fill)
//     strokeAlpha?: number;                        // 0..1; default 1 (opaque outline)
//     label?: string;
//     imageUri?: string;                           // image badge inside a box
//     color?: string;                              // hex; default theme color
//     mode?: '2d' | '3d';                          // default '2d'; '3d' SCAFFOLD only
//     orient?: 'plane' | 'camera';                 // default 'plane'
//     depthOcclusion?: boolean;                    // default false (legacy rendering)
//   }
//
// TWO overlay namespaces, rendered as a UNION (see `AROverlayStore`):
//   1. JS-set overlays — declarative `overlays` prop / imperative ref
//      methods, forwarded through the `RNSARCameraViewManager` view
//      commands.
//   2. Plugin-set overlays — native plugins place overlays directly via
//      `RNISARPluginRegistry.shared.setOverlays(...)` (zero JS latency).
// JS `setOverlays` never clobbers plugin overlays and vice-versa; the
// draw view renders both sets every frame.

import Foundation
import UIKit
import simd

// MARK: - Overlay model

/// One AR overlay annotation.  Value type (struct) so snapshots handed
/// to the draw view are cheap, immutable copies — no shared mutable
/// state across the AR thread / main thread boundary.
public struct RNISAROverlay: Equatable {

    /// Shape rendering style.
    public enum Shape: String {
        /// Stroked outline only (default) — a polygon connecting the
        /// projected corners.
        case outline
        /// FILLED box: a semi-transparent face behind a thin border — the TS
        /// contract (AROverlay.ts `shape`) both platforms honour for
        /// `worldQuad` overlays.  Fill opacity is the overlay's `fillAlpha`
        /// (default `defaultFillAlpha` ≈ 22%, Android `DEFAULT_FILL_ALPHA`
        /// parity).  For a `worldPosition` marker, a small square billboard.
        case box
    }

    /// Render mode.  `.twoD` (default) is the only mode implemented in
    /// v1.  `.threeD` is a SCAFFOLD this release — treated as `.twoD`
    /// with a one-time log warning; the native 3D hook in
    /// `AROverlayDrawView` is where a SceneKit renderer will plug in.
    public enum Mode: String {
        case twoD = "2d"
        case threeD = "3d"
    }

    /// Stable identifier.  Diffed by id against the current set so a
    /// declarative `overlays` prop / imperative update can replace one
    /// overlay without disturbing the rest.
    public let id: String

    /// A single world point (metres, ARKit world frame).  When set (and
    /// `worldQuad` is nil), the overlay is a billboard marker/box facing
    /// the camera at this point, sized by `sizeMeters`.
    public let worldPosition: simd_float3?

    /// Box extent (width, height) in metres at `worldPosition`.  Only
    /// meaningful with `worldPosition`.  Defaults to a small marker.
    public let sizeMeters: CGSize?

    /// Explicit world corners (3-4 points, metres).  When set, the
    /// overlay is the polygon through these corners (e.g. a detected
    /// quad).  Takes precedence over `worldPosition`.
    public let worldQuad: [simd_float3]?

    /// Shape style — `.outline` (default) or `.box`.
    public let shape: Shape

    /// Opacity (0...1) of the `.box` fill face.  Ignored by `.outline`
    /// (which has no fill).  Defaults to `defaultFillAlpha` (~22%), so an
    /// overlay that omits the JS `fillAlpha` key renders EXACTLY as it did
    /// before the field existed.  Always in 0...1: the init sanitises, so
    /// no consumer needs to re-validate.
    public let fillAlpha: CGFloat

    /// Opacity (0...1) of the quad's STROKE (outline).  Defaults to
    /// `defaultStrokeAlpha` (1 — fully opaque), so an overlay that omits the
    /// JS `strokeAlpha` key renders EXACTLY as it did before the field
    /// existed.  `0` yields a FILL-ONLY quad, which is what lets a tiled set
    /// of adjacent quads read as one continuous region (no internal seams).
    /// Always in 0...1: the init sanitises.
    public let strokeAlpha: CGFloat

    /// Optional text label drawn near the overlay's centroid.
    public let label: String?

    /// Optional IMAGE drawn INSIDE the box, anchored bottom-left and inset,
    /// so it annotates without covering what the box marks.  A local
    /// `file://` path; `RNSARCameraView` loads and CACHES it by URI and
    /// silently ignores an undecodable file.
    public let imageUri: String?

    /// Stroke / label color.  Defaults to a theme color when the JS hex
    /// is absent / unparseable.
    public let color: UIColor

    /// Render mode (`.twoD` default; `.threeD` is scaffold-only — see
    /// `Mode`).
    public let mode: Mode

    /// `orient == 'camera'` on a `.box` `worldQuad` overlay ⇒ draw the box
    /// as a camera-facing, screen-upright BILLBOARD (sized by the quad's
    /// edges at its centroid) instead of a plane-oriented outline.  Default
    /// false = 'plane' = byte-identical to every pre-`orient` build.  See
    /// AROverlay.ts `orient`.
    public let billboard: Bool

    /// Opt-in for the renderer's box-vs-box depth-occlusion scheme on a
    /// `.box` overlay.  Default false = the LEGACY rendering pipeline,
    /// exactly as every pre-`depthOcclusion` build drew it (no depth
    /// writer, no depth reads, fill under stroke in the historical overlay
    /// order).  true = the box participates in depth occlusion (see the
    /// "Depth participation" section in `RNSARCameraView`).  Occlusion is
    /// strictly between opted-in boxes.  See AROverlay.ts `depthOcclusion`.
    public let depthOcclusion: Bool

    public init(
        id: String,
        worldPosition: simd_float3?,
        sizeMeters: CGSize?,
        worldQuad: [simd_float3]?,
        shape: Shape,
        label: String?,
        color: UIColor,
        mode: Mode,
        // Trailing + defaulted ON PURPOSE: this memberwise init is public SPI
        // (native plugins construct overlays with it), so every pre-existing
        // call site keeps compiling unchanged and keeps the ~22% fill.
        fillAlpha: CGFloat = RNISAROverlay.defaultFillAlpha,
        strokeAlpha: CGFloat = RNISAROverlay.defaultStrokeAlpha,
        imageUri: String? = nil,
        billboard: Bool = false,
        depthOcclusion: Bool = false
    ) {
        self.id = id
        self.worldPosition = worldPosition
        self.sizeMeters = sizeMeters
        self.worldQuad = worldQuad
        self.shape = shape
        self.label = label
        self.color = color
        self.mode = mode
        self.imageUri = imageUri
        self.billboard = billboard
        self.depthOcclusion = depthOcclusion
        // Sanitise HERE (not just in `from(dictionary:)`) so the 0...1
        // invariant holds for the native-plugin path too — this is the one
        // funnel every overlay passes through.
        self.fillAlpha = Self.sanitizedFillAlpha(fillAlpha)
        self.strokeAlpha = Self.sanitizedStrokeAlpha(strokeAlpha)
    }

    /// Coerce a caller-supplied fill alpha to the honoured range.  Anything
    /// non-finite (NaN / ±inf) or outside 0...1 falls back to
    /// `defaultFillAlpha` rather than being silently clipped — a nonsense
    /// value means the caller is confused, and the safest read of "I asked
    /// for a fill" is the documented default, not "invisible" (0) or
    /// "opaque" (1), either of which would hide the subject or the feed.
    public static func sanitizedFillAlpha(_ raw: CGFloat) -> CGFloat {
        guard raw.isFinite, raw >= 0, raw <= 1 else { return defaultFillAlpha }
        return raw
    }

    /// Coerce a caller-supplied stroke alpha to the honoured range.  Same
    /// contract as `sanitizedFillAlpha`: nonsense (NaN, 3, -1, a bridged
    /// boolean) falls back to the OPAQUE default rather than being clipped,
    /// so a malformed value can never silently erase an outline.
    public static func sanitizedStrokeAlpha(_ raw: CGFloat) -> CGFloat {
        guard raw.isFinite, raw >= 0, raw <= 1 else { return defaultStrokeAlpha }
        return raw
    }

    /// Default theme color when none / an unparseable hex is supplied.
    /// Cyan matches the example overlay (`#00E5FF`).
    public static let defaultColor = UIColor(
        red: 0.0, green: 0.898, blue: 1.0, alpha: 1.0
    )

    /// Default marker extent (metres) for a bare `worldPosition` with no
    /// `sizeMeters` — a ~6 cm square so a single anchor point is visible.
    public static let defaultMarkerExtent: CGFloat = 0.06

    /// Default `.box` fill opacity when JS omits `fillAlpha`.  This is the
    /// value `RNSARCameraView` hardcoded before the field existed, and the
    /// Android twin's `DEFAULT_FILL_ALPHA` (which rounds back to the legacy
    /// 0x38 byte ≈ 22%) — keeping the two platforms and every pre-`fillAlpha`
    /// caller pixel-identical.
    public static let defaultFillAlpha: CGFloat = 0.22

    /// Default stroke opacity when JS omits `strokeAlpha`: fully opaque —
    /// every shape was unconditionally stroked before the field existed, so
    /// this keeps every pre-`strokeAlpha` caller pixel-identical.
    public static let defaultStrokeAlpha: CGFloat = 1.0

    /// Build from the JS bridge dictionary shape (the same keys the TS
    /// `AROverlay` interface serialises to).  Returns `nil` when there's
    /// no `id` (the only required field) or no geometry at all
    /// (`worldPosition`/`worldQuad` both missing) — a geometryless
    /// overlay can never be drawn.
    public static func from(dictionary dict: [String: Any]) -> RNISAROverlay? {
        guard let id = dict["id"] as? String, !id.isEmpty else { return nil }

        let worldPosition = parseVec3(dict["worldPosition"])
        let worldQuad = parseQuad(dict["worldQuad"])
        // Need at least one geometry source.
        guard worldPosition != nil || (worldQuad?.isEmpty == false) else {
            return nil
        }

        let sizeMeters: CGSize? = {
            guard let arr = dict["sizeMeters"] as? [Any], arr.count >= 2,
                  let w = numeric(arr[0]), let h = numeric(arr[1]) else {
                return nil
            }
            return CGSize(width: w, height: h)
        }()

        let shape: Shape = {
            if let s = dict["shape"] as? String, let parsed = Shape(rawValue: s) {
                return parsed
            }
            return .outline
        }()

        let mode: Mode = {
            if let m = dict["mode"] as? String, let parsed = Mode(rawValue: m) {
                return parsed
            }
            return .twoD
        }()

        let color: UIColor = {
            if let hex = dict["color"] as? String,
               let parsed = UIColor(hexString: hex) {
                return parsed
            }
            return defaultColor
        }()

        let label = dict["label"] as? String

        // Empty string → nil: JS clearing the badge image sends '' on some
        // paths, and an empty path must read as "no image", not as a load
        // failure.
        let imageUri: String? = {
            guard let s = dict["imageUri"] as? String, !s.isEmpty else { return nil }
            return s
        }()

        // Absent key → default.  A present-but-nonsense value (NaN, 3, -1, a
        // string, a BOOLEAN — see `numeric`, where a bridged `true`/`false`
        // would otherwise slip through the NSNumber cast as 1.0/0.0) also →
        // default: `numeric` rejects non-numbers and the init sanitises the
        // range.  JS is never trusted to be in-range OR in-type.
        let fillAlpha = numeric(dict["fillAlpha"]) ?? defaultFillAlpha
        let strokeAlpha = numeric(dict["strokeAlpha"]) ?? defaultStrokeAlpha
        // `orient: 'camera'` ⇒ billboard.  Any other / absent value ⇒ 'plane'
        // (false) ⇒ byte-identical to pre-`orient` builds.
        let billboard = (dict["orient"] as? String) == "camera"
        // `depthOcclusion` — genuine-boolean gate (fallback-not-clip, the
        // mirror of `numeric`'s boolean REJECTION): only a real bridged
        // boolean opts in.  A number, string, or any other nonsense falls
        // back to false — the legacy rendering — rather than being coerced,
        // so a malformed value can never silently change how a pre-existing
        // consumer's boxes draw.  Android gates on ReadableType.Boolean for
        // the same result.
        let depthOcclusion: Bool = {
            guard let n = dict["depthOcclusion"] as? NSNumber,
                  CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
            return n.boolValue
        }()

        return RNISAROverlay(
            id: id,
            worldPosition: worldPosition,
            sizeMeters: sizeMeters,
            worldQuad: (worldQuad?.isEmpty == false) ? worldQuad : nil,
            shape: shape,
            label: label,
            color: color,
            mode: mode,
            fillAlpha: fillAlpha,
            strokeAlpha: strokeAlpha,
            imageUri: imageUri,
            billboard: billboard,
            depthOcclusion: depthOcclusion
        )
    }

    // MARK: Dictionary parsing helpers

    /// Parse one bridged JS value as a number.  The single numeric funnel for
    /// EVERY field (`fillAlpha`, `strokeAlpha`, `sizeMeters`, `worldPosition`,
    /// `worldQuad`), so a `nil` here means "JS sent a non-number" for all of
    /// them alike.
    private static func numeric(_ v: Any?) -> CGFloat? {
        if let n = v as? NSNumber {
            // A JS boolean bridges to `__NSCFBoolean`, which IS an NSNumber —
            // so the cast above accepts it and `doubleValue` yields 1.0/0.0.
            // That is NOT harmless: both land INSIDE 0...1, so
            // `sanitizedFillAlpha` passes them through untouched and
            // `fillAlpha: true` renders an OPAQUE fill that hides the camera
            // feed, `fillAlpha: false` (the `fillAlpha: cond && 0.5`
            // short-circuit idiom) the invisible fill this field exists to
            // prevent.  Android's `readAlpha` gates on `ReadableType.Number`
            // and rejects booleans → default; reject them here so both
            // platforms land on the same default.
            //
            // Applies to every caller, not just the alphas: a boolean in a
            // `sizeMeters` / `worldPosition` / `worldQuad` slot is equally
            // meaningless, and dropping it (→ a defaulted size, or a
            // geometryless overlay `from(dictionary:)` discards) beats
            // silently treating `true` as 1 metre.
            guard CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
            return CGFloat(n.doubleValue)
        }
        if let d = v as? Double { return CGFloat(d) }
        if let i = v as? Int { return CGFloat(i) }
        return nil
    }

    private static func parseVec3(_ v: Any?) -> simd_float3? {
        guard let arr = v as? [Any], arr.count >= 3,
              let x = numeric(arr[0]), let y = numeric(arr[1]),
              let z = numeric(arr[2]) else {
            return nil
        }
        return simd_float3(Float(x), Float(y), Float(z))
    }

    private static func parseQuad(_ v: Any?) -> [simd_float3]? {
        guard let arr = v as? [Any] else { return nil }
        var pts: [simd_float3] = []
        pts.reserveCapacity(arr.count)
        for item in arr {
            guard let p = parseVec3(item) else { continue }
            pts.append(p)
        }
        // A polygon needs at least 3 corners; cap at 4 (the contract's
        // "3-4 points").
        guard pts.count >= 3 else { return nil }
        return Array(pts.prefix(4))
    }
}


// MARK: - UIColor hex parsing

extension UIColor {
    /// Parse a CSS-style hex string: `#RGB`, `#RGBA`, `#RRGGBB`, or
    /// `#RRGGBBAA` (the leading `#` is optional).  Returns `nil` for
    /// anything unparseable so the caller can fall back to a theme color.
    public convenience init?(hexString raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        // Expand shorthand #RGB / #RGBA to #RRGGBB / #RRGGBBAA.
        if s.count == 3 || s.count == 4 {
            s = s.map { "\($0)\($0)" }.joined()
        }
        guard s.count == 6 || s.count == 8,
              let value = UInt64(s, radix: 16) else {
            return nil
        }
        let r, g, b, a: CGFloat
        if s.count == 8 {
            r = CGFloat((value & 0xFF00_0000) >> 24) / 255.0
            g = CGFloat((value & 0x00FF_0000) >> 16) / 255.0
            b = CGFloat((value & 0x0000_FF00) >> 8) / 255.0
            a = CGFloat(value & 0x0000_00FF) / 255.0
        } else {
            r = CGFloat((value & 0xFF0000) >> 16) / 255.0
            g = CGFloat((value & 0x00FF00) >> 8) / 255.0
            b = CGFloat(value & 0x0000FF) / 255.0
            a = 1.0
        }
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}


// MARK: - Overlay store

/// Process-wide store of active overlays, split into two namespaces:
/// JS-set (declarative prop / imperative ref) and plugin-set (native
/// plugins via `RNISARPluginRegistry`).  Mounted `RNSARCameraView`s
/// subscribe (via `addObserver`) and re-read `snapshot()` to redraw.
///
/// THREAD SAFETY: mutations come from the bridge / main thread (JS
/// commands) and arbitrary plugin queues (`setOverlays`); reads come from
/// the main thread (the draw view).  All access is serialised by an
/// internal lock; `snapshot()` returns a value-type array copy so the
/// reader never holds the lock while drawing.
@objc(RNISAROverlayStore)
public final class RNISAROverlayStore: NSObject {

    /// Shared instance — singleton because the overlay set is global to
    /// the (single) AR session, matching `RNSARSession.shared`.
    @objc public static let shared = RNISAROverlayStore()

    /// Notification posted (on any thread) whenever either namespace
    /// changes.  Mounted draw views observe it to mark themselves dirty.
    /// (Used for the imperative / plugin paths; the per-frame redraw in
    /// `RNSARCameraView` already refreshes geometry every frame, so this
    /// is mainly to pick up SET changes between frames.)
    public static let overlaysChanged =
        Notification.Name("RNISAROverlaysChanged")

    /// JS-set overlays, keyed by id (last-write-wins per id).  Ordered
    /// list preserved separately for deterministic draw order.
    private var jsById: [String: RNISAROverlay] = [:]
    private var jsOrder: [String] = []

    /// Plugin-set overlays, same structure, separate namespace.
    private var pluginById: [String: RNISAROverlay] = [:]
    private var pluginOrder: [String] = []

    private let lock = NSLock()

    private override init() { super.init() }

    // MARK: JS namespace

    /// Replace the ENTIRE JS overlay set (the declarative `overlays`
    /// prop / imperative `setOverlays`).  Plugin overlays are untouched.
    public func setJSOverlays(_ overlays: [RNISAROverlay]) {
        lock.lock()
        jsById.removeAll(keepingCapacity: true)
        jsOrder.removeAll(keepingCapacity: true)
        for o in overlays {
            if jsById[o.id] == nil { jsOrder.append(o.id) }
            jsById[o.id] = o
        }
        lock.unlock()
        postChanged()
    }

    /// Add or replace a single JS overlay (imperative `addOverlay`).
    public func addJSOverlay(_ overlay: RNISAROverlay) {
        lock.lock()
        if jsById[overlay.id] == nil { jsOrder.append(overlay.id) }
        jsById[overlay.id] = overlay
        lock.unlock()
        postChanged()
    }

    /// Remove a single JS overlay by id (imperative `removeOverlay`).
    /// No-op if absent.
    public func removeJSOverlay(_ id: String) {
        lock.lock()
        jsById.removeValue(forKey: id)
        jsOrder.removeAll { $0 == id }
        lock.unlock()
        postChanged()
    }

    /// Clear ALL JS overlays (imperative `clearOverlays`).  Plugin
    /// overlays are untouched.
    public func clearJSOverlays() {
        lock.lock()
        jsById.removeAll(keepingCapacity: true)
        jsOrder.removeAll(keepingCapacity: true)
        lock.unlock()
        postChanged()
    }

    // MARK: Plugin namespace

    /// Replace the ENTIRE plugin overlay set.  JS overlays are untouched.
    public func setPluginOverlays(_ overlays: [RNISAROverlay]) {
        lock.lock()
        pluginById.removeAll(keepingCapacity: true)
        pluginOrder.removeAll(keepingCapacity: true)
        for o in overlays {
            if pluginById[o.id] == nil { pluginOrder.append(o.id) }
            pluginById[o.id] = o
        }
        lock.unlock()
        postChanged()
    }

    /// Add or replace a single plugin overlay.
    public func addPluginOverlay(_ overlay: RNISAROverlay) {
        lock.lock()
        if pluginById[overlay.id] == nil { pluginOrder.append(overlay.id) }
        pluginById[overlay.id] = overlay
        lock.unlock()
        postChanged()
    }

    /// Remove a single plugin overlay by id.  No-op if absent.
    public func removePluginOverlay(_ id: String) {
        lock.lock()
        pluginById.removeValue(forKey: id)
        pluginOrder.removeAll { $0 == id }
        lock.unlock()
        postChanged()
    }

    /// Clear ALL plugin overlays.  JS overlays are untouched.
    public func clearPluginOverlays() {
        lock.lock()
        pluginById.removeAll(keepingCapacity: true)
        pluginOrder.removeAll(keepingCapacity: true)
        lock.unlock()
        postChanged()
    }

    // MARK: Read

    /// Snapshot of the UNION of both namespaces, in draw order (JS first,
    /// then plugin).  Returns a value-type array copy so the caller can
    /// iterate + draw without holding the lock.
    public func snapshot() -> [RNISAROverlay] {
        lock.lock()
        defer { lock.unlock() }
        var out: [RNISAROverlay] = []
        out.reserveCapacity(jsOrder.count + pluginOrder.count)
        for id in jsOrder { if let o = jsById[id] { out.append(o) } }
        for id in pluginOrder { if let o = pluginById[id] { out.append(o) } }
        return out
    }

    /// Whether there are no overlays in either namespace.  Cheap gate the
    /// draw view can check to skip work.
    public var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return jsOrder.isEmpty && pluginOrder.isEmpty
    }

    private func postChanged() {
        NotificationCenter.default.post(
            name: Self.overlaysChanged, object: nil
        )
    }
}
