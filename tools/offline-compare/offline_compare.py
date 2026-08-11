#!/usr/bin/env python3
"""
offline_compare.py — replay a field DEBUG PACK through the REAL stitcher on a
device and quantify the off-vs-always compose A/B (and, optionally, an ablation
sweep for root-cause analysis).  No eyeballing: same input keyframes, both
budgets, measured SSIM + wall time.

A debug pack is the directory the app writes when `debugPack` is on:
    rlis-capture-<uuid>/
        keyframe-0.jpg ... keyframe-N.jpg
        pack.json          (device, recipe, result, timings)

Pull one from the device with:
    adb -s <serial> exec-out run-as com.rnimagestitcherexample \
        tar c cache/rlis-capture-<uuid> | tar x -C <dest>
(or `adb pull` if the app exposes it).  Then:

    venv/bin/python offline_compare.py <pack_dir> [--serial S] [--floor 0.6]
                                       [--ablate] [--out report/]

What it does per run: pushes the keyframes + stitch_probe + libc++ to the
device, runs retailens::stitchFramePaths, pulls the stitched JPEG, and records
wallMs/dims.  It runs at least:
    field   — the pack's EXACT recipe (reproduces the field stitch time)
    off     — compose 1.0 MP
    always  — compose = floor (default 0.6)
then reports SSIM(off, always) so you can see EXACTLY what the compose cut costs
in pixels, plus a side-by-side PNG.  --ablate additionally sweeps threads / seam
/ compose so you can attribute a slow stitch to a factor.

Requires: build_stitch_probe.sh already run (./stitch_probe present); a device
on adb; venv with numpy + PIL.
"""
import argparse, json, os, platform, subprocess, sys, glob
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "stitch_probe")
NDK = os.environ.get("ANDROID_NDK", os.path.expanduser("~/Library/Android/sdk/ndk/27.1.12297006"))
_HOSTTAG = f"{platform.system().lower()}-x86_64"  # darwin-x86_64 / linux-x86_64
LIBCXX = f"{NDK}/toolchains/llvm/prebuilt/{_HOSTTAG}/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
ADB = os.environ.get("ADB", os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"))
DEV = "/data/local/tmp/stitchprobe"


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def adb(serial, *args):
    return sh([ADB, "-s", serial, *args])


def pick_serial(serial):
    if serial:
        return serial
    out = sh([ADB, "devices"]).stdout.splitlines()
    for line in out[1:]:
        p = line.split()
        if len(p) >= 2 and p[1] == "device":
            return p[0]
    sys.exit("no adb device; pass --serial")


# ---------- self-contained SSIM (PIL + numpy only) ----------
def _load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)


def _box(a, r):
    I = np.pad(a, ((1, 0), (1, 0)), "constant").cumsum(0).cumsum(1)
    k = 2 * r + 1
    S = I[k:, k:] - I[:-k, k:] - I[k:, :-k] + I[:-k, :-k]
    return S / (k * k)


def _ssim_gray(x, y, r=3, L=255.0):
    C1, C2 = (0.01 * L) ** 2, (0.03 * L) ** 2
    mx, my = _box(x, r), _box(y, r)
    vx = _box(x * x, r) - mx * mx
    vy = _box(y * y, r) - my * my
    vxy = _box(x * y, r) - mx * my
    s = ((2 * mx * my + C1) * (2 * vxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2))
    return float(s.mean())


def compare_images(a, b):
    A, B = _load(a), _load(b)
    note = "identical dims"
    if A.shape != B.shape:
        B = np.asarray(
            Image.fromarray(B.astype(np.uint8)).resize((A.shape[1], A.shape[0]), Image.BILINEAR),
            dtype=np.float64,
        )
        note = f"resized {b.split('/')[-1]} -> {A.shape[1]}x{A.shape[0]}"
    mse = float(((A - B) ** 2).mean())
    psnr = float("inf") if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)
    ssim = _ssim_gray(A.mean(2), B.mean(2))
    return dict(mse=round(mse, 2), psnr=round(psnr, 2), ssim=round(ssim, 5), note=note)


