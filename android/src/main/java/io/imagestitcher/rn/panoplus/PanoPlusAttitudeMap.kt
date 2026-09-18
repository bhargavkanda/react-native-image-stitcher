// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusAttitudeMap.kt — the arithmetic that turns Android's rotation
// vector into the engine's `world←cam` quaternion, and the four gates that
// decide whether it is allowed to.
//
// ── WHY THIS EXISTS NOW AND NOT BEFORE ──────────────────────────────────
//
// PanoPlusAndroidRecorder wrote `q = [0,0,0,1]`, `qSource:"none"` on every
// row, and its header's item 1 gives the reason in full: the device→camera
// change `C` is one of 24 candidates that rnis_pano_attitude.hpp picks FROM
// DATA (`selectBasis`), `Config::basisIndex` defaults to −1, and a rotated
// quaternion written under an unvalidated basis is a fabricated measurement.
// That reasoning is still correct and nothing here weakens it.
//
// What changed is that the port now HAS a basis with honest provenance.
// `rnis::pano::android::deriveBasis` computes `C` from two documented frames
// and one documented angle (SENSOR_ORIENTATION + lens facing), and the
// programme's rule for what such a number may be CALLED is a function rather
// than a comment: `derivedBasisProvenanceName()` returns `"derived"`, and the
// same header explains at length why it must never say `"measured"`.
//
// And the cost of the identity was measured on 2026-09-01: 152 frames of a
// real A35 sweep replayed on the PLANAR arm with a first→last quaternion angle
// of 0.00°, while ARCore recorded 57.1° of rotation over the same pixels. An
// IMU arm that reports no rotation is not an IMU arm, so the AR-vs-IMU
// comparison could not be run at all.
//
// ── THE HONESTY RULE, WHICH IS THE WHOLE POINT ──────────────────────────
//
// `qSource` NAMES THE BASIS AUTHORITY, never a bare "imu":
//
//   rotation-vector×basis-measured   an index measured against a reference
//                                    (selectBasis on a concurrent ARCore log)
//                                    and handed in as a start option
//   rotation-vector×basis-derived    deriveBasis()'s arithmetic on this
//                                    camera's own characteristics
//   none                             no basis at all → `q` STAYS IDENTITY,
//                                    byte-for-byte the old behaviour
//
// A reader who distrusts the derivation can therefore find every row it
// touched by string match, and `qDevice` — the RAW sensor quaternion — still
// rides on every row unchanged, so an offline pass can re-derive `q` under a
// different basis without re-recording a sweep. That is what makes the mapping
// checkable rather than merely stated.
//
// ── FOUR PLACES A SILENT WRONG ANSWER IS EASY, ALL PINNED BY TESTS ──────
//
// 1. QUATERNION ORDER. `SensorManager.getQuaternionFromVector` returns
//    **[w, x, y, z]**; `rnis::pano`'s convention — and the pack's `q` — is
//    **[x, y, z, w]**. [panoQuatFromSensorWxyz] is the ONE conversion, shared
//    with `qDevice`, so the two can never disagree.
// 2. MULTIPLICATION ORDER. The engine applies `R_engine = R_imu · C`
//    (rnis_pano_attitude.cpp, `matMul(Rimu, basis_, Reng)`). `C · R_imu` is a
//    different rotation that stays a unit quaternion and looks entirely
//    plausible. [panoApplyBasis] is fixed to the engine's order and
//    [PanoPlusAttitudeMapTest] pins it by exhibiting a case where the two
//    products differ.
// 3. INTERPOLATION. Samples arrive at ~122 Hz against 30 fps frames, so
//    nearest-neighbour is up to ~4 ms off — at a hand-sweep's ~20 °/s that is
//    ~0.08°, which is the same order as the gyro-bias term S1 exists to
//    resolve. The aligner brackets and SLERPs; so does [PanoAttitudeRing].
// 4. EXTRAPOLATION. A frame the ring cannot bracket, or can only bracket
//    across a gap wider than the stated bound, is REFUSED BY NAME and
//    COUNTED — never extrapolated to the nearest edge. `align()` refuses the
//    same two cases (`BeforeFirstSample` / `AfterLastSample`).
//
// ── PURE, AND THAT IS LOAD-BEARING ──────────────────────────────────────
//
// Nothing here imports `android.*`. Every function is deterministic and every
// class is JVM-constructible, which is what lets the 24-candidate arithmetic,
// the bracket search and the refusal ladder be tested on a machine with no
// device attached — the same reason cpp/rnis_pano_android_basis.* is STL-only.

