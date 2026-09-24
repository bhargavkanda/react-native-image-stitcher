// SPDX-License-Identifier: Apache-2.0
//
// tables.mjs — turn the two proofs' JSON lines into the results tables, and
// grade every replayed latch with the SHIPPED JS check itself.
//
//   node --experimental-strip-types tables.mjs <outDir>
//
// `panoPlusBasisImageCheck` and `PANO_PLUS_BASIS_CHECK` are IMPORTED from
// src/sweep/panoPlusModel.ts (Node >= 22.6 strips the types) — the verdict
// column is that function's output, not a re-implementation of it.  The
// `cosRaw` column is the same cosine computed WITHOUT the two not-measurable
// floors, printed only so the direction information the floors discard is
// visible; it is not a verdict.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = await import(path.join(here, '../../src/sweep/panoPlusModel.ts'));
const { panoPlusBasisImageCheck, PANO_PLUS_BASIS_CHECK } = model;

const outDir = process.argv[2] ?? path.join(here, 'out');
const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const vec = (v) => `[${f(v[0])}, ${f(v[1])}]`;
const cosRaw = (r, t) => {
  const a = Math.hypot(r[0], r[1]);
  const b = Math.hypot(t[0], t[1]);
  return a > 0 && b > 0 ? (r[0] * t[0] + r[1] * t[1]) / (a * b) : NaN;
};

const lines = [];
const out = (s = '') => lines.push(s);

// ── (1) derivation + selection ────────────────────────────────────────────
const derive = readJsonl(path.join(outDir, 'derive.jsonl')).find((d) => d.kind === 'deriveBasis');
if (derive) {
  out('## (1a) deriveBasis(sensorOrientationDeg=90, Back, RawSensorBuffer, mirrored=false)');
  out('');
  out('| ok | index | label | refusal | residualRotationCwDeg | C (row-major) | equals #8 | provenance |');
  out('|---|---|---|---|---|---|---|---|');
  out(`| ${derive.ok} | ${derive.index} | \`${derive.label}\` | ${derive.refusal} | ${derive.residualRotationCwDeg} | \`${JSON.stringify(derive.m)}\` | **${derive.equals8}** | ${derive.provenance} |`);
  out('');
}

