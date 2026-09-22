// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusCalibBridge.swift — React Native bridge for the pano+ CALIBRATION
// step (module name `RNSSweepCalibration`).
//
// A SEPARATE MODULE from `RNSSweepSession`, for the same reason pano+ is
// separate from `HostStitchPlugins`: this is a different lifecycle.  A
// sweep is start → many frames → stop → a pack.  A calibration is a gesture, a
// reduction, a verdict, and a decision about whether to KEEP the number — and
// the keeping is the part that matters, because a persisted wrong number is
// worse than no number at all.
//
// Separate names also mean a host can probe for calibration support with a
// plain `typeof NativeModules.RNSSweepCalibration?.startBasisCalibration ===
// 'function'`, which is how a build that has not been re-podded announces
// itself instead of failing at the first call.
//
// ── THE ONE RULE THIS FILE ENFORCES ──────────────────────────────────────
//
// `saveTau` / `saveBasis` REFUSE anything whose own gate said no.  The gate
// lives in C++ (`rnis_pano_calib`), the enforcement lives in the store
// (`RNISPanoCalibStore`), and this file is the third place that will not route
// around either.  `subjectDistanceFitM` is the repo's standing example of what
// happens when a fit grades itself: 2–7.5× wrong, saturating its own clamp, and
// nothing ever reported it.

#if canImport(React)

import Foundation
import React

// ⚠ NOT USED BY ANY CODE IN THIS FILE — the only `RNISARFrameContext` mention
// below is in a doc comment.  It is kept because the six references to
// `RNISPanoBasisCalibration` further down are unguarded and that class lives
// behind this module's import graph; see the banner at the top of
// RNISPanoBasisCalibration.swift.  Verify with a compile before deleting it.

@objc(RNSSweepCalibration)
public class PanoPlusCalibBridge: NSObject, RCTInvalidating {

    @objc public static func requiresMainQueueSetup() -> Bool { return false }

    /// The format a τ record is keyed by.
    ///
    /// ⚠️ THE DEFAULT IS RESOLVED, NOT GUESSED — and this comment used to claim
    /// that while the code did the opposite.  It read `width ?? 0, height ?? 0`
    /// and keyed a caller that passed nothing at `…|0x0|60`, while the panel's
    /// SAVE passed the probe's real `1920x1440`.  Two spellings of "the format
    /// a sweep runs on", one written and one read, so the panel reported NOT
    /// CALIBRATED one line after reporting "τ saved" — and listed the record it
    /// had just written under `storedTauKeys`, which is the store being honest
    /// about a key nobody was asking for.
    ///
    /// `RNISPanoAvfSource.planFormat` is the ONE selector that decides which
    /// lens and format the arm opens, so it is what the default now asks.  An
    /// explicit `width`/`height` from the caller still WINS (the probe passes
    /// what it actually ran on, which is the honest key for a τ measured there).
    ///
    /// If the hardware refuses — no physical ultra-wide, no 4:3 at 60 fps —
    /// there is no format, so `0x0` survives as the key.  That is deliberate:
    /// nothing can be measured on this body, and a fabricated key would let a τ
    /// be written under a format that does not exist.
    private static func formatKeyParts(_ o: NSDictionary?) -> (String, Int, Int, Double) {
        // `planFormat` spells the rate `targetFps` (it is a START option); the
        // calibration key spells it `fps`.  Translate rather than let a 30 fps
        // caller silently receive the dimensions of the 60 fps format.
        var planOpts = (o as? [String: Any]) ?? [:]
        if let f = o?["fps"] as? NSNumber { planOpts["targetFps"] = f }
        let planned = RNISPanoAvfSource.plannedFormatReport(options: planOpts)
        let lens = (o?["lens"] as? String)
            ?? (planned["lens"] as? String)
            ?? "AVCaptureDeviceTypeBuiltInUltraWideCamera"
        let w = (o?["width"] as? NSNumber)?.intValue
            ?? (planned["width"] as? Int) ?? 0
        let h = (o?["height"] as? NSNumber)?.intValue
            ?? (planned["height"] as? Int) ?? 0
        let fps = (o?["fps"] as? NSNumber)?.doubleValue
            ?? (planned["fps"] as? Double) ?? 60.0
        return (lens, w, h, fps)
    }

