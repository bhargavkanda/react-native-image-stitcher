// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusAndroidProbe.kt — the Android capability probe for the pano+ port.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
// The pano+ engine (cpp/rnis_pano.*) is platform-free and already compiles
// for arm64 under NDK 27.  What is NOT known is what an Android phone will
// FEED it: whether an ultra-wide exists and at what focal ratio, whether a
// 4:3 raster can be delivered at 60 fps, whether image timestamps and IMU
// timestamps share a clock (the Android form of the τ problem the iOS arm had
// to measure), and — the highest-leverage unknown — whether the HAL publishes
// LENS_POSE_ROTATION, in which case the IMU→camera basis is READ rather than
// searched for.
//
// This module answers those questions from CameraCharacteristics and the
// sensor list alone.  It opens no camera, starts no capture session, and
// requests no permission: `CameraManager.getCameraIdList()`,
// `getCameraCharacteristics()` and `SensorManager.getDefaultSensor()` all work
// with none.  Nothing here can affect a capture that is already running.
//
// ── THE REPORTING CONTRACT ───────────────────────────────────────────────
// NO PLAUSIBLE DEFAULTS.  Every value in the output is either a real reading
// or an explicit null with a named reason beside it.  A key the HAL does not
// publish comes back null; a key whose read THREW comes back null AND its
// exception lands in that camera's `keyErrors` map; a key that needs a newer
// API level than the device has comes back null AND the guard that stopped it
// is spelled out in a sibling `…Guard` string.  A reader must never have to
// guess whether "absent" means "the device lacks it" or "the probe skipped
// it".
//
// Two things follow from that, and they are deliberate:
//   * every characteristics read is individually wrapped, so one OEM HAL that
//     throws on one key still yields a complete report for everything else;
//   * the top-level catch RESOLVES a partial report rather than rejecting —
//     a probe that returns nothing is strictly worse than one that returns
//     the device block and says what it could not reach.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
// It does not claim a rate.  `probeCapabilities` reports what the HAL and the
// sensor descriptors ADVERTISE; `measureSensorRates` is a separate,
// operator-triggered method that registers real listeners and counts real
// events, because a requested sampling period is not a measurement (the iOS
// arm learned this and reports `deliveredMotionHz` for the same reason —
// RNISPanoAvfSource.swift).

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.params.StreamConfigurationMap
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Size
import android.util.SizeF
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.sqrt