package io.imagestitcher.rn.panoplus

/**
 * The bracket bound, milliseconds — mirrors the engine's own
 * `AttitudeAligner::Config::maxBracketGapS = 0.025` (rnis_pano_attitude.hpp).
 *
 * Deliberately the SAME number: a row this recorder accepts is then one the
 * aligner would grade `tracking = 2` on replay, so the pack and the engine
 * cannot disagree about which frames had an attitude behind them.
 */
internal const val DEFAULT_ATTITUDE_MAX_BRACKET_MS = 25.0

/**
 * THE SAME LIMIT FOR THE AR POSE RING, WHICH IS FED AT A COMPLETELY DIFFERENT
 * RATE — and getting this wrong made the AR arm arithmetically incapable of
 * producing a single painted strip, on every device, since it was written.
 *
 * ⚠ THE DEFECT. `DEFAULT_ATTITUDE_MAX_BRACKET_MS` = 25 ms is correct for the
 * IMU ring: `TYPE_ROTATION_VECTOR` is delivered at ~122 Hz on the A35, i.e.
 * 8.2 ms apart, so 25 ms is three samples of slack. The AR ring inherited that
 * same constant — but ARCore emits one pose per CAMERA frame, not per IMU
 * sample. Measured on 17 packs spanning 2026-08-24 to 2026-09-10: the ARCore
 * pose interval is 33.4-33.8 ms on EVERY one, p90 33.8, i.e. 29.6-30.0 Hz.
 *
 * So the two poses that straddle any frame are ~33.8 ms apart, 33.8 > 25, and
 * `solve()` refuses EVERY frame as `bracket-too-wide`. The operator's last AR
 * attempt: ARCore TRACKING on 184 of 208 poses, 183 accepted into the ring,
 * 174 frames waited for a pose and NONE timed out — and `framesSolved = 0`,
 * 175 `bracket-too-wide`, 203 ledger rows all `warming-up`, canvas empty. The
 * ring was full, the tracking was good, and the tolerance refused it anyway.
 * "Stuck in waiting for AR tracking" is that refusal, reported honestly.
 *
 * 50 ms, and the number is not arbitrary: the widest bracket two consecutive
 * ARCore poses can produce IS the pose interval, 33.8 ms, and the measured p90
 * is 35.0. 50 clears both with margin for jitter while still refusing a genuine
 * dropout — one missed ARCore pose is a 67.6 ms bracket, which stays refused.
 *
 * The two rings keep SEPARATE limits rather than one widened constant, because
 * widening the IMU's would silently accept a 50 ms gap in a 122 Hz series,
 * which is six missing samples and a real fault worth refusing.
 */
internal const val DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS = 50.0

/**
 * The FLOOR, not the trigger — see `shouldDegradeArToImu`. Never give the AR
 * arm up inside the first 30 frames however loudly ARCore complains, because
 * the earliest rows of a session are exactly where a transient reason can
 * appear before the bootstrap has finished.
 */
internal const val DEFAULT_AR_IMU_FALLBACK_FRAMES = 30

/**
 * The backstop for the shape where ARCore never reports a failure reason at
 * all and simply never tracks — measured on this phone as 32 consecutive rows
 * of PAUSED/NONE. 4 s is comfortably past the ~2 s one-shot bootstrap window
 * the repo measured across 17 sidecars, so an arm that was going to converge
 * has already done so and accepted a pose, which closes the degrade anyway.
 */
internal const val DEFAULT_AR_IMU_FALLBACK_GRACE_MS = 4_000.0