    // ── The gesture ─────────────────────────────────────────────────────

    /// Begin the basis gesture recording.  Requires the AR camera to be
    /// MOUNTED (the reference is `RNISARFrameContext.poseRotation`), and
    /// refuses while a pano+ sweep is running.
    @objc(startBasisCalibration:resolver:rejecter:)
    public func startBasisCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let opts = (options as? [String: Any]) ?? [:]
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let r = try RNISPanoBasisCalibration.shared.start(options: opts)
                resolver(r)
            } catch let f as RNISPanoBasisCalibration.StartFailure {
                rejecter(f.code, f.detail, nil)
            } catch {
                rejecter("basiscal-io", "\(error)", nil)
            }
        }
    }

    /// The live coaching read.  Poll it at a few Hz; it is a cached
    /// dictionary, not a reduction, so it costs nothing.
    @objc(basisCalibrationStatus:rejecter:)
    public func basisCalibrationStatus(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        resolver(RNISPanoBasisCalibration.shared.liveStatus())
    }

    /// Stop and SOLVE.  `options.tauS` (default 0) is the ARKit↔CoreMotion
    /// offset the fit uses; both clocks are the system uptime clock, and the
    /// returned `stability` block is what makes that an observation.
    @objc(stopBasisCalibration:resolver:rejecter:)
    public func stopBasisCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let tau = (options["tauS"] as? NSNumber)?.doubleValue ?? 0.0
        DispatchQueue.global(qos: .userInitiated).async {
            resolver(RNISPanoBasisCalibration.shared.stop(tauS: tau))
        }
    }

    /// Re-reduce the SAME recording at a different τ, without asking the
    /// operator to perform the gesture again.
    @objc(resolveBasisCalibration:resolver:rejecter:)
    public func resolveBasisCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let tau = (options["tauS"] as? NSNumber)?.doubleValue ?? 0.0
        DispatchQueue.global(qos: .userInitiated).async {
            resolver(RNISPanoBasisCalibration.shared.resolve(tauS: tau))
        }
    }

    /// Throw the recording away and free its memory.
    @objc(discardBasisCalibration:rejecter:)
    public func discardBasisCalibration(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RNISPanoBasisCalibration.shared.discard()
        resolver(["discarded": true])
    }

    // ── τ ───────────────────────────────────────────────────────────────

    /// Combine repeated `measureCaptureClock` results into ONE number with a
    /// stated uncertainty, and say whether it may be persisted.
    ///
    /// ⚠ The gate is the STANDARD ERROR, never |τ|.  See the header of
    /// `RNISPanoCalibCore.h`.
    @objc(combineTauRuns:resolver:rejecter:)
    public func combineTauRuns(
        runs: NSArray,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        // `as?`, not `as!`: `NSArray` does not bridge to `[Any]` with a plain
        // `as`, and a force-cast on a bridge boundary the JS side controls is a
        // crash waiting for a malformed payload. An empty list reaches
        // `combineTau`, which answers "no-runs" — a refusal, not a zero.
        resolver(RNISPanoCalibCore.combineTauRuns((runs as? [Any]) ?? []))
    }

    /// THE FORMAT AN IMU SWEEP WOULD OPEN ON THIS BODY, and therefore the key
    /// its τ must be stored under.
    ///
    /// Exposed to JS so the capture surface can look the calibration up under
    /// the same key the bridge will, instead of under a default that agrees
    /// with it only by luck.  `ok: false` carries the hardware `reason`
    /// (`panoplus-no-ultrawide` / `panoplus-no-60fps-format` / `panoplus-no-camera`)
    /// — on that body the arm is not "uncalibrated", it is unavailable, and the
    /// two must not read the same on screen.
    ///
    /// Opens nothing: device discovery plus a format enumeration.  Safe to call
    /// with ARKit live, which is exactly when the surface asks.
    @objc(plannedCaptureFormat:resolver:rejecter:)
    public func plannedCaptureFormat(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        var planOpts = (options as? [String: Any]) ?? [:]
        if let f = options["fps"] as? NSNumber { planOpts["targetFps"] = f }
        var out = RNISPanoAvfSource.plannedFormatReport(options: planOpts)
        // The KEY itself, assembled here so no JS caller has to know the
        // `model | lens | WxH | fps` grammar.
        if let lens = out["lens"] as? String,
           let w = out["width"] as? Int,
           let h = out["height"] as? Int,
           let fps = out["fps"] as? Double {
            out["tauKey"] = RNISPanoCalibStore.tauKey(
                lens: lens, width: w, height: h, fps: fps)
        } else {
            out["tauKey"] = NSNull()
        }
        out["basisKey"] = RNISPanoCalibStore.basisKey()
        resolver(out)
    }

    // ── Persistence ─────────────────────────────────────────────────────

    /// What is on file for this device, and under which keys.
    @objc(getCalibration:resolver:rejecter:)
    public func getCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let (lens, w, h, fps) = Self.formatKeyParts(options)
        var out = RNISPanoCalibStore.shared.snapshot(lens: lens, width: w, height: h, fps: fps)
        out["resolved"] = RNISPanoCalibStore.shared.resolve(
            lens: lens, width: w, height: h, fps: fps)
        resolver(out)
    }

    /// Persist a τ fit.  `options`: `{ fit, lens?, width?, height?, fps?, extra? }`
    /// where `fit` is EXACTLY what `combineTauRuns` returned.
    @objc(saveTauCalibration:resolver:rejecter:)
    public func saveTauCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let fit = options["fit"] as? [String: Any] else {
            rejecter("invalid-options", "options.fit must be the combineTauRuns result.", nil)
            return
        }
        let (lens, w, h, fps) = Self.formatKeyParts(options)
        let extra = (options["extra"] as? [String: Any]) ?? [:]
        do {
            let r = try RNISPanoCalibStore.shared.saveTau(
                fit: fit, lens: lens, width: w, height: h, fps: fps, extra: extra)
            resolver(r)
        } catch let e as RNISPanoCalibStore.SaveRefusal {
            rejecter(e.code, e.detail, nil)
        } catch {
            rejecter("calibration-io", "\(error)", nil)
        }
    }

    /// Persist a basis.  `options`: `{ solve, extra? }` where `solve` is
    /// EXACTLY what `stopBasisCalibration` / `resolveBasisCalibration` returned.
    @objc(saveBasisCalibration:resolver:rejecter:)
    public func saveBasisCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let solve = options["solve"] as? [String: Any] else {
            rejecter("invalid-options",
                     "options.solve must be the stopBasisCalibration result.", nil)
            return
        }
        let extra = (options["extra"] as? [String: Any]) ?? [:]
        do {
            let r = try RNISPanoCalibStore.shared.saveBasis(solve: solve, extra: extra)
            resolver(r)
        } catch let e as RNISPanoCalibStore.SaveRefusal {
            rejecter(e.code, e.detail, nil)
        } catch {
            rejecter("calibration-io", "\(error)", nil)
        }
    }

    /// Forget a calibration.  `options.scope` is `"tau"` / `"basis"` / `"all"`.
    /// Offered because a WRONG stored number is the failure this whole step is
    /// defending against, and the operator must be able to get back to "not
    /// measured" without reinstalling.
    @objc(clearCalibration:resolver:rejecter:)
    public func clearCalibration(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let scope = (options["scope"] as? String) ?? "all"
        let (lens, w, h, fps) = Self.formatKeyParts(options)
        resolver(RNISPanoCalibStore.shared.clear(
            scope: scope, lens: lens, width: w, height: h, fps: fps))
    }

    /// RN teardown.  A JS bundle reload reaches neither stop nor discard, and
    /// without this it would leave a plugin registered on the AR thread and
    /// CoreMotion running for the rest of the process — the exact leak
    /// `PanoPlusBridge.invalidate()` exists to prevent for the sweep.
    @objc public func invalidate() {
        RNISPanoBasisCalibration.shared.stopWithoutSolving()
    }
}

#endif