class PanoPlusAndroidProbe(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNSSweepProbe"

    // ── The pure read ────────────────────────────────────────────────

    /**
     * Read every capability the pano+ port is gated on and resolve one nested
     * map.  Never rejects on a missing capability — a device that supports
     * almost nothing still produces a COMPLETE report saying so.
     *
     * Runs off the JS thread: a handful of OEM HALs block for tens of
     * milliseconds inside `getCameraCharacteristics` the first time it is
     * called (the same reason the stitch methods dispatch).
     */
    @ReactMethod
    fun probeCapabilities(promise: Promise) {
        CoroutineScope(Dispatchers.Default).launch {
            val report: WritableNativeMap? = try {
                buildReport()
            } catch (t: Throwable) {
                // Last-ditch: something outside every per-block guard threw.
                // A named, half-empty report beats a bare rejection.
                try {
                    WritableNativeMap().apply {
                        putInt("probeVersion", PROBE_VERSION)
                        putBoolean("complete", false)
                        putString("fatal", throwableLabel(t))
                    }
                } catch (_: Throwable) {
                    null
                }
            }
            try {
                if (report != null) promise.resolve(report)
                else promise.reject(
                    "probe-failed",
                    "The capability probe could not build any report at all — " +
                        "the React Native bridge map allocator threw.",
                )
            } catch (_: Throwable) {
                // A promise that was already settled logs and returns; never
                // let it propagate out of the coroutine (an unhandled throw on
                // Dispatchers.Default reaches the default handler and kills
                // the app — which is the one thing a diagnostic must not do).
            }
        }
    }

    private fun buildReport(): WritableNativeMap {
        val out = WritableNativeMap()
        out.putInt("probeVersion", PROBE_VERSION)
        out.putBoolean("complete", true)
        out.putDouble("probedAtEpochMs", System.currentTimeMillis().toDouble())
        // Stated in the payload, not only in this file's header: the reader is
        // usually an offline harness, not a person with the source open.
        out.putBoolean("openedCameraDevice", false)
        out.putBoolean("startedCaptureSession", false)
        out.putBoolean("requestedAnyPermission", false)
        out.putMap("device", safeMap("device") { deviceBlock() })
        out.putMap("cameras", safeMap("cameras") { cameraBlock() })
        out.putMap("sensors", safeMap("sensors") { sensorBlock() })
        out.putMap("arcore", safeMap("arcore") { arCoreBlock() })
        out.putArray("notes", notesBlock())
        return out
    }

    // ── Device ───────────────────────────────────────────────────────

    private fun deviceBlock(): WritableNativeMap = WritableNativeMap().apply {
        putS("model", Build.MODEL)
        putS("device", Build.DEVICE)
        putS("manufacturer", Build.MANUFACTURER)
        putS("brand", Build.BRAND)
        putS("product", Build.PRODUCT)
        putS("hardware", Build.HARDWARE)
        putS("board", Build.BOARD)
        putS("fingerprint", Build.FINGERPRINT)
        putInt("sdkInt", Build.VERSION.SDK_INT)
        putS("release", Build.VERSION.RELEASE)
        putS(
            "securityPatch",
            if (Build.VERSION.SDK_INT >= 23) Build.VERSION.SECURITY_PATCH else null,
        )
        putArr("supportedAbis", stringsArray(Build.SUPPORTED_ABIS?.toList()))
        // The engine's lens table keys on iOS' `uname().machine`; the Android
        // equivalent the port will have to key on is MODEL+DEVICE, recorded
        // here so a future table row can be written from a real pack.
        putS("lensTableKeyCandidate", "${Build.MANUFACTURER}/${Build.MODEL}/${Build.DEVICE}")
    }

    // ── Cameras ──────────────────────────────────────────────────────

    private fun cameraBlock(): WritableNativeMap {
        val out = WritableNativeMap()
        val mgr = try {
            reactApplicationContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
        } catch (t: Throwable) {
            out.putString("status", "camera-service-threw")
            out.putString("error", throwableLabel(t))
            out.putArray("cameras", WritableNativeArray())
            return out
        }
        if (mgr == null) {
            out.putString("status", "camera-service-unavailable")
            out.putArray("cameras", WritableNativeArray())
            return out
        }
        out.putString("status", "ok")

        val ids: List<String> = try {
            mgr.cameraIdList?.toList() ?: emptyList()
        } catch (t: Throwable) {
            out.putString("idListError", throwableLabel(t))
            emptyList()
        }
        out.putArr("idList", stringsArray(ids))
        out.putInt("idListCount", ids.size)

        val cams = WritableNativeArray()
        // physicalId → the logical ids that named it.  Filled while walking the
        // id list; the constituents are then reported in a second pass so a
        // physical camera shared by two logical ones is described ONCE, with
        // both parents named.
        val constituents = LinkedHashMap<String, MutableList<String>>()
        for (id in ids) {
            cams.pushMap(cameraEntry(mgr, id, "id-list", emptyList(), constituents))
        }
        var physicalReported = 0
        for ((pid, parents) in constituents) {
            if (ids.contains(pid)) continue // already described as a top-level id
            cams.pushMap(cameraEntry(mgr, pid, "physical-constituent", parents, null))
            physicalReported++
        }
        out.putArray("cameras", cams)
        out.putInt("cameraCount", cams.size())
        out.putInt("physicalConstituentsReported", physicalReported)
        return out
    }

    private fun cameraEntry(
        mgr: CameraManager,
        id: String,
        kind: String,
        parents: List<String>,
        constituents: MutableMap<String, MutableList<String>>?,
    ): WritableNativeMap {
        val m = WritableNativeMap()
        m.putString("id", id)
        m.putString("kind", kind)
        m.putArr("parentLogicalIds", if (parents.isEmpty()) null else stringsArray(parents))

        val ke = KeyErrors()
        val chars = try {
            mgr.getCameraCharacteristics(id)
        } catch (t: Throwable) {
            // A physical constituent id is only addressable from API 28/29 up
            // and some HALs refuse it outright — that is a FINDING, not a
            // crash, so it is named and the entry still ships.
            m.putString("characteristicsError", throwableLabel(t))
            m.putMap("keyErrors", ke.map)
            m.putInt("keyErrorCount", ke.count)
            return m
        }
        m.putNull("characteristicsError")

        val facing = readKey(chars, CameraCharacteristics.LENS_FACING, "LENS_FACING", ke)
        m.putI("lensFacingRaw", facing)
        m.putString("lensFacing", lensFacingName(facing))

        m.putI(
            "sensorOrientationDeg",
            readKey(chars, CameraCharacteristics.SENSOR_ORIENTATION, "SENSOR_ORIENTATION", ke),
        )

        val focals = readKey(
            chars,
            CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS,
            "LENS_INFO_AVAILABLE_FOCAL_LENGTHS",
            ke,
        )
        m.putArr("focalLengthsMm", floatsArray(focals))
        m.putString(
            "focalLengthsNote",
            "CameraCharacteristics has no LENS_FOCAL_LENGTH key — that is a per-frame " +
                "CaptureRequest/CaptureResult key. LENS_INFO_AVAILABLE_FOCAL_LENGTHS is the " +
                "characteristics form and is reported above; a fixed-focal lens publishes " +
                "exactly one entry.",
        )

        val physSize = readKey(
            chars, CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE, "SENSOR_INFO_PHYSICAL_SIZE", ke,
        )
        m.putM("sensorPhysicalSizeMm", sizeFMap(physSize))
        val pixArr = readKey(
            chars,
            CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE,
            "SENSOR_INFO_PIXEL_ARRAY_SIZE",
            ke,
        )
        m.putM("pixelArraySize", sizeMap(pixArr))
        val activeArr = readKey(
            chars,
            CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE,
            "SENSOR_INFO_ACTIVE_ARRAY_SIZE",
            ke,
        )
        m.putM("activeArraySize", rectMap(activeArr))

        putDerivedOptics(m, focals, physSize, pixArr, activeArr)

        val caps = readKey(
            chars,
            CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES,
            "REQUEST_AVAILABLE_CAPABILITIES",
            ke,
        )
        m.putArr("capabilitiesRaw", intsArray(caps))
        m.putArr(
            "capabilities",
            caps?.let { a -> WritableNativeArray().apply { for (v in a) pushString(capabilityName(v)) } },
        )
        m.putB("isLogicalMultiCamera", caps?.contains(CAP_LOGICAL_MULTI_CAMERA))
        m.putB("hasDepthOutput", caps?.contains(CAP_DEPTH_OUTPUT))
        m.putB("hasMotionTracking", caps?.contains(CAP_MOTION_TRACKING))
        m.putB(
            "hasConstrainedHighSpeedVideo",
            caps?.contains(CAP_CONSTRAINED_HIGH_SPEED_VIDEO),
        )

        val hw = readKey(
            chars,
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL,
            "INFO_SUPPORTED_HARDWARE_LEVEL",
            ke,
        )
        m.putI("hardwareLevelRaw", hw)
        m.putString("hardwareLevel", hardwareLevelName(hw))

        // Physical constituents — API 28.  Guarded, and the guard is REPORTED.
        if (Build.VERSION.SDK_INT >= 28) {
            val pids: Set<String>? = try {
                chars.physicalCameraIds
            } catch (t: Throwable) {
                ke.record("getPhysicalCameraIds", t)
                null
            }
            m.putArr("physicalCameraIds", pids?.let { stringsArray(it.toList()) })
            m.putNull("physicalCameraIdsGuard")
            if (pids != null && constituents != null) {
                for (p in pids) constituents.getOrPut(p) { mutableListOf() }.add(id)
            }
        } else {
            m.putNull("physicalCameraIds")
            m.putString(
                "physicalCameraIdsGuard",
                "CameraCharacteristics.getPhysicalCameraIds() requires API 28; this device " +
                    "is API ${Build.VERSION.SDK_INT} — constituent ids were not enumerated.",
            )
        }

        m.putMap("streamConfig", streamBlock(chars, ke))
        m.putMap("lensPose", lensPoseBlock(chars, ke))
        m.putMap("distortion", distortionBlock(chars, ke))

        val tsSrc = readKey(
            chars,
            CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE,
            "SENSOR_INFO_TIMESTAMP_SOURCE",
            ke,
        )
        val ts = WritableNativeMap()
        ts.putI("raw", tsSrc)
        ts.putString("name", timestampSourceName(tsSrc))
        ts.putString(
            "meaning",
            when (tsSrc) {
                TIMESTAMP_SOURCE_REALTIME ->
                    "REALTIME: image timestamps come from SystemClock.elapsedRealtimeNanos(), " +
                        "the SAME base as SensorEvent.timestamp — frame↔IMU alignment needs no " +
                        "clock conversion, and any residual offset is pipeline latency (τ), not " +
                        "a clock difference."
                TIMESTAMP_SOURCE_UNKNOWN ->
                    "UNKNOWN: image timestamps are monotonic but their base is unspecified and " +
                        "is NOT comparable to SensorEvent.timestamp. Frame↔IMU alignment must be " +
                        "measured (the Android form of the iOS τ problem); do not assume a shared " +
                        "epoch."
                null -> "unavailable — the key was not published, so the domain is unknown."
                else -> "unrecognised value; treat as UNKNOWN until identified."
            },
        )
        m.putMap("timestampSource", ts)

        m.putB(
            "aeLockAvailable",
            readKey(
                chars, CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE, "CONTROL_AE_LOCK_AVAILABLE", ke,
            ),
        )
        m.putB(
            "awbLockAvailable",
            readKey(
                chars,
                CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE,
                "CONTROL_AWB_LOCK_AVAILABLE",
                ke,
            ),
        )
        val minFocus = readKey(
            chars,
            CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE,
            "LENS_INFO_MINIMUM_FOCUS_DISTANCE",
            ke,
        )
        m.putD("minimumFocusDistanceDiopters", minFocus?.toDouble())
        m.putD(
            "minimumFocusDistanceMeters",
            // 0.0 diopters is the documented marker for a FIXED-FOCUS lens, not
            // "focuses at infinity by choice" — inverting it would print ∞.
            minFocus?.toDouble()?.let { if (it > 0.0) 1.0 / it else null },
        )
        m.putS(
            "minimumFocusDistanceNote",
            if (minFocus != null && minFocus == 0.0f) {
                "0.0 diopters = FIXED FOCUS: this lens cannot be refocused, which also means " +
                    "no focus breathing and a stable fx across a sweep."
            } else {
                null
            },
        )
        val afModes = readKey(
            chars,
            CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES,
            "CONTROL_AF_AVAILABLE_MODES",
            ke,
        )
        m.putArr("afModesRaw", intsArray(afModes))
        m.putArr(
            "afModes",
            afModes?.let { a -> WritableNativeArray().apply { for (v in a) pushString(afModeName(v)) } },
        )
        m.putB("afOffSupported", afModes?.contains(AF_MODE_OFF))

        m.putMap("keyErrors", ke.map)
        m.putInt("keyErrorCount", ke.count)
        return m
    }

    /**
     * fx ÷ imageWidth and the field of view, derived the way the engine's lens
     * gate derives them (`lens::resolve`, cpp/rnis_pano.cpp): fx in pixels is
     * `focal_mm × arrayWidth_px ÷ sensorWidth_mm`, and the gate reads
     * `fx ÷ imageWidth`, which is therefore just `focal_mm ÷ sensorWidth_mm`
     * and is INVARIANT under whatever raster the stream actually delivers.
     * That invariance is why the ratio measured here can be compared with the
     * ratio a frame will produce on the device.
     *
     * Reported TWICE on purpose.  `SENSOR_INFO_PHYSICAL_SIZE` describes the
     * FULL pixel array, but a stream is cropped to the ACTIVE array, so the
     * two derivations differ by the crop.  Which one a frame will match is not
     * knowable without opening the camera, so both are given and named rather
     * than one being picked.
     */
    private fun putDerivedOptics(
        m: WritableNativeMap,
        focals: FloatArray?,
        physSize: SizeF?,
        pixArr: Size?,
        activeArr: Rect?,
    ) {
        if (focals == null || focals.isEmpty() || physSize == null || pixArr == null) {
            m.putNull("derivedOptics")
            m.putString(
                "derivedOpticsUnavailable",
                "needs LENS_INFO_AVAILABLE_FOCAL_LENGTHS + SENSOR_INFO_PHYSICAL_SIZE + " +
                    "SENSOR_INFO_PIXEL_ARRAY_SIZE; missing: " +
                    listOfNotNull(
                        if (focals == null || focals.isEmpty()) "focalLengths" else null,
                        if (physSize == null) "physicalSize" else null,
                        if (pixArr == null) "pixelArraySize" else null,
                    ).joinToString(", "),
            )
            return
        }
        m.putNull("derivedOpticsUnavailable")
        val arr = WritableNativeArray()
        for (f in focals) {
            val e = WritableNativeMap()
            e.putD("focalLengthMm", f.toDouble())
            e.putMap(
                "fromPixelArray",
                opticsFor(
                    f.toDouble(),
                    physSize.width.toDouble(),
                    physSize.height.toDouble(),
                    pixArr.width,
                    pixArr.height,
                ),
            )
            if (activeArr != null && pixArr.width > 0 && pixArr.height > 0) {
                // The active array is a sub-rectangle of the pixel array, so its
                // physical extent scales by the same fraction.
                val sw = physSize.width.toDouble() * activeArr.width() / pixArr.width
                val sh = physSize.height.toDouble() * activeArr.height() / pixArr.height
                e.putMap(
                    "fromActiveArray",
                    opticsFor(f.toDouble(), sw, sh, activeArr.width(), activeArr.height()),
                )
                e.putNull("fromActiveArrayUnavailable")
            } else {
                e.putNull("fromActiveArray")
                e.putString(
                    "fromActiveArrayUnavailable",
                    "SENSOR_INFO_ACTIVE_ARRAY_SIZE unavailable or the pixel array is degenerate",
                )
            }
            arr.pushMap(e)
        }
        m.putArray("derivedOptics", arr)
        m.putString(
            "derivedOpticsNote",
            "fxOverImageWidth is what the engine's lens gate compares against its calibrated " +
                "row (rnis_pano.cpp lens::resolve, tolerance 4%). It equals focal_mm ÷ " +
                "sensorWidth_mm and is invariant under raster rescale. iOS reference values on " +
                "iPhone17,1 for scale: wide 0.6952, ultra-wide 0.4056 — quoted as a yardstick " +
                "for reading the numbers above, NOT as a claim about this device.",
        )
    }

    private fun opticsFor(
        focalMm: Double,
        sensorWmm: Double,
        sensorHmm: Double,
        wPx: Int,
        hPx: Int,
    ): WritableNativeMap = WritableNativeMap().apply {
        putD("sensorWidthMm", sensorWmm)
        putD("sensorHeightMm", sensorHmm)
        putI("arrayWidthPx", wPx)
        putI("arrayHeightPx", hPx)
        val fx = PanoPlusProbeMath.focalPixels(focalMm, wPx, sensorWmm)
        val fy = PanoPlusProbeMath.focalPixels(focalMm, hPx, sensorHmm)
        putD("fxPixels", fx)
        putD("fyPixels", fy)
        putD("fxOverImageWidth", if (fx != null && wPx > 0) fx / wPx else null)
        putD("horizontalFovDeg", PanoPlusProbeMath.fovDegrees(sensorWmm, focalMm))
        putD("verticalFovDeg", PanoPlusProbeMath.fovDegrees(sensorHmm, focalMm))
        putD(
            "diagonalFovDeg",
            PanoPlusProbeMath.fovDegrees(
                sqrt(sensorWmm * sensorWmm + sensorHmm * sensorHmm),
                focalMm,
            ),
        )
    }

    /**
     * YUV_420_888 output geometry + the frame-rate questions the pano+ capture
     * loop is gated on.
     *
     * The 60 fps answer is deliberately split into its two independent halves.
     * A normal (non-high-speed) session reaches 60 fps only if BOTH a size
     * exists whose SCALER min frame duration allows it AND an AE target-FPS
     * range reaches it; reporting one number would hide which half failed.
     */
    private fun streamBlock(chars: CameraCharacteristics, ke: KeyErrors): WritableNativeMap {
        val out = WritableNativeMap()
        val map: StreamConfigurationMap? = readKey(
            chars,
            CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP,
            "SCALER_STREAM_CONFIGURATION_MAP",
            ke,
        )
        if (map == null) {
            out.putBoolean("available", false)
            out.putString("reason", "SCALER_STREAM_CONFIGURATION_MAP unavailable")
            return out
        }
        out.putBoolean("available", true)

        val sizes: Array<Size>? = try {
            map.getOutputSizes(ImageFormat.YUV_420_888)
        } catch (t: Throwable) {
            ke.record("getOutputSizes(YUV_420_888)", t)
            null
        }
        out.putB("yuv420Supported", sizes != null && sizes.isNotEmpty())

        val model = ArrayList<PanoPlusProbeMath.OutputSize>()
        val yuvArr = WritableNativeArray()
        if (sizes != null) {
            for (s in sizes) {
                val dur = try {
                    map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, s)
                } catch (t: Throwable) {
                    ke.record("getOutputMinFrameDuration(${s.width}x${s.height})", t)
                    -1L
                }
                val fps = PanoPlusProbeMath.maxFpsFromMinFrameDuration(dur)
                model.add(PanoPlusProbeMath.OutputSize(s.width, s.height, dur))
                yuvArr.pushMap(
                    WritableNativeMap().apply {
                        putInt("width", s.width)
                        putInt("height", s.height)
                        // 0 is the documented "no minimum published" value; it is
                        // reported as-is and `maxFps` stays null rather than ∞.
                        putD("minFrameDurationNs", if (dur >= 0) dur.toDouble() else null)
                        putD("maxFps", fps)
                        putS("aspect", aspectLabel(s.width, s.height))
                    },
                )
            }
        }
        out.putArray("yuv420Sizes", yuvArr)
        out.putInt("yuv420SizeCount", yuvArr.size())

        val ranges = readKey(
            chars,
            CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES,
            "CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES",
            ke,
        )
        val rangeArr = WritableNativeArray()
        var aeMaxUpper: Int? = null
        if (ranges != null) {
            for (r in ranges) {
                rangeArr.pushMap(
                    WritableNativeMap().apply {
                        putInt("lower", r.lower)
                        putInt("upper", r.upper)
                    },
                )
                val u = r.upper
                if (aeMaxUpper == null || u > aeMaxUpper!!) aeMaxUpper = u
            }
        }
        out.putArr("aeTargetFpsRanges", if (ranges == null) null else rangeArr)
        out.putI("aeTargetFpsMaxUpper", aeMaxUpper)

        val at60 = PanoPlusProbeMath.largestMatchingAspectAtLeastFps(model, 4, 3, 60.0)
        val at30 = PanoPlusProbeMath.largestMatchingAspectAtLeastFps(model, 4, 3, 30.0)
        out.putB("hasFourThreeAt60Fps", if (sizes == null) null else at60 != null)
        out.putB("hasFourThreeAt30Fps", if (sizes == null) null else at30 != null)
        out.putM("largestFourThreeAt60Fps", outputSizeMap(at60))
        out.putM("largestFourThreeAt30Fps", outputSizeMap(at30))
        out.putD("fpsMatchToleranceFrac", PanoPlusProbeMath.FPS_TOLERANCE_FRAC)
        out.putString(
            "fpsMatchToleranceNote",
            "A rate counts as reaching the target if it is within " +
                "${(PanoPlusProbeMath.FPS_TOLERANCE_FRAC * 100).toInt()}% of it, so NTSC rates " +
                "(29.97, 59.94 — published as 33 366 700 / 16 683 350 ns) are not misreported " +
                "as failures.",
        )
        out.putB(
            "sixtyFpsNormalSessionPlausible",
            if (sizes == null || aeMaxUpper == null) null else (at60 != null && aeMaxUpper!! >= 60),
        )
        out.putString(
            "sixtyFpsNote",
            "PLAUSIBLE, not proven: only opening a session proves it. Both halves are reported " +
                "separately above — a size whose min frame duration allows 60 fps AND an AE " +
                "target-FPS range that reaches 60. On many phones 60 fps and above live only in " +
                "a CONSTRAINED_HIGH_SPEED session (see highSpeed below), which is a different " +
                "session type with its own restrictions.",
        )

        // High-speed catalogue — where 60/120/240 usually actually lives.
        val hsSizes: Array<Size>? = try {
            map.highSpeedVideoSizes
        } catch (t: Throwable) {
            ke.record("getHighSpeedVideoSizes", t)
            null
        }
        val hsArr = WritableNativeArray()
        if (hsSizes != null) {
            for (s in hsSizes) {
                val e = WritableNativeMap()
                e.putInt("width", s.width)
                e.putInt("height", s.height)
                e.putS("aspect", aspectLabel(s.width, s.height))
                val fr = try {
                    map.getHighSpeedVideoFpsRangesFor(s)
                } catch (t: Throwable) {
                    ke.record("getHighSpeedVideoFpsRangesFor(${s.width}x${s.height})", t)
                    null
                }
                val fa = WritableNativeArray()
                if (fr != null) {
                    for (r in fr) {
                        fa.pushMap(
                            WritableNativeMap().apply {
                                putInt("lower", r.lower)
                                putInt("upper", r.upper)
                            },
                        )
                    }
                }
                e.putArr("fpsRanges", if (fr == null) null else fa)
                hsArr.pushMap(e)
            }
        }
        out.putArr("highSpeedVideoSizes", if (hsSizes == null) null else hsArr)
        return out
    }

    /**
     * LENS_POSE_* — the highest-leverage unknown in the port.
     *
     * If the HAL publishes a real rotation with reference GYROSCOPE, the
     * IMU→camera basis is READ rather than searched for, and the Android arm
     * skips the basis-calibration step the iOS arm needed.
     *
     * THE TRAP, reported rather than hidden: an identity quaternion
     * [0,0,0,1] with a zero translation is exactly what a HAL publishes as a
     * PLACEHOLDER when it has no calibration to give. It is indistinguishable
     * from a genuine "the camera axes coincide with the reference axes"
     * measurement by value alone, so both shapes are flagged and the caller
     * must decide — a placeholder read as a measurement would silently install
     * a wrong basis, which is the failure mode this whole probe exists to
     * prevent.
     */
    private fun lensPoseBlock(chars: CameraCharacteristics, ke: KeyErrors): WritableNativeMap {
        val out = WritableNativeMap()
        val rot = readKey(chars, CameraCharacteristics.LENS_POSE_ROTATION, "LENS_POSE_ROTATION", ke)
        val tr = readKey(
            chars, CameraCharacteristics.LENS_POSE_TRANSLATION, "LENS_POSE_TRANSLATION", ke,
        )
        out.putArr("rotationQuaternionXYZW", floatsArray(rot))
        out.putArr("translationMeters", floatsArray(tr))
        out.putB("rotationPublished", rot != null && rot.size == 4)
        out.putB("translationPublished", tr != null && tr.size == 3)

        val identity = rot != null && rot.size == 4 &&
            abs(rot[0]) < 1e-6f && abs(rot[1]) < 1e-6f && abs(rot[2]) < 1e-6f &&
            abs(abs(rot[3]) - 1.0f) < 1e-6f
        val zeroT = tr != null && tr.size == 3 &&
            abs(tr[0]) < 1e-9f && abs(tr[1]) < 1e-9f && abs(tr[2]) < 1e-9f
        out.putB("rotationLooksLikeIdentity", if (rot == null) null else identity)
        out.putB("translationLooksLikeZero", if (tr == null) null else zeroT)

        if (Build.VERSION.SDK_INT >= 28) {
            val ref = readKey(
                chars, CameraCharacteristics.LENS_POSE_REFERENCE, "LENS_POSE_REFERENCE", ke,
            )
            out.putI("referenceRaw", ref)
            out.putString("reference", poseReferenceName(ref))
            out.putNull("referenceGuard")
        } else {
            out.putNull("referenceRaw")
            out.putString("reference", "unavailable")
            out.putString(
                "referenceGuard",
                "CameraCharacteristics.LENS_POSE_REFERENCE requires API 28; this device is " +
                    "API ${Build.VERSION.SDK_INT}. Without it the frame the rotation is " +
                    "expressed in is UNKNOWN and the rotation must not be used as an " +
                    "IMU→camera basis.",
            )
        }

        out.putString(
            "verdict",
            when {
                rot == null -> "not-published — the IMU→camera basis must be calibrated, " +
                    "as on the iOS arm."
                identity && zeroT -> "published-but-placeholder-shaped — identity rotation AND " +
                    "zero translation is what a HAL emits when it has no calibration. Treat as " +
                    "UNVERIFIED until a capture corroborates it."
                identity -> "published, rotation is identity — either the camera and reference " +
                    "axes genuinely coincide or this is a placeholder. Corroborate before use."
                else -> "published with a non-trivial rotation — this is a real calibration and " +
                    "the IMU→camera basis can be READ instead of searched. Confirm `reference` " +
                    "is GYROSCOPE before using it against SensorEvent data."
            },
        )
        return out
    }

    private fun distortionBlock(chars: CameraCharacteristics, ke: KeyErrors): WritableNativeMap {
        val out = WritableNativeMap()
        val intr = readKey(
            chars,
            CameraCharacteristics.LENS_INTRINSIC_CALIBRATION,
            "LENS_INTRINSIC_CALIBRATION",
            ke,
        )
        out.putArr("intrinsicCalibration", floatsArray(intr))
        out.putString(
            "intrinsicCalibrationLayout",
            "[fx, fy, cx, cy, s] in ACTIVE-ARRAY pixels (Android's own ordering). Null is the " +
                "common case: most non-depth cameras publish nothing here.",
        )
        if (Build.VERSION.SDK_INT >= 28) {
            out.putArr(
                "distortion",
                floatsArray(readKey(chars, CameraCharacteristics.LENS_DISTORTION, "LENS_DISTORTION", ke)),
            )
            out.putString("distortionLayout", "[k1, k2, k3, p1, p2] (Brown-Conrady)")
            out.putNull("distortionGuard")
        } else {
            out.putNull("distortion")
            out.putNull("distortionLayout")
            out.putString(
                "distortionGuard",
                "CameraCharacteristics.LENS_DISTORTION requires API 28; this device is API " +
                    "${Build.VERSION.SDK_INT} — radialDistortion below is the pre-28 form.",
            )
        }
        @Suppress("DEPRECATION")
        out.putArr(
            "radialDistortion",
            floatsArray(
                readKey(
                    chars,
                    CameraCharacteristics.LENS_RADIAL_DISTORTION,
                    "LENS_RADIAL_DISTORTION",
                    ke,
                ),
            ),
        )
        out.putString(
            "radialDistortionNote",
            "LENS_RADIAL_DISTORTION is the API 23 key, deprecated at API 28 in favour of " +
                "LENS_DISTORTION; both are read so a pre-28 device is not left empty. Layout " +
                "[k1..k4, p1, p2] and NOTE the sign convention differs from LENS_DISTORTION.",
        )
        return out
    }

    // ── Sensors (advertised) ─────────────────────────────────────────

    private fun sensorBlock(): WritableNativeMap {
        val out = WritableNativeMap()
        val sm = try {
            reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        } catch (t: Throwable) {
            out.putString("status", "sensor-service-threw")
            out.putString("error", throwableLabel(t))
            return out
        }
        if (sm == null) {
            out.putString("status", "sensor-service-unavailable")
            return out
        }
        out.putString("status", "ok")
        for ((type, label) in TRACKED_SENSORS) {
            out.putMap(label, sensorEntry(sm, type))
        }
        out.putMap("highSamplingRate", highSamplingRateBlock())
        out.putString(
            "ratesNote",
            "minDelayUs → maxHzFromMinDelay is what the sensor ADVERTISES. It is not what will " +
                "be delivered: call measureSensorRates() to count real events. The iOS arm " +
                "reports the same distinction as deliveredMotionHz.",
        )
        return out
    }

    private fun sensorEntry(sm: SensorManager, type: Int): WritableNativeMap {
        val out = WritableNativeMap()
        out.putInt("type", type)
        val s: Sensor? = try {
            sm.getDefaultSensor(type)
        } catch (t: Throwable) {
            out.putString("error", throwableLabel(t))
            null
        }
        val all: List<Sensor> = try {
            sm.getSensorList(type) ?: emptyList()
        } catch (_: Throwable) {
            emptyList()
        }
        out.putInt("instanceCount", all.size)
        out.putArr(
            "instanceNames",
            WritableNativeArray().apply { for (x in all) pushString(x.name ?: "(unnamed)") },
        )
        if (s == null) {
            out.putBoolean("present", false)
            return out
        }
        out.putBoolean("present", true)
        out.putS("name", s.name)
        out.putS("vendor", s.vendor)
        out.putInt("version", s.version)
        out.putS("stringType", if (Build.VERSION.SDK_INT >= 20) s.stringType else null)
        val minDelayUs = s.minDelay
        out.putInt("minDelayUs", minDelayUs)
        out.putD("maxHzFromMinDelay", PanoPlusProbeMath.maxHzFromMinDelayUs(minDelayUs))
        out.putS(
            "minDelayNote",
            if (minDelayUs <= 0) {
                "minDelay <= 0 means this sensor is on-change/one-shot or publishes no minimum " +
                    "— it does NOT mean unbounded rate, so no Hz is derived."
            } else {
                null
            },
        )
        out.putI("maxDelayUs", if (Build.VERSION.SDK_INT >= 21) s.maxDelay else null)
        out.putD("resolution", s.resolution.toDouble())
        out.putD("powerMa", s.power.toDouble())
        out.putD("maximumRange", s.maximumRange.toDouble())
        if (Build.VERSION.SDK_INT >= 21) {
            out.putInt("reportingModeRaw", s.reportingMode)
            out.putString("reportingMode", reportingModeName(s.reportingMode))
            out.putBoolean("isWakeUpSensor", s.isWakeUpSensor)
        } else {
            out.putNull("reportingModeRaw")
            out.putString("reportingMode", "unavailable")
            out.putNull("isWakeUpSensor")
            out.putString(
                "reportingModeGuard",
                "Sensor.getReportingMode()/isWakeUpSensor() require API 21",
            )
        }
        out.putInt("fifoReservedEventCount", s.fifoReservedEventCount)
        out.putInt("fifoMaxEventCount", s.fifoMaxEventCount)
        out.putI("id", if (Build.VERSION.SDK_INT >= 24) s.id else null)
        out.putB("isDynamicSensor", if (Build.VERSION.SDK_INT >= 24) s.isDynamicSensor else null)
        return out
    }

    /**
     * Android 12 caps `SENSOR_DELAY_FASTEST` at 200 Hz unless the app holds
     * HIGH_SAMPLING_RATE_SENSORS — a normal permission that must be DECLARED
     * in the manifest (it cannot be requested at runtime).  This module ships
     * no manifest entry, so the honest report is the state as read, plus what
     * that implies for any rate measured below.
     */
    private fun highSamplingRateBlock(): WritableNativeMap = WritableNativeMap().apply {
        if (Build.VERSION.SDK_INT < 31) {
            putString("state", "not-applicable")
            putString(
                "detail",
                "HIGH_SAMPLING_RATE_SENSORS gates >200 Hz from API 31; this device is API " +
                    "${Build.VERSION.SDK_INT}, where no cap applies.",
            )
            return@apply
        }
        val granted = try {
            reactApplicationContext.checkSelfPermission(PERM_HIGH_SAMPLING_RATE) ==
                PackageManager.PERMISSION_GRANTED
        } catch (t: Throwable) {
            putString("state", "check-threw")
            putString("detail", throwableLabel(t))
            return@apply
        }
        putString("state", if (granted) "held" else "not-held")
        putString(
            "detail",
            if (granted) {
                "The host app declares HIGH_SAMPLING_RATE_SENSORS, so sensor rates above 200 Hz " +
                    "can be delivered."
            } else {
                "The host app does not declare HIGH_SAMPLING_RATE_SENSORS, so the platform caps " +
                    "delivery at 200 Hz however fast the sensor is. A measured ~200 Hz is " +
                    "therefore a CEILING, not the hardware's limit."
            },
        )
    }

    // ── ARCore (reflective — no gradle dependency is added) ───────────

    /**
     * ⚠ ONE implementation, shared with the RECORDER's reference channel.
     *
     * `readArCoreAvailability` (PanoPlusArCoreReference.kt) is the same read,
     * and it must be: it is the guard that decides whether it is safe to LOAD
     * an ARCore type at all, and a probe that answered differently from the
     * guard would report a capability the recorder then refuses to use. The
     * reflection lives there rather than here because there is exactly one
     * correct way to ask this question and it has to survive the classes being
     * absent.
     */
    private fun arCoreBlock(): WritableNativeMap {
        val out = WritableNativeMap()
        val a = readArCoreAvailability(reactApplicationContext)
        out.putString("status", if (a.linked) "linked" else "not-linked")
        if (a.linked && a.status != "check-threw") {
            out.putS("availability", a.status)
            out.putNull("availabilityError")
        } else if (a.linked) {
            out.putNull("availability")
            out.putString("availabilityError", a.detail)
        } else {
            out.putNull("availability")
        }
        out.putBoolean("supported", a.supported)
        out.putString("detail", a.detail)
        // What the RECORDER would do with this, spelled out here so the
        // capability probe answers the question an operator actually has.
        out.putString(
            "referenceChannel",
            if (a.supported) {
                "startRecording({arcoreReference:'shared'}) can record an ARCore world<-camera " +
                    "pose per frame into panoplus/attitude_arcore.jsonl beside the rotation " +
                    "vector. In shared-camera mode ARCore SELECTS the camera id and the CPU " +
                    "image size, so the pack's raster changes — that confound is recorded in " +
                    "device.json's arcore block."
            } else {
                "no ARCore reference channel is possible on this build/device — " +
                    "arcoreReference will refuse by name and record nothing."
            },
        )
        out.putMap("installedPackage", arCorePackageBlock())
        return out
    }

    private fun arCorePackageBlock(): WritableNativeMap = WritableNativeMap().apply {
        try {
            val pi = reactApplicationContext.packageManager.getPackageInfo("com.google.ar.core", 0)
            putBoolean("visible", true)
            putS("versionName", pi.versionName)
            putD(
                "versionCode",
                if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toDouble()
                else @Suppress("DEPRECATION") pi.versionCode.toDouble(),
            )
        } catch (t: Throwable) {
            putBoolean("visible", false)
            putString("reason", throwableLabel(t))
            putString(
                "caveat",
                "From API 30 package visibility is filtered: NameNotFoundException here does " +
                    "NOT prove Google Play Services for AR is absent, only that this app cannot " +
                    "see it without a <queries> manifest entry.",
            )
        }
    }

    // ── Notes ────────────────────────────────────────────────────────

    private fun notesBlock(): WritableNativeArray = WritableNativeArray().apply {
        pushString(
            "Pure read: no camera device was opened, no capture session started, no permission " +
                "requested. getCameraIdList/getCameraCharacteristics and the sensor list all " +
                "work without CAMERA.",
        )
        pushString(
            "Every null in this report means 'the device did not publish it' or 'an API guard " +
                "stopped the read' — never 'the probe assumed a default'. Guards are named in " +
                "the sibling *Guard fields; read failures are named in each camera's keyErrors.",
        )
        pushString(
            "Nanosecond values cross the React Native bridge as doubles. That is exact below " +
                "2^53 ns ≈ 104 days of uptime; a device up longer than that loses sub-nanosecond " +
                "precision in the raw timestamps (the derived millisecond deltas are unaffected).",
        )
        pushString(
            "streamConfig answers what the HAL advertises for a normal session. It is not proof: " +
                "only opening a session proves a configuration, and 60 fps frequently lives only " +
                "in a CONSTRAINED_HIGH_SPEED session.",
        )
        pushString(
            "measureSensorRates() is a SEPARATE, explicitly triggered method. Nothing in " +
                "probeCapabilities registers a listener, so calling it cannot perturb a capture.",
        )
    }

    // ── The live measurement ─────────────────────────────────────────

    /**
     * Register the rotation-vector / game-rotation-vector / gyro /
     * accelerometer listeners at SENSOR_DELAY_FASTEST for [durationMs], then
     * report the rate that was actually DELIVERED.
     *
     * A requested sampling period is not a measurement — the platform silently
     * clamps it (and from API 31 caps it at 200 Hz without
     * HIGH_SAMPLING_RATE_SENSORS, which is reported here too). The iOS arm
     * reports the same quantity for the same reason and calls it
     * `deliveredMotionHz`.
     *
     * It also answers the timestamp-domain question directly: at the FIRST
     * event of each sensor it captures `SystemClock.elapsedRealtimeNanos()`
     * and `System.nanoTime()` and reports both deltas against
     * `SensorEvent.timestamp`, plus the separation between those two clocks —
     * because when the device has not slept the clocks coincide and the test
     * genuinely cannot discriminate. Saying so is the point.
     *
     * Everything runs on one private HandlerThread, so the counters are
     * single-threaded by construction and need no locking.
     */
    @ReactMethod
    fun measureSensorRates(durationMs: Double, promise: Promise) {
        if (!measuring.compareAndSet(false, true)) {
            promise.reject(
                "probe-busy",
                "A sensor-rate measurement is already running — wait for it to resolve.",
            )
            return
        }

        val requested = durationMs
        val effectiveMs = when {
            !durationMs.isFinite() -> DEFAULT_MEASURE_MS
            durationMs < MIN_MEASURE_MS -> MIN_MEASURE_MS
            durationMs > MAX_MEASURE_MS -> MAX_MEASURE_MS
            else -> durationMs
        }.toLong()

        val sm = try {
            reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        } catch (_: Throwable) {
            null
        }
        if (sm == null) {
            measuring.set(false)
            promise.resolve(
                WritableNativeMap().apply {
                    putInt("probeVersion", PROBE_VERSION)
                    putBoolean("ran", false)
                    putString("reason", "sensor-service-unavailable")
                    putD("requestedDurationMs", requested)
                },
            )
            return
        }

        val thread = HandlerThread("RNISPanoProbeSensors")
        thread.start()
        val handler = Handler(thread.looper)

        // ALL state below is touched only on `thread` — registration, every
        // event callback (registered with this handler), and the finish. That
        // is the whole concurrency design; there is nothing to lock.
        val posted = handler.post {
            val acc = HashMap<Int, TypeAcc>()
            // A plain Kotlin map, NOT a WritableNativeMap: ReadableNativeMap
            // caches its key set on the first read, so a `hasKey` interleaved
            // with further `put`s can answer from a stale snapshot. It is also
            // converted fresh at every use site, which keeps the bridge's
            // "a native map may be added to only one parent" rule trivially
            // satisfied on the paths that report it more than once.
            val status = LinkedHashMap<String, String>()
            val listener = object : SensorEventListener {
                override fun onSensorChanged(e: SensorEvent) {
                    val a = acc[e.sensor?.type ?: return] ?: return
                    a.onEvent(e)
                }

                override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {
                    acc[s?.type ?: return]?.lastAccuracy = accuracy
                }
            }
            var registeredCount = 0
            try {
                for ((type, label) in TRACKED_SENSORS) {
                    val s = try {
                        sm.getDefaultSensor(type)
                    } catch (t: Throwable) {
                        status[label] = "lookup-threw: ${throwableLabel(t)}"
                        null
                    }
                    if (s == null) {
                        if (!status.containsKey(label)) status[label] = "absent"
                        continue
                    }
                    val ok = try {
                        sm.registerListener(
                            listener, s, SensorManager.SENSOR_DELAY_FASTEST, handler,
                        )
                    } catch (t: Throwable) {
                        status[label] = "register-threw: ${throwableLabel(t)}"
                        false
                    }
                    if (ok) {
                        acc[type] = TypeAcc(label, s.name ?: "(unnamed)")
                        status[label] = "registered"
                        registeredCount++
                    } else if (!status.containsKey(label)) {
                        status[label] = "register-refused"
                    }
                }

                if (registeredCount == 0) {
                    sm.unregisterListener(listener)
                    finish(
                        promise,
                        thread,
                        WritableNativeMap().apply {
                            putInt("probeVersion", PROBE_VERSION)
                            putBoolean("ran", false)
                            putString("reason", "no-tracked-sensor-registered")
                            putMap("registration", statusMap(status))
                            putD("requestedDurationMs", requested)
                        },
                    )
                    return@post
                }

                val startElapsed = SystemClock.elapsedRealtimeNanos()
                val startUptime = System.nanoTime()
                handler.postDelayed({
                    val endElapsed = SystemClock.elapsedRealtimeNanos()
                    try {
                        sm.unregisterListener(listener)
                    } catch (_: Throwable) {
                        // Unregistering a listener that the framework already
                        // dropped is harmless; the counts stand either way.
                    }
                    val out = try {
                        rateReport(
                            acc, status, requested, effectiveMs,
                            startElapsed, startUptime, endElapsed,
                        )
                    } catch (t: Throwable) {
                        WritableNativeMap().apply {
                            putInt("probeVersion", PROBE_VERSION)
                            putBoolean("ran", false)
                            putString("reason", "report-build-threw")
                            putString("detail", throwableLabel(t))
                        }
                    }
                    finish(promise, thread, out)
                }, effectiveMs)
            } catch (t: Throwable) {
                try {
                    sm.unregisterListener(listener)
                } catch (_: Throwable) {
                }
                finish(
                    promise,
                    thread,
                    WritableNativeMap().apply {
                        putInt("probeVersion", PROBE_VERSION)
                        putBoolean("ran", false)
                        putString("reason", "registration-threw")
                        putString("detail", throwableLabel(t))
                        putMap("registration", statusMap(status))
                    },
                )
            }
        }
        if (!posted) {
            // The looper died between start() and post(). Without this the busy
            // flag would never clear and every later call would reject
            // `probe-busy` for the rest of the process's life.
            measuring.set(false)
            try {
                thread.quitSafely()
            } catch (_: Throwable) {
            }
            promise.reject(
                "probe-failed",
                "Could not schedule the measurement — the probe's handler thread was already " +
                    "exiting.",
            )
        }
    }

    /** Settle the promise, release the busy flag and retire the thread — in
     *  that order, and exactly once per measurement. */
    private fun finish(promise: Promise, thread: HandlerThread, out: WritableNativeMap) {
        measuring.set(false)
        try {
            promise.resolve(out)
        } catch (_: Throwable) {
        }
        try {
            thread.quitSafely()
        } catch (_: Throwable) {
        }
    }

    private fun rateReport(
        acc: Map<Int, TypeAcc>,
        status: Map<String, String>,
        requestedMs: Double,
        effectiveMs: Long,
        startElapsedNs: Long,
        startUptimeNs: Long,
        endElapsedNs: Long,
    ): WritableNativeMap {
        val out = WritableNativeMap()
        out.putInt("probeVersion", PROBE_VERSION)
        out.putBoolean("ran", true)
        out.putD("requestedDurationMs", requestedMs)
        out.putDouble("effectiveDurationMs", effectiveMs.toDouble())
        // A non-finite request WAS replaced (by the default), so it counts as
        // clamped — reporting it as unclamped would hide the substitution.
        out.putBoolean(
            "durationClamped",
            !requestedMs.isFinite() || requestedMs != effectiveMs.toDouble(),
        )
        out.putString(
            "durationClampNote",
            "Clamped to [$MIN_MEASURE_MS, $MAX_MEASURE_MS] ms; a non-finite request falls back " +
                "to $DEFAULT_MEASURE_MS ms.",
        )
        out.putDouble("wallClockSpanMs", (endElapsedNs - startElapsedNs) / 1e6)
        out.putMap("registration", statusMap(status))
        out.putString("requestedDelay", "SENSOR_DELAY_FASTEST")
        out.putMap("highSamplingRate", highSamplingRateBlock())

        // The separation between CLOCK_BOOTTIME (elapsedRealtimeNanos) and
        // CLOCK_MONOTONIC (nanoTime) is total deep-sleep since boot. It is the
        // ONLY thing that gives the domain test below any discriminating power:
        // on a device that has not slept the two clocks coincide and no
        // observation can tell them apart. Reported first, so the verdicts are
        // read in the light of it.
        val separationNs = startElapsedNs - startUptimeNs
        val clocks = WritableNativeMap()
        clocks.putDouble("elapsedRealtimeMinusNanoTimeNs", separationNs.toDouble())
        clocks.putDouble("elapsedRealtimeMinusNanoTimeSec", separationNs / 1e9)
        clocks.putBoolean("discriminating", abs(separationNs) >= CLOCK_SEPARATION_MIN_NS)
        clocks.putString(
            "note",
            "elapsedRealtimeNanos() is CLOCK_BOOTTIME and nanoTime() is CLOCK_MONOTONIC; they " +
                "differ by the time spent in deep sleep since boot. When that difference is " +
                "under ${CLOCK_SEPARATION_MIN_NS / 1_000_000} ms the two are indistinguishable " +
                "and every per-sensor domain verdict below is reported as ambiguous rather than " +
                "guessed.",
        )
        out.putMap("clocks", clocks)

        val sensors = WritableNativeMap()
        for ((_, label) in TRACKED_SENSORS) {
            val a = acc.values.firstOrNull { it.label == label }
            if (a == null) {
                sensors.putMap(
                    label,
                    WritableNativeMap().apply {
                        putBoolean("registered", false)
                        putInt("events", 0)
                        putNull("deliveredHz")
                    },
                )
                continue
            }
            sensors.putMap(label, a.report(startElapsedNs, endElapsedNs, separationNs))
        }
        out.putMap("sensors", sensors)
        out.putString(
            "deliveredHzNote",
            "deliveredHz is (events − 1) ÷ (last event timestamp − first event timestamp) — the " +
                "rate the device actually produced, not the rate requested. It is the Android " +
                "counterpart of the iOS arm's deliveredMotionHz.",
        )
        return out
    }

    // ── Small typed helpers ──────────────────────────────────────────

    private fun <T : Any> readKey(
        chars: CameraCharacteristics,
        key: CameraCharacteristics.Key<T>,
        label: String,
        ke: KeyErrors,
    ): T? = try {
        chars.get(key)
    } catch (t: Throwable) {
        // Some OEM HALs throw IllegalArgumentException (and, seen in the wild,
        // NPE) for keys they do not implement instead of returning null. One
        // such key must not cost the whole report.
        ke.record(label, t)
        null
    }

    private fun safeMap(label: String, build: () -> WritableNativeMap): WritableNativeMap = try {
        build()
    } catch (t: Throwable) {
        WritableNativeMap().apply {
            putString("errorIn", label)
            putString("error", throwableLabel(t))
        }
    }

    private fun outputSizeMap(s: PanoPlusProbeMath.OutputSize?): WritableNativeMap? =
        s?.let {
            WritableNativeMap().apply {
                putInt("width", it.width)
                putInt("height", it.height)
                putD(
                    "minFrameDurationNs",
                    if (it.minFrameDurationNs >= 0) it.minFrameDurationNs.toDouble() else null,
                )
                putD("maxFps", PanoPlusProbeMath.maxFpsFromMinFrameDuration(it.minFrameDurationNs))
            }
        }

    companion object {
        /** Bumped whenever the SHAPE of either payload changes, so an offline
         *  reader can refuse a report it does not understand. */
        private const val PROBE_VERSION = 1

        private const val MIN_MEASURE_MS = 250.0
        private const val MAX_MEASURE_MS = 15_000.0
        private const val DEFAULT_MEASURE_MS = 2_000.0

        private const val PERM_HIGH_SAMPLING_RATE =
            "android.permission.HIGH_SAMPLING_RATE_SENSORS"

        /** The four the pano+ attitude path can possibly use, in report order. */
        private val TRACKED_SENSORS = listOf(
            Sensor.TYPE_ROTATION_VECTOR to "rotationVector",
            Sensor.TYPE_GAME_ROTATION_VECTOR to "gameRotationVector",
            Sensor.TYPE_GYROSCOPE to "gyroscope",
            Sensor.TYPE_ACCELEROMETER to "accelerometer",
        )

        // CameraMetadata capability codes, as literals with their API level, so
        // the probe never resolves a constant the runtime may not have and an
        // unrecognised code degrades to "unknown(n)" instead of vanishing.
        private const val CAP_DEPTH_OUTPUT = 8
        private const val CAP_CONSTRAINED_HIGH_SPEED_VIDEO = 9
        private const val CAP_MOTION_TRACKING = 10
        private const val CAP_LOGICAL_MULTI_CAMERA = 11

        private const val AF_MODE_OFF = 0
        private const val TIMESTAMP_SOURCE_UNKNOWN = 0
        private const val TIMESTAMP_SOURCE_REALTIME = 1

        @JvmStatic
        private val measuring = AtomicBoolean(false)
    }
}

