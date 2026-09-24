// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

/**
 * One `attitude_arcore.jsonl` row from the stitcher's ARCore session (the
 * AR-plugin arm), in the shape `rnis_pano_android_s1` reads:
 *
 *  - `kind` "arcore-frame" — the reader skips any other kind;
 *  - `tsNs` / `tS` — ARCore's frame timestamp;
 *  - `q` — `camera.pose` rotation, world<-camera, `[x, y, z, w]` (the same pose
 *    pano+'s own channel recorded, NOT the display-oriented one);
 *  - `t` — the pose translation, metres;
 *  - `trackingState` in ARCore's own names. The plugin contract says
 *    "normal" / "limited" / "notAvailable", which are ARCore's TRACKING /
 *    PAUSED / STOPPED; the reader keeps only "TRACKING" rows, so a row written
 *    in the contract's vocabulary would be silently dropped — the same shape as
 *    the 472-frame gate bug, one file along.
 *  - `source` "ar-plugin", so a row says which session produced it.
 *
 * Pure, so the format is a JVM test.
 */
internal fun panoArPluginPoseRow(
    tsNs: Double,
    q: DoubleArray,
    t: DoubleArray,
    tracking: String,
): String {
    val state = when (tracking) {
        "normal" -> "TRACKING"
        "limited" -> "PAUSED"
        else -> "STOPPED"
    }
    return Jo()
        .s("kind", "arcore-frame")
        .i("tsNs", tsNs.toLong())
        .n("tS", tsNs / 1e9)
        .raw("q", if (q.size >= 4) jarr(q[0], q[1], q[2], q[3]) else "null")
        .raw("t", if (t.size >= 3) jarr(t[0], t[1], t[2]) else "null")
        .s("trackingState", state)
        .s("source", "ar-plugin")
        .end()
}
