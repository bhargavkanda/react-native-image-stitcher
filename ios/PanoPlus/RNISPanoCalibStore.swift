// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCalibStore — where the two measured numbers LIVE between sweeps.
//
// A calibration that has to be re-measured before every sweep is a calibration
// nobody runs.  This is the file that makes "run it once, then sweep" true, and
// it is deliberately NATIVE rather than an AsyncStorage key on the JS side: the
// decoupled arm refuses to START without τ and the basis, and that refusal
// happens inside `RNISPanoAvfSource.start`, below any place a JS default could
// reach.  Putting the store here means a sweep can be started from anywhere —
// including a future auto-router row — and still find its calibration.
//
// ── TWO SCOPES, BECAUSE THE TWO NUMBERS DO NOT EXPIRE TOGETHER ───────────
//
// τ folds the camera/sensor epoch difference, the exposure-timestamp convention
// and the rolling-shutter readout constant into ONE observable.  The last of
// those is a property of the FORMAT — a different binning or a different rate
// reads out over a different interval — so τ is keyed by
// `model | lens | W×H | fps`, and changing the format invalidates it.
//
// `C` is the device-body → camera-raster rotation: one of 24 signed
// permutations, fixed by how the sensor is mounted in the chassis.  It does not
// depend on the format at all, so it is keyed by `model` alone.  Keying it by
// format too would silently force a re-measure every time the capture format
// moved, for a quantity that cannot have changed — and the re-measure is the
// expensive one, because it is the one with the gesture.
//
// ── THE CROSS-LENS CAVEAT IS RECORDED, NOT ASSUMED ───────────────────────
//
// `C` is measured against ARKit, which streams the WIDE camera; it is applied
// on the decoupled arm, which streams the PHYSICAL ULTRA-WIDE.  That transfer
// is sound because the 24 candidates are 90° apart and two back cameras on one
// chassis are parallel to a fraction of a degree — no mounting tolerance can
// promote one candidate over another.  `referenceSource` carries the fact into
// every record and every pack, so the argument is available rather than
// remembered.
//
// ── NOTHING IS PERSISTED THAT DID NOT PASS ITS OWN GATE ──────────────────
//
// `saveTau` and `saveBasis` REFUSE a record whose `ok` is false.  This repo has
// `subjectDistanceFitM` as the cautionary example — a fit that was 2–7.5×
// wrong, saturating its clamp, and self-scoring, so nothing ever reported it.
// The gate is in C++ (`rnis_pano_calib`), the refusal is enforced here, and the
// two are different files on purpose.

#if canImport(Foundation)

import Foundation

@objc(RNISPanoCalibStore)
public final class RNISPanoCalibStore: NSObject {

    @objc public static let shared = RNISPanoCalibStore()

    /// Bump when the RECORD SHAPE changes in a way an old file cannot satisfy.
    /// A record whose schema does not match is IGNORED, not migrated: a
    /// half-understood old record is exactly the kind of thing that produces a
    /// confident wrong τ.
    @objc public static let schema = 1

    private let queue = DispatchQueue(label: "io.imagestitcher.rn.panoplus.calibstore")
    private override init() { super.init() }

    // MARK: - Identity