// ── File-private plumbing ────────────────────────────────────────────────

/**
 * Below this CLOCK_BOOTTIME-vs-CLOCK_MONOTONIC separation the two clocks
 * cannot be told apart by any observation, so the timestamp-domain verdict
 * says "ambiguous" instead of picking one.
 *
 * ONE definition on purpose: the threshold is applied in two places (the
 * `clocks` block's `discriminating` flag and each sensor's verdict), and two
 * copies of it would eventually disagree and make the report contradict
 * itself.
 */
private const val CLOCK_SEPARATION_MIN_NS = 50_000_000L // 50 ms

/** Per-camera read failures, kept beside the values so a null is never
 *  ambiguous between "not published" and "the read threw". */
private class KeyErrors {
    val map = WritableNativeMap()
    var count = 0
    fun record(label: String, t: Throwable) {
        map.putString(label, throwableLabel(t))
        count++
    }
}

/** One sensor's counters. Written only on the probe's HandlerThread. */
private class TypeAcc(val label: String, val sensorName: String) {
    var events = 0
    var firstTsNs = 0L
    var lastTsNs = 0L
    var maxGapNs = 0L
    var nonMonotonic = 0
    var firstCallbackElapsedNs = 0L
    var firstCallbackUptimeNs = 0L
    var lastAccuracy = ACCURACY_NEVER_REPORTED

