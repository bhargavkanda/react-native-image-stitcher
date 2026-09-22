// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoAvfSource — the DECOUPLED pano+ frame source (iOS).
//
// S3 of the decoupled-capture architecture (2026-08-30).
//
// ── What this is, and what it deliberately is NOT ────────────────────────
//
// It is A SECOND PRODUCER AGAINST AN UNCHANGED CONSUMER.  `RNISPanoCore`'s
// entry point is a bare `CVPixelBufferRef` + a quaternion + per-frame
// intrinsics — no ARKit type appears in the signature, and it already accepts
// `kCVPixelFormatType_420YpCbCr8BiPlanar{Full,Video}Range`, which is exactly
// what an `AVCaptureVideoDataOutput` delivers.  So this file replaces
// `RNISPanoPlusPlugin.process(_:)` — a 40-line adapter — and NOTHING BELOW IT.
// The engine, the strip painter, the pack writer, the ledger, the preview
// band, the SDK surface and the router are all reused byte for byte.
//
// It is NOT a new engine and NOT a new pack.  If a future edit here starts
// reimplementing something the engine already does, that is the failure mode
// this whole design is organised against.
//
// ── Why it exists ────────────────────────────────────────────────────────
//
// ARKit publishes no ultra-wide video format on iPhone17,1 (0 of 22, measured),
// so `ARConfiguration.videoFormat` cannot reach 0.5×.  And the low-end Android
// this tier targets has no guaranteed ARCore at all, where the router's own
// `ar-unsupported → PANO` row is the ONLY row.  0.5× and the Android port are
// therefore the same piece of work, and this is the iOS half of it.
//
// ── The three things it must get right ───────────────────────────────────
//
//  1. THE LENS: the PHYSICAL device the caller ASKED FOR, never a virtual one.
//     Which of the two — ultra-wide (0.5×, the default) or wide (1×) — is the
//     `lens` option, i.e. the host's `panoPlusLens` flag as written by Pano's
//     lens chip (parity, 2026-09-03), parsed strictly by `RNISPanoLensRequest`
//     and honoured by the SWEEP and the IDLE VIEWFINDER through the one
//     selector (`planFormat`).  A lens the body does not publish is a named
//     refusal, never a swap, and the pack stamps the request beside the run.
//     Physical, because on a `dualWide`/`triple` the system switches
//     constituent lens as a function of zoom, keeping `imageWidth` IDENTICAL
//     while `fx` jumps ~1.85× — and the engine's `format-change` abort tests
//     DIMENSIONS, so a constituent switch is a focal discontinuity it
//     structurally cannot see.  On the physical device that failure cannot
//     occur.  "0.5×" is never a zoom of 0.5 either: `videoZoomFactor` minimum
//     1.0 IS the constituent lens's full field of view, so on the physical
//     device we set NOTHING.
//
//  2. THE RATE: 60 fps FILTERS, sensor area RANKS.  Frame rate is the
//     motion-blur defence on a moving sweep and is not tradeable, so a lens
//     that publishes no 4:3 format reaching 60 fps is a FINDING reported as a
//     refusal — never a silent downgrade to 30.
//
//  3. THE TIME ALIGNMENT: every frame's attitude is sampled at `PTS + τ` by
//     SLERP between the two bracketing motion samples, in the SHARED C++
//     `AttitudeAligner` (via RNISPanoAttitude).  Not here — there, so the
//     Android leg runs the same arithmetic.
//
// ── The orientation trap, avoided by doing nothing ───────────────────────
//
// `AVCaptureConnection.videoOrientation` is deliberately NOT set.  The buffer
// then arrives in the native sensor landscape raster, which is the raster the
// delivered intrinsics are expressed against — and the engine's whole contract
// is that nothing is rotated mid-pipeline (output orientation is applied ONCE,
// at `finalCanvas()`).  Setting it would rotate the PIXELS while the
// intrinsics stayed unoriented: the standing repo trap, in a new place.
//
// ⚠ AND UNTIL v14 THE PARENTHESIS ABOVE WAS A PROMISE NOBODY KEPT.
// `finalCanvas()` applied the AXIS/SIGN bake — an undo of the engine's own
// `axisMatrix`, which lands back in THIS raster — and no device-orientation
// term at all.  So the deliverable left the phone sensor-referenced, and came
// out upright only when the hold happened to match the sensor's native
// landscape: correct for a landscape-left sweep, a quarter turn over for a
// portrait one.  That is the operator's 2026-09-02 report ("the output image is
// sideways"), reproduced on his own packs.  The turn is now real —
// `rnis::pano::Config::outputRotationCwDeg`, supplied by the SDK from the hold
// it measured at Start, baked once in `renderOriented()`.  Nothing on THIS path
// changes: not setting `videoOrientation` is still right, and still for the
// reason above.
//
// ── Threading ────────────────────────────────────────────────────────────
//
// `captureOutput` runs on `videoQueue`; the motion handler on its own
// `OperationQueue`.  The aligner's lock lives in RNISPanoAttitude, in one
// place.  `RNISPanoCore.ingest` copies into a pre-allocated ring slot and
// returns, exactly as on the AR arm — this delegate never allocates a canvas
// and never touches OpenCV.

import AVFoundation
import CoreMedia
import CoreMotion
import CoreVideo
import Foundation
import QuartzCore
import simd

@objc(RNISPanoAvfSource)
public final class RNISPanoAvfSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {

    @objc public static let shared = RNISPanoAvfSource()

    // MARK: - Errors

    public struct StartFailure: Error {
        public let code: String
        public let detail: String
    }

    // MARK: - State

    private let session = AVCaptureSession()
    private let videoQueue = DispatchQueue(label: "io.imagestitcher.rn.panoplus.avf.video")
    /// v12 REVIEW FIX (blocker) — THE ONE QUEUE EVERY SESSION MUTATION RUNS ON.
    /// `AVCaptureSession` is not thread-safe, and before this queue existed the
    /// idle viewfinder configured it from the RN module method queue while
    /// start/stop/cancel configured it from `DispatchQueue.global` — and the
    /// racy ordering was the COMMON sweep-start path (the surface's idle-off
    /// effect fires in the React commit AFTER Start reaches the bridge).
    /// `start()`, `stop()`, `startIdlePreview()` and `stopIdlePreview()` are
    /// now thin wrappers that hop here; the interruption/runtime-error restart
    /// handlers bounce here asynchronously.  Nothing on this queue ever hops
    /// back onto it, so there is no re-entrancy to deadlock on.
    private let sessionQ = DispatchQueue(label: "io.imagestitcher.rn.panoplus.avf.session")
    private let motionManager = CMMotionManager()
    private var device: AVCaptureDevice?
    private var output: AVCaptureVideoDataOutput?

    /// Requested motion rate.  CMMotionManager exposes only a REQUESTED
    /// interval and silently clamps it, so we ask for more than exists and
    /// report what actually arrives (`deliveredMotionHz` below).
    private static let requestedMotionHz = 200.0

    /// How long the input open may be retried while a previous owner (ARKit)
    /// finishes releasing the camera.  Bounded, and the attempt count is
    /// REPORTED, so a handoff that is quietly getting slower is visible in the
    /// pack rather than only when it finally exceeds the budget.
    private static let inputOpenBudgetS = 0.60

    /// Written by start/stop on the bridge queue and read on `videoQueue`, so
    /// it goes through `motionLock` like every other cross-queue field.  The
    /// alternative is a torn read nobody would ever reproduce.
    private var running = false
    private var sessionDir: String = ""
    private var config: [String: Any] = [:]

    /// ── THE RAW MOTION SERIES, WRITTEN TO `sensors.jsonl` ────────────────
    ///
    /// Android has written `sensors.jsonl` on every sweep for months; this arm
    /// wrote NOTHING, so an iOS pack could not answer a question about its own
    /// motion. The specific casualty: the shipped lateral guard
    /// (`usePanMotion.ts`) is an EMA of `|gyro.x|` and it runs on iOS too, but
    /// no iOS pack carried a gyro trace — so what the guard actually saw on a
    /// capture was not measurable, only reconstructed. On Android four
    /// independent reconstructions of ONE sweep spanned 0.046 to 0.533.
    ///
    /// `dm.rotationRate` is the quantity that guard consumes and it was
    /// already in hand in the callback below, discarded every sample at 200 Hz.
    ///
    /// ⚠ NOT the magnetometer question. This arm is `.xArbitraryZVertical`
    /// and ARKit's default is `.gravity`, so BOTH iOS arms are mag-free and
    /// the compass contamination that makes Android's `crossRectifyDeg` ~90%
    /// heading correction cannot occur here. There is no second stream to
    /// difference because there is no compass term to remove — which is also
    /// why `crossRectifyDeg` is a TRUSTWORTHY hand-motion signal on iOS and
    /// not on Android.
    private var sensorsFp: UnsafeMutablePointer<FILE>?
    private var sensorRows: Int64 = 0
    private var sensorWriteFailed = false

    /// Set once at configure; used for the fallback intrinsics and reported.
    private var fovFx: Double = 0
    private var frameW: Int = 0
    private var frameH: Int = 0
    private var intrinsicsDelivered = false
    private var holdBudgetS: Double = 0.006

    // Counters — all reported, none inferred.
    private var framesDelivered: Int64 = 0
    private var framesIngested: Int64 = 0
    private var framesRefused: Int64 = 0
    private var framesFatal: Int64 = 0
    private var framesIntrinsicsDelivered: Int64 = 0
    private var framesIntrinsicsFovDerived: Int64 = 0
    private var holdsAttempted: Int64 = 0
    private var holdsRescued: Int64 = 0
    // v12 — the camera lock's per-frame witness on THIS arm.  The AR arm's
    // equivalent (`observedUnlockedFrames`) is driven by its frame plugin;
    // nothing drives it here, so a zero from the shared lock would be
    // "unmonitored", not "held".  This counter is the monitor: incremented on
    // every delivered frame whose device reports a non-locked exposure mode
    // while the start-time lock claimed success.
    private var lockArmed = false
    private var framesObservedUnlocked: Int64 = 0
    private var motionSamples: Int64 = 0
    private var firstMotionS: Double = .nan
    private var lastMotionS: Double = .nan
    private var lastPtsS: Double = .nan
    private var ptsGapsOverTwoFrames: Int64 = 0
    private var firstRefusalName: String = ""