def side_by_side(a, b, out):
    A, B = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    h = max(A.height, B.height)
    A = A.resize((int(A.width * h / A.height), h))
    B = B.resize((int(B.width * h / B.height), h))
    canvas = Image.new("RGB", (A.width + B.width + 12, h), (20, 20, 20))
    canvas.paste(A, (0, 0))
    canvas.paste(B, (A.width + 12, 0))
    canvas.save(out)


# ---------- device probe run ----------
def push_setup(serial, kf_paths):
    adb(serial, "shell", f"rm -rf {DEV}; mkdir -p {DEV}/kf {DEV}/out")
    adb(serial, "push", PROBE, f"{DEV}/")
    adb(serial, "push", LIBCXX, f"{DEV}/")
    for f in kf_paths:
        adb(serial, "push", f, f"{DEV}/kf/")
    adb(serial, "shell", f"chmod +x {DEV}/stitch_probe")
    kf = adb(serial, "shell", f"ls {DEV}/kf/*.jpg").stdout.replace("\r", "").split()
    return kf


def run_probe(serial, out_name, kf_dev, compose, reg, rangew, threads, seam, warper, orient, mode):
    cmd = (
        f"cd {DEV} && LD_LIBRARY_PATH={DEV} ./stitch_probe out/{out_name} "
        f"{compose} {reg} {rangew} {threads} {seam} {warper} {orient} {mode} "
        + " ".join(kf_dev)
    )
    r = adb(serial, "shell", cmd)
    line = next((l for l in r.stdout.splitlines() if l.startswith("RESULT ")), None)
    if not line:
        return {"error": r.stdout[-400:] + r.stderr[-400:]}
    res = json.loads(line[len("RESULT "):])
    return res