    fun onEvent(e: SensorEvent) {
        val ts = e.timestamp
        if (events == 0) {
            // Captured INSIDE the first callback, so the deltas below measure
            // event-timestamp against the clocks as they read at delivery.
            firstCallbackElapsedNs = SystemClock.elapsedRealtimeNanos()
            firstCallbackUptimeNs = System.nanoTime()
            firstTsNs = ts
        } else {
            val gap = ts - lastTsNs
            if (gap <= 0L) nonMonotonic++
            if (gap > maxGapNs) maxGapNs = gap
        }
        lastTsNs = ts
        events++
        lastAccuracy = e.accuracy
    }

    fun report(startElapsedNs: Long, endElapsedNs: Long, clockSeparationNs: Long): WritableNativeMap =
        WritableNativeMap().apply {
            putBoolean("registered", true)
            putString("sensorName", sensorName)
            putInt("events", events)
            val spanNs = if (events > 1) lastTsNs - firstTsNs else 0L
            putD("eventTimestampSpanSec", if (events > 1) spanNs / 1e9 else null)
            putD(
                "deliveredHz",
                if (events > 1 && spanNs > 0L) (events - 1) * 1e9 / spanNs else null,
            )
            val wallNs = endElapsedNs - startElapsedNs
            putD(
                "deliveredHzFromWallClock",
                if (events > 0 && wallNs > 0L) events * 1e9 / wallNs else null,
            )
            putD("maxInterEventGapMs", if (events > 1) maxGapNs / 1e6 else null)
            putInt("nonMonotonicTimestamps", nonMonotonic)
            putInt("lastAccuracyRaw", lastAccuracy)
            putString("lastAccuracy", accuracyName(lastAccuracy))
            if (events == 0) {
                putNull("timestampDomain")
                putString(
                    "silentNote",
                    "Registered but delivered nothing in the measurement window — report this " +
                        "rather than reading it as a rate of 0 Hz.",
                )
                return@apply
            }
            val dER = firstCallbackElapsedNs - firstTsNs
            val dUP = firstCallbackUptimeNs - firstTsNs
            putMap(
                "timestampDomain",
                WritableNativeMap().apply {
                    putDouble("firstEventTimestampNs", firstTsNs.toDouble())
                    putDouble("elapsedRealtimeAtFirstCallbackNs", firstCallbackElapsedNs.toDouble())
                    putDouble("nanoTimeAtFirstCallbackNs", firstCallbackUptimeNs.toDouble())
                    putDouble("deltaVsElapsedRealtimeMs", dER / 1e6)
                    putDouble("deltaVsNanoTimeMs", dUP / 1e6)
                    val nearER = abs(dER) < ONE_SECOND_NS
                    val nearUP = abs(dUP) < ONE_SECOND_NS
                    putString(
                        "verdict",
                        when {
                            !nearER && !nearUP ->
                                "neither-clock-within-1s — SensorEvent.timestamp is in a domain " +
                                    "this probe does not recognise; do NOT compare it with frame " +
                                    "timestamps until it is identified."
                            abs(clockSeparationNs) < CLOCK_SEPARATION_MIN_NS ->
                                "ambiguous — the device has not slept, so CLOCK_BOOTTIME and " +
                                    "CLOCK_MONOTONIC agree to within " +
                                    "${abs(clockSeparationNs) / 1_000_000} ms and no observation " +
                                    "can separate them. Both deltas are small; re-run after the " +
                                    "phone has been asleep to discriminate."
                            nearER && !nearUP ->
                                "elapsedRealtimeNanos (CLOCK_BOOTTIME) — the same base as " +
                                    "SENSOR_INFO_TIMESTAMP_SOURCE = REALTIME image timestamps."
                            nearUP && !nearER ->
                                "nanoTime / uptime (CLOCK_MONOTONIC) — NOT the base of REALTIME " +
                                    "image timestamps; a conversion is required."
                            abs(dER) <= abs(dUP) ->
                                "closer to elapsedRealtimeNanos (CLOCK_BOOTTIME), by " +
                                    "${abs(abs(dUP) - abs(dER)) / 1_000_000} ms."
                            else ->
                                "closer to nanoTime (CLOCK_MONOTONIC), by " +
                                    "${abs(abs(dER) - abs(dUP)) / 1_000_000} ms."
                        },
                    )
                    putString(
                        "note",
                        "A positive delta is the delivery latency between the sensor stamping " +
                            "the sample and this callback running; it is not an offset to " +
                            "subtract from anything.",
                    )
                },
            )
        }

