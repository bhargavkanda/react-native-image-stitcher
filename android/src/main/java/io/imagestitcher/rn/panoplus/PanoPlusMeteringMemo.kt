// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusMeteringMemo — what the IDLE viewfinder already learned about the
// light, kept where the SWEEP can read it.
//
// ── THE INCIDENT THIS FILE EXISTS FOR ────────────────────────────────────────
//
// The operator, 2026-09-09, on his A35: "I still see the preview thumbnail
// appears after more than a second after I hold the shutter. If I start moving
// before that comes up, I see clear jumps in the output."
//
// Measured on his five packs that night, from holding the shutter to the first
// painted strip: median 2148 ms. It splits in two, and this file addresses the
// bigger half:
//
//   ~1150 ms  camera open + AE/AWB settle, BEFORE one frame reaches the engine
//              (aeSettleMs 1045-1139 across the five; the open itself is ~70 ms)
//   ~940 ms  the engine's own warm-up (4 frames) + bootstrap (7-42 frames)
//
// WHY THE SETTLE IS THAT SLOW, AND WHY IT IS AVOIDABLE. Android allows ONE
// client per back camera (PanoPlusAndroidRecorder's own error text says so).
// So the idle viewfinder is torn down and the HAL closed before the recorder
// opens its own CameraDevice — and a freshly opened device begins metering
// from nothing. It re-learns, over ~26 CaptureResults, a scene the operator has
// been pointing at and the idle viewfinder has ALREADY metered correctly.
//
// The idle preview knew the answer and threw it away: it passed `null` as the
// CaptureCallback to setRepeatingRequest, so it never saw a single
// CaptureResult of its own.
//
// ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────
//
// It is a MEMO, not a control path. Nothing here is applied to any camera by
// this file. The recorder decides what to do with it, gates it on freshness and
// on the camera id matching, and RECORDS in device.json what it used and how
// old it was. A memo that turns out to be wrong costs the sweep nothing that
// the settle would not have cost anyway, because the settle still runs.
//
// It is deliberately NOT a cache with a policy. There is exactly one slot,
// last-writer-wins, because there is exactly one back camera the sweep can use
// and the only question ever asked of it is "what was the light like a moment
// ago, on this camera?".
//
// STALENESS IS THE CALLER'S PROBLEM, BY DESIGN. This records `atElapsedNs` and
// hands it over. The recorder applies the age limit, because the recorder is
// the one that knows what it is about to do with it — and because a memo that
// silently expired itself would be indistinguishable from a memo that was never
// written, which is exactly the ambiguity the 2026-09-02 AR-arm copy taught us
// not to ship.
//
// THREADING. Written on the idle camera thread, read on the recorder's camera
// thread, and they are different threads that never overlap in time (the idle
// session is fully torn down before the recorder opens). @Volatile on the one
// reference is therefore sufficient and no lock is needed: readers either see
// the whole immutable snapshot or the previous one, never a half-written field.

package io.imagestitcher.rn.panoplus

import android.os.SystemClock

/**
 * One immutable observation of a converged metering state, taken from a
 * CaptureResult the idle viewfinder received.
 *
 * Every field is a MEASUREMENT read back off the result, never a value that was
 * requested. A null means the HAL did not publish that key on this device —
 * which is normal on a LIMITED-level camera and is why every consumer must
 * treat each field independently rather than assuming the set arrives together.
 */