def pull(serial, out_name, dest):
    adb(serial, "pull", f"{DEV}/out/{out_name}", dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack_dir")
    ap.add_argument("--serial", default=None)
    ap.add_argument("--floor", type=float, default=None, help="always-mode compose MP (default: pack floor or 0.6)")
    ap.add_argument("--ablate", action="store_true", help="also sweep threads/seam/compose for RCA")
    ap.add_argument("--out", default=None, help="report dir (default <pack_dir>/compare)")
    args = ap.parse_args()

    serial = pick_serial(args.serial)
    pack_dir = os.path.abspath(args.pack_dir)
    out_dir = args.out or os.path.join(pack_dir, "compare")
    os.makedirs(out_dir, exist_ok=True)

    pack_path = os.path.join(pack_dir, "pack.json")
    pack = json.load(open(pack_path)) if os.path.exists(pack_path) else {}
    cfg = pack.get("config", {})
    seam = cfg.get("seamFinder", "graphcut")
    warper = cfg.get("warper", "spherical")
    orient = cfg.get("captureOrientation") or pack.get("capture", {}).get("captureOrientation", "portrait")
    mode = cfg.get("stitchModeResolved", "panorama")
    rangew = int(cfg.get("rangeMatcherWidth", 3))
    threads = int(cfg.get("numThreads", 1))
    field_compose = float(cfg.get("compositingResolMP", -1.0)) or -1.0
    floor = args.floor if args.floor is not None else float(cfg.get("adaptiveMinOutputMP", 0.6))

    kf_paths = sorted(glob.glob(os.path.join(pack_dir, "keyframe-*.jpg")))
    if not kf_paths:
        sys.exit(f"no keyframe-*.jpg in {pack_dir}")

    print(f"device={serial}  pack={pack_dir}")
    if pack:
        d = pack.get("device", {})
        t = pack.get("timings", {})
        print(f"  field device: {d.get('manufacturer','?')} {d.get('model','?')}  cores={d.get('cores','?')}")
        print(f"  field pack  : keyframes={pack.get('capture',{}).get('keyframeCount','?')}  "
              f"longEdge={pack.get('capture',{}).get('firstKeyframeLongEdge','?')}  "
              f"stitchWallMs={t.get('stitchWallMs','?')}  queueDelayMs={t.get('queueDelayMs','?')}")
        print(f"  field recipe: mode={mode} warper={warper} seam={seam} range={rangew} "
              f"threads={threads} compose={field_compose} floor={floor}")
    print(f"  local kf     : {len(kf_paths)} frames")

    kf_dev = push_setup(serial, kf_paths)

    runs = [
        ("field", field_compose, seam, threads),
        ("off_1.0", 1.0, seam, threads),
        ("always_floor", floor, seam, threads),
    ]
    results = {}
    print("\n=== runs (this device) ===")
    for name, compose, sm, th in runs:
        res = run_probe(serial, f"{name}.jpg", kf_dev, compose, -1.0, rangew, th, sm, warper, orient, mode)
        results[name] = res
        if "error" in res:
            print(f"  {name:14s} ERROR: {res['error'][:200]}")
            continue
        pull(serial, f"{name}.jpg", os.path.join(out_dir, f"{name}.jpg"))
        print(f"  {name:14s} wallMs={res['wallMs']:<6} included={res['framesIncluded']}/{res['framesRequested']} "
              f"canvas={res['width']}x{res['height']} composeMP={res['composeMP']}")

    # A/B quality: off(1.0) vs always(floor)
    off_img = os.path.join(out_dir, "off_1.0.jpg")
    alw_img = os.path.join(out_dir, "always_floor.jpg")
    ab = None
    if os.path.exists(off_img) and os.path.exists(alw_img):
        ab = compare_images(off_img, alw_img)
        side_by_side(off_img, alw_img, os.path.join(out_dir, "off_vs_always.png"))
        print("\n=== A/B  off(1.0) vs always(floor) ===")
        print(f"  SSIM={ab['ssim']}  PSNR={ab['psnr']}dB  MSE={ab['mse']}  ({ab['note']})")
        o, a = results.get("off_1.0", {}), results.get("always_floor", {})
        if "wallMs" in o and "wallMs" in a:
            sp = 100 * (o["wallMs"] - a["wallMs"]) / o["wallMs"] if o["wallMs"] else 0
            print(f"  speed: off={o['wallMs']}ms  always={a['wallMs']}ms  ->  {sp:.1f}% faster")

    ablation = None
    if args.ablate:
        print("\n=== ablation (compose 1.0 unless noted; this device) ===")
        ablation = []
        sweeps = [
            ("threads=1", dict(threads=1)), ("threads=4", dict(threads=4)),
            ("seam=graphcut", dict(seam="graphcut")), ("seam=voronoi", dict(seam="voronoi")),
            ("seam=skip", dict(seam="skip")),
            ("compose=1.0", dict(compose=1.0)), ("compose=0.6", dict(compose=0.6)),
        ]
        for label, ov in sweeps:
            res = run_probe(
                serial, "abl.jpg", kf_dev,
                ov.get("compose", 1.0), -1.0, rangew, ov.get("threads", threads),
                ov.get("seam", seam), warper, orient, mode,
            )
            ms = res.get("wallMs", "ERR")
            ablation.append({"label": label, **{k: res.get(k) for k in ("wallMs", "width", "height")}})
            print(f"  {label:16s} wallMs={ms}")

    report = {
        "device": serial, "pack": pack.get("device"), "field_timings": pack.get("timings"),
        "field_keyframeCount": pack.get("capture", {}).get("keyframeCount"),
        "field_longEdge": pack.get("capture", {}).get("firstKeyframeLongEdge"),
        "recipe": {"mode": mode, "warper": warper, "seam": seam, "rangeWidth": rangew, "threads": threads},
        "runs": results, "ab_quality": ab, "ablation": ablation,
    }
    json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=2)
    print(f"\nreport: {os.path.join(out_dir, 'report.json')}")
    print(f"images: {out_dir}/  (off_1.0.jpg, always_floor.jpg, off_vs_always.png)")


if __name__ == "__main__":
    main()
