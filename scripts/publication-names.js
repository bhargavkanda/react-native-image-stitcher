#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * publication-names.js — no private product, customer, brand or person name
 * in anything this repository tracks or publishes.
 *
 *   node scripts/publication-names.js            # human output, exit 1 on a hit
 *   node scripts/publication-names.js --json     # what the jest wrapper reads
 *   node scripts/publication-names.js --messages origin/main..HEAD
 *                                                # commit messages too (CI)
 *
 * WHAT IS SCANNED
 *   1. every TRACKED file (`git ls-files`): its PATH and its text
 *   2. every file `npm pack --dry-run` would publish: its PATH and its text
 *      (dist/ included once built — prepublishOnly builds before it tests)
 *   3. with --messages <range>: every commit message in the range
 *   Binary files (a NUL in the first 8 KiB) are skipped; nothing else is.  No
 *   root list, no extension list: the older guard walked five roots and never
 *   saw README, CHANGELOG, LICENSE, NOTICE, docs/, website/, tools/,
 *   example/, the pbxproj, or any file NAME.
 *
 * WHY THE NAMES ARE HASHED
 *   A guard that spells the names publishes them.  Each entry in
 *   publication-names.denylist.json is a SHA-256 of the needle plus a 32-bit
 *   FNV-1a prefilter; the scanner slides a window over the text and confirms
 *   candidates by SHA-256.  Add an entry with scripts/denylist-entry.js
 *   (plaintext on stdin only).  Hashing is obfuscation, not secrecy: a short
 *   dictionary word can be brute-forced from its hash.  What it buys is that
 *   no grep, code search or search engine finds the names in this repository.
 *
 * WHY IT RUNS OUT OF PROCESS
 *   Measured: the same loop takes 0.6 s in node and 55 s inside a jest
 *   worker's vm context.  The jest test only launches this file.
 *
 * WHY IT CANNOT PASS VACUOUSLY
 *   - floors on the entry count, the tracked-file count and the packed count;
 *   - a canary entry whose plaintext IS known must be found in a synthetic
 *     buffer, so a broken scanner, an emptied list or a bad hash turns RED;
 *   - `git` or `npm` failing is a failure, never a skip.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIST = path.join(__dirname, 'publication-names.denylist.json');
const SELF = [path.relative(ROOT, __filename), 'src/__tests__/publicationNames.test.ts'];
const MIN_ENTRIES = 20; // 27 at introduction.  Never lower a floor to make a failure go away.
const MIN_TRACKED = 500; // 646 at introduction
const MIN_PACKED = 200; // 296 at introduction, without dist/
const CANARY = 'zqxcanaryzqx'; // the one needle whose plaintext may appear (here only)

const spec = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const ENTRIES = spec.entries;
const ALLOW = new Set(spec.allow.map((a) => `${a.path}\0${a.lineSha256}`));
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const cls = (c) => (c ? new RegExp(`^${c}$`) : null);

const byKey = new Map(); // `${len}:${fnv}` -> entries
for (const e of ENTRIES) {
  const k = `${e.len}:${e.fnv}`;
  byKey.set(k, [...(byKey.get(k) || []), { ...e, nb: cls(e.notBefore), af: cls(e.after), na: cls(e.notAfter) }]);
}
const MAX_LEN = Math.max(...ENTRIES.map((e) => e.len));
const bloom = new Uint32Array((1 << 22) >>> 5);
const slot = (h, len) => Math.imul(h ^ len, 0x9e3779b1) >>> 10;
for (const e of ENTRIES) {
  const s = slot(e.fnv, e.len);
  bloom[s >>> 5] |= 1 << (s & 31);
}
// Lock files are pages of base64 integrity hashes; a 4-letter needle matches
// one by chance every few regenerations.  Only 8+ character needles apply.
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|Podfile\.lock|Gemfile\.lock)$/;

function casingOk(e, w) {
  if (e.mode !== 'acr') return true;
  const lo = w.toLowerCase();
  return w === lo || w === w.toUpperCase() || w === lo[0].toUpperCase() + lo.slice(1);
}

