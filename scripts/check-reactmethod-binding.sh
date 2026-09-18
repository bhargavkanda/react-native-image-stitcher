#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# check-reactmethod-binding.sh — every @ReactMethod must still be touching the
# function it was written for.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────
# Kotlin binds an annotation to the NEXT DECLARATION, whatever that turns out
# to be. Insert a helper class or a property between `@ReactMethod` and its
# `fun` and the annotation silently moves onto the helper: the method stops
# being exported to the React Native bridge, and the only symptom is
# `undefined is not a function` at the JS call site, at runtime, on a device.
#
# That is exactly what happened to `IncrementalStitcher.start` — the
# engine-refusal code was inserted between the annotation and the function,
# `start` left the bridge, and every panorama on Android failed with
# PANORAMA_START_FAILED. Nothing caught it:
#
#   - kotlinc did not error;
#   - the JUnit suite passed, because it calls the Kotlin method DIRECTLY and
#     never goes through the bridge that does the exporting;
#   - `nm`/dex greps found the symbol, because the method still exists — it is
#     only its EXPORT that vanished;
#   - the JS availability probe passed, because the module object is still
#     there. Only the one method is missing.
#
# So the check has to be structural and it has to be here.
#
# ⚠ IT MUST NOT BE ABLE TO PASS VACUOUSLY. A scan that finds no files, or no
# annotations, reports zero violations and exits 0 — a green run that checked
# nothing. The floor below makes that a failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# Raise this when modules are added; never lower it to make a run go green.
MIN_ANNOTATIONS="${MIN_REACTMETHOD_ANNOTATIONS:-70}"

python3 - "$MIN_ANNOTATIONS" <<'PY'
import re, sys, pathlib

MIN = int(sys.argv[1])
ROOT = pathlib.Path('android/src')
if not ROOT.is_dir():
    print(f"  ✗ SELF-CHECK: {ROOT} does not exist — this script cannot check anything")
    raise SystemExit(2)

DECL = re.compile(r'^(public |internal |private |protected |open |override |suspend )*fun\b')
bad, total, files = [], 0, 0

for p in sorted(ROOT.rglob('*.kt')):
    files += 1
    L = p.read_text(encoding='utf-8').splitlines()
    for i, line in enumerate(L):
        if not line.strip().startswith('@ReactMethod'):
            continue
        total += 1
        # Walk forward to the next real declaration, skipping blank lines,
        # line comments, block/KDoc comments and further annotations.
        j, indoc = i + 1, False
        while j < len(L):
            s = L[j].strip()
            if indoc:
                if '*/' in s:
                    indoc = False
                j += 1; continue
            if s.startswith('/*'):
                if '*/' not in s:
                    indoc = True
                j += 1; continue
            if s == '' or s.startswith('//') or s.startswith('@'):
                j += 1; continue
            break
        decl = L[j].strip() if j < len(L) else '<end of file>'
        if not DECL.match(decl):
            bad.append((p, i + 1, j + 1, decl[:78]))

if files == 0:
    print("  ✗ SELF-CHECK: no .kt files found under android/src — nothing was checked")
    raise SystemExit(2)
if total < MIN:
    print(f"  ✗ SELF-CHECK: found {total} @ReactMethod annotations across {files} files,")
    print(f"    expected at least {MIN}. Annotations went missing silently — find out")
    print(f"    which before touching the floor.")
    raise SystemExit(2)

for p, aline, dline, decl in bad:
    print(f"  ✗ {p}:{aline}: @ReactMethod binds to a non-function at line {dline}:")
    print(f"      {decl}")
    print(f"    Kotlin attaches an annotation to the next declaration. Move the")
    print(f"    @ReactMethod down so it touches its `fun`, or delete it.")

print(f"checked {total} @ReactMethod annotations in {files} Kotlin files")
if bad:
    print(f"REACTMETHOD BINDING VIOLATED ({len(bad)})")
    raise SystemExit(1)
print("reactmethod binding OK")
PY