/**
 * Whether a live AR sweep should give its arm up and finish on the IMU ring.
 *
 * Pure, and separate from the recorder, because every term is a SAFETY
 * property and a safety property that cannot be tested is a comment.
 *
 * ── THE TRIGGER IS ARCore'S OWN VERDICT, NOT A FRAME COUNT ──────────────
 * The first version of this counted camera frames and fired at 30. That was
 * wrong, and the repo had already measured why. From all 17 ARCore sidecars
 * on disk (`src/sweep/panoPlusModel.ts`): INSUFFICIENT_LIGHT first appears at
 * ARCore row 60 in 12 of 13 failing packs, 2001-2062 ms after ARCore's first
 * row, and it is "the label ARCore latches when its one-shot motion-tracking
 * bootstrap fails to converge inside a fixed ~2 s window." Before that the
 * rows read PAUSED with reason NONE — ARCore is not failing, it is still
 * starting.
 *
 * A frame count cannot see that window. It starts at seq 0, before ARCore is
 * even resumed, and the live cadence measured across four packs on one phone
 * spans 9.3 to 23.3 fps — so 30 frames is anywhere from 1.3 s to 3.2 s. On
 * the verification run it fired after ~950 ms of ARCore output, at pose ~28
 * of the first 60, every one of which was PAUSED/NONE. A 25-frame run on the
 * same phone was 32 rows of pure NONE: five frames longer and it would have
 * discarded an arm that had never been given a chance to fail. The degrade is
 * one-way, so that discard is permanent.
 *
 * So [arcoreVerdictLatched] is the trigger — ARCore saying it failed, which
 * the same study shows is contiguous to the last row in 13 of 13 packs and
 * never returns to NONE. [nsSinceStart] >= [graceNs] is the backstop for the
 * shape where the reason never leaves NONE at all, set well past the ~2 s
 * window. [minFramesFloor] is now only a FLOOR: never degrade before it,
 * never degrade because of it.
 *
 * ⚠ [arPosesAccepted] AND [arFramesSolved] ARE THE ONE-WAY TERMS. The arm
 * decision is made once, before the camera opens, precisely so a sweep cannot
 * produce "a quaternion series that is not comparable with itself". This does
 * not breach that rule, it depends on it: with nothing accepted and nothing
 * solved, NO frame can have used an AR pose, so what comes out is entirely
 * IMU-derived rather than a splice.
 *
 * Both are checked, and the second is not redundant. `arPoseAccepted` is
 * written by the ARCore PUMP thread after the ring insert, so a reader on the
 * writer thread can see a ring that is one sample ahead of the counter. That
 * window provably cannot produce a mixed series — a one-sample ring can only
 * solve on a bit-exact timestamp match, measured 0 times in 738 on this
 * device — but the argument takes four steps and rests on a measurement.
 * `arFramesSolved` is incremented only inside `solveArPose`, on the writer
 * thread that evaluates this, so it states the property directly: "no frame
 * has solved against the AR ring." One term to read instead of four to trust.
 */
internal fun shouldDegradeArToImu(
    minFramesFloor: Int,
    arPosesAccepted: Long,
    arFramesSolved: Long,
    framesWithNoPose: Long,
    arcoreVerdictLatched: Boolean,
    nsSinceStart: Long,
    graceNs: Long,
    attitudeMapping: Boolean,
    haveBasis: Boolean,
    imuRingSamples: Long,
): Boolean =
    // `0` disables the degrade outright — the pre-2026-09-18 behaviour.
    minFramesFloor > 0 &&
        // ONE-WAY, both spellings. See the note above.
        arPosesAccepted == 0L &&
        arFramesSolved == 0L &&
        // A floor, not the trigger.
        framesWithNoPose >= minFramesFloor &&
        // Never degrade INTO an arm that cannot answer either: that would
        // swap one silent refusal for another and make the pack blame the
        // map instead of the tracker.
        attitudeMapping &&
        haveBasis &&
        imuRingSamples > 0L &&
        // ARCore has DECIDED it failed, or it has had its whole window and
        // said nothing at all.
        (arcoreVerdictLatched || nsSinceStart >= graceNs)

/** How many rotation-vector samples the ring keeps. ~122 Hz measured on
 *  SM-A356U1, so 512 is a little over four seconds — far more than any join
 *  needs, and bounded so a ten-minute sweep cannot grow it. */
internal const val ATTITUDE_RING_CAPACITY = 512

// ── qSource / authority vocabulary ──────────────────────────────────────
// Constants rather than inline literals because these strings are the pack's
// index: an offline pass selects the rows it trusts by matching them, and a
// typo in one of five call sites would silently split the set.

internal const val PANO_BASIS_AUTHORITY_MEASURED = "measured"
internal const val PANO_BASIS_AUTHORITY_DERIVED = "derived"
internal const val PANO_BASIS_AUTHORITY_NONE = "none"

internal const val PANO_Q_SOURCE_NONE = "none"
internal const val PANO_Q_SOURCE_MEASURED = "rotation-vector×basis-measured"
internal const val PANO_Q_SOURCE_DERIVED = "rotation-vector×basis-derived"

/**
 * THE AR ARM'S `qSource` (2026-09-02).
 *
 * ⚠ IT NAMES A SERIES WITH NO BASIS IN IT, AND THAT IS THE FACT IT EXISTS TO
 * RECORD. `Camera.getPose()` is `world<-camera` in ARCore's GL camera
 * convention — the same convention the engine was written against for ARKit —
 * so nothing is multiplied by `C` on this arm. A row that said
 * `rotation-vector×basis-derived` on an ARCore-fed sweep would send a reader
 * to the derivation for an answer the derivation had no part in, and would make
 * `qBasisIndex` look like the index that produced the pixels.
 */
