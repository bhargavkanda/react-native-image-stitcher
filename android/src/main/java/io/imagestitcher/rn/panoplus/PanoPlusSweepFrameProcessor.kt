// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.graphics.ImageFormat
import android.media.Image
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy

/**
 * The sweep engine, fed from the camera `<Camera>` already owns (S5).
 *
 * ── WHAT THIS RUNG IS FOR ───────────────────────────────────────────────
 * pano+'s non-AR arm opens its OWN Camera2 session. That is why switching
 * engines swaps the whole viewfinder and why two stacks fight over one back
 * camera. This plugin is the other half of a start mode in which the
 * recorder opens nothing: vision-camera owns the device, the plugin hands
 * the pixels over, and the recorder supplies everything that is not pixels.
 *
 * ⚠ THIS FILE IS EXCLUDED FROM THE BUILD WITHOUT VISION-CAMERA, and it is
 * the ONLY pano+ file that may import `com.mrousavy.camera`. Its
 * counterpart, `PanoPlusVcFrameSink`, deliberately holds no vc type so the
 * recorder can arm the arm — and report that nothing fed it — on a build
 * where this file does not exist. Add any new vc import here, never there,
 * and add the file to the exclude list in `android/build.gradle`.
 *
 * ── THE THREE THINGS VISION-CAMERA DOES NOT GIVE US ─────────────────────
 * Measured against vc 4.7.3, not assumed:
 *   1. NO POSE. The sweep's attitude comes from the recorder's own
 *      TYPE_ROTATION_VECTOR ring through basis C — it keeps the SENSOR when
 *      it gives up the CAMERA.
 *   2. NO INTRINSICS. `grep -ri intrinsic` over vc's android sources returns
 *      nothing. They are derived from `CameraCharacteristics`, which needs
 *      no open camera. `fx > 1.0` is a hard engine guard and 0 refuses every
 *      frame as RejectedInput, silently — so this is the failure that looks
 *      like "ran: 100%, painted: 0%".
 *   3. NO EXPOSURE, AND NO AE LOCK. vc surfaces neither
 *      SENSOR_EXPOSURE_TIME nor SENSOR_SENSITIVITY, and has no exposure lock
 *      on Android at all (5.2.3 still throws "not yet supported"). The sweep
 *      therefore runs UNLOCKED on this arm. That is a real regression — the
 *      banding defence the operator rejected twice — and it is named in the
 *      pack rather than discovered in a picture.
 *
 * ── LIFETIME AND THREADING ──────────────────────────────────────────────
 * The `Frame` is valid only inside `callback()` — vc closes it on return —
 * so the de-stride into the pooled buffer happens HERE, synchronously. The
 * engine call does not: `PanoPlusLiveNative.ingest`'s own doc says never to
 * call it from the camera callback, and vc runs this on ONE HandlerThread
 * with STRATEGY_BLOCK_PRODUCER, so a ~30 ms ingest would throttle the camera
 * rather than drop a frame. The sink posts it to a worker and returns.
 */