    // ── THE SESSION'S OWN FAULT LEDGER (2026-08-31) ────────────────────────
    //
    // Until this existed the file registered NO `AVCaptureSession`
    // notifications at all, and the consequences all landed as the same
    // unreadable pack:
    //
    //  · A phone call, Control Centre, or backgrounding mid-sweep stops
    //    delivery.  `running` stayed true, `RNISPanoCore` stayed running, and
    //    CoreMotion kept pushing at 200 Hz — so the frame counters froze with
    //    nothing anywhere able to say an interruption had happened.
    //  · iOS does not always auto-resume (`videoDeviceNotAvailableInBackground`
    //    needs an explicit `startRunning()`), so the sweep simply never came
    //    back.
    //  · A media-services reset killed the session outright and the pack
    //    reported a frozen `framesDelivered` and `firstRefusal: null`.
    //  · And — the one that matters most for THIS arm — if ARKit is still
    //    holding the camera when we open the ultra-wide, `canAddInput` may
    //    well succeed and the conflict surface as an interruption instead.
    //    Without an observer that is a silent zero-frame pack; with one it is
    //    a named reason.
    //
    // These are written on the notification queue (main) and read at `stop()`,
    // so they go through `motionLock` like every other cross-queue field.
    private var interruptions: Int64 = 0
    private var interruptionsEnded: Int64 = 0
    private var firstInterruptionReason: String = ""
    private var runtimeErrors: Int64 = 0
    private var firstRuntimeError: String = ""
    private var restartsAttempted: Int64 = 0
    private var interrupted = false
    private var observers: [NSObjectProtocol] = []

    /// How many times the input open had to be retried before it took, and the
    /// last failure if it never did.  A camera another client is releasing is
    /// not instantly free, so a single attempt turns a 30 ms handoff into a
    /// permanent refusal.
    private var inputOpenAttempts = 0

    /// Guards EVERY field written from the CoreMotion queue and read at
    /// `stop()`: the acceleration magnitude and the three motion counters.  One
    /// lock, because they are written in the same callback.
    private let motionLock = NSLock()
    private var lastAccelMagMps2: Double = .nan

    private override init() { super.init() }