internal const val PANO_Q_SOURCE_ARCORE = "arcore-world-from-camera"

// ── Quaternion / matrix arithmetic, transcribed from the engine ─────────
// Transcribed rather than invented: every one of these has the same branch
// structure as its counterpart in cpp/rnis_pano_attitude.cpp's `detail`
// namespace, so a row this file writes and a row `align()` would have
// produced from the same samples differ only by floating-point association.

/**
 * `SensorManager.getQuaternionFromVector` order → `rnis::pano` order.
 *
 * ⚠ THE SILENT ONE. Android hands back **[w, x, y, z]**; the engine, the pack
 * and `FrameInput::q` all use **[x, y, z, w]**. Both are four finite numbers
 * of modulus one, so a swapped pair survives every sanity check there is and
 * comes out as a plausible rotation about the wrong axis.
 *
 * This is the recorder's ONE conversion — `qDevice` and `q` both come through
 * here — so the raw sample in the pack and the mapped quaternion beside it can
 * never be built on different readings of the same four floats.
 */
internal fun panoQuatFromSensorWxyz(wxyz: FloatArray): DoubleArray = doubleArrayOf(
    wxyz[1].toDouble(), wxyz[2].toDouble(), wxyz[3].toDouble(), wxyz[0].toDouble(),
)

/** Row-major 3×3 from `[x, y, z, w]`. */
internal fun panoQuatToMat(q: DoubleArray): DoubleArray {
    val x = q[0]; val y = q[1]; val z = q[2]; val w = q[3]
    val xx = x * x; val yy = y * y; val zz = z * z
    val xy = x * y; val xz = x * z; val yz = y * z
    val wx = w * x; val wy = w * y; val wz = w * z
    return doubleArrayOf(
        1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy),
        2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx),
        2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy),
    )
}

/**
 * Row-major 3×3 → `[x, y, z, w]`, by Shepperd's method.
 *
 * The branch on the largest denominator is not defensive tidiness: the
 * trace-only form loses all its precision near a 180° rotation, and several of
 * the 24 basis candidates ARE 180° rotations — so the naive form would degrade
 * exactly on the indices this file exists to apply.
 */
internal fun panoMatToQuat(m: DoubleArray): DoubleArray {
    val q = DoubleArray(4)
    val tr = m[0] + m[4] + m[8]
    if (tr > 0.0) {
        val s = Math.sqrt(tr + 1.0) * 2.0
        q[3] = 0.25 * s
        q[0] = (m[7] - m[5]) / s
        q[1] = (m[2] - m[6]) / s
        q[2] = (m[3] - m[1]) / s
    } else if (m[0] > m[4] && m[0] > m[8]) {
        val s = Math.sqrt(1.0 + m[0] - m[4] - m[8]) * 2.0
        q[3] = (m[7] - m[5]) / s
        q[0] = 0.25 * s
        q[1] = (m[1] + m[3]) / s
        q[2] = (m[2] + m[6]) / s
    } else if (m[4] > m[8]) {
        val s = Math.sqrt(1.0 + m[4] - m[0] - m[8]) * 2.0
        q[3] = (m[2] - m[6]) / s
        q[0] = (m[1] + m[3]) / s
        q[1] = 0.25 * s
        q[2] = (m[5] + m[7]) / s
    } else {
        val s = Math.sqrt(1.0 + m[8] - m[0] - m[4]) * 2.0
        q[3] = (m[3] - m[1]) / s
        q[0] = (m[2] + m[6]) / s
        q[1] = (m[5] + m[7]) / s
        q[2] = 0.25 * s
    }
    panoQuatNormalize(q)
    return q
}

/** Row-major `a · b`. */
internal fun panoMatMul(a: DoubleArray, b: DoubleArray): DoubleArray {
    val out = DoubleArray(9)
    for (r in 0 until 3) {
        for (c in 0 until 3) {
            var s = 0.0
            for (k in 0 until 3) s += a[r * 3 + k] * b[k * 3 + c]
            out[r * 3 + c] = s
        }
    }
    return out
}

/** Unit-normalise in place; a degenerate input becomes the identity rather
 *  than a NaN quaternion that would poison every row after it. */
internal fun panoQuatNormalize(q: DoubleArray) {
    val n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if (!(n > 0.0) || !n.isFinite()) {
        q[0] = 0.0; q[1] = 0.0; q[2] = 0.0; q[3] = 1.0
        return
    }
    val inv = 1.0 / n
    q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv
}