/** Every [id, offset] in `text`. */
function scan(text, minLen = 0) {
  const lower = text.toLowerCase();
  const n = lower.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let h = 0x811c9dc5;
    const lim = Math.min(MAX_LEN, n - i);
    for (let k = 0; k < lim; k++) {
      h = Math.imul(h ^ lower.charCodeAt(i + k), 16777619) >>> 0;
      const s = slot(h, k + 1);
      if ((bloom[s >>> 5] & (1 << (s & 31))) === 0 || k + 1 < minLen) continue;
      const cands = byKey.get(`${k + 1}:${h}`);
      if (!cands) continue;
      const raw = text.slice(i, i + k + 1);
      for (const e of cands) {
        if (sha(e.mode === 'cs' ? raw : raw.toLowerCase()) !== e.sha256 || !casingOk(e, raw)) continue;
        const before = i > 0 ? text[i - 1] : undefined;
        const next = text[i + k + 1];
        if (e.nb && before !== undefined && e.nb.test(before)) continue;
        if (e.af && (next === undefined || !e.af.test(next))) continue;
        if (e.na && next !== undefined && e.na.test(next)) continue;
        out.push([e.id, i]);
      }
    }
  }
  return out;
}

function lineHits(rel, text) {
  const found = [];
  const minLen = LOCKFILE.test(rel) ? 8 : 0;
  text.split('\n').forEach((line, n) => {
    const hits = scan(line, minLen).filter((h) => !(SELF.includes(rel) && h[0] === 'canary'));
    if (!hits.length || ALLOW.has(`${rel}\0${sha(line.trim())}`)) return;
    found.push(`${rel}:${n + 1} [${hits.map((h) => h[0]).join(',')}] ${line.trim().slice(0, 120)}`);
  });
  return found;
}

const memo = new Map();
function checkFile(rel) {
  if (memo.has(rel)) return memo.get(rel);
  const found = scan(rel).map(([id]) => `PATH ${rel} [${id}]`);
  const abs = path.join(ROOT, rel);
  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch {
    /* tracked but deleted in the working tree: nothing to publish */
  }
  if (st) {
    const buf = st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs);
    if (!buf.subarray(0, 8192).includes(0)) found.push(...lineHits(rel, buf.toString('utf8')));
  }
  memo.set(rel, found);
  return found;
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 256 << 20 }).toString('utf8');

function main() {
  const problems = [];
  if (ENTRIES.length < MIN_ENTRIES) problems.push(`denylist has ${ENTRIES.length} entries (< ${MIN_ENTRIES})`);
  if (!scan(`x ${CANARY} y`).some((h) => h[0] === 'canary')) problems.push('scanner does not find the canary');
  if (!scan(`x ${CANARY.toUpperCase()} y`).some((h) => h[0] === 'canary')) problems.push('scanner is case-sensitive for ci needles');

  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  if (tracked.length < MIN_TRACKED) problems.push(`only ${tracked.length} tracked files (< ${MIN_TRACKED})`);
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8'),
  )[0].files.map((f) => f.path);
  if (packed.length < MIN_PACKED) problems.push(`npm would pack only ${packed.length} files (< ${MIN_PACKED})`);

  const hits = [];
  for (const rel of new Set([...tracked, ...packed])) hits.push(...checkFile(rel));

  const mi = process.argv.indexOf('--messages');
  if (mi > 0) {
    const range = process.argv[mi + 1];
    const log = git('log', '--format=%H%x00%B%x01', range);
    for (const rec of log.split('\x01')) {
      const [h, body] = rec.replace(/^\n/, '').split('\0');
      if (!h || body === undefined) continue;
      for (const l of lineHits(`<commit ${h.slice(0, 9)}>`, body)) hits.push(l);
    }
  }

  const res = { ok: problems.length === 0 && hits.length === 0, problems, hits,
    counts: { entries: ENTRIES.length, tracked: tracked.length, packed: packed.length } };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(res));
  else {
    for (const p of problems) console.error(`SELF-CHECK: ${p}`);
    for (const h of hits.slice(0, 200)) console.error(h);
    console.error(res.ok ? `publication-names: clean (${JSON.stringify(res.counts)})` : `publication-names: ${hits.length} hit(s)`);
  }
  process.exitCode = res.ok ? 0 : 1;
}

main();