    /// `uname().machine`, e.g. `iPhone17,1`.  The marketing name is not stable
    /// across locales and is not what a τ is a property of.
    @objc public static func deviceModel() -> String {
        var s = utsname()
        uname(&s)
        let m = withUnsafePointer(to: &s.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        return m.isEmpty ? "unknown" : m
    }

    /// The τ key.  Every component is load-bearing — see the header.
    @objc public static func tauKey(lens: String, width: Int, height: Int, fps: Double) -> String {
        return "\(deviceModel())|\(lens)|\(width)x\(height)|\(Int(fps.rounded()))"
    }

    /// The basis key.  Model alone, and the header says why.
    @objc public static func basisKey() -> String { return deviceModel() }

    // MARK: - File

    private var fileURL: URL? {
        guard let dir = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let sub = dir.appendingPathComponent("RNImageStitcher", isDirectory: true)
        if !FileManager.default.fileExists(atPath: sub.path) {
            try? FileManager.default.createDirectory(
                at: sub, withIntermediateDirectories: true)
        }
        let url = sub.appendingPathComponent("panoplus_calibration.json")
        adoptEarlierFileOnce(into: url, supportDir: dir)
        return url
    }

    /// One-time adoption of a calibration an EARLIER build of this library wrote
    /// under a different Application Support sub-folder.  The folder is
    /// DISCOVERED (an immediate sub-folder holding a same-named file of this
    /// schema), never named; the file is COPIED so a downgrade still finds its
    /// own.  Runs once per process and only while no current file exists, so a
    /// calibration taken on this build always wins.  Every caller of `fileURL`
    /// runs on `queue`, which is what makes the plain flag safe.
    private var adoptionChecked = false
    private func adoptEarlierFileOnce(into target: URL, supportDir: URL) {
        if adoptionChecked { return }
        adoptionChecked = true
        let fm = FileManager.default
        guard !fm.fileExists(atPath: target.path),
              let subs = try? fm.contentsOfDirectory(
                at: supportDir, includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]) else { return }
        let own = target.deletingLastPathComponent().standardizedFileURL
        for d in subs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
            where d.standardizedFileURL != own {
            let cand = d.appendingPathComponent(target.lastPathComponent)
            guard let data = try? Data(contentsOf: cand),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["schema"] as? NSNumber)?.intValue == Self.schema else { continue }
            // Copy beside the target, then MOVE into place: a rename within one
            // folder is atomic, so a process killed mid-copy leaves a stray
            // temp file, never a truncated target that would both block any
            // later adoption and read as "no calibration".
            let tmp = target.deletingLastPathComponent()
                .appendingPathComponent(".adopt-\(UUID().uuidString).json")
            do {
                try fm.copyItem(at: cand, to: tmp)
                try fm.moveItem(at: tmp, to: target)
                NSLog("[RNIS pano+] adopted an earlier calibration file")
            } catch {
                try? fm.removeItem(at: tmp)
            }
            return
        }
    }

    private func loadAllLocked() -> [String: Any] {
        guard let url = fileURL, let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any] else { return [:] }
        // A file from a different schema is not read.  See the header.
        if (dict["schema"] as? NSNumber)?.intValue != Self.schema { return [:] }
        return dict
    }

    private func writeAllLocked(_ dict: [String: Any]) -> Bool {
        guard let url = fileURL else { return false }
        var out = dict
        out["schema"] = Self.schema
        out["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        guard JSONSerialization.isValidJSONObject(out),
              let data = try? JSONSerialization.data(
                withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) else { return false }
        // `.atomic` so a crash mid-write cannot leave a truncated JSON file
        // that the next launch would read as "no calibration".
        do { try data.write(to: url, options: .atomic) } catch { return false }
        return true
    }

    // MARK: - Read

    /// Everything on file, plus the keys this device would look under.  The
    /// keys are returned even when nothing is stored, because "no calibration"
    /// and "a calibration under a different key" look identical otherwise —
    /// and they call for completely different actions.
    @objc public func snapshot(lens: String, width: Int, height: Int, fps: Double)
        -> [String: Any] {
        var out: [String: Any] = [:]
        queue.sync {
            let all = loadAllLocked()
            let tKey = Self.tauKey(lens: lens, width: width, height: height, fps: fps)
            let bKey = Self.basisKey()
            let taus = all["tau"] as? [String: Any] ?? [:]
            let bases = all["basis"] as? [String: Any] ?? [:]
            out["schema"] = Self.schema
            out["deviceModel"] = Self.deviceModel()
            out["tauKey"] = tKey
            out["basisKey"] = bKey
            out["tau"] = taus[tKey] ?? NSNull()
            out["basis"] = bases[bKey] ?? NSNull()
            out["storedTauKeys"] = Array(taus.keys).sorted()
            out["storedBasisKeys"] = Array(bases.keys).sorted()
            out["updatedAt"] = all["updatedAt"] ?? NSNull()
            out["path"] = fileURL?.path ?? NSNull()
        }
        return out
    }

    /// The pair the decoupled arm needs, or `nil` for whichever half is
    /// missing.  Deliberately NOT a "best effort" merge: a τ from one format
    /// applied to another is precisely the silent error this file exists to
    /// prevent.
    @objc public func resolve(lens: String, width: Int, height: Int, fps: Double)
        -> [String: Any] {
        let snap = snapshot(lens: lens, width: width, height: height, fps: fps)
        let tau = snap["tau"] as? [String: Any]
        let basis = snap["basis"] as? [String: Any]
        var out: [String: Any] = [
            "tauKey": snap["tauKey"] ?? NSNull(),
            "basisKey": snap["basisKey"] ?? NSNull(),
            "haveTau": tau != nil,
            "haveBasis": basis != nil,
        ]
        out["tauS"] = (tau?["tauS"] as? NSNumber) ?? NSNull()
        out["tauStdErrMs"] = (tau?["stdErrMs"] as? NSNumber) ?? NSNull()
        out["tauMeasuredAt"] = tau?["measuredAt"] ?? NSNull()
        out["basisIndex"] = (basis?["index"] as? NSNumber) ?? NSNull()
        out["basisLabel"] = basis?["label"] ?? NSNull()
        out["basisMeasuredAt"] = basis?["measuredAt"] ?? NSNull()
        out["complete"] = (tau != nil && basis != nil)
        if tau == nil && basis == nil {
            out["missing"] = "tau+basis"
        } else if tau == nil {
            out["missing"] = "tau"
        } else if basis == nil {
            out["missing"] = "basis"
        } else {
            out["missing"] = NSNull()
        }
        return out
    }

    // MARK: - Write

    public struct SaveRefusal: Error {
        public let code: String
        public let detail: String
    }

    /// Persist a τ fit.  `fit` is the dictionary `RNISPanoCalibCore.combineTauRuns`
    /// returned — unmodified, so the record carries the evidence that produced
    /// it and not a summary somebody re-typed.
    public func saveTau(fit: [String: Any], lens: String, width: Int, height: Int,
                        fps: Double, extra: [String: Any]) throws -> [String: Any] {
        guard (fit["ok"] as? NSNumber)?.boolValue == true else {
            throw SaveRefusal(
                code: "calibration-not-persistable",
                detail: "The τ fit did not pass its own gate (\(fit["reason"] ?? "unknown")). "
                      + "A silently-wrong τ is worse than none: it produces a sweep "
                      + "that looks plausible and is not. Nothing was written.")
        }
        guard let tauS = (fit["tauS"] as? NSNumber)?.doubleValue, tauS.isFinite else {
            throw SaveRefusal(code: "calibration-malformed",
                              detail: "The τ fit passed its gate but carries no finite tauS.")
        }
        var rec: [String: Any] = fit
        rec["tauS"] = tauS
        rec["measuredAt"] = ISO8601DateFormatter().string(from: Date())
        rec["deviceModel"] = Self.deviceModel()
        rec["lens"] = lens
        rec["width"] = width
        rec["height"] = height
        rec["fps"] = fps
        for (k, v) in extra { rec[k] = v }

        let key = Self.tauKey(lens: lens, width: width, height: height, fps: fps)
        var wrote = false
        queue.sync {
            var all = loadAllLocked()
            var taus = all["tau"] as? [String: Any] ?? [:]
            taus[key] = rec
            all["tau"] = taus
            wrote = writeAllLocked(all)
        }
        guard wrote else {
            throw SaveRefusal(code: "calibration-io",
                              detail: "Could not write the calibration file.")
        }
        return ["saved": true, "key": key, "record": rec]
    }

    /// Persist a basis.  `solve` is the dictionary
    /// `RNISPanoCalibCore.solveBasis` returned.
    ///
    /// ⚠ THE DRIFT VERDICT IS NOT A PERSIST GATE, and that is deliberate: the
    /// basis is a discrete choice among 24 permutations, and a drifting gyro
    /// does not make a different permutation correct.  The drift RIDES the
    /// record so every pack carries the architecture's own veto number, but it
    /// never blocks a measurement that is exactly right.
    ///
    /// ⚠ THE τ-STABILITY VERDICT *IS* A PERSIST GATE, and the argument above
    /// does NOT transfer to it (2026-08-31).  `basisStability()` re-fits at
    /// −10/−5/0/+5/+10 ms and reports whether the WINNER MOVES.  A winner that
    /// changes under a 5 ms clock offset was selected by the clock and not by
    /// the geometry — which is direct evidence that the permutation is NOT
    /// identified, exactly what this gate is for.  `sel.unique` at a single τ
    /// cannot cover it: the sweep exists precisely because uniqueness at one τ
    /// was judged insufficient.
    public func saveBasis(solve: [String: Any], extra: [String: Any]) throws -> [String: Any] {
        let basis = solve["basis"] as? [String: Any]
        guard (basis?["ok"] as? NSNumber)?.boolValue == true else {
            let why = basis?["reason"] ?? "unknown"
            throw SaveRefusal(
                code: "calibration-not-persistable",
                detail: "The basis fit did not pass its own gate (\(why)). "
                      + "Persisting a guess here would be worse than persisting "
                      + "nothing: `align()` would then run, on the wrong rotation, "
                      + "and produce a canvas. Nothing was written.")
        }
        let stability = solve["stability"] as? [String: Any]
        let stabilityRan = (stability?["ok"] as? NSNumber)?.boolValue == true
        let winnerStable = (stability?["winnerStable"] as? NSNumber)?.boolValue == true
        guard stabilityRan && winnerStable else {
            let why = stability?["reason"] ?? "not-run"
            throw SaveRefusal(
                code: "calibration-not-persistable",
                detail: "The basis is not stable under the τ sweep (\(why)). The fit "
                      + "was re-run at −10/−5/0/+5/+10 ms and the winning candidate "
                      + "did not survive it, so the permutation was chosen by the "
                      + "clock rather than by the geometry. A single-τ margin cannot "
                      + "see that, which is why the sweep exists. Nothing was "
                      + "written — perform the gesture again with more OFF-AXIS "
                      + "motion (tilt and roll, not a straight pan).")
        }
        guard let idx = (basis?["index"] as? NSNumber)?.intValue, idx >= 0, idx < 24 else {
            throw SaveRefusal(code: "calibration-malformed",
                              detail: "The basis fit passed its gate but carries no valid index.")
        }
        var rec: [String: Any] = [
            "index": idx,
            "label": basis?["label"] ?? "",
            "rmsDeg": basis?["rmsDeg"] ?? NSNull(),
            "marginDeg": basis?["marginDeg"] ?? NSNull(),
            "pairs": basis?["pairs"] ?? NSNull(),
            "runnerUpIndex": basis?["runnerUpIndex"] ?? NSNull(),
            "runnerUpLabel": basis?["runnerUpLabel"] ?? NSNull(),
            "drift": solve["drift"] ?? NSNull(),
            "stability": solve["stability"] ?? NSNull(),
            "excitationRef": solve["excitationRef"] ?? NSNull(),
            "selection": solve["selection"] ?? NSNull(),
            "tauUsedS": solve["tauUsedS"] ?? NSNull(),
            "imuSamples": solve["imuSamples"] ?? NSNull(),
            "refSamples": solve["refSamples"] ?? NSNull(),
            "durationS": solve["durationS"] ?? NSNull(),
            "deliveredImuHz": solve["deliveredImuHz"] ?? NSNull(),
            "measuredAt": ISO8601DateFormatter().string(from: Date()),
            "deviceModel": Self.deviceModel(),
            // The transfer caveat, in the record so it reaches every pack.
            "referenceSource": "arkit-poseRotation (wide camera)",
            "appliedTo": "any back lens on this body",
            "transferNote": "C ranges over 24 signed permutations, 90° apart. Two "
                          + "back cameras on one chassis are parallel to a fraction "
                          + "of a degree, so no mounting tolerance can promote one "
                          + "candidate over another. The basis therefore transfers "
                          + "from the ARKit (wide) reference to the ultra-wide.",
        ]
        for (k, v) in extra { rec[k] = v }

        let key = Self.basisKey()
        var wrote = false
        queue.sync {
            var all = loadAllLocked()
            var bases = all["basis"] as? [String: Any] ?? [:]
            bases[key] = rec
            all["basis"] = bases
            wrote = writeAllLocked(all)
        }
        guard wrote else {
            throw SaveRefusal(code: "calibration-io",
                              detail: "Could not write the calibration file.")
        }
        return ["saved": true, "key": key, "record": rec]
    }

    /// Forget a calibration.  `scope` is `"tau"`, `"basis"` or `"all"`.
    /// Clearing is offered because a WRONG stored number is the failure this
    /// whole file is defending against, and the operator must be able to get
    /// back to "not measured" without reinstalling the app.
    @objc public func clear(scope: String, lens: String, width: Int, height: Int,
                            fps: Double) -> [String: Any] {
        var out: [String: Any] = ["cleared": false]
        queue.sync {
            var all = loadAllLocked()
            if scope == "all" {
                all = [:]
            } else if scope == "tau" {
                var taus = all["tau"] as? [String: Any] ?? [:]
                taus.removeValue(forKey: Self.tauKey(
                    lens: lens, width: width, height: height, fps: fps))
                all["tau"] = taus
            } else if scope == "basis" {
                var bases = all["basis"] as? [String: Any] ?? [:]
                bases.removeValue(forKey: Self.basisKey())
                all["basis"] = bases
            }
            out["cleared"] = writeAllLocked(all)
            out["scope"] = scope
        }
        return out
    }
}

#endif