/**
 * SLERP, shortest path.
 *
 * ⚠ THE SIGN FLIP IS NOT OPTIONAL. `q` and `−q` are the same rotation, so
 * without it the interpolation can take the long way round the 4-sphere — a
 * 350° sweep across an 8 ms bracket. The output is still a unit quaternion,
 * which is why nothing downstream would catch it.
 */
internal fun panoQuatSlerp(q0: DoubleArray, q1: DoubleArray, a: Double): DoubleArray {
    val b = doubleArrayOf(q1[0], q1[1], q1[2], q1[3])
    var dot = q0[0] * b[0] + q0[1] * b[1] + q0[2] * b[2] + q0[3] * b[3]
    if (dot < 0.0) {
        for (i in 0 until 4) b[i] = -b[i]
        dot = -dot
    }
    if (dot > 1.0) dot = 1.0
    val theta = Math.acos(dot)
    val out = DoubleArray(4)
    if (!(theta > 1e-9)) {
        // Below ~1e-9 rad the sines have no significant figures left and NLERP
        // is indistinguishable from SLERP to far better than double precision.
        for (i in 0 until 4) out[i] = q0[i] + a * (b[i] - q0[i])
        panoQuatNormalize(out)
        return out
    }
    val s = Math.sin(theta)
    val w0 = Math.sin((1.0 - a) * theta) / s
    val w1 = Math.sin(a * theta) / s
    for (i in 0 until 4) out[i] = w0 * q0[i] + w1 * b[i]
    panoQuatNormalize(out)
    return out
}

/**
 * ⚠ ATAN2, NEVER ACOS. Near the identity — where a correct mapping lives —
 * `2·acos(|w|)` loses half its significant figures to cancellation and floors
 * out around 2.4e-6 deg, which sits directly on top of the gyro-bias term.
 * The engine's own note (rnis_pano_attitude.cpp) records that this was
 * measured, not predicted.
 */
internal fun panoQuatAngleDeg(q: DoubleArray): Double {
    val v = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2])
    return 2.0 * Math.atan2(v, Math.abs(q[3])) * 180.0 / Math.PI
}

/** The angle between two rotations, degrees. */
internal fun panoQuatDeltaDeg(q0: DoubleArray, q1: DoubleArray): Double {
    val w = q0[3] * q1[3] + q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2]
    val x = q0[3] * q1[0] - q0[0] * q1[3] - q0[1] * q1[2] + q0[2] * q1[1]
    val y = q0[3] * q1[1] + q0[0] * q1[2] - q0[1] * q1[3] - q0[2] * q1[0]
    val z = q0[3] * q1[2] - q0[0] * q1[1] + q0[1] * q1[0] - q0[2] * q1[3]
    val v = Math.sqrt(x * x + y * y + z * z)
    return 2.0 * Math.atan2(v, Math.abs(w)) * 180.0 / Math.PI
}

/**
 * `R_engine = R_imu · C`, returned as `[x, y, z, w]`.
 *
 * ⚠ THE ORDER IS THE ENGINE'S, NOT THE NAME'S. rnis_pano_attitude.cpp:490
 * reads `matMul(Rimu, basis_, Reng)` — the basis is applied on the RIGHT.
 * "device→camera basis" is equally readable as `C · R_imu`, and that product
 * is a perfectly good unit quaternion describing the wrong rotation; nothing
 * downstream — not the pack, not the replay, not a residual — distinguishes
 * them without a reference log. So the order is transcribed from the engine
 * and pinned by a test that exhibits a case where the two disagree.
 *
 * @param qImu `R_ref←device` from TYPE_ROTATION_VECTOR, `[x, y, z, w]`
 * @param c    the engine's own `basisMatrix(index)`, row-major — NEVER a
 *             matrix rebuilt here, so the 24-candidate table has one owner
 */
internal fun panoApplyBasis(qImu: DoubleArray, c: DoubleArray): DoubleArray =
    panoMatToQuat(panoMatMul(panoQuatToMat(qImu), c))

// ── The bracket ─────────────────────────────────────────────────────────

/** Why a frame got no mapped attitude. Stable, greppable, lowercase-hyphen —
 *  the pack's own vocabulary, and the key `counts.attitudeRefusals` is
 *  bucketed by. */