    private companion object {
        const val ACCURACY_NEVER_REPORTED = -99
        const val ONE_SECOND_NS = 1_000_000_000L
    }
}

private fun throwableLabel(t: Throwable): String =
    "${t.javaClass.simpleName}: ${t.message ?: "(no message)"}"

private fun lensFacingName(v: Int?): String = when (v) {
    null -> "unavailable"
    0 -> "FRONT"
    1 -> "BACK"
    2 -> "EXTERNAL"
    else -> "unknown($v)"
}

private fun hardwareLevelName(v: Int?): String = when (v) {
    null -> "unavailable"
    0 -> "LIMITED"
    1 -> "FULL"
    2 -> "LEGACY"
    3 -> "LEVEL_3"
    4 -> "EXTERNAL"
    else -> "unknown($v)"
}

/** REQUEST_AVAILABLE_CAPABILITIES codes with the API level that introduced
 *  each. Written as literals so a device reporting a code newer than this
 *  compileSdk still gets a legible "unknown(n)" instead of being dropped. */
private fun capabilityName(v: Int): String = when (v) {
    0 -> "BACKWARD_COMPATIBLE"
    1 -> "MANUAL_SENSOR"
    2 -> "MANUAL_POST_PROCESSING"
    3 -> "RAW"
    4 -> "PRIVATE_REPROCESSING"
    5 -> "READ_SENSOR_SETTINGS"
    6 -> "BURST_CAPTURE"
    7 -> "YUV_REPROCESSING"
    8 -> "DEPTH_OUTPUT"
    9 -> "CONSTRAINED_HIGH_SPEED_VIDEO"
    10 -> "MOTION_TRACKING"            // API 28
    11 -> "LOGICAL_MULTI_CAMERA"       // API 28
    12 -> "MONOCHROME"                 // API 28
    13 -> "SECURE_IMAGE_DATA"          // API 29
    14 -> "SYSTEM_CAMERA"              // API 30
    15 -> "OFFLINE_PROCESSING"         // API 30
    16 -> "ULTRA_HIGH_RESOLUTION_SENSOR" // API 31
    17 -> "REMOSAIC_REPROCESSING"      // API 31
    18 -> "DYNAMIC_RANGE_TEN_BIT"      // API 33
    19 -> "STREAM_USE_CASE"            // API 33
    20 -> "COLOR_SPACE_PROFILES"       // API 34
    else -> "unknown($v)"
}