const packList = fs.readFileSync(path.join(here, 'packs.txt'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('\t'));
const tagOf = (dir) => (packList.find(([, d]) => d === dir) ?? [dir.replace(/^.*\/Downloads\//, '')])[0];

const sel = readJsonl(path.join(outDir, 'select.jsonl'));
if (sel.length) {
  out('## (1b) selectBasis(imu = attitude_imu.jsonl, ref = track.jsonl ARKit, tau = 0) per pack');
  out('');
  out('| pack | imu n (Hz) | ref n | pairs | winner | residual rms deg | runner-up | runner-up rms deg | margin deg | unique | refusal | = #8 | stability ±10 ms | gradeBasis (persist gate) | ref excitation tilt/pan/roll deg (rank2) |');
  out('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of sel) {
    const tag = tagOf(d.pack);
    if (d.error) { out(`| ${tag} | error: ${d.error} |`); continue; }
    const s = d.selection;
    const w = s.ranked[0];
    const r = s.ranked[1];
    const e = d.excitationRef;
    out(`| ${tag} | ${d.imu.accepted} (${f(d.imu.hz, 0)}) | ${d.ref.accepted} | ${w.pairs} | #${w.index} \`${w.label}\` | ${f(w.rmsDeg, 3)} | #${r.index} \`${r.label}\` | ${f(r.rmsDeg, 3)} | ${f(s.marginDeg, 3)} | ${s.unique} | ${s.refusal} | **${s.winnerIs8 ? 'yes' : 'NO'}** | ${d.stability.reason} (#${d.stability.winnerIndex}, min margin ${f(d.stability.minMarginDeg, 2)}) | ${d.verdict.ok ? 'ok' : d.verdict.reason} | ${f(e.perAxisDeg_tilt_pan_roll[0])}/${f(e.perAxisDeg_tilt_pan_roll[1])}/${f(e.perAxisDeg_tilt_pan_roll[2])} (${f(e.rank2, 2)}) |`);
  }
  out('');
}

// ── (2) negative control ──────────────────────────────────────────────────
const rep = readJsonl(path.join(outDir, 'replay.jsonl'));
if (rep.length) {
  out('## (2) Wrong-basis negative control — replayed latch, graded by the shipped `panoPlusBasisImageCheck`');
  out('');
  out(`Thresholds in force (read from src/sweep/panoPlusModel.ts at run time): \`${JSON.stringify(PANO_PLUS_BASIS_CHECK)}\``);
  out('');
  out('| pack | arm | latch rotationPx | latch totalPx | abs rot / abs total | **verdict (shipped)** | cos (check) | cosRaw (no floors) | what-if minTotalPx=20 | latched / frames / relatch | rotTravel / resTravel px | rotationFraction | painted / held / rejected | output WxH | abort |');
  out('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of rep) {
    const c = panoPlusBasisImageCheck({ rotationPx: d.latch.rotationPx, totalPx: d.latch.totalPx });
    // WHAT-IF, computed BY THE SHIPPED FUNCTION: both floors are ratios of
    // |totalPx| (the rotation-share floor is scale-free, the cosine is
    // scale-free), so doubling both vectors is exactly minTotalPx / 2 with
    // every other threshold as shipped.  Not the shipped check — a calibration
    // probe for it.
    const w = panoPlusBasisImageCheck({
      rotationPx: d.latch.rotationPx.map((x) => 2 * x),
      totalPx: d.latch.totalPx.map((x) => 2 * x),
    });
    const armName = d.arm === 'ar' ? 'ARKit (as captured)'
      : d.arm === 'arq' ? 'ARKit q, vc row shape'
      : `IMU·C#${d.basisIndex} \`${d.basisLabel}\``;
    out(`| ${d.tag} | ${armName} | ${vec(d.latch.rotationPx)} | ${vec(d.latch.totalPx)} | ${f(c.rotationPx)} / ${f(c.totalPx)} | **${c.verdict}** | ${c.cos == null ? '—' : f(c.cos, 3)} | ${f(cosRaw(d.latch.rotationPx, d.latch.totalPx), 3)} | ${w.verdict} | ${d.latch.latched ? 'yes' : 'NO'} / ${d.latch.framesUsed} / ${d.latch.relatchCount} | ${f(d.regime.rotTravelPx, 0)} / ${f(d.regime.resTravelPx, 0)} | ${f(d.regime.rotationFraction, 2)} | ${d.painted} / ${d.held} / ${d.rejected} | ${d.outputW}x${d.outputH} | ${d.abortReason || (d.ok ? '' : d.error)} |`);
  }
  out('');
}

// ── the device's own latch, straight out of each pack's meta.json ─────────
const packs = packList;
if (packs.length) {
  out('## (2b) The DEVICE latch each pack recorded (ARKit arm, meta.json), same check');
  out('');
  out('| pack | latch rotationPx | latch totalPx | abs total | verdict | cosRaw |');
  out('|---|---|---|---|---|---|');
  for (const [tag, dir] of packs) {
    const mp = path.join(dir, 'panoplus', 'meta.json');
    if (!fs.existsSync(mp)) { out(`| ${tag} | (no meta.json) |`); continue; }
    const l = JSON.parse(fs.readFileSync(mp, 'utf8')).latch;
    const c = panoPlusBasisImageCheck(l);
    out(`| ${tag} | ${vec(l.rotationPx)} | ${vec(l.totalPx)} | ${f(c.totalPx)} | ${c.verdict} | ${f(cosRaw(l.rotationPx, l.totalPx), 3)} |`);
  }
  out('');
}

const text = lines.join('\n');
fs.writeFileSync(path.join(outDir, 'tables.md'), text + '\n');
process.stdout.write(text + '\n');