internal object PanoAttitudeRefusal {
    const val NONE = "none"
    const val BUFFER_EMPTY = "buffer-empty"
    const val BEFORE_FIRST_SAMPLE = "before-first-sample"
    const val AFTER_LAST_SAMPLE = "after-last-sample"
    const val BRACKET_TOO_WIDE = "bracket-too-wide"
    const val NON_FINITE = "non-finite-sample"
}

/**
 * One frame's answer from the ring.
 *
 * `q` is ALWAYS populated — with the identity on a refusal — so no caller can
 * dereference a null into a row. `ok` is the only thing that says whether the
 * quaternion means anything, and `refusal` says which of the five ways it
 * does not.
 */
internal class PanoAttitudeSolution(
    val ok: Boolean,
    val refusal: String,
    val q: DoubleArray,
    val bracketGapS: Double,
    val alpha: Double,
    val slerpAngleDeg: Double,
) {
    companion object {
        fun refused(why: String): PanoAttitudeSolution = PanoAttitudeSolution(
            false, why, doubleArrayOf(0.0, 0.0, 0.0, 1.0), 0.0, 0.0, 0.0,
        )
    }
}

/**
 * A bounded, monotonic ring of attitude samples, with the aligner's own
 * bracket-and-SLERP over it.
 *
 * ⚠ WHY A RING AND NOT THE LATEST SAMPLE. `imuLatest` — an
 * `AtomicReference<ImuSample>` — is the right instrument for FRESHNESS
 * ([derivePanoTracking] reads exactly that), and the wrong one for a POSE: at
 * 121.8 Hz delivered against 30 fps frames the newest sample is up to ~4 ms
 * away from the frame's own timestamp, and a hand sweep covers ~0.08° in that
 * time. Interpolating between the two samples that straddle the frame costs
 * one binary search and removes the error entirely, which is why `align()`
 * does it and why this does too.
 *
 * THREAD-SAFE BY `@Synchronized`, not by lock-freedom: [add] runs on the
 * sensor HandlerThread and [solve] on the writer thread, and the critical
 * sections are a few array stores and a binary search over ≤512 entries.
 */
internal class PanoAttitudeRing(private val capacity: Int = ATTITUDE_RING_CAPACITY) {
    private val ts = LongArray(capacity)
    private val qx = DoubleArray(capacity)
    private val qy = DoubleArray(capacity)
    private val qz = DoubleArray(capacity)
    private val qw = DoubleArray(capacity)

    /** Samples ever accepted — the ring's write cursor, not its size. */
    private var total = 0L
    private var lastTs = Long.MIN_VALUE

    /** Samples REJECTED for arriving at or before the previous timestamp. */
    private var nonMonotonic = 0L

    /**
     * @return false when the sample was rejected. A timestamp that does not
     *   strictly increase breaks the binary search's precondition, and the
     *   engine's own buffer refuses the same thing (rnis_pano_attitude.cpp —
     *   "STRICTLY increasing … a zero-width bracket whose alpha is a division
     *   by zero"). Rejected rather than reordered: a sensor delivering out of
     *   order is a fact the pack should carry, not one to paper over.
     */
    @Synchronized
    fun add(tsNs: Long, x: Double, y: Double, z: Double, w: Double): Boolean {
        if (tsNs <= lastTs) { nonMonotonic++; return false }
        if (!x.isFinite() || !y.isFinite() || !z.isFinite() || !w.isFinite()) {
            nonMonotonic++
            return false
        }
        val i = (total % capacity).toInt()
        ts[i] = tsNs; qx[i] = x; qy[i] = y; qz[i] = z; qw[i] = w
        lastTs = tsNs
        total++
        return true
    }

    @Synchronized fun sampleCount(): Long = total

    @Synchronized fun nonMonotonicCount(): Long = nonMonotonic

    /** Chronological index → ring slot. Valid for `0 <= i < retained()`. */
    private fun slot(i: Int): Int = (((total - retained()) + i) % capacity).toInt()

    private fun retained(): Int =
        if (total < capacity.toLong()) total.toInt() else capacity

