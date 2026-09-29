// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusBridge.swift — React Native bridge for the pano+ capture mode
// (module name `RNSSweepSession`).
//
// Same shape as this pod's StitchPluginsBridge: an `@objc(...)`-named Swift
// class whose promise methods are declared to RN by the sibling
// PanoPlusBridge.m (RN's module map is populated by RCT_EXTERN_* macros, not
// by @objc decorators alone).  A SEPARATE module from
// a host's render-plugin module because pano+ is a capture SESSION with lifecycle,
// not a stateless render call — mixing them would put a long-lived session
// behind a module whose contract is "one call, one result".
//
// Threading: `start` / `stop` / `cancel` dispatch onto a global queue.  The RN
// bridge queue is never blocked, and `stop` in particular must not run on the
// main thread (it drains the engine queue and encodes a multi-megapixel JPEG).
//
// ── What start/stop own beyond the engine ────────────────────────────────
//
//  1. PLUGIN REGISTRATION.  `start` registers RNISPanoPlusPlugin with
//     `RNISARPluginRegistry.shared`, `stop`/`cancel` unregister it.  Leaving
//     it registered would cost every other AR surface an atomic load per
//     frame for nothing.
//
//  2. THE CAMERA LOCK (v6).  Exposure, white balance and focus are LOCKED for
//     the sweep and restored on stop/cancel/error/invalidate — standard
//     panorama practice, and the fix for the banding the operator rejected
//     twice.  The ORDER below is the whole of it:
//
//         engine start → video-format switch → METERING SETTLE → lock
//                      → register the frame plugin → resolve
//
//     The format switch re-runs `arSession.run`, and AE/AWB/AF re-converge
//     over the following few hundred ms; locking into the middle of that would
//     pin the sweep to a half-metered exposure.  The settle POLLS the device's
//     own `isAdjusting*` flags rather than sleeping a guessed duration, and
//     `meteringSettleMs` is its CEILING.  And the plugin registers LAST, so no
//     frame is ingested before the lock — the reference frame the whole
//     radiometric normalisation is measured against is a locked frame.
//
//     THE COST, STATED SO IT IS NOT MISREAD AS LAG: the settle is real time
//     during which the sweep is live but no frame is ingested.  The capture
//     surface shows a METERING state for it; an operator who starts panning on
//     the button press would otherwise have that motion dropped silently.
//
//     Locking is BEST-EFFORT (ARKit owns the capture session) and the report
//     is written into the pack rather than asserted; the pack's own exposure
//     trace is what proves whether it held.  See RNISPanoCameraLock.swift.
//
//  3. THE AR VIDEO FORMAT.  `RNSARSession.pickVideoFormat` defaults to the
//     SMALLEST 4:3 format; for a slit-scan sweep the frame interval is a hard
//     exposure ceiling AND it sets the strip density, so pano+ asks for the
//     high-fps format.  `setHighFpsFormatEnabled` re-runs `arSession.run`,
//     which drops a few frames — so it is called ONLY when the value actually
//     changes, and the previous value is RESTORED on stop.  (Calling
//     `IncrementalStitcher.start()` to get the same effect would also claim
//     the single `incrementalConsumer` slot and spin up the batch collector;
//     this is the narrow, side-effect-free route.)
//
//  4. TEARDOWN ON HOST INVALIDATION.  `invalidate()` is RN's teardown hook
//     (RCTCxxBridge calls it on every module conforming to `RCTInvalidating`)
//     and it fires on a JS bundle reload — the one path that reaches NEITHER
//     stop NOR cancel.  Without it a reload mid-sweep leaves the frame plugin
//     registered and the camera pinned for the rest of the process, and the
//     NEXT sweep would then read `.locked` back as the mode to "restore" to.

#if canImport(React)

import Foundation
import QuartzCore
import React


@objc(RNSSweepSession)
public class PanoPlusBridge: NSObject, RCTInvalidating {

    /// Nothing here needs the main thread, and the heavy work runs on our own
    /// queues (the StitchPluginsBridge precedent).
    @objc public static func requiresMainQueueSetup() -> Bool { return false }