internal data class PanoPlusMetering(
    /** The camera this was observed on. A memo from another lens is useless. */
    val cameraId: String,
    /** `SystemClock.elapsedRealtimeNanos()` at the moment the result arrived. */
    val atElapsedNs: Long,
    /** `SENSOR_EXPOSURE_TIME`, nanoseconds. */
    val exposureTimeNs: Long?,
    /** `SENSOR_SENSITIVITY`, ISO. */
    val sensitivityIso: Int?,
    /** `SENSOR_FRAME_DURATION`, nanoseconds. */
    val frameDurationNs: Long?,
    /** `LENS_FOCUS_DISTANCE`, dioptres, as the idle AF converged it. */
    val focusDistanceDiopters: Float?,
    /** `CONTROL_AE_STATE` at the moment of the read, for the audit trail. */
    val aeState: Int?,
    /** `CONTROL_AWB_STATE` at the moment of the read. */
    val awbState: Int?,
    /** `COLOR_CORRECTION_GAINS` flattened to [r, gEven, gOdd, b], if published. */
    val colorGains: FloatArray?,
) {
    /**
     * Age in milliseconds against a clock read the CALLER supplies.
     *
     * There is deliberately no default. `SystemClock` is an Android framework
     * stub that THROWS in a plain JVM unit test unless the whole module opts
     * into `returnDefaultValues`, and opting in would silently change every
     * other framework call in all 203 tests here. Passing the clock in keeps
     * this object testable without that blast radius, and production callers
     * read the clock once at the call site where it belongs anyway.
     */
    fun ageMs(nowElapsedNs: Long): Double = (nowElapsedNs - atElapsedNs) / 1e6

    /**
     * True when the two numbers the radiometric chain actually cares about are
     * both present. A memo without these is an audit record, not a seed.
     */
    fun hasExposurePair(): Boolean = exposureTimeNs != null && sensitivityIso != null

    // data class with a FloatArray member: equals/hashCode are generated over
    // the reference, which is wrong and would silently break any future use in
    // a set or as a map key. Nothing does that today; these exist so nothing
    // starts to by accident.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PanoPlusMetering) return false
        return cameraId == other.cameraId &&
            atElapsedNs == other.atElapsedNs &&
            exposureTimeNs == other.exposureTimeNs &&
            sensitivityIso == other.sensitivityIso &&
            frameDurationNs == other.frameDurationNs &&
            focusDistanceDiopters == other.focusDistanceDiopters &&
            aeState == other.aeState &&
            awbState == other.awbState &&
            (colorGains?.toList() == other.colorGains?.toList())
    }

    override fun hashCode(): Int {
        var h = cameraId.hashCode()
        h = 31 * h + atElapsedNs.hashCode()
        h = 31 * h + (exposureTimeNs?.hashCode() ?: 0)
        h = 31 * h + (sensitivityIso ?: 0)
        h = 31 * h + (frameDurationNs?.hashCode() ?: 0)
        h = 31 * h + (focusDistanceDiopters?.hashCode() ?: 0)
        h = 31 * h + (aeState ?: 0)
        h = 31 * h + (awbState ?: 0)
        h = 31 * h + (colorGains?.toList()?.hashCode() ?: 0)
        return h
    }
}

/**
 * The single slot. See the file header for why there is only one.
 */
internal object PanoPlusMeteringMemo {

    @Volatile
    private var last: PanoPlusMetering? = null

    /**
     * Record an observation. Callers should only pass results whose AE and AWB
     * have CONVERGED or LOCKED — a memo taken mid-search is worse than none,
     * because it looks authoritative and is not.
     */
    fun put(m: PanoPlusMetering) {
        last = m
    }

    /**
     * The last observation for [cameraId], or null when there is none, when it
     * was taken on a different camera, or when it is older than [maxAgeMs].
     *
     * The age limit is the CALLER's, not this object's — see the file header.
     * A caller that wants the memo regardless of age passes `Double.MAX_VALUE`
     * and reads [PanoPlusMetering.ageMs] itself.
     */
    fun get(
        cameraId: String,
        maxAgeMs: Double,
        nowElapsedNs: Long = SystemClock.elapsedRealtimeNanos(),
    ): PanoPlusMetering? {
        val m = last ?: return null
        if (m.cameraId != cameraId) return null
        if (m.ageMs(nowElapsedNs) > maxAgeMs) return null
        return m
    }

    /**
     * The raw slot, ignoring camera and age, for the audit trail ONLY.
     * device.json reports what was there and why it was or was not used, so a
     * rejected memo has to remain readable after the rejection.
     */
    fun peek(): PanoPlusMetering? = last

    /** Drop the memo. Used when the idle session closes for a lens change. */
    fun clear() {
        last = null
    }
}