    /// A preview layer bound to this session.  Vended for a future
    /// `RNISPanoSourceView`; nothing mounts it yet, which is why the operator
    /// aims by the engine's own live preview band on this arm.
    @objc public func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let l = AVCaptureVideoPreviewLayer(session: session)
        // `.resizeAspect`, NOT `.resizeAspectFill` — the operator's 2026-09-01
        // report: "I see more than where I stopped the pan in the output."
        // Fill CROPS a 103.6° 4:3 frame to the portrait screen, so the sweep
        // captures (and the tail flush paints) content the viewfinder never
        // showed.  Aspect-fit letterboxes instead: every pixel the engine will
        // ingest is on screen, which is the only honest framing surface for a
        // capture instrument.  The letterbox bars are the price and they are
        // the truthful part: they say "this is the whole frame".
        l.videoGravity = .resizeAspect
        return l
    }

    // MARK: - Idle preview (v12)

    /// True between a successful `startIdlePreview()` and the matching stop.
    /// Never true during a sweep — a live sweep IS the preview.
    private var idlePreviewActive = false

    /// `uniqueID` of the device the idle input was built on, so a repeat
    /// request for the SAME lens keeps the live feed instead of blinking it
    /// off and on, and a request for the OTHER lens is a clean close→open.
    /// `nil` whenever no idle input of ours is attached.  Session-queue only.
    private var idleDeviceUniqueId: String? = nil

    /// Run the session INPUT-ONLY so `RNISPanoSourceView` has something to
    /// draw before a sweep starts — the operator could not FRAME the first
    /// shot on this arm at all (black screen until Start, and the first frame
    /// anchors the whole canvas).
    ///
    /// ⚠️ CALL ONLY FROM THE BRIDGE MODULE QUEUE.  `AVCaptureSession` is not
    /// thread-safe and `start()` configures this same session object from that
    /// queue; routing idle preview through `PanoPlusBridge.setIdlePreview`
    /// gives both the SAME serialization for free.  A view that called this
    /// from the main thread would race a concurrent Start — which is why the
    /// view deliberately has no lifecycle of its own.
    ///
    /// No output, no delegate, no motion, no lock, no engine: nothing ingests,
    /// so this cannot produce a pack, drop a frame, or perturb a calibration.
    /// A sweep's `start()` strips the idle input first (its existing
    /// strip-first block) and owns the session from there; `stop()` leaves the
    /// session stopped and the SURFACE re-enables idle preview on its next
    /// phase change.
    ///
    /// RETURNS THE BRIDGE'S OWN ANSWER — `on`, a `reason` sentence, and the
    /// lens that is live (`lens` = device-type raw value, `lensRequested` =
    /// the flag spelling) — instead of a bare Bool.  Until parity the iOS
    /// refusal reached the screen as the two words `camera-open-failed`
    /// whatever had actually happened, while Android's explainer named the
    /// camera and the cause; the surface's own header says a reason the
    /// operator can read is "the whole difference between a black screen that
    /// looks broken and one that reports itself".
    @discardableResult
    public func startIdlePreview(options: [String: Any] = [:]) -> [String: Any] {
        return sessionQ.sync { startIdlePreviewOnSessionQ(options: options) }
    }

    private func startIdlePreviewOnSessionQ(options: [String: Any]) -> [String: Any] {
        motionLock.lock(); let live = running; motionLock.unlock()
        if live {
            // The sweep's own feed is showing, on the lens the sweep opened.
            return ["on": true,
                    "reason": "the sweep's own feed is showing",
                    "lens": config["lens"] ?? NSNull(),
                    "lensRequested": config["lensRequested"] ?? NSNull()]
        }
        // THE SAME SELECTOR THE SWEEP USES, so the viewfinder frames with the
        // camera `start()` will open — and refuses with the SAME code when
        // the requested lens is not on this body or its spelling is unknown.
        let plan: Plan
        do {
            plan = try Self.planFormat(options: options)
        } catch let f as StartFailure {
            return ["on": false, "reason": "\(f.code): \(f.detail)",
                    "lens": NSNull(), "lensRequested": NSNull()]
        } catch {
            return ["on": false, "reason": "panoplus-io: \(error)",
                    "lens": NSNull(), "lensRequested": NSNull()]
        }
        // v12/P5 — a lens change must re-plan, or the viewfinder keeps
        // showing the OLD camera after the operator flips 0.5x/1x.  Parity
        // refines it: the SAME camera asked for again is KEPT (no blink), the
        // OTHER camera is a full close first (one owner at a time).  The rule
        // is pure and host-tested in RNISPanoLensRequest.  The *OnSessionQ
        // form: we are already on sessionQ, and the public wrapper's sync hop
        // would deadlock.
        switch RNISPanoLensRequest.idleAction(idleActive: idlePreviewActive,
                                              sessionRunning: session.isRunning,
                                              liveUniqueId: idleDeviceUniqueId,
                                              plannedUniqueId: plan.device.uniqueID) {
        case .keep:
            return ["on": true,
                    "reason": "idle viewfinder already LIVE on the \(plan.lensLabel) "
                            + "(\(plan.lensRawValue))",
                    "lens": plan.lensRawValue,
                    "lensRequested": plan.lensRequested]
        case .reopen:
            stopIdlePreviewOnSessionQ()
        case .open:
            break
        }
        session.beginConfiguration()
        for i in session.inputs { session.removeInput(i) }
        for o in session.outputs { session.removeOutput(o) }
        // ⚠️ `.inputPriority` AND THE SWEEP'S OWN FORMAT, SINCE 2026-09-07.
        //
        // This used to be `.high` with no `activeFormat` and no frame-rate
        // pin, on the reasoning that "idle preview has no format contract to
        // defend (no engine, no calibration key)".  That reasoning is right
        // about the ENGINE and wrong about the OPERATOR, and he found it in
        // the field: `.high` is 1920x1080 on this body, so the viewfinder was
        // 16:9 while the sweep records the 4:3 1920x1440 format — same width,
        // a THIRD more height — and the panorama came back carrying a band
        // above and below what he had framed.  A viewfinder that does not
        // show the frame you are about to capture is a lie, and framing is
        // the one job it has.
        //
        // The free-running frame rate was the second half of the same
        // complaint ("when AR is on the viewfinder is smooth and when AR is
        // off it is stucking"): with no min/max duration the camera lengthens
        // its exposure in dim light and the preview drops below 60, which the
        // sweep's pinned 1/fps then hides the moment he holds the button.
        //
        // So idle now opens exactly what `start()` will open — same selector
        // (it always was), same `activeFormat`, same pinned rate.  The cost is
        // named rather than hidden: a pinned 60 fps means shorter exposures,
        // so the idle preview is DARKER in a dim room than `.high` was.  That
        // is the honest picture — it is what the sweep is going to record.
        session.sessionPreset = .inputPriority
        guard let input = try? AVCaptureDeviceInput(device: plan.device),
              session.canAddInput(input) else {
            session.commitConfiguration()
            idleDeviceUniqueId = nil
            return ["on": false,
                    "reason": "camera-open-failed: the \(plan.lensLabel) "
                            + "(\(plan.lensRawValue)) refused an input — another "
                            + "session may still hold it.",
                    "lens": NSNull(),
                    "lensRequested": plan.lensRequested]
        }
        session.addInput(input)
        session.commitConfiguration()

        // THE FORMAT, APPLIED THE WAY `start()` APPLIES IT — after the commit,
        // under the device lock.  `plan` already carries both: `planFormat`
        // picked this format for the sweep and REFUSES a lens that cannot
        // reach `fps`, so there is no second selector here to drift.
        //
        // A lock failure is NOT fatal here, unlike in `start()` where it is a
        // start refusal (the sweep cannot honestly record at an unapplied
        // format).  At idle the feed is still worth showing; what must not
        // happen is showing it while CLAIMING it matches.  So the reason
        // string says which of the two the operator is looking at.
        var formatApplied = false
        var formatError: String? = nil
        do {
            try plan.device.lockForConfiguration()
            plan.device.activeFormat = plan.format
            let dur = CMTimeMake(value: 1, timescale: Int32(plan.fps.rounded()))
            plan.device.activeVideoMinFrameDuration = dur
            plan.device.activeVideoMaxFrameDuration = dur
            plan.device.unlockForConfiguration()
            formatApplied = true
        } catch {
            formatError = "\(error)"
        }

        if !session.isRunning { session.startRunning() }
        idlePreviewActive = true
        idleDeviceUniqueId = plan.device.uniqueID
        let framing = formatApplied
            ? "\(plan.width)x\(plan.height) @ \(Int(plan.fps.rounded())) fps — "
              + "the frame the sweep will record"
            : "PREVIEW FORMAT NOT APPLIED (\(formatError ?? "unknown")) — this "
              + "viewfinder does NOT match what the sweep will record"
        return ["on": true,
                "reason": "idle viewfinder LIVE on the \(plan.lensLabel) "
                        + "(\(plan.lensRawValue)), \(framing)",
                "lens": plan.lensRawValue,
                "lensRequested": plan.lensRequested,
                "previewFormatApplied": formatApplied,
                "previewWidth": plan.width,
                "previewHeight": plan.height,
                "previewFps": plan.fps]
    }

    /// Idempotent; a no-op during a live sweep (the sweep owns the session and
    /// its teardown path already stops it).
    @objc public func stopIdlePreview() {
        sessionQ.sync { stopIdlePreviewOnSessionQ() }
    }

    private func stopIdlePreviewOnSessionQ() {
        motionLock.lock(); let live = running; motionLock.unlock()
        guard !live else { idlePreviewActive = false; idleDeviceUniqueId = nil; return }
        guard idlePreviewActive else { return }
        idlePreviewActive = false
        idleDeviceUniqueId = nil
        session.stopRunning()
        session.beginConfiguration()
        for i in session.inputs { session.removeInput(i) }
        for o in session.outputs { session.removeOutput(o) }
        session.commitConfiguration()
    }

    /// v12 REVIEW FIX — the per-frame lock witness, exposed so teardown can
    /// merge it into meta.json's lock block beside the AR-shaped counters
    /// (whose zeros on this arm mean "unmonitored", not "held").
    @objc public var framesObservedUnlockedCount: Int64 {
        var n: Int64 = 0
        videoQueue.sync { n = self.framesObservedUnlocked }
        return n
    }

    @objc public var isRunning: Bool {
        motionLock.lock(); defer { motionLock.unlock() }
        return running
    }

    // MARK: - The planned lens + format

    /// The lens and format a sweep on this arm WOULD open, resolved without
    /// touching the capture session.
    public struct Plan {
        public let device: AVCaptureDevice
        public let format: AVCaptureDevice.Format
        /// `AVCaptureDevice.DeviceType.rawValue` — the SAME spelling the
        /// capture-clock probe reports and the calibration store keys on.
        public let lensRawValue: String
        /// The REQUEST, in the flag's spelling (`ultraWide` | `wide`).  With
        /// the fallback gone it can differ from `lensRawValue` only by a
        /// refusal, and the pack still carries both so a reader never has to
        /// decode "0.5×" out of a device-type string.
        public let lensRequested: String
        /// True when the caller named no lens and the ultra-wide default
        /// applied — a default is a fact about the request, and the pack
        /// says so rather than letting it pass as a choice.
        public let lensDefaulted: Bool
        /// Pano's name for it: `0.5× ultra-wide` / `1× wide`.
        public let lensLabel: String
        public let width: Int
        public let height: Int
        public let fps: Double
    }

    /// ⚠️ THE CALIBRATION KEY IS A PROPERTY OF THE FORMAT, AND THE FORMAT IS
    /// CHOSEN HERE — which is why this is a `static` a NON-running caller can
    /// ask, and not a private step inside `start`.
    ///
    /// τ is stored under `model | lens | W×H | fps` because the rolling-shutter
    /// readout constant is folded into it and is a property of the format.  But
    /// the format is not something the HOST can know: it is whatever this
    /// selector picks on this body.  Before this function existed, the bridge
    /// looked τ up under `width 0, height 0` (its own `?? 0` defaults) while
    /// the calibration panel SAVED it under the real `1920x1440` the probe
    /// measured on.  Those are different keys, so a correctly measured and
    /// correctly persisted τ was never found, and the arm refused
    /// `alignment-unconfigured` forever — with the panel simultaneously
    /// reporting the record it had just written under `storedTauKeys`.  A
    /// precondition that cannot be satisfied is worse than a missing feature,
    /// because it looks like the feature is broken rather than absent.
    ///
    /// So: ONE selector, two callers, and the key a sweep looks under is by
    /// construction the key of the format that sweep will open.
    ///
    /// Cost is device discovery plus a format enumeration — no session, no
    /// input, no exclusivity claim — so it is safe to call while ARKit owns the
    /// camera, which is exactly when the surface needs to ask.
    public static func planFormat(options: [String: Any]) throws -> Plan {
        let targetFps = (options["targetFps"] as? NSNumber)?.doubleValue ?? 60.0

        // ── THE LENS ───────────────────────────────────────────────────
        // Parsed STRICTLY (RNISPanoLensRequest, host-tested): absent ⇒
        // ultra-wide, the flag's two spellings or the two device-type raw
        // values ⇒ that lens, anything else ⇒ `panoplus-bad-lens`.  The old
        // inline `!= "wide"` opened the ultra-wide on every unknown spelling,
        // which is a camera chosen by a guess — the defect class this arm's
        // other gates exist to refuse.
        let request: RNISPanoLensRequest
        do {
            request = try RNISPanoLensRequest.parse(options["lens"])
        } catch let bad as RNISPanoLensRequest.BadSpelling {
            throw StartFailure(code: bad.code, detail: bad.detail)
        }
        let wanted: AVCaptureDevice.DeviceType =
            request.lens == .ultraWide ? .builtInUltraWideCamera : .builtInWideAngleCamera

        // PHYSICAL device types only.  A virtual container is excluded by
        // construction, not by preference — see the file header.
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera],
            mediaType: .video, position: .back)
        guard !discovery.devices.isEmpty else {
            throw StartFailure(code: "panoplus-no-camera",
                               detail: "No back capture device was discovered.")
        }
        // THE REQUESTED LENS OR NOTHING.  There used to be a fallback to
        // "the first device found" that fired silently when the WIDE was
        // asked for and absent; the ultra-wide case already refused.  Both
        // now refuse, each under its own code: a sweep on a lens it did not
        // ask for has a different τ (readout differs) and a different
        // coverage, so a pack that ran on it would be unusable evidence.
        guard let device = discovery.devices.first(where: { $0.deviceType == wanted }) else {
            throw StartFailure(code: request.lens.absentCode,
                               detail: request.lens.absentDetail)
        }

        // ── THE FORMAT: rate FILTERS, area RANKS ───────────────────────
        var chosen: AVCaptureDevice.Format?
        var bestArea = -1.0
        for f in device.formats {
            var maxFps = 0.0
            for r in f.videoSupportedFrameRateRanges where r.maxFrameRate > maxFps {
                maxFps = r.maxFrameRate
            }
            guard maxFps >= targetFps - 0.5 else { continue }
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let w = Double(d.width), h = Double(d.height)
            guard h > 0, abs(w / h - 4.0 / 3.0) < 0.02 else { continue }
            let a = w * h
            if a > bestArea { bestArea = a; chosen = f }
        }
        guard let fmt = chosen else {
            throw StartFailure(
                code: "panoplus-no-60fps-format",
                detail: "This lens publishes no 4:3 format reaching \(Int(targetFps)) fps. "
                      + "Frame rate is the motion-blur defence on a moving sweep and is "
                      + "not tradeable, so this is reported as a refusal rather than "
                      + "silently downgraded to 30.")
        }

        let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
        return Plan(device: device,
                    format: fmt,
                    // Read off the DEVICE, not the request: by construction
                    // they agree (the guard above matched on `wanted`), and
                    // the pack's stamp must be what ran, not what was asked.
                    lensRawValue: device.deviceType.rawValue,
                    lensRequested: request.lens.rawValue,
                    lensDefaulted: request.defaulted,
                    lensLabel: request.lens.label,
                    width: Int(dims.width),
                    height: Int(dims.height),
                    fps: targetFps)
    }

    /// The plan as a plain dictionary, for the bridges and for JS.
    ///
    /// A REFUSAL IS AN ANSWER AND IS REPORTED AS ONE — `ok: false` with the
    /// hardware `reason`, never an exception and never a plausible-looking
    /// default.  A caller that gets `ok: false` must not fabricate a key: there
    /// is no format, so there is nothing for a τ to be keyed by.
    public static func plannedFormatReport(options: [String: Any] = [:]) -> [String: Any] {
        // The REQUEST rides every answer, refusals included, so a JS caller
        // asking "is there a 0.5× on this body" reads `lensRequested:
        // ultraWide, reason: panoplus-no-ultrawide` and not a bare refusal it
        // has to match back to its own question.  NSNull when the spelling
        // itself was refused — there is no request to report then.
        let requested: Any =
            (try? RNISPanoLensRequest.parse(options["lens"]))?.lens.rawValue ?? NSNull()
        do {
            let p = try planFormat(options: options)
            return [
                "ok": true,
                "lens": p.lensRawValue,
                "lensRequested": p.lensRequested,
                "lensLabel": p.lensLabel,
                "width": p.width,
                "height": p.height,
                "fps": p.fps,
                "reason": NSNull(),
                "detail": NSNull(),
            ]
        } catch let f as StartFailure {
            return ["ok": false, "reason": f.code, "detail": f.detail,
                    "lens": NSNull(), "lensRequested": requested,
                    "width": NSNull(), "height": NSNull(),
                    "fps": (options["targetFps"] as? NSNumber)?.doubleValue ?? 60.0]
        } catch {
            return ["ok": false, "reason": "panoplus-io", "detail": "\(error)",
                    "lens": NSNull(), "lensRequested": requested,
                    "width": NSNull(), "height": NSNull(),
                    "fps": (options["targetFps"] as? NSNumber)?.doubleValue ?? 60.0]
        }
    }

    // MARK: - Start

    /// Configure the capture device, start CoreMotion and start the session.
    /// Throws `StartFailure` with a `code` the bridge maps onto a JS rejection.
    ///
    /// REFUSES rather than degrades on: no ultra-wide, no 60 fps 4:3 format, a
    /// camera another session still holds, and an unusable alignment
    /// configuration (missing τ or unvalidated basis — those are checked by
    /// `RNISPanoAttitude.configure` before we ever open the camera).
    public func start(sessionDir: String, options: [String: Any]) throws -> [String: Any] {
        return try sessionQ.sync {
            try startOnSessionQ(sessionDir: sessionDir, options: options)
        }
    }

    private func startOnSessionQ(sessionDir: String,
                                 options: [String: Any]) throws -> [String: Any] {
        if isRunning {
            throw StartFailure(code: "panoplus-busy",
                               detail: "The AVF source is already running.")
        }

        let targetFps = (options["targetFps"] as? NSNumber)?.doubleValue ?? 60.0
        holdBudgetS = (options["holdBudgetS"] as? NSNumber)?.doubleValue ?? 0.006

        // ── 0. THE HARDWARE QUESTION IS ASKED BEFORE THE CALIBRATION ONE
        // Selection lives in `planFormat` and is called from exactly two
        // places: here, and the calibration KEY resolver.  See that function's
        // header for why those two must not be allowed to drift.
        //
        // ORDER CHANGED 2026-08-31, and the reason is the operator's screen and
        // not the code: on a body with no physical ultra-wide, the alignment
        // check fired first and told him to go and measure a τ.  Measuring it
        // would not have helped — there is no lens to measure it on.  A
        // hardware finding must outrank a calibration finding, or the panel
        // sends him to do work that cannot fix the fault.
        //
        // It does NOT weaken the "refuse before the camera opens" rule this
        // block was written for: `planFormat` is discovery plus a format
        // enumeration.  It opens no input, claims no exclusivity, and starts no
        // session, so both refusals still land before anything is running.
        let plan = try Self.planFormat(options: options)
        let device = plan.device
        let fmt = plan.format

        // ── 0a. THE SENSOR, ASKED BEFORE THE CAMERA ────────────────────
        // `startMotion()` used to `guard motionManager.isDeviceMotionAvailable
        // else { return }` and `start()` went on to `startRunning()` and
        // reported success.  Every frame then refused `buffer-empty` and the
        // operator got a live preview that could never paint — the exact
        // outcome the D7 intrinsics block and the 0b alignment block below are
        // both written to prevent.  The asymmetry was the tell:
        // `RNISPanoBasisCalibration.start` already refuses this case.
        //
        // Asked HERE, before anything is opened, so the refusal costs nothing.
        guard motionManager.isDeviceMotionAvailable else {
            throw StartFailure(
                code: "panoplus-no-device-motion",
                detail: "CoreMotion reports no device-motion support on this hardware. "
                      + "This arm's attitude comes entirely from CMDeviceMotion, so "
                      + "there is nothing to align frames against — every frame would "
                      + "refuse `buffer-empty` behind a live preview that never paints.")
        }

        // ── 0b. THE ALIGNMENT CONFIGURATION ────────────────────────────
        // Still before the camera and before CoreMotion: a build with no
        // measured τ for this configuration does not sweep on this arm, and
        // finding that out AFTER opening the camera would leave the operator
        // staring at a live preview that can never paint.
        // `configureWithOptions:error:` returns BOOL + NSError**, so Swift
        // imports it as a throwing call — the refusal MESSAGE (which of the two
        // numbers is missing, and what to run to get it) travels with it.
        //
        // ── AND THE ONE CONFIGURATION THAT STARTS WITHOUT A τ ──────────
        // `tauUncorrected` is the DELIBERATE τ = 0, UNMEASURED sweep
        // (2026-08-31).  The BELT is here as well as in the bridge because
        // this entry point is reachable from anywhere — a future auto-router
        // row included — and an uncorrected sweep that sampled at a non-zero
        // offset would be a run whose pack says the opposite of what it did.
        //
        // FORCED ONLY WHERE NOTHING CONTRADICTS IT.  When the caller ALSO
        // supplied a real measured τ it is left exactly as it arrived, so
        // `configure` refuses with `tau-mode-conflict` — overwriting one of
        // two contradictory claims here is how the two states become
        // indistinguishable in the pack, which is the whole defect class.
        //
        // ⚠ THE TEST IS THE SHARED C++ ONE, on the RAW bag.  Written here by
        // hand it was `tauMeasured && tauS.isFinite`, which let two
        // contradicting shapes through to the forcing branch — a claim with no
        // number, and a number with no claim.  Both produced a truthful pack,
        // so neither showed up as a lie; what they dropped was the caller's own
        // explicit claim, silently.  Asking the shared rule also keeps this
        // belt and the bridge's from drifting apart, which two hand-written
        // copies of one predicate reliably do.
        var alignOptions = options
        let uncorrectedTau =
            (options["tauUncorrected"] as? NSNumber)?.boolValue == true
        let rawTauNum = options["tauS"] as? NSNumber
        if uncorrectedTau,
           RNISPanoAttitude.uncorrectedOptionConflict(
               uncorrected: true,
               claimsMeasuredTau:
                   (options["tauMeasured"] as? NSNumber)?.boolValue ?? false,
               hasExplicitTau: rawTauNum != nil,
               tauS: rawTauNum?.doubleValue ?? 0.0) == "none" {
            alignOptions["tauS"] = 0.0
            alignOptions["tauMeasured"] = false
        }
        do {
            try RNISPanoAttitude.configure(options: alignOptions)
        } catch let e as NSError {
            throw StartFailure(code: "panoplus-alignment-unconfigured",
                               detail: e.localizedDescription)
        }

        frameW = plan.width
        frameH = plan.height
        let hFovDeg = Double(fmt.videoFieldOfView)
        // Device-published horizontal FOV → fx in pixels.  Arithmetic on a
        // measurement, and the FALLBACK only: the per-frame delivered
        // intrinsics are preferred wherever the connection offers them.
        fovFx = hFovDeg > 0
            ? (0.5 * Double(frameW)) / tan(0.5 * hFovDeg * Double.pi / 180.0)
            : 0

        // ── 3. THE SESSION ─────────────────────────────────────────────
        // The sweep owns the session from here; a late stopIdlePreview must
        // not mistake it for the idle one (review blocker's rider).
        idlePreviewActive = false
        idleDeviceUniqueId = nil
        session.beginConfiguration()
        // STRIP FIRST.  `session` is a stored property reused across
        // start/stop cycles, and `stop()` detaches the delegate but does not
        // remove the input.  Without this, the SECOND start on the same
        // process would hit `canAddInput == false` and report
        // `panoplus-camera-busy` — a diagnosis pointing at ARKit for a fault
        // that is entirely ours, which is the worst kind of wrong error
        // message.  (It also covers the one mid-configuration throw below.)
        for i in session.inputs { session.removeInput(i) }
        for o in session.outputs { session.removeOutput(o) }
        // `.inputPriority` so `activeFormat` is OURS and no preset overrides it.
        session.sessionPreset = .inputPriority

        // ── THE INPUT OPEN, RETRIED WITHIN A BOUNDED WINDOW ────────────
        //
        // ARKit and an AVCaptureSession cannot share the camera, so the
        // decoupled arm's caller tears ARKit down first (see
        // `PanoPlusBridge.tearDownArkitForDecoupledArm`).  `ARSession.pause()`
        // returns before the hardware is necessarily released, though, and a
        // single attempt would turn a ~30 ms handoff into a permanent
        // `panoplus-camera-busy`.
        //
        // ⚠ AND THE REVERSE IS ALSO TRUE, WHICH IS WHY THIS IS A BELT AND NOT
        // THE FIX.  ARKit holds `builtInWideAngleCamera`; this opens
        // `builtInUltraWideCamera` — a DIFFERENT `AVCaptureDevice`.
        // `canAddInput` tests configuration compatibility, not runtime
        // exclusivity, so it can perfectly well return true while ARKit is
        // still live and the conflict surfaces later as a session
        // INTERRUPTION instead.  That is what the interruption observers below
        // are for: the failure is named in the pack either way.
        var openedInput: AVCaptureDeviceInput?
        var lastOpenError = ""
        inputOpenAttempts = 0
        let openDeadline = CACurrentMediaTime() + Self.inputOpenBudgetS
        repeat {
            inputOpenAttempts += 1
            do {
                let candidate = try AVCaptureDeviceInput(device: device)
                if session.canAddInput(candidate) { openedInput = candidate; break }
                lastOpenError = "canAddInput returned false"
            } catch {
                lastOpenError = "\(error)"
            }
            if CACurrentMediaTime() >= openDeadline { break }
            usleep(20_000)
        } while CACurrentMediaTime() < openDeadline
        guard let input = openedInput else {
            session.commitConfiguration()
            throw StartFailure(
                code: "panoplus-camera-busy",
                detail: "Could not open the camera for input after \(inputOpenAttempts) "
                      + "attempts over \(Int(Self.inputOpenBudgetS * 1000)) ms "
                      + "(\(lastOpenError)) — most likely ARKit or another session "
                      + "still holds it. ARKit and AVCaptureSession cannot share the "
                      + "camera; the caller must tear ARKit DOWN before this arm "
                      + "starts, and this refusal is what makes that observable "
                      + "rather than asserted.")
        }
        session.addInput(input)

        let out = AVCaptureVideoDataOutput()
        out.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String:
                Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),
        ]
        // A real sweep discards late frames rather than building an unbounded
        // queue — the engine's own ring does the same thing one layer down.
        out.alwaysDiscardsLateVideoFrames = true
        out.setSampleBufferDelegate(self, queue: videoQueue)
        guard session.canAddOutput(out) else {
            session.commitConfiguration()
            throw StartFailure(code: "panoplus-output-failed", detail: "canAddOutput false.")
        }
        session.addOutput(out)
        output = out

        var intrinsicsSupported = false
        intrinsicsDelivered = false
        if let conn = out.connection(with: .video) {
            // Stabilisation OFF: it silently re-warps the image under a
            // geometry engine that believes it owns the mapping — and
            // intrinsics delivery requires it off anyway.
            if conn.isVideoStabilizationSupported {
                conn.preferredVideoStabilizationMode = .off
            }
            // `videoOrientation` is deliberately NOT set — see the header.
            intrinsicsSupported = conn.isCameraIntrinsicMatrixDeliverySupported
            if intrinsicsSupported {
                conn.isCameraIntrinsicMatrixDeliveryEnabled = true
                intrinsicsDelivered = conn.isCameraIntrinsicMatrixDeliveryEnabled
            }
        }
        session.commitConfiguration()

        var gdcSupported: Any = NSNull()
        var gdcEnabled: Any = NSNull()
        var lockError: Any = NSNull()
        do {
            try device.lockForConfiguration()
            device.activeFormat = fmt
            let dur = CMTimeMake(value: 1, timescale: Int32(targetFps.rounded()))
            device.activeVideoMinFrameDuration = dur
            device.activeVideoMaxFrameDuration = dur
            // `videoZoomFactor` is NOT touched: on the PHYSICAL ultra-wide the
            // minimum factor 1.0 already IS the full field of view.
            gdcSupported = device.isGeometricDistortionCorrectionSupported
            // READ, never written.  The engine's fitted lens model is
            // wide-only and its gate refuses to apply it here (LensMismatch),
            // which is CORRECT rather than merely harmless: GDC is on by
            // default where supported, so a wide-only k1/k2 on top would
            // DOUBLE-CORRECT. Recording the actual default is what lets a
            // future ultra-wide row be fitted as a post-GDC residual.
            gdcEnabled = device.isGeometricDistortionCorrectionEnabled
            device.unlockForConfiguration()
        } catch {
            lockError = "\(error)"
        }

        // ── M8: A FORMAT THAT WAS NOT APPLIED IS A START REFUSAL ───────
        //
        // On a `lockForConfiguration()` throw this used to stash `lockError`
        // and CARRY ON — so `activeFormat` and the 60 fps min/max frame
        // duration were never applied, while `config` went on to report the
        // PLAN's width/height/fps.  Two consequences, both bad:
        //
        //  1. This file's own item 2 says the frame rate is the motion-blur
        //     defence on a moving sweep and is "never a silent downgrade to
        //     30".  Continuing here IS that downgrade, silently.
        //  2. τ is keyed `model | lens | W×H | fps`.  The τ that gated this
        //     start was looked up under the PLANNED format; a sweep that then
        //     runs at a different one is using a τ measured for a format it is
        //     not in — and the rolling-shutter constant is part of τ.
        //
        // The `panoplus-no-intrinsics` block eight lines below already refuses
        // its own case correctly; this one now matches it.
        if !(lockError is NSNull) {
            abortConfiguredSession()
            throw StartFailure(
                code: "panoplus-format-not-applied",
                detail: "The capture device refused lockForConfiguration (\(lockError)), "
                      + "so neither the chosen format nor the 60 fps frame duration was "
                      + "applied. Frame rate is the motion-blur defence on a moving "
                      + "sweep and τ is keyed by the format, so sweeping anyway would "
                      + "run on an unknown rate with a τ measured for a different "
                      + "configuration. Refused rather than downgraded.")
        }

        // ── D7: NO USABLE INTRINSICS ROUTE IS A START REFUSAL ──────────
        // With neither per-frame delivery nor a published field of view there
        // is no fx at all, and the engine cannot rectify without one.  Caught
        // here rather than in the delegate, where it would present as a sweep
        // that runs, paints nothing, and reports thousands of identical
        // refusals — the same discipline the τ check follows.
        if !intrinsicsDelivered && !(fovFx > 0) {
            // L15 — NOT `stopRunning()`.  `startRunning()` is 40 lines BELOW
            // this point, so the session has never been started; stopping it
            // was a no-op that also left the input, the output and the
            // delegate attached, with the device's `activeFormat` already
            // mutated. The next start then inherited all of it.
            abortConfiguredSession()
            throw StartFailure(
                code: "panoplus-no-intrinsics",
                detail: "This configuration delivers no per-frame intrinsics and "
                      + "publishes no videoFieldOfView, so there is no focal length "
                      + "to rectify with. Nothing is guessed here.")
        }

        self.device = device
        self.sessionDir = sessionDir
        resetCounters()

        config = [
            "poseSource": "imu-attitude-only",
            // ── THE LENS THAT RAN, AND THE LENS THAT WAS ASKED FOR ────
            // `lens` is read off the device that opened — what RAN.  The
            // request rides beside it in the flag's own spelling so the pack
            // says "0.5× was asked for and the ultra-wide ran" in two fields
            // a reader can compare, not one he has to decode.  They can
            // differ only by a refusal (there is no fallback any more), and
            // `lensDefaulted` says whether the request was a choice or the
            // default.
            "lens": device.deviceType.rawValue,
            "lensIsUltraWide": device.deviceType == .builtInUltraWideCamera,
            "lensRequested": plan.lensRequested,
            "lensDefaulted": plan.lensDefaulted,
            "lensLabel": plan.lensLabel,
            "uniqueId": device.uniqueID,
            "width": frameW,
            "height": frameH,
            "requestedFps": targetFps,
            "hFovDeg": hFovDeg,
            "isBinned": fmt.isVideoBinned,
            "fovDerivedFx": fovFx > 0 ? fovFx : NSNull(),
            "intrinsicsDeliverySupported": intrinsicsSupported,
            "intrinsicsDeliveryEnabled": intrinsicsDelivered,
            "gdcSupported": gdcSupported,
            "gdcEnabled": gdcEnabled,
            "configLockError": lockError,
            "requestedMotionHz": Self.requestedMotionHz,
            "holdBudgetS": holdBudgetS,
            // ── JOB 1: WHICH CALIBRATION THIS SWEEP RAN ON ─────────────
            // The pack must be self-describing about the two numbers the whole
            // arm rests on.  Without these a reader sees a τ in the alignment
            // block and cannot tell whether it was measured on THIS device and
            // THIS format, inherited from a stored record, or handed in by a
            // caller running an experiment.  Recorded as whatever arrived —
            // NSNull when nothing did, never a plausible default.
            "calibrationSource": options["calibrationSource"] ?? NSNull(),
            // ── AND THE PER-NUMBER ANSWER, BECAUSE THE PAIR CAN DISAGREE ──
            // On the τ = 0 experiment the basis comes off the store and τ
            // comes from nowhere at all — deliberately.  One combined field
            // cannot say that, and a reader who has to infer it will infer
            // wrong.  `tauSource` ∈ options | store | uncorrected | none.
            "tauSource": options["tauSource"] ?? NSNull(),
            "basisSource": options["basisSource"] ?? NSNull(),
            "calibration": options["calibrationRecord"] ?? NSNull(),
            // ── THE HANDOFF, RECORDED RATHER THAN ASSUMED ──────────────
            // What the caller did to ARKit before this arm opened the camera,
            // and how many attempts the input open then took.  Both are here
            // because "ARKit was down" was an ASSERTION IN A COMMENT until
            // 2026-08-31 and the arm cannot produce a frame if it is false.
            "arTeardown": options["arTeardown"] ?? NSNull(),
            "inputOpenAttempts": inputOpenAttempts,
        ]

        // ── 4. OBSERVERS, MOTION, THEN PIXELS ──────────────────────────
        // In that order.  The observers go on FIRST so an interruption raised
        // by `startRunning()` itself — which is exactly what a camera ARKit
        // has not finished releasing produces — is caught rather than missed;
        // motion second, so the aligner has samples bracketing the first
        // frames instead of refusing them for an empty buffer.
        installSessionObservers()
        startMotion()
        session.startRunning()

        // ── 5. LOCK, THEN INGEST — v12 ─────────────────────────────────
        // The v6 exposure lock never ran on this arm: `PanoPlusBridge` parses
        // `lockCamera` for both arms, but its only call site sat after this
        // branch's unconditional return — and `RNISPanoCameraLock`'s default
        // resolution is the WIDE-ANGLE device, not the camera this session
        // streams.  The 2026-08-31 packs measured what that costs: metered
        // exposure swung 1.8–6.2× within single sweeps, hit the ×4 gain clamp
        // on 117 frames of one pack, and put a photometric step at every
        // ownership junction.
        //
        // ORDER MATTERS TWICE.  The lock runs AFTER `startRunning()` because
        // the `activeFormat` write above re-arms AE/AWB, and a lock taken
        // before the session runs pins a never-metered exposure.  And
        // `running` flips true only AFTER the lock attempt returns, so no
        // frame reaches the engine while AE is still converging — the
        // reference frame, the photometric datum for the whole sweep, is a
        // settled exposure or the report says why not.  Frames delivered in
        // that window are dropped by the `running` guard exactly like
        // pre-start frames; the ceiling on the window is `meteringSettleMs`.
        //
        // Best-effort like the AR arm: a refused lock is reported, never a
        // start failure — an unlocked sweep with honest metadata beats no
        // sweep at all.
        let lockRequested = (options["lockCamera"] as? Bool) ?? true
        let settleCeilingMs =
            (options["meteringSettleMs"] as? NSNumber)?.doubleValue ?? 600.0
        var lockReport: [String: Any]
        if lockRequested {
            lockReport = RNISPanoCameraLock.shared.lockForSweep(
                device: device, settleCeilingMs: settleCeilingMs)
        } else {
            lockReport = RNISPanoCameraLock.shared.attach(device: device)
            lockReport["requested"] = false
            lockReport["locked"] = false
            lockReport["reason"] = "lockCamera=false"
        }
        lockArmed = (lockReport["locked"] as? Bool) == true
        config["cameraLock"] = lockReport

        motionLock.lock(); running = true; motionLock.unlock()
        return config
    }

    /// Undo a session that was CONFIGURED but never STARTED.
    ///
    /// The refusal paths above run after `commitConfiguration()` and before
    /// `startRunning()`, so `stopRunning()` is not what they want: it is a
    /// no-op on a session that never ran, and it leaves the input, the output
    /// and the delegate attached with the device's `activeFormat` already
    /// mutated — state the NEXT start would inherit.  `start()`'s strip-first
    /// block covers the inputs on the next pass, but the DELEGATE would go on
    /// pointing at us in the meantime.
    private func abortConfiguredSession() {
        if let out = output { out.setSampleBufferDelegate(nil, queue: nil) }
        session.beginConfiguration()
        for i in session.inputs { session.removeInput(i) }
        for o in session.outputs { session.removeOutput(o) }
        session.commitConfiguration()
        output = nil
        device = nil
    }

    // MARK: - The session's fault observers

    /// Register the three `AVCaptureSession` notifications this arm's evidence
    /// channel depends on.  Idempotent by construction — `stop()` removes
    /// them, and `start()` calls this exactly once per run.
    ///
    /// AN INTERRUPTION IS NOT AN ERROR AND IS NOT A SUCCESS.  It is recorded
    /// with its reason, and — because iOS does not always auto-resume — a
    /// resume is ATTEMPTED and the attempt is counted.  What must never happen
    /// is the thing that happened before: delivery stops, every counter
    /// freezes, and the pack cannot say whether the phone rang or the arm is
    /// broken.
    private func installSessionObservers() {
        removeSessionObservers()
        let nc = NotificationCenter.default
        let q = OperationQueue.main

        observers.append(nc.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification,
            object: session, queue: q) { [weak self] note in
                guard let self = self else { return }
                var reason = "unknown"
                if let raw = note.userInfo?[
                        AVCaptureSessionInterruptionReasonKey] as? Int,
                   let r = AVCaptureSession.InterruptionReason(rawValue: raw) {
                    switch r {
                    case .videoDeviceNotAvailableInBackground:
                        reason = "videoDeviceNotAvailableInBackground"
                    case .audioDeviceInUseByAnotherClient:
                        reason = "audioDeviceInUseByAnotherClient"
                    case .videoDeviceInUseByAnotherClient:
                        // THE ONE THIS ARM IS MOST EXPOSED TO: ARKit did not
                        // let go, `canAddInput` did not catch it, and the
                        // conflict surfaced here instead of at the open.
                        reason = "videoDeviceInUseByAnotherClient"
                    case .videoDeviceNotAvailableWithMultipleForegroundApps:
                        reason = "videoDeviceNotAvailableWithMultipleForegroundApps"
                    case .videoDeviceNotAvailableDueToSystemPressure:
                        reason = "videoDeviceNotAvailableDueToSystemPressure"
                    case .sensitiveContentMitigationActivated:
                        reason = "sensitiveContentMitigationActivated"
                    @unknown default:
                        // A REASON WE HAVE NO NAME FOR IS STILL A REASON.  The
                        // raw value rides the pack so a future OS's new
                        // interruption is a lookup rather than an "unknown".
                        reason = "unknown-reason-\(raw)"
                    }
                }
                self.motionLock.lock()
                self.interruptions += 1
                self.interrupted = true
                if self.firstInterruptionReason.isEmpty {
                    self.firstInterruptionReason = reason
                }
                self.motionLock.unlock()
            })

        observers.append(nc.addObserver(
            forName: AVCaptureSession.interruptionEndedNotification,
            object: session, queue: q) { [weak self] _ in
                guard let self = self else { return }
                self.motionLock.lock()
                self.interruptionsEnded += 1
                self.interrupted = false
                let live = self.running
                self.motionLock.unlock()
                // iOS does not always resume on its own —
                // `videoDeviceNotAvailableInBackground` in particular needs an
                // explicit start.  `startRunning()` is a no-op when it already
                // is, so this is safe; the COUNT is what makes it visible.
                guard live else { return }
                self.motionLock.lock(); self.restartsAttempted += 1; self.motionLock.unlock()
                // v12 REVIEW FIX — restart on the session queue, re-checking
                // `running` there: a stop() that lands between the check above
                // and the restart used to leave a headless session running.
                self.sessionQ.async {
                    self.motionLock.lock(); let stillLive = self.running; self.motionLock.unlock()
                    guard stillLive else { return }
                    self.session.startRunning()
                }
            })

        observers.append(nc.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session, queue: q) { [weak self] note in
                guard let self = self else { return }
                let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
                let desc = err.map { "\($0.domain) \($0.code): \($0.localizedDescription)" }
                    ?? "unknown runtime error"
                self.motionLock.lock()
                self.runtimeErrors += 1
                if self.firstRuntimeError.isEmpty { self.firstRuntimeError = desc }
                let live = self.running
                self.motionLock.unlock()
                // A media-services reset is the one runtime error that is
                // recoverable by restarting; anything else is recorded and
                // left alone rather than being retried into a loop.
                guard live,
                      err?.code == AVError.Code.mediaServicesWereReset.rawValue
                else { return }
                self.motionLock.lock(); self.restartsAttempted += 1; self.motionLock.unlock()
                self.sessionQ.async {
                    self.motionLock.lock(); let stillLive = self.running; self.motionLock.unlock()
                    guard stillLive else { return }
                    self.session.startRunning()
                }
            })
    }

    private func removeSessionObservers() {
        let nc = NotificationCenter.default
        for o in observers { nc.removeObserver(o) }
        observers.removeAll()
    }

    private func startMotion() {
        // Availability is refused at `start()`, before anything is opened —
        // see the 0a block.  This guard stays as a belt: a silent return here
        // was what produced a live preview that could never paint.
        guard motionManager.isDeviceMotionAvailable else { return }
        motionManager.deviceMotionUpdateInterval = 1.0 / Self.requestedMotionHz
        // A FAILURE TO OPEN IS NEVER A FAILED SWEEP. The row is diagnostic;
        // an operator in an aisle must not lose a capture because a log file
        // could not be created. The refusal is recorded and the sweep runs.
        if !sessionDir.isEmpty {
            let path = (sessionDir as NSString).appendingPathComponent("sensors.jsonl")
            sensorsFp = fopen(path, "w")
            if sensorsFp == nil { sensorWriteFailed = true }
        } else {
            sensorWriteFailed = true
        }
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        // `.xArbitraryZVertical`, NOT `.xTrueNorthZVertical`: the magnetometer
        // injects yaw STEPS mid-sweep as it re-converges, and a step in the
        // attitude is a step in the rectification.  The arbitrary yaw datum
        // costs nothing — it cancels exactly in `dR = R₀ᵀ·Rᵢ`, which is the
        // only rotation that reaches the geometry.
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: q) {
            [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let a = dm.userAcceleration
            // CoreMotion reports userAcceleration in G; the cage is in m/s².
            let magMps2 = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot() * 9.80665
            self.motionLock.lock()
            self.lastAccelMagMps2 = magMps2
            self.motionSamples += 1
            if self.firstMotionS.isNaN { self.firstMotionS = dm.timestamp }
            self.lastMotionS = dm.timestamp
            self.motionLock.unlock()

            let q = dm.attitude.quaternion
            RNISPanoAttitude.pushSample(atTimeS: dm.timestamp,
                                        qx: q.x, qy: q.y, qz: q.z, qw: q.w)

            // ── THE RAW ROW ──────────────────────────────────────────────
            // FORMATTED BEFORE THE LOCK, for the same reason the sidecar does
            // it: `String(format:)` allocates, and holding the motion lock
            // across an allocation puts microseconds between this queue and a
            // lock it wants 200 times a second. The hold below is one buffered
            // `fputs`, i.e. a memcpy.
            //
            // `rotationRate` is the whole point — it is what `usePanMotion`
            // consumes and what no iOS pack has ever carried. `userAccel` in
            // m/s² to match `accelMps2` above, so the lurch cage can be
            // re-run offline against the same quantity it uses live, rather
            // than against CoreMotion's G-units.
            let r = dm.rotationRate
            let line = String(
                format: "{\"type\":\"device-motion\",\"tsS\":%.9f,"
                      + "\"q\":[%.9f,%.9f,%.9f,%.9f],"
                      + "\"rotationRate\":[%.9f,%.9f,%.9f],"
                      + "\"userAccelMps2\":[%.6f,%.6f,%.6f],"
                      + "\"accelMagMps2\":%.6f}\n",
                dm.timestamp, q.x, q.y, q.z, q.w,
                r.x, r.y, r.z,
                a.x * 9.80665, a.y * 9.80665, a.z * 9.80665, magMps2)
            self.motionLock.lock()
            if let f = self.sensorsFp {
                fputs(line, f)
                self.sensorRows += 1
                // Flush on a cadence, not per row: a crash mid-sweep should
                // still leave a readable file, but fsync at 200 Hz would be
                // the most expensive thing on this queue.
                if self.sensorRows % 200 == 0 { fflush(f) }
            }
            self.motionLock.unlock()
        }
    }

    // MARK: - Frame delivery

    public func captureOutput(_ output: AVCaptureOutput,
                              didOutput sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        motionLock.lock()
        let live = running
        motionLock.unlock()
        guard live, RNISPanoCore.isRunning() else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        guard pts.isFinite, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        framesDelivered += 1

        if !lastPtsS.isNaN, pts - lastPtsS > 2.5 / 60.0 { ptsGapsOverTwoFrames += 1 }
        lastPtsS = pts

        motionLock.lock()
        let accel = lastAccelMagMps2
        motionLock.unlock()

        // ── ALIGN, WITH A BOUNDED HOLD BUT NEVER AN EXTRAPOLATION ──────
        //
        // THE HOLD LOOP PROBES; IT DOES NOT COUNT.  `probe` is the pure
        // overload of the same arithmetic.  Retrying the COUNTING call here
        // would record one held-then-rescued frame as up to six
        // `after-last-sample` refusals — a pack reporting six lost frames
        // where none were lost, which is precisely the reporting dishonesty
        // this arm is most at risk of.  Exactly ONE counted alignment per
        // delivered frame, at the bottom of this block.
        var probe = RNISPanoAttitude.probe(ptsS: pts, accelMagMps2: accel)
        if !probe.ok, probe.refusal == .afterLastSample, holdBudgetS > 0 {
            // The IMU is behind this frame.  Waiting can fix that; inventing
            // attitude past the last sample cannot be bounded at all.  Poll in
            // 1 ms steps rather than sleeping the whole budget, so the common
            // case (the sample lands almost immediately) costs almost nothing.
            //
            // COST, STATED: worst case 6 ms of a 16.7 ms frame interval on a
            // queue whose only other work is a memcpy — and because
            // `alwaysDiscardsLateVideoFrames` is on, a hold that fired on
            // every frame could cost delivered frames rather than just
            // latency.  `holdsAttempted` against `framesDelivered` is the
            // number that says whether it does.
            holdsAttempted += 1
            let deadline = CACurrentMediaTime() + holdBudgetS
            while CACurrentMediaTime() < deadline {
                usleep(1000)
                probe = RNISPanoAttitude.probe(ptsS: pts, accelMagMps2: accel)
                if probe.ok { holdsRescued += 1; break }
                if probe.refusal != .afterLastSample { break }
            }
        }
        // The one counted alignment.  The buffer only grows, so this returns
        // the probe's answer or a better one; it can never be worse.
        let res = RNISPanoAttitude.align(ptsS: pts, accelMagMps2: accel)

        if !res.ok {
            framesRefused += 1
            if firstRefusalName.isEmpty {
                firstRefusalName = RNISPanoAttitude.refusalName(res.refusal)
            }
            if res.fatal {
                // A configuration fault cannot improve frame by frame.  Count
                // it and stop feeding: a sweep of thousands of identical fatal
                // refusals is noise, not evidence.
                framesFatal += 1
                return
            }
            // NON-fatal refusals are still INGESTED, with tracking = 0.  The
            // engine's own hold / abort ladder then runs on a real input and
            // the frame gets a ledger row — silently dropping it would leave
            // the pack unable to say the frame ever existed.
        }

        // ── INTRINSICS: delivered where offered, FOV-derived otherwise ──
        var fx = fovFx, fy = fovFx
        var cx = Double(frameW) * 0.5, cy = Double(frameH) * 0.5
        if intrinsicsDelivered,
           let k = Self.intrinsics(from: sampleBuffer) {
            fx = Double(k.columns.0.x)
            fy = Double(k.columns.1.y)
            cx = Double(k.columns.2.x)
            cy = Double(k.columns.2.y)
            framesIntrinsicsDelivered += 1
        } else {
            framesIntrinsicsFovDerived += 1
        }
        guard fx > 0, fy > 0 else { framesRefused += 1; return }

        // ── EXPOSURE: ours, and NOT circular ───────────────────────────
        // On the AR arm this pair is read off a device we resolved and locked,
        // which cannot answer "is that the device ARKit streams?".  Here we
        // OPENED the device, so the question does not arise.  The AR-probe
        // fields are passed as unavailable (have = false) because there is no
        // ARFrame on this path — never as zeros, which the engine would count
        // in a trace they do not belong to.
        var expDur = 0.0, expISO = 0.0
        if let d = device {
            let s = d.exposureDuration.seconds
            if s.isFinite, s > 0 { expDur = s }
            let iso = Double(d.iso)
            if iso.isFinite, iso > 0 { expISO = iso }
            // v12 — the per-frame lock witness; see the counter's own comment.
            if lockArmed, d.exposureMode != .locked { framesObservedUnlocked += 1 }
        }

        let trackingName = res.tracking == 2 ? "normal" : (res.tracking == 1 ? "limited" : "notAvailable")

        RNISPanoCore.ingest(
            pixelBuffer: pb,
            timestampNs: pts * 1e9,
            fx: fx, fy: fy, cx: cx, cy: cy,
            imageWidth: frameW, imageHeight: frameH,
            rotation: [NSNumber(value: res.qx), NSNumber(value: res.qy),
                       NSNumber(value: res.qz), NSNumber(value: res.qw)],
            // ── THERE IS NO TRANSLATION ON THIS PATH ───────────────────
            // Not "zero because we could not measure it" — zero because this
            // arm has no VIO at all.  Every consumer of `t` was read out of
            // the engine one by one: the reference latch goes inert, the
            // relocalisation guard's failure class cannot occur, the
            // subject-distance fit falls back to `cfg.subjectDistanceM` on its
            // own, and the cross-scale term degenerates to exactly s = 1.  The
            // ONE consumer that mattered — the pose-side lurch cage — is
            // replaced in the aligner, in acceleration rather than
            // displacement.  `poseSource` in the sidecar is what stops a
            // reader seeing `rejectedPoseSpeed: 0` and concluding it passed.
            translation: [NSNumber(value: 0.0), NSNumber(value: 0.0), NSNumber(value: 0.0)],
            tracking: trackingName,
            exposureDurationS: expDur,
            exposureISO: expISO,
            arExposureDurationS: 0.0,
            arExposureOffsetEV: 0.0,
            arExposureHave: false
        )
        framesIngested += 1
    }

    /// The per-frame 3×3, copied into an ALIGNED local before it is read.
    /// `CFDataGetBytePtr` promises no 16-byte alignment, and a `load(as:)`
    /// straight off it is undefined behaviour that works right up until it
    /// does not.
    private static func intrinsics(from sb: CMSampleBuffer) -> matrix_float3x3? {
        guard let raw = CMGetAttachment(
            sb, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, attachmentModeOut: nil)
        else { return nil }
        let data = raw as! CFData
        guard CFDataGetLength(data) >= MemoryLayout<matrix_float3x3>.size else { return nil }
        var m = matrix_float3x3()
        withUnsafeMutableBytes(of: &m) { dst in
            CFDataGetBytes(data, CFRangeMake(0, MemoryLayout<matrix_float3x3>.size),
                           dst.bindMemory(to: UInt8.self).baseAddress)
        }
        return m
    }

    // MARK: - Stop

    /// Stop the session and the motion updates and return the report.  Also
    /// writes it as `pose_source.json` beside the pack.
    ///
    /// A SIDECAR, deliberately, rather than a new key in `meta.json`: adding a
    /// key to the meta literal would change the ARKit arm's `meta.json` too
    /// (as an explicit null), and this arm is not worth one byte of the
    /// default arm's pack.  Folding it into `meta.json` is a named follow-up,
    /// not an oversight.
    @discardableResult
    public func stop() -> [String: Any] {
        return sessionQ.sync { stopOnSessionQ() }
    }

    private func stopOnSessionQ() -> [String: Any] {
        motionLock.lock()
        let wasRunning = running
        running = false
        motionLock.unlock()
        guard wasRunning else { return ["ran": false] }
        removeSessionObservers()
        session.stopRunning()
        motionManager.stopDeviceMotionUpdates()
        if let out = output { out.setSampleBufferDelegate(nil, queue: nil) }
        // BARRIER, not decoration: the frame counters below are written only on
        // `videoQueue`, and a delegate call already in flight when
        // `stopRunning()` returned would otherwise race the read.  A sync hop
        // onto that queue is the cheapest correct fence.
        videoQueue.sync { }

        // Closed AFTER `stopDeviceMotionUpdates()` and after the videoQueue
        // fence, so no callback can still be holding the pointer. Under the
        // lock because the motion queue writes through it.
        motionLock.lock()
        if let f = sensorsFp { fflush(f); fclose(f); sensorsFp = nil }
        let sensorRowsSnapshot = sensorRows
        let sensorWriteFailedSnapshot = sensorWriteFailed
        motionLock.unlock()

        motionLock.lock()
        let motionSamplesSnapshot = motionSamples
        let motionSpan = lastMotionS - firstMotionS
        let interruptionsSnapshot = interruptions
        let interruptionsEndedSnapshot = interruptionsEnded
        let interruptedSnapshot = interrupted
        let firstInterruptionReasonSnapshot = firstInterruptionReason
        let runtimeErrorsSnapshot = runtimeErrors
        let firstRuntimeErrorSnapshot = firstRuntimeError
        let restartsAttemptedSnapshot = restartsAttempted
        motionLock.unlock()

        var report = config
        report["ran"] = true
        report["framesDelivered"] = framesDelivered
        report["framesIngested"] = framesIngested
        report["framesRefused"] = framesRefused
        report["framesRefusedFatal"] = framesFatal
        report["firstRefusal"] = firstRefusalName.isEmpty ? NSNull() : firstRefusalName
        report["framesIntrinsicsDelivered"] = framesIntrinsicsDelivered
        report["framesIntrinsicsFovDerived"] = framesIntrinsicsFovDerived
        report["intrinsicsSource"] =
            framesIntrinsicsDelivered > 0
                ? (framesIntrinsicsFovDerived > 0 ? "mixed" : "delivered")
                : "fov-derived"
        report["holdsAttempted"] = holdsAttempted
        report["holdsRescued"] = holdsRescued
        // v12 — 0 with `cameraLock.locked: true` now really means "held for
        // the whole sweep": the delegate checked the device's exposure mode on
        // every delivered frame.
        report["framesObservedUnlocked"] = framesObservedUnlocked
        report["ptsGapsOverTwoFrames"] = ptsGapsOverTwoFrames
        report["motionSamples"] = motionSamplesSnapshot
        // ── THE SENSOR LOG, AS A COUNT NOT A CLAIM ─────────────────────
        // A `present: true` says a file was opened; only a non-zero count says
        // rows were WRITTEN. A pack that merely asserts it carries a gyro
        // trace is worse than one that admits it does not, because the first
        // gets replayed and the second gets recaptured.
        report["sensorsJsonl"] = [
            "rows": sensorRowsSnapshot,
            "openFailed": sensorWriteFailedSnapshot,
            "fields": "tsS, q[xyzw], rotationRate[xyz] rad/s, "
                + "userAccelMps2[xyz], accelMagMps2",
            "referenceFrame": "xArbitraryZVertical",
            "note": "CoreMotion device-motion at the requested 200 Hz. "
                + "rotationRate is the quantity usePanMotion's lateral guard "
                + "consumes; before this it was discarded every sample and no "
                + "iOS pack could say what that guard saw.",
        ]
        // ── THE SESSION FAULT LEDGER ───────────────────────────────────
        // A sweep that stopped delivering because the phone rang and a sweep
        // that stopped delivering because the arm is broken produced BYTE-
        // IDENTICAL packs before this block existed. `interrupted` is the
        // state at teardown: true means the sweep ended INSIDE an
        // interruption, which is a different fact from having survived one.
        report["session"] = [
            "interruptions": interruptionsSnapshot,
            "interruptionsEnded": interruptionsEndedSnapshot,
            "endedWhileInterrupted": interruptedSnapshot,
            "firstInterruptionReason": firstInterruptionReasonSnapshot.isEmpty
                ? NSNull() : firstInterruptionReasonSnapshot,
            "runtimeErrors": runtimeErrorsSnapshot,
            "firstRuntimeError": firstRuntimeErrorSnapshot.isEmpty
                ? NSNull() : firstRuntimeErrorSnapshot,
            "restartsAttempted": restartsAttemptedSnapshot,
            "note": "an interruption or a runtime error stops frame delivery while "
                  + "every other counter keeps its last value; read framesDelivered "
                  + "against these before reading it as a capture-side finding",
        ]
        // MEASURED, not the requested rate: CMMotionManager exposes only a
        // requested interval and silently clamps it, so the only honest number
        // is the one derived from the delivered timestamps.
        report["deliveredMotionHz"] =
            (motionSamplesSnapshot > 1 && motionSpan > 0)
                ? Double(motionSamplesSnapshot - 1) / motionSpan : NSNull()
        report["alignment"] = RNISPanoAttitude.report()

        // ── THE THREE-WAY τ PROVENANCE, COMPOSED EXACTLY ONCE ──────────
        // The seam knows `measured` vs `uncorrected`; only THIS layer knows
        // whether a measured τ came from the caller or off the calibration
        // store.  Composed here and read from `report` by `metaBlock` below,
        // so the sidecar and `meta.json` cannot disagree — two independent
        // derivations of one fact is how they start to.
        let prov = Self.tauProvenance(report: report)
        report["tauProvenance"] = prov
        report["tauCorrectionApplied"] = (prov == "measured" || prov == "from-store")
        report["tauNote"] = Self.tauNote(provenance: prov)
        // ── AND THE BASIS HALF, COMPOSED THE SAME WAY AND ONCE ─────────
        // The basis provenance used to be a literal inside `metaBlock`, which
        // meant `meta.json` asserted it and the sidecar did not carry it at
        // all: one file claiming, the other silent. Derived here from
        // `basisSource` through the shared C++ mapping, written into `report`,
        // and read back by `metaBlock` — so the two files cannot disagree, for
        // the same reason τ's three-way field is composed here.
        let basisProv = RNISPanoAttitude.basisProvenance(
            source: report["basisSource"] as? String)
        report["basisProvenance"] = basisProv
        report["basisNote"] = Self.basisNote(provenance: basisProv)

        writeSidecar(report)
        // ── M7: THE MARKER GOES IN meta.json TOO ───────────────────────
        //
        // The sidecar was the whole disclosure, and `meta.json` is the file
        // every offline harness in this repo reads.  `meta.json` carries
        // `rejectedPoseSpeed: 0` and `maxTranslationJump: 0` from cages that
        // NEVER RAN on this arm (there is no translation at all), and it
        // carried no `poseSource` key to say so — so the one file with the
        // zeros in it was the one file with no marker on it.
        //
        // Recorded through the engine rather than written here so it lands
        // inside the pack the engine is about to finalize.  On the ARKit arm
        // nothing calls this, the key is absent, and `meta.json` is byte-
        // identical to what shipped.
        RNISPanoCore.recordPoseSource(Self.metaBlock(from: report))
        return report
    }

    /// WHERE THIS SWEEP'S τ CAME FROM — `measured` / `from-store` /
    /// `uncorrected`, plus `not-measured` for a configuration that could never
    /// have started.  **THREE VALUES, NEVER A BOOLEAN.**
    ///
    /// The two halves come from different layers and neither can answer alone:
    /// the C++ seam owns `measured` vs `uncorrected` (it is the thing that
    /// applies, or does not apply, the offset), and only this layer knows
    /// whether a measured τ was handed in by the caller or looked up in
    /// `RNISPanoCalibStore`.  A pack that cannot tell those three apart is a
    /// pack whose central number is unattributable — which is the defect this
    /// arm's entire calibration step exists to prevent.
    static func tauProvenance(report: [String: Any]) -> String {
        let alignment = report["alignment"] as? [String: Any] ?? [:]
        // The SEAM's answer outranks everything: it is the layer that either
        // applied an offset or did not.
        // `alignment.tauMode` is the SEAM's own three-valued answer
        // (`measured` / `uncorrected` / `not-measured`); `tauUncorrected` is
        // the same fact as a flag.  Either is authoritative over anything this
        // layer thinks, because the seam is what applies the offset.
        if (alignment["tauMode"] as? String) == "uncorrected"
            || (alignment["tauUncorrected"] as? NSNumber)?.boolValue == true {
            return "uncorrected"
        }
        guard (alignment["tauMeasured"] as? NSNumber)?.boolValue == true else {
            // Unreachable through `start` (the configuration is refused before
            // the camera opens) and reported honestly anyway rather than
            // collapsed into one of the three real answers.
            return "not-measured"
        }
        return (report["tauSource"] as? String) == "store" ? "from-store" : "measured"
    }

    /// THE PLAIN SENTENCE, so a reader six weeks from now cannot mistake an
    /// experiment for a calibrated run without reading a single other field.
    static func tauNote(provenance: String) -> String {
        switch provenance {
        case "uncorrected":
            return "THIS SWEEP APPLIED NO TIMING CORRECTION. tau was held at 0 and "
                 + "was NOT measured — attitude was sampled at each frame's "
                 + "presentation timestamp exactly, with no camera-to-IMU offset of "
                 + "any kind. It is a DELIBERATE EXPERIMENT: the device's tau "
                 + "calibration resolved on 8 of 12 runs and scattered 5.03 ms, wider "
                 + "than the 3.08 ms budget the correction is meant to buy back, so "
                 + "the persist gate refused to write one and this pack is the "
                 + "evidence for whether tau binds at all. DO NOT read it as a "
                 + "calibrated run, and do not compare its residuals with a corrected "
                 + "pack's without saying which is which. The BASIS was measured and "
                 + "IS a real calibration — see attitudeBasisIndex."
        case "from-store":
            return "tau was MEASURED for this (device, lens, format) and read from the "
                 + "on-device calibration store, then applied: attitude was sampled at "
                 + "pts + tau."
        case "measured":
            return "tau was supplied by the caller as a measured offset and applied: "
                 + "attitude was sampled at pts + tau."
        default:
            return "tau provenance could not be established, which should be "
                 + "unreachable: the arm refuses to start without either a measured "
                 + "tau or an explicit uncorrected request."
        }
    }

    /// THE BASIS HALF'S SENTENCE, chosen by where the basis came from.
    ///
    /// On the τ = 0 experiment exactly one of the two numbers is missing, and
    /// recording the pair under one "uncalibrated" banner would throw away a
    /// real measurement: the basis was selected from 777 pairs at 0.234°
    /// against a 19.45° runner-up and survived every offset in ±10 ms, i.e. it
    /// was chosen by the geometry and not by the clock.  But that sentence is
    /// only true for the basis this device MEASURED, and a caller may hand one
    /// in instead — in which case saying it was validated would be the pack
    /// certifying a calibration nobody ran.
    static func basisNote(provenance: String) -> String {
        switch provenance {
        case "measured":
            return "the device→camera basis C was MEASURED and validated on this "
                 + "device (selectBasis against a live ARKit reference, plus the "
                 + "±10 ms tau-stability gate) and read from the on-device "
                 + "calibration store. It is a real calibration, whatever "
                 + "tauProvenance says: the two numbers have different scopes and do "
                 + "not expire together."
        case "caller-supplied":
            return "the device→camera basis C was HANDED IN BY THE CALLER. This build "
                 + "did NOT measure or validate it — nothing here certifies it, and it "
                 + "must not be read as a calibration this device ran. Compare it "
                 + "against attitudeBasisIndex in a pack whose basisProvenance is "
                 + "'measured' before trusting any geometry derived from it."
        default:
            return "no device→camera basis was resolved, which should be unreachable: "
                 + "a -1 basis index is a fatal refusal and the sweep would not have "
                 + "started. Treat this pack's orientation as unattributable."
        }
    }

    /// The compact `meta.json` block — a POINTER plus the four facts a reader
    /// must not have to open the sidecar to learn.  Deliberately not the whole
    /// report: duplicating it would create two copies that can disagree.
    private static func metaBlock(from report: [String: Any]) -> [String: Any] {
        let alignment = report["alignment"] as? [String: Any] ?? [:]
        // READ, never re-derived — see the composition site in `stop()`.
        let basisProv = (report["basisProvenance"] as? String) ?? "not-measured"
        return [
            "poseSource": "imu-attitude-only",
            "translation": "none",
            // The sentence that stops the misreading. Both of these counters
            // are structurally zero here and neither is a cage that passed.
            "posesSpeedCageNote":
                "counts.rejectedPoseSpeed and the translation-jump cage did NOT run "
              + "on this sweep: t is identically zero on this arm, so both are "
              + "structurally 0 and neither is evidence of anything.",
            // L16 — `referenceQuat` is exported on BOTH arms under one key and
            // denotes a DIFFERENT frame on each: world←cam on ARKit, versus
            // R_imu(t0)·C in CoreMotion's arbitrary-yaw datum here. Naming the
            // frame is what stops an offline reader comparing two packs that
            // do not share a datum.
            "referenceQuatFrame":
                "R_imu(t0)*C in CoreMotion .xArbitraryZVertical — NOT the ARKit "
              + "world frame the ARKit arm's referenceQuat is expressed in. The "
              + "arbitrary yaw datum B cancels in dR = R0^T*Ri, which is the only "
              + "rotation that reaches the geometry.",
            "tauS": alignment["tauS"] ?? NSNull(),
            "tauMeasured": alignment["tauMeasured"] ?? NSNull(),
            // ── THE THREE-WAY FIELD, IN THE FILE EVERY HARNESS READS ───
            // `measured` / `from-store` / `uncorrected`. Read from `report`,
            // never re-derived: the sidecar and meta.json must not be able to
            // disagree about which of the three this sweep was.
            "tauProvenance": report["tauProvenance"] ?? NSNull(),
            "tauCorrectionApplied": report["tauCorrectionApplied"] ?? NSNull(),
            "tauNote": report["tauNote"] ?? NSNull(),
            "tauSource": report["tauSource"] ?? NSNull(),
            "basisSource": report["basisSource"] ?? NSNull(),
            // ── THE BASIS *DID* CALIBRATE, AND SAYS SO ─────────────────
            // On the τ = 0 experiment exactly one of the two numbers is
            // missing. Recording the pair under one "uncalibrated" banner
            // would throw away a real measurement — the basis was selected
            // from 777 pairs at 0.234° against a 19.45° runner-up and survived
            // every offset in ±10 ms, i.e. it was chosen by the geometry and
            // not by the clock. The arm cannot start without it (a −1 index is
            // a fatal refusal), so a pack that exists has a validated one.
            //
            // ⚠ DERIVED FROM `basisSource`, NOT ASSERTED.  This was an
            // unconditional "measured" literal sitting one key away from
            // `basisSource`, which the bridge can set to "options" — so a
            // caller-supplied basis would have been certified by the pack as a
            // calibration this build never ran. That is the SAME defect class
            // the τ side of this file exists to kill, committed on the other
            // number, and it was added by the cut that killed it. The mapping
            // is in the shared C++ so the Android leg reads the same one.
            "basisProvenance": basisProv,
            "basisNote": report["basisNote"] ?? NSNull(),
            "tauSign": alignment["tauSign"] ?? NSNull(),
            "attitudeBasisIndex": alignment["attitudeBasisIndex"] ?? NSNull(),
            "attitudeBasisLabel": alignment["attitudeBasisLabel"] ?? NSNull(),
            "lurchCage": alignment["lurchCage"] ?? NSNull(),
            "calibrationSource": report["calibrationSource"] ?? NSNull(),
            "lens": report["lens"] ?? NSNull(),
            // The request beside the run, in meta.json too — the file every
            // offline harness reads must not need the sidecar to say which
            // chip position produced this pack.
            "lensRequested": report["lensRequested"] ?? NSNull(),
            "lensLabel": report["lensLabel"] ?? NSNull(),
            "session": report["session"] ?? NSNull(),
            "sidecar": "pose_source.json",
        ]
    }

    private func writeSidecar(_ report: [String: Any]) {
        guard !sessionDir.isEmpty else { return }
        let path = (sessionDir as NSString).appendingPathComponent("pose_source.json")
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(
                withJSONObject: report,
                options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    private func resetCounters() {
        framesDelivered = 0; framesIngested = 0; framesRefused = 0; framesFatal = 0
        framesIntrinsicsDelivered = 0; framesIntrinsicsFovDerived = 0
        holdsAttempted = 0; holdsRescued = 0
        lockArmed = false; framesObservedUnlocked = 0
        motionSamples = 0; firstMotionS = .nan; lastMotionS = .nan
        lastPtsS = .nan; ptsGapsOverTwoFrames = 0
        firstRefusalName = ""
        motionLock.lock()
        lastAccelMagMps2 = .nan
        interruptions = 0; interruptionsEnded = 0; interrupted = false
        firstInterruptionReason = ""
        runtimeErrors = 0; firstRuntimeError = ""
        restartsAttempted = 0
        motionLock.unlock()
        RNISPanoAttitude.reset()
    }
}