private fun poseReferenceName(v: Int?): String = when (v) {
    null -> "unavailable"
    0 -> "PRIMARY_CAMERA"
    1 -> "GYROSCOPE"
    2 -> "UNDEFINED"   // API 30
    3 -> "AUTOMOTIVE"  // API 33
    else -> "unknown($v)"
}

private fun timestampSourceName(v: Int?): String = when (v) {
    null -> "unavailable"
    0 -> "UNKNOWN"
    1 -> "REALTIME"
    else -> "unknown($v)"
}

private fun afModeName(v: Int): String = when (v) {
    0 -> "OFF"
    1 -> "AUTO"
    2 -> "MACRO"
    3 -> "CONTINUOUS_VIDEO"
    4 -> "CONTINUOUS_PICTURE"
    5 -> "EDOF"
    else -> "unknown($v)"
}

private fun reportingModeName(v: Int): String = when (v) {
    0 -> "CONTINUOUS"
    1 -> "ON_CHANGE"
    2 -> "ONE_SHOT"
    3 -> "SPECIAL_TRIGGER"
    else -> "unknown($v)"
}

private fun accuracyName(v: Int): String = when (v) {
    -99 -> "never-reported"
    -1 -> "NO_CONTACT"
    0 -> "UNRELIABLE"
    1 -> "LOW"
    2 -> "MEDIUM"
    3 -> "HIGH"
    else -> "unknown($v)"
}

