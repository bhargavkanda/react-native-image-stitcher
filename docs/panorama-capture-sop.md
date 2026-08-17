# Panorama capture — standard operating procedure (field users)

*Applies to app builds on library v0.24.5 or later. One page: how to take a
shelf panorama that stitches cleanly, what the screen is telling you, and what
to do when you see a message.*

---

## Before you start

1. **Clean the camera lens** — a smudged lens blurs every frame.
2. **Use the 1x lens** (not 0.5x ultra-wide). The ultra-wide amplifies
   alignment errors and frequently fails to stitch.
3. **Check the light.** Avoid strong glare on the shelf; stand so your shadow
   isn't on the products.
4. **Stand back.** Position yourself so the full shelf height fits in frame
   with a little margin — usually 1–1.5 m from the shelf. More distance =
   easier stitching.

## Taking the capture

1. **Frame the left edge** of the shelf section (or the top, for a vertical
   sweep).
2. **Press and hold the shutter.** A **green border** and a **REC pill**
   appear — you're recording.
3. **Pan slowly and smoothly in ONE direction.** Prefer **pivoting your
   body/wrists** over side-stepping along the aisle — turning stitches better
   than walking.
4. **Watch the counter** (e.g. `5 / 8`) — each tick is a captured frame, and
   the thumbnail strip fills as you go. The capture **finishes on its own**
   when the counter is full; you can also release the shutter early to finish.
5. **Hold the phone still for a beat** at the end. The screen goes dark and
   shows **"Stitching panorama…"** for a few seconds — this is normal. The
   result appears when it's done.

### While recording — respond to the guidance

| What you see | What it means | What to do |
|---|---|---|
| "Hold steady — pan slowly" (green) | All good | Keep going at the same pace |
| **Red border** + "Moving too fast — slow down" | Pan speed too high — frames will blur or lose overlap | Slow down until the border turns green again |
| "Keep the pan straight" popup | You drifted sideways off the sweep line — capture was stopped | Note the partial result; recapture with a straighter sweep |
| Capture stops after you tilt/turn the device | **Rotating the phone mid-capture cancels on purpose** — a capture can't mix portrait and landscape | Keep the phone in ONE orientation for the whole sweep; recapture |

## If you get a message instead of a panorama

The message tells you what to change — captures are free, so just go again:

| Message | Why it happened | What to do |
|---|---|---|
| "Please pan more slowly — not enough overlap" | Frames didn't overlap enough to chain together | Slower sweep; stand further back |
| "Please pan more slowly — the phone moved through space" | Too much sideways/walking movement for the stitcher | Pivot instead of stepping; use 1x; capture the shelf in shorter sections |
| "That didn't come out right" | The frames stitched but not into one coherent image | One smooth pass, single direction, no back-tracking |
| "Try a shorter sweep" | The panorama was too large for the device's memory | Split the shelf into 2–3 shorter captures |
| Any other error | Something unexpected | Retry once; if it repeats, report it (see below) |

## Long shelves

Capture in **overlapping sections**: end each section roughly one bay past
where the next one will start, so every product appears fully in at least one
capture. Two or three good sections beat one over-long sweep — long sweeps are
the main cause of memory errors and drift.

## If the app closes by itself

That's a crash, not your mistake — please report it:

1. Note the **time**, the **store/shelf**, and what you were doing (usually:
   right after the capture, during "Stitching panorama…").
2. On iPhone/iPad, the log we need is in **Settings → Privacy & Security →
   Analytics & Improvements → Analytics Data** — look for a file starting with
   `JetsamEvent-` or the app's name with that day's date, and share it.
3. Meanwhile, recapture using **shorter sweeps** — that usually avoids it.

---

*Questions or repeated failures: report with the app version (Settings/About
in the app) and the device model. The capture team can enable a diagnostic
"debug pack" mode on your build that saves the exact frames of a failing
capture for analysis.*