    /// ── WHY THIS PACKAGE SHIPS ITS OWN DOCUMENT DIRECTORY ───────────────
    /// A sweep needs one thing from the filesystem before it can start: a
    /// writable base directory to put the session under.  Native creates the
    /// session directory itself, so that single path is the whole
    /// requirement.
    ///
    /// pano+ got that path from `expo-file-system`, because the host it grew
    /// up in is an Expo app.  That dependency came along when pano+ moved
    /// into this package and became a hidden, unstated requirement: a plain
    /// React Native app installing `react-native-image-stitcher` — including
    /// this repo's own example app — got "pano+ is not available", a message
    /// whose wording sends the reader to the build when the truth was a
    /// missing peer dependency nobody had told them about.
    ///
    /// An Apache-2.0 package must not require Expo to run its own feature, so
    /// the base path comes from here and the host's `expo-file-system` is now
    /// a PREFERENCE rather than a requirement — see `fileSystem.ts`, which
    /// still uses the host's copy when there is one so existing hosts keep
    /// writing to exactly the directory they always did.
    ///
    /// CONSTANTS, not a promise method: the surface reads this during render
    /// to decide whether it can offer a capture at all, and a promise cannot
    /// answer a synchronous question without a frame in which the feature
    /// falsely appears unavailable.
    ///
    /// `.documentDirectory` is the deliberate choice — it is what
    /// `expo-file-system` reports for `documentDirectory` on iOS, it is
    /// backed up and not subject to the eviction that could delete a
    /// half-finished sweep out from under the engine.  `.absoluteString`
    /// gives the `file://…/Documents/` form, trailing slash included, so both
    /// paths through `loadVideoFileSystem()` hand the surface the same shape
    /// of string.
    @objc public func constantsToExport() -> [AnyHashable: Any] {
        let docs = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask
        ).first
        return [
            "documentDirectory": docs?.absoluteString as Any,
            // M5 — the vision-camera sweep arm is compiled into this binary.
            // JS reads it to REFUSE a host-camera sweep by name on a build
            // without it (`ENGINE_UNAVAILABLE`), never to fall back to a
            // camera of pano+'s own.
            "vcArmSupported": RNISPanoVcArm.isSupported,
        ]
    }

    /// Set while pano+ owns the high-fps override, so stop restores exactly
    /// what it found.  Written on the bridge's work queue only.
    /// v12 REVIEW FIX (minor) — guarded by `armLock` like the arm claim: it
    /// is written in start's global-queue block and read/cleared from stop and
    /// invalidate on their own queues.
    private static var previousHighFps: Bool? = nil
    private static func setPreviousHighFps(_ v: Bool?) {
        armLock.lock(); previousHighFps = v; armLock.unlock()
    }
    private static func takePreviousHighFps() -> Bool? {
        armLock.lock(); defer { armLock.unlock() }
        let v = previousHighFps; previousHighFps = nil
        return v
    }

    /// TRUE while the DECOUPLED (AVFoundation + CoreMotion) source owns the
    /// camera instead of ARKit.  Read by every teardown path so the right
    /// producer is stopped.
    ///
    /// `poseSource` defaults to `"ar"`, and that default is unchanged by the
    /// 2026-08-31 wiring: the SDK surface has a `poseSource` prop and the app a
    /// `panoPlusPoseSource` flag, but BOTH baselines ship `"ar"`, so a build
    /// that is merely carrying this code still takes the ARKit path below byte
    /// for byte.  The arm is REACHABLE (one pill in the gear), which is a
    /// different thing from being selected.
    ///
    /// ⚠ IT IS BEHIND A LOCK, AND THE LOCK IS NOT DECORATION.  It used to be a
    /// bare `static var` written inside `start`'s
    /// `DispatchQueue.global(qos:).async` block and read+written by
    /// `teardownPlugin()` — which `stop()`, `cancel()` and `invalidate()` each
    /// reach from THEIR OWN queue.  Three-way unsynchronised access to mutable
    /// static state is a data race by the Swift memory model, but the concrete
    /// harm was the ORDERING: a `stop()` / `cancel()` / bundle reload that
    /// reached teardown before start's async block set the flag took the ARKit
    /// branch, unregistered a plugin that was never registered — and NEVER
    /// CALLED `RNISPanoAvfSource.shared.stop()`.  The 60 fps ultra-wide session
    /// and CoreMotion at 200 Hz then ran for the rest of the process with the
    /// camera pinned and every frame silently discarded.
    ///
    /// So: the arm is CLAIMED SYNCHRONOUSLY on the bridge queue before start
    /// goes async, and teardown TAKES it atomically.  A teardown that wins the
    /// race leaves `claimed == false`, and the start path checks that after the
    /// source is up and stops it rather than orphaning it.
    private static let armLock = NSLock()

    /// ── M8: THE CAMERA-RELEASE POINT OF A STOP ───────────────────────────
    /// `stop()` tears the arm down (plugin disarmed, camera lock released,
    /// format restored) and only THEN finalizes the canvas and the pack, which
    /// takes seconds. JS keeps the camera mounted until this reads true, then
    /// unmounts it for the rest of the finish — the keyframe engine's
    /// stitching rule — so nothing native still reads the camera it unmounts.
    /// False from every start; true from the teardown of a stop or cancel.
    ///
    /// ⚠ GENERATION-SCOPED (M8 review). A stop or cancel runs its teardown
    /// on a global queue; a cancel followed at once by a new start would
    /// otherwise land its "released" AFTER the new start cleared it, and the
    /// new sweep's finish would unmount the camera before native let go. So
    /// each start opens a generation, a stop/cancel captures the generation
    /// it belongs to on the bridge queue, and only the CURRENT one counts.
    private static let releaseLock = NSLock()
    private static var releaseGen: UInt64 = 0
    private static var releasedGen: UInt64 = .max
    private static func beginRelease() {
        releaseLock.lock(); releaseGen &+= 1; releaseLock.unlock()
    }
    private static func currentReleaseGen() -> UInt64 {
        releaseLock.lock(); defer { releaseLock.unlock() }
        return releaseGen
    }
    private static func markReleased(_ g: UInt64) {
        releaseLock.lock(); if g == releaseGen { releasedGen = g }; releaseLock.unlock()
    }
    private static func cameraReleased() -> Bool {
        releaseLock.lock(); defer { releaseLock.unlock() }
        return releasedGen == releaseGen
    }

    /// ── ONE CLAIM, TAKEN ONCE, WITH A GENERATION (M5 review) ─────────────
    ///
    /// The two camera arms that pano+ drives itself — the AVF source and the
    /// vision-camera arm — share ONE claim. It is a TEST-AND-SET on the bridge
    /// queue: a start that finds either arm claimed is refused `panoplus-busy`
    /// AT ONCE, before going async, and never touches the claim it found.
    ///
    /// It used to be two blind Bools. A second start during a live sweep set
    /// the flag (a no-op), was refused busy inside its async block — and its
    /// refusal CLEARED the live sweep's claim. The live sweep's stop then took
    /// nothing, fell into the ARKit teardown, and left CoreMotion running and
    /// the plugin armed for the rest of the process.
    ///
    /// Each claim carries a generation, so only the start that took it can
    /// release it, and a start's post-open re-check asks "is MY claim still
    /// standing", not "is some claim standing".
    private enum ArmClaim { case none, avf(UInt64), vc(UInt64) }
    private static var armClaim: ArmClaim = .none
    private static var armClaimGen: UInt64 = 0

    /// Test-and-set. Nil when any arm is already claimed.
    private static func claimArm(vc: Bool) -> UInt64? {
        armLock.lock(); defer { armLock.unlock() }
        guard case .none = armClaim else { return nil }
        armClaimGen += 1
        armClaim = vc ? .vc(armClaimGen) : .avf(armClaimGen)
        return armClaimGen
    }
    /// Release the claim `gen` — and only that one (a start that refused).
    private static func releaseArm(_ gen: UInt64) {
        armLock.lock(); defer { armLock.unlock() }
        switch armClaim {
        case .avf(let g) where g == gen, .vc(let g) where g == gen: armClaim = .none
        default: break
        }
    }
    /// Is the claim `gen` still standing? The start path's check that a
    /// concurrent teardown did not take it while the arm was opening.
    private static func armIsClaimed(_ gen: UInt64) -> Bool {
        armLock.lock(); defer { armLock.unlock() }
        switch armClaim {
        case .avf(let g), .vc(let g): return g == gen
        case .none: return false
        }
    }
    /// TAKE whatever is claimed, atomically. Exactly one caller ever gets it.
    private static func takeArm() -> ArmClaim {
        armLock.lock(); defer { armLock.unlock() }
        let c = armClaim
        armClaim = .none
        return c
    }

    /// How long `start` will wait for ARKit to acknowledge a stop before it
    /// gives up waiting and reports what it saw.  It never BLOCKS on the main
    /// queue — the wait is a semaphore with this timeout, so a busy main thread
    /// degrades to "not observed" in the pack rather than to a deadlock.
    private static let arTeardownWaitS = 1.0

    /// ── THE SEQUENTIAL HANDOFF, PERFORMED RATHER THAN ASSERTED ──────────
    ///
    /// ARKit and an AVCaptureSession cannot share the camera.  Until
    /// 2026-08-31 that fact was stated in three comments and implemented
    /// nowhere: the IMU branch returned early from the ARKit machinery but
    /// never stopped `RNSARSession`, and the capture surface mounted
    /// `<ARCameraView>` on BOTH arms — and mounting that view is what STARTS
    /// ARKit.  So the decoupled arm opened its session with ARKit live.  The
    /// claimed safety net ("the AVF input open FAILS LOUDLY if ARKit still
    /// holds it") is not a guarantee either: ARKit holds the WIDE camera and
    /// this opens the ULTRA-WIDE, a different `AVCaptureDevice`, and
    /// `canAddInput` tests configuration compatibility rather than runtime
    /// exclusivity.
    ///
    /// The surface no longer mounts the AR view on this arm — that is the
    /// structural fix.  This is the belt, for every other path that may hold
    /// ARKit (another surface, a router hand-off, a stale mount): stop it,
    /// WAIT for the stop to be observed, and RECORD what was found so the pack
    /// can say whether the handoff was clean.
    private static func tearDownArkitForDecoupledArm() -> [String: Any] {
        let wasRunning = RNSARSession.shared.isRunning
        guard wasRunning else {
            return ["arWasRunning": false, "stopObserved": true, "waitedMs": 0.0]
        }
        let t0 = CACurrentMediaTime()
        let sem = DispatchSemaphore(value: 0)
        // Main queue, ASYNC + semaphore rather than `.sync`: the library's own
        // ARSessionBridge stops the session from the main queue, and a `.sync`
        // from this global queue would deadlock the moment main is waiting on
        // anything that waits on us.
        DispatchQueue.main.async {
            RNSARSession.shared.stop()
            sem.signal()
        }
        let observed = sem.wait(timeout: .now() + arTeardownWaitS) == .success
        return [
            "arWasRunning": true,
            "stopObserved": observed,
            "waitedMs": (CACurrentMediaTime() - t0) * 1000.0,
            "stillRunningAfter": RNSARSession.shared.isRunning,
            "note": observed
                ? "ARKit was live and was stopped before the AVF session opened"
                : "the main queue did not acknowledge the stop within "
                  + "\(Int(arTeardownWaitS * 1000)) ms; the input open below is "
                  + "then the observation, and the session fault ledger names an "
                  + "interruption if the camera was never released",
        ]
    }

    /// Begin a sweep.  `options` are the RNISPanoCore option dictionary plus:
    ///   sessionDir        String  (REQUIRED — the host owns pack placement)
    ///   preferHighFps     Bool    (default true; see the header note)
    ///   lockCamera        Bool    (default TRUE — v6; see the header note)
    ///   meteringSettleMs  Double  (default 600; the CEILING on the AE/AWB/AF
    ///                              re-convergence poll after the video-format
    ///                              switch — not a fixed sleep)
    ///   poseSource        String  ("ar" DEFAULT | "imu")
    ///                              "imu" selects the DECOUPLED AVFoundation +
    ///                              CoreMotion source (0.5× ultra-wide, 60 fps,
    ///                              attitude time-aligned at pts+τ).  It also
    ///                              needs `tauS` + `tauMeasured` + `basisIndex`
    ///                              and REFUSES to start without them.
    ///   tauUncorrected    Bool    (default FALSE) — the DELIBERATE τ = 0,
    ///                              UNMEASURED sweep.  Only read on the "imu"
    ///                              arm.  It replaces the τ half of the
    ///                              precondition (the BASIS is still required)
    ///                              and it OUTRANKS the calibration store, so
    ///                              a calibrated phone still runs the
    ///                              experiment.  The pack records
    ///                              `tauProvenance: "uncorrected"` and never
    ///                              `tauMeasured: true`.
    ///
    /// Resolves `{ sessionDir, startedAtMs, pluginAvailable }`.
    /// Rejects: `panoplus-busy` (a sweep is already running),
    /// `invalid-options`, `panoplus-io`.
    ///
    /// NOT `panoplus-unavailable`: that code was emitted by a
    /// conditional-compilation fallback that no longer exists — the stitcher
    /// dependency is unconditional now, so its absence is a compile error.
    /// The JS layer still synthesises the code itself when the whole native
    /// module is missing; this method never produces it.
    @objc(start:resolver:rejecter:)
    public func start(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let sessionDir = options["sessionDir"] as? String, !sessionDir.isEmpty else {
            rejecter("invalid-options", "sessionDir must be a non-empty string", nil)
            return
        }
        Self.beginRelease()
        let preferHighFps = (options["preferHighFps"] as? Bool) ?? true
        // Default ON.  A feature shipped OFF in the field build has not been
        // tested, and this one is the fix for a defect the operator has
        // rejected twice.
        let lockCamera = (options["lockCamera"] as? Bool) ?? true
        let settleMs = (options["meteringSettleMs"] as? NSNumber)?.doubleValue ?? 600.0
        // "ar" (DEFAULT) — ARKit is the frame source, exactly as shipped.
        // "imu" — the decoupled AVFoundation + CoreMotion source.  OFF unless a
        // caller passes it, and it additionally REFUSES to start without a
        // measured τ and a validated basis for this device, so a build that
        // merely carries the code cannot sweep on it by accident.
        let poseSource = (options["poseSource"] as? String) ?? "ar"
        // ── THE SECOND ATTITUDE CHANNEL, DEFAULT OFF ───────────────────
        // Record CoreMotion attitude into `attitude_imu.jsonl` BESIDE the
        // ARKit attitude `track.jsonl` already carries, so the two pose arms
        // can be replayed offline against the SAME PIXELS.  Absent ⇒ the
        // sweep that shipped: no second plugin, no second file, no `meta.json`
        // key.  See RNISPanoImuSidecar's header for why an AVCaptureSession
        // could not do this and CoreMotion can.
        let imuSidecar = (options["imuSidecar"] as? Bool) ?? false
        // ── M5: THE VISION-CAMERA ARM ──────────────────────────────────
        // An IMU sweep on the camera `<Camera>` already opened: no
        // AVCaptureSession here, no ARKit, and every state that cannot run is
        // a NAMED refusal. Read WITH the pose arm, never alone.
        if poseSource == "imu", (options["vcPluginArm"] as? Bool) == true {
            startVcArm(options: options, sessionDir: sessionDir,
                       imuSidecar: imuSidecar, resolver: resolver, rejecter: rejecter)
            return
        }
        // ⚠ CLAIMED HERE, SYNCHRONOUSLY, ON THE BRIDGE QUEUE — before the hop
        // below.  A `stop()` / `cancel()` / bundle reload that reaches teardown
        // while start is still in flight must find the arm claimed, or it takes
        // the ARKit branch and orphans a live 60 fps session for the rest of
        // the process.  See `armClaim`.
        var avfGen: UInt64 = 0
        if poseSource == "imu" {
            guard let g = Self.claimArm(vc: false) else {
                rejecter("panoplus-busy", "A pano+ sweep is already running.", nil)
                return
            }
            avfGen = g
        }
        DispatchQueue.global(qos: .userInitiated).async {
            if RNISPanoCore.isRunning() {
                if poseSource == "imu" { Self.releaseArm(avfGen) }
                rejecter("panoplus-busy", "A pano+ sweep is already running.", nil)
                return
            }
            var opts = (options as? [String: Any]) ?? [:]
            opts["sessionDir"] = sessionDir
            // v10 — THE ACTIVE LENS, written HERE and over anything JS sent.
            // The undistortion gate refuses coefficients that belong to
            // another camera, so the camera identity may never come from the
            // host.  (The body itself is read straight from `uname` inside
            // RNISPanoCore; only the lens name has to come through Swift,
            // because AVFoundation is not reachable from that translation
            // unit.)  Advisory by construction — see RNISPanoCameraLock.lensType().
            //
            // v12 — PER ARM.  `RNISPanoCameraLock.lensType()` resolves the
            // WIDE-ANGLE device, which is right for ARKit and wrong for the
            // decoupled arm: the 2026-08-31 packs captured on the ultra-wide
            // yet recorded `deviceLens: ...WideAngleCamera`, so the gate
            // reported `focal-mismatch` where the true answer was
            // `lens-mismatch`.  The AVF plan's resolver is the same one
            // `start` will use, so plan and stamp cannot disagree.
            if poseSource == "imu" {
                let planned = RNISPanoAvfSource.plannedFormatReport(options: opts)
                opts["lensDeviceLens"] = (planned["lens"] as? String) ?? ""
            } else {
                opts["lensDeviceLens"] = RNISPanoCameraLock.shared.lensType() ?? ""
            }
            do {
                try RNISPanoCore.start(options: opts)
            } catch let nsError as NSError {
                if poseSource == "imu" { Self.releaseArm(avfGen) }
                let key = nsError.code == 409 ? "panoplus-busy"
                        : (nsError.code == 400 ? "invalid-options" : "panoplus-io")
                rejecter(key,
                         (nsError.userInfo[NSLocalizedDescriptionKey] as? String)
                             ?? "Could not start the pano+ sweep.",
                         nsError)
                return
            }

            // ── THE DECOUPLED ARM ──────────────────────────────────────
            // A SECOND PRODUCER against the engine that has already started
            // above.  Everything below this block — the AR video-format
            // override, the ARKit camera lock, the AR exposure probe and the
            // frame-plugin registration — is ARKit machinery that has no
            // meaning when ARKit is not the source, so this returns early
            // rather than running any of it.
            //
            // SEQUENTIAL BY CONSTRUCTION: ARKit and AVCaptureSession cannot
            // share the camera, and the AVF input open FAILS LOUDLY
            // (`panoplus-camera-busy`) if ARKit still holds it.  That makes a
            // clean teardown OBSERVABLE rather than asserted — the router's
            // acceptance test is a repeated pano+ ⇄ router cycle with that
            // code never appearing.
            if poseSource == "imu" {
                // ── JOB 1: THE STORED CALIBRATION ──────────────────────
                // The arm REFUSES to start without a measured τ and a
                // validated basis, and re-measuring both before every sweep is
                // a calibration nobody runs.  So when the caller did not carry
                // them, look them up in `RNISPanoCalibStore` — keyed by
                // (model, lens, format) for τ and by model for the basis, which
                // is the honest scoping: a format change invalidates τ and
                // cannot have moved the basis.
                //
                // OPTIONS WIN.  A caller that passed τ explicitly is running a
                // deliberate experiment, and silently overriding it with a
                // stored number would make that experiment unreproducible.
                // `calibrationSource` says which route supplied each half, so
                // the pack is never ambiguous about it.
                //
                // ⚠️ THE KEY IS THE PLANNED FORMAT'S, NOT A DEFAULT.  τ is
                // stored under `model | lens | W×H | fps` because the
                // rolling-shutter constant is part of it, and this bridge does
                // not know W×H — the AVF source's own selector picks it.  Until
                // 2026-08-31 this block used its own `?? 0` fallbacks and read
                // the store at `0x0`, while the calibration panel wrote at the
                // probe's real `1920x1440`.  Different keys: a correctly
                // measured, correctly persisted τ was NEVER found, and the arm
                // refused for a calibration that was sitting on disk.  Asking
                // the selector costs a device discovery and opens nothing.
                //
                // NSNull-SAFE, deliberately: `startPanoPlus` strips `undefined`
                // so the keys are normally ABSENT, but a caller sending an
                // explicit `null` bridges to NSNull — which `== nil` is false
                // for.  That would skip the lookup AND leave NSNull in the bag
                // for `RNISPanoAttitude.configure` to read as "not measured".
                // ── AND THE ONE REQUEST THE STORE MAY NOT OVERRIDE ────
                //
                // 2026-08-31.  `tauUncorrected` is the DELIBERATE τ = 0,
                // UNMEASURED sweep — the experiment that answers whether τ
                // binds at all, after the device's own calibration scattered
                // 5.03 ms and the persist gate correctly refused to write one.
                //
                // The block below exists to FILL IN whatever the caller left
                // out, which is right for a normal sweep and FATAL for this
                // one: an uncorrected experiment quietly handed a measured τ
                // off disk is not the experiment, and the pack would say it
                // was.  So the request is resolved by the SHARED C++ rule
                // (`resolveTauSource`, host-tested, and the one Android will
                // read too) before the store is consulted for τ, and it wins.
                //
                // THE BASIS IS UNAFFECTED and is still looked up: it is a
                // different number with a different scope, it really WAS
                // measured on this device (0.234° over 777 pairs, basis #8),
                // and an uncorrected sweep still needs it or the whole canvas
                // is rotated.
                let uncorrected =
                    (opts["tauUncorrected"] as? NSNumber)?.boolValue ?? false
                var calibSource = "options"
                let haveOptTau = (opts["tauMeasured"] as? NSNumber) != nil
                    || (opts["tauMeasured"] as? Bool) != nil
                let haveOptBasis = (opts["basisIndex"] as? NSNumber) != nil

                // ── WHETHER THE HOST MAY FORCE THE ZERO AT ALL ─────────
                // Asked of the SHARED C++ on the RAW bag, before anything is
                // derived from it.  Anything but "none" means the caller made a
                // second, contradicting claim about τ, and the bag must travel
                // on UNTOUCHED so `RNISPanoAttitude.configure` refuses it with
                // `tau-mode-conflict`.
                //
                // 2026-08-31, review: this test used to live here as
                // `tauMeasured && tauS.isFinite`, which let TWO contradicting
                // shapes through to the forcing branch — a `tauMeasured: true`
                // with no `tauS`, and an explicit non-zero `tauS` with no
                // `tauMeasured`.  Both produced a TRUTHFUL pack, which is
                // exactly why it survived a reading: the defect is not in the
                // pack, it is that the caller's explicit claim was discarded
                // where no reader could ever see it.
                let optTauNum = opts["tauS"] as? NSNumber
                let optConflict = RNISPanoAttitude.uncorrectedOptionConflict(
                    uncorrected: uncorrected,
                    claimsMeasuredTau:
                        (opts["tauMeasured"] as? NSNumber)?.boolValue ?? false,
                    hasExplicitTau: optTauNum != nil,
                    tauS: optTauNum?.doubleValue ?? 0.0)

                var basisSource = haveOptBasis ? "options" : "none"
                var storeTau: NSNumber? = nil
                var haveStoreTau = false
                // ⚠ THE STORE IS ASKED ONLY WHEN ITS ANSWER CAN MATTER, and
                // not asking is NOT the same as pretending it answered nothing.
                // `resolveTauSource` returns `Uncorrected` for EITHER value of
                // `hasStoreTau`, and `Options` whenever the caller supplied τ —
                // so in the two cases skipped here the store's τ cannot change
                // the outcome, and the lookup is a device discovery run for a
                // question already decided.  The BASIS is a separate reason to
                // look, and on the operator's actual sweep (no `basisIndex` in
                // the bag) that reason always fires, so the calibration record
                // and the planned format still ride the pack.
                if !haveOptBasis || (!uncorrected && !haveOptTau) {
                    let store = RNISPanoCalibStore.shared
                    let planned = RNISPanoAvfSource.plannedFormatReport(options: opts)
                    let lens = (planned["lens"] as? String)
                        ?? (opts["lens"] as? String)
                        ?? "AVCaptureDeviceTypeBuiltInUltraWideCamera"
                    let w = (planned["width"] as? Int) ?? 0
                    let h = (planned["height"] as? Int) ?? 0
                    let fps = (planned["fps"] as? Double)
                        ?? (opts["targetFps"] as? NSNumber)?.doubleValue ?? 60.0
                    var r = store.resolve(lens: lens, width: w, height: h, fps: fps)
                    storeTau = r["tauS"] as? NSNumber
                    haveStoreTau = storeTau != nil
                    if !haveOptBasis, let b = r["basisIndex"] as? NSNumber {
                        opts["basisIndex"] = b
                        basisSource = "store"
                        calibSource = "store"
                    }
                    // ⚠ THE RECORD RIDES THE PACK EVEN WHEN ITS τ WAS NOT
                    // USED.  On the uncorrected arm it may carry a stored
                    // `tauS` this sweep DELIBERATELY IGNORED, which is evidence
                    // worth keeping — it says what was on disk at the time.
                    // But an unlabelled second `tauS` in the same file as the
                    // one that ran is a misreading waiting to happen, so the
                    // record SAYS whether its own number was applied rather
                    // than leaving that to be inferred from a sibling key.
                    if haveStoreTau {
                        let applied = !uncorrected && !haveOptTau
                        r["tauApplied"] = applied
                        r["tauAppliedNote"] = applied
                            ? "this record's tauS WAS applied to this sweep."
                            : "this record's tauS was NOT applied to this sweep — it "
                            + "is what was on disk at the time, kept as evidence. Read "
                            + "tauProvenance / tauSource for the tau the sweep ran on."
                    }
                    opts["calibrationRecord"] = r
                    // The key this sweep actually looked under, in the pack.  A
                    // reader must never have to reconstruct it from the lens
                    // name and guess the format.
                    opts["calibrationPlannedFormat"] = planned
                }

                // THE PRECEDENCE, DECIDED IN THE SHARED C++ — and asked here,
                // once, on the same inputs whether or not the store was
                // consulted.
                let tauSource = RNISPanoAttitude.tauSource(
                    uncorrected: uncorrected,
                    hasOptionTau: haveOptTau,
                    hasStoreTau: haveStoreTau)
                if tauSource == "store", let t = storeTau {
                    opts["tauS"] = t
                    opts["tauMeasured"] = true
                    calibSource = "store"
                } else if tauSource == "uncorrected" {
                    if optConflict == "none" {
                        // FORCED, and stated: τ is zero because this sweep
                        // deliberately applies none, and `tauMeasured` is
                        // written FALSE rather than left absent so no
                        // downstream default can revive it.
                        opts["tauS"] = 0.0
                        opts["tauMeasured"] = false
                    }
                    // ELSE: left EXACTLY as it arrived, so `configure` refuses
                    // it by name.  Nothing is chosen here.
                }

                // THREE VALUES, NEVER A BOOLEAN, all the way to the pack:
                // `tauSource` says options / store / uncorrected / none for τ
                // alone, `basisSource` the same for the basis, and
                // `calibrationSource` keeps its existing meaning for every
                // sweep that is not the experiment.
                opts["tauSource"] = tauSource
                opts["basisSource"] = basisSource
                // ⚠ COMPOUND ON THE EXPERIMENT, because a bare "uncorrected"
                // answers the τ question by ERASING the basis one: the basis
                // usually came off the store and really was measured, and a
                // reader who checks only this field would learn nothing about
                // the half that IS a calibration.
                opts["calibrationSource"] = uncorrected
                    ? "uncorrected+basis-\(basisSource)"
                    : calibSource

                // ── THE HANDOFF, PERFORMED BEFORE THE CAMERA IS ASKED FOR ──
                // ARKit and an AVCaptureSession cannot share the camera, and
                // until 2026-08-31 nothing anywhere tore ARKit down for this
                // arm.  The result rides the pack, so a sweep can say whether
                // the handoff was clean instead of leaving a zero-frame pack
                // to be guessed at.  See `tearDownArkitForDecoupledArm`.
                opts["arTeardown"] = Self.tearDownArkitForDecoupledArm()

                // ── A SIDECAR ASKED FOR ON THIS ARM IS REFUSED BY NAME ──
                //
                // NOT because CoreMotion is busy — it is this arm's PRIMARY
                // attitude source — but because the comparison the sidecar
                // exists for is impossible in principle here.  ARKit has just
                // been torn down four lines above, so there is no second
                // channel to record: `track.jsonl` would carry CoreMotion and
                // `attitude_imu.jsonl` would carry the same CoreMotion, and a
                // pack with two copies of one channel is worse than a pack
                // with one, because it LOOKS like an A/B.
                //
                // Recorded rather than dropped.  A host that set the flag and
                // got nothing must be able to read why out of the pack instead
                // of concluding the recording silently failed.
                if imuSidecar {
                    RNISPanoCore.recordImuSidecar([
                        "ran": false,
                        "requested": true,
                        "reason": "not-applicable-on-imu-arm",
                        "detail":
                            "the second attitude channel was requested but this sweep "
                          + "ran on the DECOUPLED arm, where ARKit is torn down before "
                          + "the camera opens. CoreMotion is already this arm's only "
                          + "attitude source and track.jsonl carries it; there is no "
                          + "ARKit channel left to compare it against, so no sidecar "
                          + "was recorded. The same-pixels A/B is an ARKit-arm "
                          + "instrument by construction.",
                    ])
                }

                do {
                    let report = try RNISPanoAvfSource.shared.start(
                        sessionDir: sessionDir, options: opts)
                    // ⚠ DID A TEARDOWN TAKE THE ARM WHILE WE WERE OPENING?
                    // `stop()`/`cancel()`/`invalidate()` all run on their own
                    // queues; one that landed during the camera open has
                    // already taken the claim and gone home believing there
                    // was nothing to stop.  Without this check the session it
                    // could not see would run for the life of the process.
                    guard Self.armIsClaimed(avfGen) else {
                        RNISPanoAvfSource.shared.stop()
                        // v12 REVIEW FIX (major) — the racing teardown's own
                        // unlock() ran BEFORE this start's lock existed (the
                        // lock is the last act of AvfSource.start), so without
                        // this the aborted sweep leaves AE/AWB/AF pinned on
                        // the ultra-wide for every other capture surface in
                        // the app.  Idempotent when nothing was locked.
                        RNISPanoCameraLock.shared.unlock()
                        RNISPanoCore.cancel()
                        rejecter("panoplus-cancelled",
                                 "The sweep was stopped while the decoupled camera "
                                 + "was still opening. The AVF session and CoreMotion "
                                 + "have been torn down rather than orphaned.", nil)
                        return
                    }
                    // v12 — the lock ran inside `RNISPanoAvfSource.start`
                    // (its device, its ordering); record it exactly like the
                    // AR arm does so meta.json carries it, and hand it to JS
                    // under the SAME key — `panoPlusCameraLockLine` keys its
                    // "unlocked" warning on this field, and this arm never
                    // sending it is why five unlocked sweeps drew no warning.
                    let lockReport = report["cameraLock"] as? [String: Any]
                    RNISPanoCore.recordCameraLock(lockReport)
                    resolver([
                        "sessionDir": sessionDir,
                        "startedAtMs": Date().timeIntervalSince1970 * 1000.0,
                        "pluginAvailable": true,
                        "poseSource": "imu",
                        "avfSource": report,
                        "cameraLock": (lockReport as Any?) ?? NSNull(),
                    ])
                } catch let f as RNISPanoAvfSource.StartFailure {
                    // The engine is already running at this point; drop it,
                    // or the next start would reject with `panoplus-busy` and
                    // the operator would chase the wrong fault.  The arm claim
                    // goes with it — a refused start owns no producer.
                    Self.releaseArm(avfGen)
                    RNISPanoCore.cancel()
                    rejecter(f.code, f.detail, nil)
                } catch {
                    Self.releaseArm(avfGen)
                    RNISPanoCore.cancel()
                    rejecter("panoplus-io", "\(error)", nil)
                }
                return
            }

            // Order matters: the engine must be ready BEFORE the plugin starts
            // receiving frames, or the first frames are dropped on the floor.
            let session = RNSARSession.shared
            if preferHighFps && !session.prefersHighFpsFormat {
                Self.setPreviousHighFps(session.prefersHighFpsFormat)
                session.setHighFpsFormatEnabled(true)
            } else {
                Self.setPreviousHighFps(nil)
            }

            // v6 — LOCK, THEN REGISTER.  See the header's ordering note: the
            // format switch above has just re-run `arSession.run`, so the
            // settle is not optional, and the plugin must not start ingesting
            // until the lock has been attempted or the reference frame (the
            // photometric datum for the whole sweep) is metered mid-drift.
            //
            // `attach()` runs in BOTH arms: with the lock off we still want
            // the per-frame exposure metadata, because that is exactly the arm
            // where the frames really do drift and the engine's exact
            // normalisation has the most work to do.
            var lockReport: [String: Any]
            if lockCamera {
                lockReport = RNISPanoCameraLock.shared
                    .lockForSweep(settleCeilingMs: settleMs)
            } else {
                lockReport = RNISPanoCameraLock.shared.attach()
                lockReport["requested"] = false
                lockReport["locked"] = false
                lockReport["reason"] = "lockCamera=false"
            }
            RNISPanoCore.recordCameraLock(lockReport)

            // v11 — ARM THE NON-CIRCULAR EXPOSURE PROBE before the plugin
            // starts feeding frames, so the ARSession is already cached when
            // the first one arrives.  `attach()` only resets counters and
            // schedules an ASYNC main-queue discovery: it never blocks this
            // queue, and a failure to find the session degrades to
            // `exposure.ar.frames: 0` with a stated reason, never to a
            // failed start.
            RNISArExposureProbe.shared.attach()

            RNISARPluginRegistry.shared.register(RNISPanoPlusPlugin.shared)

            // ── THE SECOND ATTITUDE CHANNEL (2026-09-01) ───────────────
            //
            // ⚠ AFTER the pano+ registration, and the order is a decision, not
            // an accident.  The registry runs plugins SERIALLY in registration
            // order, so registering the sidecar first would put its work ahead
            // of the memcpy that copies ARKit's recycled buffer — i.e. it would
            // add latency INSIDE the shipped producer's critical section.  The
            // experiment goes second and the field-validated arm keeps its
            // place.
            //
            // WHAT THAT COSTS, STATED AND COUNTED: CoreMotion starts a few
            // microseconds later than the frame plugin, so the first ARFrame or
            // two can land before the first 200 Hz sample.  Those frames are
            // recorded as `arFramesBeforeFirstSample` — the offline A/B drops
            // them from the IMU arm — rather than being paired with a sample
            // that does not exist.  At 200 Hz against 60 fps that is normally
            // zero or one frame, inside the engine's own bootstrap.
            //
            // OFF ⇒ NOTHING REGISTERS.  `RNISPanoPlusPlugin` is untouched by
            // this feature; the sidecar is its own plugin, so a sweep that did
            // not ask for it runs the same single plugin the field build has
            // always run and writes the same `meta.json` keys.
            //
            // A FAILURE HERE IS NEVER A FAILED START.  `start` returns
            // `armed: false` with a named reason (no device motion, no session
            // dir, file open refused) and that report rides the pack — an
            // operator standing in an aisle must not lose a sweep because a
            // recording channel could not open its file.
            if imuSidecar {
                let armed = RNISPanoImuSidecar.shared.start(
                    sessionDir: sessionDir,
                    arLens: RNISPanoCameraLock.shared.lensType() ?? "")
                if (armed["armed"] as? Bool) != true {
                    // The refusal is recorded IMMEDIATELY rather than waiting
                    // for teardown, because a sidecar that never armed has no
                    // teardown of its own — `stop()` returns `ran: false` and
                    // the reason would be lost.
                    RNISPanoCore.recordImuSidecar(armed)
                }
            }

            resolver([
                "sessionDir": sessionDir,
                "startedAtMs": Date().timeIntervalSince1970 * 1000.0,
                "pluginAvailable": true,
                // STATED, NEVER INFERRED.  The IMU branch above answers
                // `poseSource` and this one used to answer nothing, so JS had
                // to read "the key is absent" as "it must have been ARKit".
                // That is the shape of assumption that lets a silent fallback
                // hide: the arm the sweep RAN on is a fact native owns, and it
                // now says so on both branches.
                "poseSource": "ar",
                // Surfaced to JS so the capture surface can warn the operator
                // IMMEDIATELY when the sweep is running unlocked, instead of
                // the pack saying so afterwards.
                "cameraLock": lockReport,
            ])
        }
    }

    /// M5 — the vision-camera arm's start. See `RNISPanoVcArm` for the what;
    /// this is the order: claim → refuse what cannot run (device, zoom, fps,
    /// basis) → start the ENGINE → start the arm (IMU, lock, plugin armed) →
    /// re-check the claim → resolve. Nothing is opened, so a refusal at any
    /// step leaves no camera state behind.
    private func startVcArm(
        options: NSDictionary,
        sessionDir: String,
        imuSidecar: Bool,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let vcGen = Self.claimArm(vc: true) else {
            rejecter("panoplus-busy", "A pano+ sweep is already running.", nil)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            func refuse(_ code: String, _ detail: String) {
                Self.releaseArm(vcGen)
                rejecter(code, detail, nil)
            }
            if RNISPanoCore.isRunning() {
                refuse("panoplus-busy", "A pano+ sweep is already running.")
                return
            }
            guard RNISPanoVcArm.isSupported else {
                refuse("panoplus-vc-arm-unavailable",
                       "This build has no vision-camera sweep plugin "
                     + "(panoplus_sweep_ingest), so a sweep on <Camera>'s camera "
                     + "cannot run. It is refused rather than opening a camera of "
                     + "pano+'s own.")
                return
            }
            var opts = (options as? [String: Any]) ?? [:]
            opts["sessionDir"] = sessionDir
            let cameraId = (opts["vcCameraId"] as? String) ?? ""
            let dev: RNISPanoVcArm.Device
            do {
                dev = try RNISPanoVcArm.resolve(cameraId: cameraId)
            } catch let f as RNISPanoVcArm.StartFailure {
                refuse(f.code, f.detail); return
            } catch {
                refuse("panoplus-io", "\(error)"); return
            }
            if let r = RNISPanoVcRules.zoomRefusal(zoomFactor: Double(dev.device.videoZoomFactor)) {
                refuse(r.code, r.detail); return
            }
            if let r = RNISPanoVcRules.fpsRefusal(activeFps: dev.activeFps) {
                refuse(r.code, r.detail); return
            }

            // ── τ (D2): 0 BY DEFAULT ON THIS ARM ───────────────────────
            // A caller that passes a measured τ is running a deliberate
            // experiment and wins; otherwise the sweep applies no timing
            // correction and SAYS so. The conflict test is the shared C++
            // one on the RAW bag: a contradicting bag travels on untouched so
            // `configure` refuses it by name.
            let optTauNum = opts["tauS"] as? NSNumber
            let claimsMeasured = (opts["tauMeasured"] as? NSNumber)?.boolValue ?? false
            let askedUncorrected = (opts["tauUncorrected"] as? NSNumber)?.boolValue ?? false
            let tauSource: String
            if (claimsMeasured || optTauNum != nil) && !askedUncorrected {
                tauSource = "options"
            } else {
                tauSource = "uncorrected"
                opts["tauUncorrected"] = true
                if RNISPanoAttitude.uncorrectedOptionConflict(
                    uncorrected: true, claimsMeasuredTau: claimsMeasured,
                    hasExplicitTau: optTauNum != nil,
                    tauS: optTauNum?.doubleValue ?? 0.0) == "none" {
                    opts["tauS"] = 0.0
                    opts["tauMeasured"] = false
                }
            }

            // ── THE BASIS (D3): DERIVED FROM THE CAMERA THAT IS OPEN ───
            let basisSource: String
            if opts["basisIndex"] as? NSNumber != nil {
                basisSource = "options"
                opts["basisDerivation"] = ["skipped": "the caller supplied basisIndex"]
            } else {
                let der = RNISPanoVcArm.deriveBasis(device: dev.device)
                opts["basisDerivation"] = der
                if (der["holdRefusal"] as? Bool) == true {
                    let r = RNISPanoVcRules.holdRefusal()
                    refuse(r.code, r.detail); return
                }
                let idx = (der["index"] as? NSNumber)?.intValue ?? -1
                if let r = RNISPanoVcRules.basisRefusal(
                    derivedIndex: idx,
                    mountingAngleDeg: (der["mountingAngleDeg"] as? NSNumber)?.intValue,
                    method: (der["method"] as? String) ?? "",
                    refusal: der["refusal"] as? String) {
                    refuse(r.code, r.detail); return
                }
                opts["basisIndex"] = idx
                basisSource = "derived"
            }
            opts["tauSource"] = tauSource
            opts["basisSource"] = basisSource
            opts["calibrationSource"] = "vc-arm: tau-\(tauSource)+basis-\(basisSource)"
            // The lens the frames come from, for the undistortion gate — the
            // colour lens, never a virtual container's type.
            opts["lensDeviceLens"] = dev.colourLens

            do {
                try RNISPanoCore.start(options: opts)
            } catch let nsError as NSError {
                let key = nsError.code == 409 ? "panoplus-busy"
                        : (nsError.code == 400 ? "invalid-options" : "panoplus-io")
                refuse(key, (nsError.userInfo[NSLocalizedDescriptionKey] as? String)
                             ?? "Could not start the pano+ sweep.")
                return
            }
            // The second attitude channel is an ARKit-arm instrument. Recorded
            // AFTER the engine starts (M5 review): before it there is no
            // session to record into, and the refusal was dropped silently.
            if imuSidecar {
                RNISPanoCore.recordImuSidecar([
                    "ran": false, "requested": true, "reason": "not-applicable-on-vc-arm",
                    "detail": "the sweep ran on vision-camera's camera with CoreMotion as its "
                        + "only attitude source; there is no ARKit channel to compare.",
                ])
            }
            do {
                let report = try RNISPanoVcArm.shared.start(
                    sessionDir: sessionDir, device: dev, options: opts)
                // A teardown that landed while the arm was starting has taken
                // the claim and found nothing to stop.
                guard Self.armIsClaimed(vcGen) else {
                    RNISPanoVcArm.shared.stop()
                    RNISPanoCameraLock.shared.unlock()
                    RNISPanoCore.cancel()
                    rejecter("panoplus-cancelled",
                             "The sweep was stopped while the vision-camera arm was "
                             + "starting; it was disarmed rather than left running.", nil)
                    return
                }
                let lockReport = report["cameraLock"] as? [String: Any]
                RNISPanoCore.recordCameraLock(lockReport)
                resolver([
                    "sessionDir": sessionDir,
                    "startedAtMs": Date().timeIntervalSince1970 * 1000.0,
                    "pluginAvailable": true,
                    "poseSource": "imu",
                    "frameSource": "vc-plugin",
                    "opensAvCaptureSession": false,
                    "vcArm": report,
                    "cameraLock": (lockReport as Any?) ?? NSNull(),
                ])
            } catch let f as RNISPanoVcArm.StartFailure {
                Self.releaseArm(vcGen)
                RNISPanoCore.cancel()
                rejecter(f.code, f.detail, nil)
            } catch {
                Self.releaseArm(vcGen)
                RNISPanoCore.cancel()
                rejecter("panoplus-io", "\(error)", nil)
            }
        }
    }

    /// Finish the sweep: unregister, drain, tail-flush, write the pack, and
    /// resolve the summary.  Rejects `panoplus-not-running` / `panoplus-empty`
    /// / `panoplus-io`; on `panoplus-empty` the ORIGINAL NSError is passed to
    /// the rejecter so RN copies its userInfo onto the JS error — a FAILED
    /// sweep still surfaces its counters and its sessionDir (the pattern this
    /// pod already uses for every robust bridge entry).
    @objc(stop:rejecter:)
    public func stop(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let releaseGen = Self.currentReleaseGen()
        DispatchQueue.global(qos: .userInitiated).async {
            Self.teardownPlugin()
            Self.markReleased(releaseGen)   // M8 — before the finalize
            // `isRunning` tracks the SESSION, not the engine: an engine abort
            // (tracking-lost, chain-lost) leaves the session running and its
            // painted content is exactly what the operator wants to see, so
            // this never short-circuits on an aborted sweep.  The only case
            // it catches is "there is genuinely nothing to finalize", and the
            // `status() == nil` second check keeps a sweep that has not yet
            // seen its first frame from being rejected outright.
            if !RNISPanoCore.isRunning() && RNISPanoCore.status() == nil {
                rejecter("panoplus-not-running", "No pano+ sweep is running.", nil)
                return
            }
            do {
                let summary = try RNISPanoCore.finalizeSession()
                resolver(summary)
            } catch let nsError as NSError {
                let key = nsError.code == 404 ? "panoplus-not-running"
                        : (nsError.code == 422 ? "panoplus-empty" : "panoplus-io")
                rejecter(key,
                         (nsError.userInfo[NSLocalizedDescriptionKey] as? String)
                             ?? "The pano+ sweep could not be finished.",
                         nsError)
            }
        }
    }

    /// Abandon the sweep and delete its session directory.  Always resolves.
    @objc(cancel:rejecter:)
    public func cancel(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let releaseGen = Self.currentReleaseGen()
        DispatchQueue.global(qos: .userInitiated).async {
            Self.teardownPlugin()
            Self.markReleased(releaseGen)
            RNISPanoCore.cancel()
            resolver(["cancelled": true])
        }
    }

    /// Poll fallback for the live status.  The primary channel is the plugin's
    /// SYNC return riding `onArFrame.plugins["sweep"]`; this exists
    /// for hosts that are not mounting the AR meta callback.
    @objc(getStatus:rejecter:)
    public func getStatus(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        var st = RNISPanoCore.status() ?? ["running": false]
        // M5 — a DEVICE-LEVEL refusal on the vision-camera arm (a mirrored or
        // rotated buffer, a changed orientation, a zoom other than 1×) is
        // surfaced live, so the host discards the sweep by name instead of
        // letting it run on painting nothing.
        if RNISPanoVcArm.shared.isRunning,
           let r = RNISPanoVcArm.pluginReport()?["deviceRefusal"] as? String, !r.isEmpty {
            st["vcDeviceRefusal"] = r
        }
        // M8 — read through the FINISH, when the core may already answer
        // `running: false`: JS unmounts the camera on it.
        st["cameraReleased"] = Self.cameraReleased()
        resolver(st)
    }

    /// v12 — idle viewfinder for the decoupled arm.  Runs the arm's OWN
    /// AVCaptureSession input-only (no output, no delegate, no motion, no
    /// engine) so `RNISPanoSourceView` shows a live feed BEFORE the sweep —
    /// the operator could not frame the first shot on this arm, and the first
    /// frame anchors the whole canvas.
    ///
    /// A MODULE method on purpose: RN gives this module one serial method
    /// queue, so idle start/stop serialize with `start`/`stop`/`cancel` and
    /// the session is never configured from two threads — the exact reason
    /// the view itself has no lifecycle.  Refused (never forced) while ARKit
    /// runs: the surface only asks on the IMU arm, where ARCameraView is
    /// unmounted, but a host that asks at the wrong moment gets a named
    /// refusal instead of a camera fight.
    @objc(setIdlePreview:options:resolver:rejecter:)
    public func setIdlePreview(
        _ on: NSNumber,
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        if on.boolValue {
            guard !RNSARSession.shared.isRunning else {
                resolver(["on": false, "reason": "arkit-running"])
                return
            }
            // P5 — the options carry the lens ('ultraWide' default | 'wide'),
            // so the viewfinder frames with the SAME camera the sweep will
            // open.  planFormat reads the identical key on start().
            //
            // Parity (2026-09-03) — the source's own report is resolved
            // VERBATIM: `on`, a `reason` sentence naming the camera or the
            // refusal (`panoplus-no-wide: …`, `panoplus-bad-lens: …`,
            // `camera-open-failed: …`), and `lens` / `lensRequested`.  The
            // two-word `camera-open-failed` this used to synthesise for every
            // failure told the operator nothing about WHICH lens or WHY.
            resolver(RNISPanoAvfSource.shared.startIdlePreview(
                options: (options as? [String: Any]) ?? [:]))
        } else {
            RNISPanoAvfSource.shared.stopIdlePreview()
            resolver(["on": false])
        }
    }

    /// RN teardown hook.  Fires on a JS bundle reload, which is the ONE path
    /// that reaches neither `stop` nor `cancel` — and which would otherwise
    /// leave the frame plugin registered and the camera pinned for the rest of
    /// the process.  Runs on the RN bridge queue, so it must not block: the
    /// engine itself is left to `cancel()`, which claims the session and drops
    /// it on its own queue.
    @objc public func invalidate() {
        Self.teardownPlugin()
        // JOB 1 — the CALIBRATION recorder is a second AR-thread plugin with
        // the same leak, and it has its own bridge module whose `invalidate`
        // may or may not have run yet.  `stopWithoutSolving()` is idempotent
        // and a no-op when nothing is recording, so calling it from both places
        // is cheaper than reasoning about RN's teardown order.
        RNISPanoBasisCalibration.shared.stopWithoutSolving()
        DispatchQueue.global(qos: .userInitiated).async {
            RNISPanoCore.cancel()
        }
    }

    /// Unregister the frame plugin and restore whatever high-fps state we
    /// found.  Idempotent — stop, cancel and invalidate all call it.
    private static func teardownPlugin() {
        // ── THE SECOND ATTITUDE CHANNEL, BEFORE EVERY BRANCH ───────────
        //
        // ⚠ ABOVE THE DECOUPLED-ARM EARLY RETURN, DELIBERATELY.  This method
        // has an exit that skips everything below it, and a recorder reachable
        // from only one of two exits is a 200 Hz CoreMotion service running
        // for the life of the process the first time the arms are confused —
        // which is the leak this file's own `armClaim` doc-comment was
        // written about.  The sidecar arms on the ARKit arm ONLY, so today the
        // decoupled path cannot have one; placing the call where that fact is
        // not load-bearing costs one uncontended lock and removes the class.
        //
        // `stop()` unregisters its plugin, stops CoreMotion, FLUSHES AND
        // CLOSES `attitude_imu.jsonl`, and returns the block for `meta.json`.
        // The close matters as much as the report: the file is written through
        // a 64 KB buffer, so up to ~700 samples — several seconds of the end of
        // the sweep — live only in that buffer until it is closed.
        //
        // Idempotent: a second call (stop then invalidate) answers
        // `ran: false` and records nothing, so the FIRST caller's report is
        // never overwritten by an empty one.  Runs before finalize on every
        // path, which is what puts the block in the pack.
        let sidecar = RNISPanoImuSidecar.shared.stop()
        if (sidecar["ran"] as? Bool) == true {
            RNISPanoCore.recordImuSidecar(sidecar)
        }
        // THE DECOUPLED ARM FIRST, and it returns early: the ARKit machinery
        // below (plugin unregister, high-fps restore, AR exposure probe)
        // never ran on this arm.  Stopping the AVF source also writes
        // `pose_source.json` beside the pack, BEFORE finalize.
        // TAKE the claim atomically: exactly one caller can ever get `true`,
        // so a concurrent stop/cancel/invalidate cannot both stop the source
        // and neither can miss it.
        //
        // v12 — the lock IS taken on this arm now (its own device, inside
        // `RNISPanoAvfSource.start`), so the restore and the evidence merge
        // run here too, in the same stop-then-merge-then-finalize order the
        // AR path uses.  Both are idempotent: a sweep whose lock was refused,
        // or that ran with `lockCamera=false`, restores nothing and merges a
        // benign report.
        // M5 — THE VISION-CAMERA ARM, taken like the AVF one: disarm the
        // plugin (waiting out a frame inside the engine), stop CoreMotion and
        // publish the pose block, then unlock vision-camera's device. The lock
        // witness is the plugin's per-frame check, named as such.
        let claim = takeArm()
        if case .vc = claim {
            RNISPanoVcArm.shared.stop()
            RNISPanoCameraLock.shared.unlock()
            var sweep = RNISPanoCameraLock.shared.sweepReport()
            sweep["framesObservedUnlocked"] =
                RNISPanoVcArm.pluginReport()?["framesObservedUnlocked"] ?? NSNull()
            sweep["witness"] = "vc-plugin"
            RNISPanoCore.mergeCameraLock(sweep)
            return
        }
        if case .avf = claim {
            RNISPanoAvfSource.shared.stop()
            RNISPanoCameraLock.shared.unlock()
            // v12 REVIEW FIX (major) — the shared lock's own counters are
            // AR-plugin-driven and stay ZERO on this arm, which a reader
            // would misread as "held perfectly".  The real witness is the
            // AVF delegate's per-frame check; merge it in beside them and
            // name the witness so the zeros cannot be misattributed.
            var sweep = RNISPanoCameraLock.shared.sweepReport()
            sweep["framesObservedUnlocked"] =
                RNISPanoAvfSource.shared.framesObservedUnlockedCount
            sweep["witness"] = "avf-delegate"
            RNISPanoCore.mergeCameraLock(sweep)
            return
        }
        // v12 — the idle viewfinder holds the camera OUTSIDE any sweep, so
        // the arm-claim gate above never covers it: a JS reload with idle
        // preview up would otherwise pin the camera for the life of the
        // process.  Idempotent, and a no-op during a live sweep.
        RNISPanoAvfSource.shared.stopIdlePreview()
        RNISARPluginRegistry.shared.unregister(RNISPanoPlusPlugin.pluginName)
        // v6 — ALWAYS restore the camera, on every exit path.  A sweep that
        // ends, is cancelled, or fails after locking must not leave AE/AWB/AF
        // pinned for every other capture surface in the app.  `unlock()` is
        // idempotent and a no-op when nothing was locked.
        //
        // MERGE THE SWEEP'S OWN EVIDENCE INTO THE PACK BEFORE THE ENGINE IS
        // FINALIZED.  What the lock reported at START is only half the story:
        // how many frames were observed running UNLOCKED, how many re-asserts
        // it took, and above all whether the RESTORE was refused (which leaves
        // the camera pinned for every other surface) are only known now.  Both
        // callers reach this before the session is torn down, so the merged
        // report lands in meta.json.
        RNISPanoCameraLock.shared.unlock()
        RNISPanoCore.mergeCameraLock(RNISPanoCameraLock.shared.sweepReport())
        // v11 — the AR-exposure probe's own account of itself, recorded
        // BEFORE `detach()` clears the session reference and before the
        // engine is finalized, for the same reason the lock's sweep report
        // is: a run with `exposure.ar.frames == 0` is ambiguous between a
        // build that could not reach ARKit's camera, a preview view that was
        // never mounted, and a sweep that ingested nothing.  The counters
        // survive `detach()` deliberately; the ORDER here is belt-and-braces.
        RNISPanoCore.recordArExposureProbe(RNISArExposureProbe.shared.report())
        RNISArExposureProbe.shared.detach()
        if let prev = takePreviousHighFps() {
            RNSARSession.shared.setHighFpsFormatEnabled(prev)
        }
    }
}

#endif