private fun aspectLabel(w: Int, h: Int): String = when {
    w <= 0 || h <= 0 -> "degenerate"
    PanoPlusProbeMath.matchesAspect(w, h, 4, 3) -> "4:3"
    PanoPlusProbeMath.matchesAspect(w, h, 16, 9) -> "16:9"
    PanoPlusProbeMath.matchesAspect(w, h, 1, 1) -> "1:1"
    PanoPlusProbeMath.matchesAspect(w, h, 3, 2) -> "3:2"
    PanoPlusProbeMath.matchesAspect(w, h, 18, 9) -> "18:9"
    else -> "other(${"%.4f".format(w.toDouble() / h.toDouble())})"
}

/** A FRESH bridge map per call — see the note at the `status` declaration. */
private fun statusMap(m: Map<String, String>): WritableNativeMap =
    WritableNativeMap().apply { for ((k, v) in m) putString(k, v) }

private fun stringsArray(v: List<String>?): WritableNativeArray? =
    v?.let { WritableNativeArray().apply { for (s in it) pushString(s) } }

private fun floatsArray(v: FloatArray?): WritableNativeArray? =
    v?.let {
        WritableNativeArray().apply {
            // NaN/Infinity must never cross the bridge (the serialiser rejects
            // them) — an unrepresentable component becomes null, not 0.
            for (f in it) if (f.isFinite()) pushDouble(f.toDouble()) else pushNull()
        }
    }

private fun intsArray(v: IntArray?): WritableNativeArray? =
    v?.let { WritableNativeArray().apply { for (i in it) pushInt(i) } }

private fun sizeMap(s: Size?): WritableNativeMap? = s?.let {
    WritableNativeMap().apply {
        putInt("width", it.width)
        putInt("height", it.height)
    }
}

private fun sizeFMap(s: SizeF?): WritableNativeMap? = s?.let {
    WritableNativeMap().apply {
        putD("width", it.width.toDouble())
        putD("height", it.height.toDouble())
    }
}

private fun rectMap(r: Rect?): WritableNativeMap? = r?.let {
    WritableNativeMap().apply {
        putInt("left", it.left)
        putInt("top", it.top)
        putInt("right", it.right)
        putInt("bottom", it.bottom)
        putInt("width", it.width())
        putInt("height", it.height())
    }
}

// Null-tolerant putters. Every one of them writes an EXPLICIT null rather than
// omitting the key, so a reader can tell "absent" from "not in this report".
private fun WritableNativeMap.putD(key: String, v: Double?) {
    if (v == null || !v.isFinite()) putNull(key) else putDouble(key, v)
}

private fun WritableNativeMap.putI(key: String, v: Int?) {
    if (v == null) putNull(key) else putInt(key, v)
}

private fun WritableNativeMap.putB(key: String, v: Boolean?) {
    if (v == null) putNull(key) else putBoolean(key, v)
}

private fun WritableNativeMap.putS(key: String, v: String?) {
    if (v == null) putNull(key) else putString(key, v)
}

private fun WritableNativeMap.putArr(key: String, v: WritableNativeArray?) {
    if (v == null) putNull(key) else putArray(key, v)
}

private fun WritableNativeMap.putM(key: String, v: WritableNativeMap?) {
    if (v == null) putNull(key) else putMap(key, v)
}

// ── The host-testable arithmetic ─────────────────────────────────────────
//
// Deliberately free of android.* and React Native types so the JVM suite
// (src/test/…/PanoPlusProbeMathTest.kt) can exercise it with no mockable
// android.jar and no RN on the classpath. Each function here has a documented
// way of lying if written naively; the tests pin exactly those.