    /**
     * The attitude at [targetNs], interpolated — or a named refusal.
     *
     * ⚠ NO EXTRAPOLATION, EVER. A target outside the retained window is
     * refused rather than clamped to the nearest edge. Clamping would produce
     * a quaternion for every frame including the ones recorded before the
     * sensor started delivering, and a start-up transient would then paint as
     * a frozen attitude the engine has no way to tell from a still phone.
     *
     * @param targetNs the frame's timestamp in the SAME clock as the samples.
     *   That is the caller's obligation, not this function's — see
     *   [panoAttitudeClockGate] for the gate that establishes it.
     * @param maxGapNs the widest bracket that may be interpolated across.
     */
    @Synchronized
    fun solve(targetNs: Long, maxGapNs: Long): PanoAttitudeSolution {
        val n = retained()
        if (n == 0) return PanoAttitudeSolution.refused(PanoAttitudeRefusal.BUFFER_EMPTY)
        val firstTs = ts[slot(0)]
        val lastTsN = ts[slot(n - 1)]
        if (targetNs < firstTs) {
            return PanoAttitudeSolution.refused(PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE)
        }
        if (targetNs > lastTsN) {
            return PanoAttitudeSolution.refused(PanoAttitudeRefusal.AFTER_LAST_SAMPLE)
        }

        // Largest i with ts[i] <= target. The two range checks above guarantee
        // it exists; the +1 clamps only when the target lands exactly on the
        // newest sample, where the bracket is that sample twice and alpha is 0.
        var lo = 0
        var hi = n - 1
        while (lo < hi) {
            val mid = lo + (hi - lo + 1) / 2
            if (ts[slot(mid)] <= targetNs) lo = mid else hi = mid - 1
        }
        val i0 = lo
        val i1 = if (i0 + 1 < n) i0 + 1 else i0
        val s0 = slot(i0)
        val s1 = slot(i1)
        val gapNs = ts[s1] - ts[s0]
        if (gapNs > maxGapNs) {
            return PanoAttitudeSolution.refused(PanoAttitudeRefusal.BRACKET_TOO_WIDE)
        }

        val q0 = doubleArrayOf(qx[s0], qy[s0], qz[s0], qw[s0])
        val q1 = doubleArrayOf(qx[s1], qy[s1], qz[s1], qw[s1])
        val alpha = if (gapNs > 0L) {
            ((targetNs - ts[s0]).toDouble() / gapNs.toDouble()).coerceIn(0.0, 1.0)
        } else {
            0.0
        }
        val q = panoQuatSlerp(q0, q1, alpha)
        if (!q[0].isFinite() || !q[1].isFinite() || !q[2].isFinite() || !q[3].isFinite()) {
            return PanoAttitudeSolution.refused(PanoAttitudeRefusal.NON_FINITE)
        }
        return PanoAttitudeSolution(
            true, PanoAttitudeRefusal.NONE, q,
            gapNs / 1e9, alpha, panoQuatDeltaDeg(q0, q1),
        )
    }
}

// ── The two gates ───────────────────────────────────────────────────────

/**
 * Which basis authority a sweep may claim, and therefore what `qSource` says.
 *
 * PRIORITY IS NOT NEGOTIABLE: a MEASURED index outranks a DERIVED one. The
 * derivation is a hypothesis about how Samsung mounted the sensor
 * (rnis_pano_android_basis.hpp's FALSIFICATION section says so in as many
 * words); a measurement against a concurrent ARCore log is evidence. When the
 * two disagree the measured one is right BY DEFINITION of what each is, and a
 * build that let the derivation win would make the falsification sweep
 * unable to change anything.
 */
internal class PanoBasisAuthority(
    /** Index into the ENGINE's 24-candidate enumeration, or −1 for none. */
    val index: Int,
    /** [PANO_BASIS_AUTHORITY_MEASURED] / `_DERIVED` / `_NONE`. */
    val authority: String,
    /** The exact string that goes in every row's `qSource`. */
    val qSource: String,
    /** Why this authority and not a stronger one — always populated. */
    val note: String,
)

/**
 * Resolve the authority from what the sweep was given.
 *
 * @param measuredIndex a start option. ≥ 0 asserts "somebody ran
 *   `selectBasis()` against a reference log and this is what it said".
 * @param derivedIndex `deriveBasis()`'s answer for this camera, or −1.
 * @param derivedRefusal `BasisDerivation::refusal` — carried into the note so
 *   a sweep that fell through to identity says WHICH refusal put it there
 *   rather than merely that it happened.
 * @param candidateCount `rnis::pano::basisCandidateCount()`, read from the
 *   engine rather than hardcoded as 24 — an index this build cannot look up
 *   is not an index, whatever the operator typed.
 */