@DoNotStrip
@Keep
class PanoPlusSweepFrameProcessor(
    proxy: VisionCameraProxy,
    options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    companion object {
        const val PLUGIN_NAME = "panoplus_sweep_ingest"
    }

    @Suppress("unused", "UNUSED_PARAMETER")
    private val unused = proxy to options

    /**
     * The de-stride scratch. The NV21 destination comes from the SINK's pool
     * (M4) — a buffer the engine may still be reading is never handed out, so
     * this callback cannot overwrite one mid-ingest.
     */
    private var scratch: ByteArray? = null
    private var pooledW = -1
    private var pooledH = -1

    /**
     * The size the FIRST frame of this sweep had.
     *
     * ⚠ THE ENGINE ABORTS THE WHOLE SESSION ON A SIZE CHANGE, so a stream
     * that switches resolution mid-sweep does not degrade — it ends the
     * capture with "format-change". Refusing the odd frame here costs one
     * frame; passing it costs the sweep.
     */
    private var latchedW = -1
    private var latchedH = -1
    /**
     * Which sweep the latch above belongs to.
     *
     * ⚠ WITHOUT THIS THE LATCH SPANS EVERY SWEEP ON ONE CAMERA SCREEN, and
     * the second one refuses every frame. vision-camera builds a fresh
     * plugin per `initFrameProcessorPlugin`, but `useSweepWorklet` calls that
     * ONCE per `<Camera>` mount and holds the handle — so one instance, and
     * one latch, outlives any single sweep. Sweep 1 at 1440x1080 latches
     * those; if the video format changes before sweep 2 (a `standalone-uw`
     * lens switch, a highRes/keyframe-quality toggle, a background rebind)
     * every frame of sweep 2 takes the size-changed branch and the canvas
     * stays empty — presenting as the arm never having run.
     */
    private var latchedGeneration = -1L


    override fun callback(frame: Frame, params: Map<String, Any>?): Any? {
        // Cheapest exit first: no sweep wants frames. Checked BEFORE
        // `frame.image`, which costs a JNI hop and an ImageProxy acquire at
        // 30 fps for a plugin that is idle most of the time.
        if (!PanoPlusVcFrameSink.isArmed) return mapOf("ingested" to false, "why" to "not armed")

        val image: Image = try {
            frame.image
        } catch (t: Throwable) {
            // FrameInvalidError — vc already released it. Not an error we can
            // act on, and not one worth counting against the sweep.
            PanoPlusVcFrameSink.notePreOfferRefusal()
            return mapOf("ingested" to false, "why" to "frame invalid")
        }

        if (image.format != ImageFormat.YUV_420_888) {
            PanoPlusVcFrameSink.notePreOfferRefusal()
            return mapOf("ingested" to false, "why" to "format ${image.format}")
        }
        val w = image.width
        val h = image.height
        // The converter requires even dimensions (YUV_420_888 chroma is
        // half-resolution) and the engine ABORTS the session on a mid-sweep
        // size change, so a refusal here is better than a resize.
        if (w <= 0 || h <= 0 || w % 2 != 0 || h % 2 != 0) {
            PanoPlusVcFrameSink.notePreOfferRefusal()
            return mapOf("ingested" to false, "why" to "odd size ${w}x$h")
        }
        val planes = image.planes
        if (planes.size < 3) {
            // COUNTED, like its three neighbours. A refused frame the counter
            // never sees makes `vcFramesOffered` and `vcFramesRefusedPreOffer`
            // fail to account for the frames vision-camera actually delivered,
            // and the arm's own arithmetic is the only evidence this arm ran.
            PanoPlusVcFrameSink.notePreOfferRefusal()
            return mapOf("ingested" to false, "why" to "planes ${planes.size}")
        }

        // ⚠ THE BUFFER BEFORE THE COPY, NOT AFTER IT: the de-stride writes
        // into a buffer the sink's pool has handed over, never into one the
        // engine is still reading.
        // ⚠ D3 (M4): THE BASIS ASSUMES AN UNROTATED, UNMIRRORED BUFFER. The
        // recorder derives C from SENSOR_ORIENTATION for the RAW sensor raster
        // (PanoPlusNativeBasis, appliedRotation 0). vision-camera 4.7.3 does
        // not rotate or mirror frame-processor buffers today — but nothing
        // checked, and a rotated buffer would roll C by 90° with every scalar
        // check passing. Refused by name instead.
        val orient = bufferOrientation(frame)
        if (orient != null) {
            PanoPlusVcFrameSink.notePreOfferRefusal()
            return mapOf("ingested" to false, "why" to orient)
        }
        val out = PanoPlusVcFrameSink.acquireBuffer(w * h * 3 / 2)
            ?: return mapOf("ingested" to false, "why" to "busy")
        var acquired = true
        try {
            // First-frame size latch, PER SWEEP. Checked INSIDE the gate so
            // the latch and the buffers move together, and re-taken whenever
            // the sink reports a new arm — see [latchedGeneration].
            val gen = PanoPlusVcFrameSink.armGeneration
            if (gen != latchedGeneration) {
                latchedGeneration = gen
                latchedW = w
                latchedH = h
            }
            if (w != latchedW || h != latchedH) {
                // POST-acquire: `acquireBuffer()` above already counted this
                // frame as offered, so booking it pre-offer would put it in
                // two buckets and break the partition the pack is read with.
                PanoPlusVcFrameSink.notePostAcquireRefusal()
                return mapOf("ingested" to false, "why" to "size changed ${w}x$h")
            }

            if (pooledW != w || pooledH != h) {
                pooledW = w
                pooledH = h
                scratch = null
            }
            // ⚠ SIZED BY THE CONVERTER'S OWN HELPER, NOT BY `w`. It reads a
            // V row AND a U row into the two HALVES of scratch before
            // consuming either, so a semi-planar stream (uPixelStride == 2,
            // the common Android layout) needs ~2w, not w. `ByteArray(w)`
            // threw on EVERY frame of every such device — and because the
            // throw landed before `offer`, the pack reported
            // `vcFramesOffered == 0`, which reads as "the plugin never
            // mounted". The Camera2 arm has always called this helper.
            val needScr = Yuv420ToNv21.scratchBytes(
                w, planes[0].pixelStride, planes[1].pixelStride, planes[2].pixelStride,
            )
            var scr = scratch
            if (scr == null || scr.size < needScr) { scr = ByteArray(needScr); scratch = scr }

            try {
                Yuv420ToNv21.convert(
                    planes[0].buffer, planes[0].rowStride, planes[0].pixelStride,
                    planes[1].buffer, planes[1].rowStride, planes[1].pixelStride,
                    planes[2].buffer, planes[2].rowStride, planes[2].pixelStride,
                    w, h, out, scr,
                )
            } catch (t: Throwable) {
                PanoPlusVcFrameSink.notePostAcquireRefusal()   // past the door
                return mapOf("ingested" to false, "why" to "convert: ${t.javaClass.simpleName}")
            }

            // The image's own timestamp. The attitude ring is keyed on the
            // Camera2 SENSOR_TIMESTAMP domain; joining a different clock
            // would bracket every frame against samples from the wrong era
            // and refuse them all, silently.
            val tsNs = try { image.timestamp } catch (t: Throwable) {
                PanoPlusVcFrameSink.notePostAcquireRefusal()
                return mapOf("ingested" to false, "why" to "no timestamp")
            }

            // `out.size` — never a recomputed w*h*3/2. The JNI does not
            // validate `length` against the array, so a confident wrong
            // value is a SIGSEGV inside cvtColor rather than a refusal.
            // The frame's own CaptureResult (M4) — exposure, lock read-back,
            // crop, zoom, the active physical lens. Null when CameraX paired
            // none; the sink and the recorder treat that as "not measured".
            val meta = PanoPlusVcCameraControl.metaOf(frame)
            val taken = PanoPlusVcFrameSink.submit(out, out.size, w, h, tsNs, meta)
            acquired = false   // ownership handed to the sink
            return mapOf("ingested" to taken)
        } finally {
            // Every early return above still holds the slot. Releasing it
            // here is what stops one bad frame wedging the arm shut for the
            // rest of the sweep.
            if (acquired) PanoPlusVcFrameSink.returnBuffer(out)
        }
    }

    /**
     * Null when the buffer is the raw sensor raster the basis assumes;
     * otherwise why it is not. Reads CameraX's sensor-to-buffer transform: an
     * unrotated, unmirrored buffer maps sensor to buffer by scale and
     * translation only (no skew terms, positive scales).
     */
    private fun bufferOrientation(frame: Frame): String? = try {
        val m = FloatArray(9)
        frame.imageProxy.imageInfo.sensorToBufferTransformMatrix.getValues(m)
        val skewX = m[android.graphics.Matrix.MSKEW_X]
        val skewY = m[android.graphics.Matrix.MSKEW_Y]
        val sx = m[android.graphics.Matrix.MSCALE_X]
        val sy = m[android.graphics.Matrix.MSCALE_Y]
        when {
            kotlin.math.abs(skewX) > 1e-3f || kotlin.math.abs(skewY) > 1e-3f ->
                "buffer rotated (sensor-to-buffer skew ${"%.3f".format(skewX)},${"%.3f".format(skewY)})"
            sx < 0f || sy < 0f -> "buffer mirrored"
            else -> null
        }
    } catch (_: Throwable) {
        null   // no transform to read: the pre-M4 assumption stands, as before
    }
}