internal object PanoPlusProbeMath {

    /**
     * A published output size and the SCALER minimum frame duration beside it.
     * `minFrameDurationNs <= 0` means the HAL published NO minimum — which is
     * not the same as "arbitrarily fast", and is why every derived rate here
     * is nullable.
     */
    internal data class OutputSize(
        val width: Int,
        val height: Int,
        val minFrameDurationNs: Long,
    ) {
        val area: Long get() = width.toLong() * height.toLong()
    }

    /**
     * Rates are compared with a 2% tolerance because the question is decided
     * in whole nanoseconds: a 59.94 fps device publishes 16 683 350 ns, and an
     * exact `>= 60.0` would answer "no 60 fps size" on a device that has one.
     * 2% is far below the gap between adjacent standard rates (30→60), so it
     * cannot promote one rate into the next.
     */
    const val FPS_TOLERANCE_FRAC = 0.02

    /** Frames per second a min frame duration allows, or null when the HAL
     *  published none. */
    fun maxFpsFromMinFrameDuration(ns: Long): Double? =
        if (ns <= 0L) null else 1e9 / ns.toDouble()

    /** Max sampling rate a sensor's `minDelay` advertises, or null when it is
     *  0/negative (on-change, one-shot, or simply unpublished). */
    fun maxHzFromMinDelayUs(minDelayUs: Int): Double? =
        if (minDelayUs <= 0) null else 1e6 / minDelayUs.toDouble()

    /** Whether `w×h` is the `num:den` aspect ratio within [tolFrac]. */
    fun matchesAspect(w: Int, h: Int, num: Int, den: Int, tolFrac: Double = 0.02): Boolean {
        if (w <= 0 || h <= 0 || num <= 0 || den <= 0) return false
        val target = num.toDouble() / den.toDouble()
        val actual = w.toDouble() / h.toDouble()
        return abs(actual - target) <= tolFrac * target
    }

    /**
     * The LARGEST (by area) size whose published minimum frame duration allows
     * at least [minFps]. Sizes with no published duration are excluded:
     * silence is not evidence of speed.
     *
     * ⚠ THIS IS THE SWEEP'S OWN RATE RUNG, EXTRACTED SO THE IDLE VIEWFINDER
     * CANNOT DISAGREE WITH IT. `PanoPlusAndroidRecorder.start` picks the
     * recording size with exactly this rule, and
     * `PanoPlusIdlePreviewSession` has to reach the SAME answer or the
     * operator frames his shot at one aspect ratio and the pack records
     * another — on this device the difference is 4:3 (1440x1080, what the
     * live packs record) against 16:9, i.e. a vertical field of view he was
     * shown and does not get. One implementation is the only way that stays
     * true as the ladder changes.
     */
    fun largestAtLeastFps(sizes: List<OutputSize>, minFps: Double): OutputSize? {
        var best: OutputSize? = null
        for (s in sizes) {
            val fps = maxFpsFromMinFrameDuration(s.minFrameDurationNs) ?: continue
            if (fps < minFps * (1.0 - FPS_TOLERANCE_FRAC)) continue
            val b = best
            // Strictly greater: ties keep the FIRST, which is the order the HAL
            // published them in — the same tie-break `maxByOrNull` gives.
            if (b == null || s.area > b.area) best = s
        }
        return best
    }

    /**
     * The LARGEST (by area) size matching `num:den` whose published minimum
     * frame duration allows at least [minFps]. Sizes with no published
     * duration are excluded: silence is not evidence of speed.
     */
    fun largestMatchingAspectAtLeastFps(
        sizes: List<OutputSize>,
        num: Int,
        den: Int,
        minFps: Double,
    ): OutputSize? = largestAtLeastFps(
        sizes.filter { matchesAspect(it.width, it.height, num, den) }, minFps,
    )

    /**
     * One published CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES entry, without
     * `android.util.Range` — this object stays free of android.* so the JVM
     * suite can exercise it. Both call sites map to and from the real Range at
     * their own edge.
     */
    internal data class FpsRange(val lower: Int, val upper: Int) {
        val isFixed: Boolean get() = lower == upper
        /** Matches `android.util.Range.toString()`, so a note built from this
         *  reads identically to one built from the platform type. */
        override fun toString(): String = "[$lower, $upper]"
    }

    /**
     * The AE target frame-rate range to REQUEST, chosen from the ones the
     * camera advertises.
     *
     * ⚠ THIS IS THE SWEEP'S OWN RULE, EXTRACTED SO THE IDLE VIEWFINDER CANNOT
     * DISAGREE WITH IT — the same move, and for the same reason, as
     * [largestAtLeastFps] one function above. Until 2026-09-07
     * `PanoPlusIdlePreviewSession.buildRequest` set no range at all while
     * `PanoPlusAndroidRecorder.baseRequest` set this one, so the operator
     * framed through a HAL-default (usually variable) rate and recorded at a
     * pinned one. The iOS half of exactly that fault is written up in
     * `RNISPanoAvfSource.startIdlePreviewOnSessionQ`. Writing the rule twice
     * would have re-opened it the first time either copy moved.
     *
     * The rule, unchanged from the recorder:
     *   * Among ranges whose CEILING reaches [preferFps]: prefer a FIXED range
     *     (lower == upper) over a variable one, then the LOWEST such ceiling.
     *     Fixed matters because a variable range lets AE lengthen the exposure
     *     in a dim aisle, and a long exposure on a moving phone is motion blur
     *     — which is the whole reason a high rate is wanted.
     *   * If nothing reaches [preferFps]: the highest ceiling available, fixed
     *     breaking the tie. 60 is a blur DEFENCE, not an engine requirement,
     *     so 30 is accepted — and both call sites say so in words.
     *   * An empty list yields null: a range the characteristics do not
     *     advertise must never be requested.
     *
     * Ties keep the FIRST entry, which is the order the HAL published them in.
     */
    fun pickAeFpsRange(ranges: List<FpsRange>, preferFps: Int): FpsRange? =
        ranges.filter { it.upper >= preferFps }.minByOrNull {
            (if (it.isFixed) 0 else 1_000_000) + it.upper
        } ?: ranges.maxByOrNull {
            it.upper * 1000 + (if (it.isFixed) 1 else 0)
        }

    /**
     * Can an output clocked at [outputMaxFps] honour [range]?
     *
     * ⚠ THE 10-FPS TRAP, ASKED BEFORE THE REQUEST IS MADE. The recorder's size
     * ladder names it (`PanoPlusAndroidRecorder.kt`: "a 4000x3000 output that
     * can only be clocked at 10 fps no matter what CONTROL_AE_TARGET_FPS_RANGE
     * says") and defends against it by CHOOSING the size by its published rate.
     * The idle viewfinder cannot choose its way out of it the same way — its
     * one output is a preview-sized SurfaceTexture whose size is fixed by the
     * recording aspect — so it asks the question instead and declines the pin
     * when the answer is no. A repeating request the HAL refuses would take
     * the whole viewfinder down, and the viewfinder is the only one on the
     * decoupled arm.
     *
     * Only the range's LOWER bound is tested: a variable [15,60] on a 30 fps
     * output is perfectly honourable — AE runs at the bottom of the range —
     * and refusing it would disable the pin on the bodies it helps most. A
     * FIXED [60,60] on a 10 fps output is not.
     *
     * [outputMaxFps] null (the HAL published no minimum frame duration for
     * this output, which is the ordinary case for a preview-sized
     * SurfaceTexture) is NOT a veto. Silence is not evidence of speed — that
     * is why the size ladder excludes silent sizes from its rungs — but it is
     * not evidence of slowness either, and the recorder requests its range on
     * such a camera too. A guard that fired on silence would be a permanent
     * no-op wearing a guard's clothes.
     *
     * Compared with [FPS_TOLERANCE_FRAC] for the same reason the size ladder
     * is: 59.94 fps publishes 16 683 350 ns.
     */
    fun outputCanSustainFpsRange(range: FpsRange, outputMaxFps: Double?): Boolean {
        if (outputMaxFps == null || !outputMaxFps.isFinite() || outputMaxFps <= 0.0) return true
        return outputMaxFps >= range.lower * (1.0 - FPS_TOLERANCE_FRAC)
    }

    /** Full-angle field of view in degrees for a sensor extent and focal
     *  length, both in millimetres. Null for any non-positive or non-finite
     *  input — a FoV derived from a missing dimension is a fiction. */
    fun fovDegrees(sensorDimMm: Double, focalMm: Double): Double? {
        if (!sensorDimMm.isFinite() || !focalMm.isFinite()) return null
        if (sensorDimMm <= 0.0 || focalMm <= 0.0) return null
        return Math.toDegrees(2.0 * atan(sensorDimMm / (2.0 * focalMm)))
    }

    /**
     * Focal length in PIXELS: `focal_mm ÷ pixel_pitch_mm`, i.e.
     * `focal_mm × arrayDimPx ÷ sensorDimMm`. Divided by the same
     * `arrayDimPx` it yields `focal_mm ÷ sensorDimMm` — the raster-invariant
     * ratio the engine's lens gate reads.
     */
    fun focalPixels(focalMm: Double, arrayDimPx: Int, sensorDimMm: Double): Double? {
        if (!focalMm.isFinite() || !sensorDimMm.isFinite()) return null
        if (focalMm <= 0.0 || arrayDimPx <= 0 || sensorDimMm <= 0.0) return null
        return focalMm * arrayDimPx.toDouble() / sensorDimMm
    }
}