internal fun panoResolveBasisAuthority(
    measuredIndex: Int,
    derivedIndex: Int,
    derivedRefusal: String,
    candidateCount: Int,
): PanoBasisAuthority {
    val measuredOk = candidateCount > 0 && measuredIndex in 0 until candidateCount
    val derivedOk = candidateCount > 0 && derivedIndex in 0 until candidateCount
    // An out-of-range index that was nevertheless SUPPLIED is a caller fault,
    // and it must not silently become "no option was passed": the operator
    // believes their measurement is in this pack.
    val badMeasured = measuredIndex >= 0 && !measuredOk

    return when {
        measuredOk -> PanoBasisAuthority(
            measuredIndex, PANO_BASIS_AUTHORITY_MEASURED, PANO_Q_SOURCE_MEASURED,
            "measuredBasisIndex=$measuredIndex was supplied and OUTRANKS the derived index " +
                (if (derivedOk) "($derivedIndex)" else "(none — $derivedRefusal)") +
                ". The recorder does not verify the claim; the option asserts that " +
                "selectBasis() measured it against a reference log.",
        )
        derivedOk -> PanoBasisAuthority(
            derivedIndex, PANO_BASIS_AUTHORITY_DERIVED, PANO_Q_SOURCE_DERIVED,
            (if (badMeasured)
                "measuredBasisIndex=$measuredIndex is OUT OF RANGE for this engine's " +
                    "$candidateCount candidates and was DISCARDED. "
            else "") +
                "deriveBasis() returned $derivedIndex from this camera's SENSOR_ORIENTATION " +
                "and lens facing. It is an arithmetic HYPOTHESIS about the sensor mounting, " +
                "not a measurement — run the ARCore basis sweep to falsify it.",
        )
        else -> PanoBasisAuthority(
            -1, PANO_BASIS_AUTHORITY_NONE, PANO_Q_SOURCE_NONE,
            (if (badMeasured)
                "measuredBasisIndex=$measuredIndex is OUT OF RANGE for this engine's " +
                    "$candidateCount candidates and was DISCARDED. "
            else "") +
                "no basis authority: " + derivedRefusal +
                ". `q` stays IDENTITY on every row, which is this recorder's original " +
                "behaviour and a legitimate planar-arm pack.",
        )
    }
}

/** Whether the camera's and the sensor's timestamps may be differenced. */
internal class PanoClockGate(val joinable: Boolean, val reason: String)

/**
 * THE JOIN'S PRECONDITION, read from the device at runtime.
 *
 * `CaptureResult.SENSOR_TIMESTAMP` and `SensorEvent.timestamp` are two clocks
 * with two contracts. `SENSOR_INFO_TIMESTAMP_SOURCE == REALTIME` is Android's
 * own statement that image timestamps are on `SystemClock.elapsedRealtimeNanos`
 * — the same base `SensorEvent.timestamp` nominally uses — and that is what
 * makes bracketing a frame between two IMU samples a defined operation rather
 * than a subtraction across an unknown epoch.
 *
 * SM-A356U1 measured REALTIME on 2026-09-01. THAT IS NOT WHY THIS RETURNS
 * TRUE: the value is read from the opened camera's characteristics on every
 * start, because a pack recorded on a device where it is UNKNOWN and mapped
 * anyway would carry a `q` series joined at an arbitrary offset — plausible
 * quaternions, wrong frames, and no field in the pack able to say so. UNKNOWN
 * therefore falls back to identity with the reason named, exactly as though
 * there were no basis.
 *
 * @param timestampSourceName the recorder's own `timestampSourceName()` output
 *   ("REALTIME" / "UNKNOWN" / "unavailable" / "unrecognised(n)"). A STRING and
 *   not the raw int on purpose: the Camera2 constants live behind `android.*`,
 *   and this file is JVM-testable precisely because it never touches them.
 */
internal fun panoAttitudeClockGate(timestampSourceName: String): PanoClockGate =
    if (timestampSourceName == "REALTIME") {
        PanoClockGate(
            true,
            "SENSOR_INFO_TIMESTAMP_SOURCE is REALTIME, so CaptureResult.SENSOR_TIMESTAMP and " +
                "SensorEvent.timestamp are both on SystemClock.elapsedRealtimeNanos and the " +
                "frame can be bracketed between two IMU samples directly. tau is 0 and " +
                "UNCORRECTED: the residual pipeline latency between the two domains has not " +
                "been measured on this device, so the join is exact in EPOCH and approximate " +
                "in LATENCY.",
        )
    } else {
        PanoClockGate(
            false,
            "SENSOR_INFO_TIMESTAMP_SOURCE is $timestampSourceName, NOT REALTIME — the camera's " +
                "timestamps are on an undocumented epoch, so differencing them against " +
                "SensorEvent.timestamp would join the two series at an arbitrary offset. `q` " +
                "stays IDENTITY; qDevice and sensors.jsonl still carry the full attitude " +
                "series for an offline pass that can establish the offset.",
        )
    }
