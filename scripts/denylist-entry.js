#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * denylist-entry.js — turn a name into a hashed guard entry.
 *
 *   echo -n '<name>' | node scripts/denylist-entry.js --mode ci [--not-before '[A-Za-z]'] \
 *        [--after '[-._]'] [--not-after '[A-Za-z0-9_]'] --id n21
 *
 * Reads the plaintext from STDIN (never argv, so it stays out of shell
 * history and `ps`), prints one JSON object to paste into
 * src/__tests__/publicationNames.denylist.json.  The plaintext is never
 * written anywhere by this script.
 *
 *   --mode ci   case-insensitive substring
 *   --mode acr  exact lower / UPPER / Capitalised casing only (short acronyms,
 *               where a case-insensitive match hits base64 and camelCase)
 *   --mode cs   exact case
 *   --allow-line  hash a whole trimmed LINE for the allow list instead
 */
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const raw = input.replace(/\r?\n$/, '');
  if (!raw) throw new Error('empty input');
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  if (args.includes('--allow-line')) {
    console.log(JSON.stringify({ path: opt('--path'), lineSha256: sha(raw.trim()) }));
    return;
  }
  const mode = opt('--mode') || 'ci';
  const key = mode === 'cs' ? raw : raw.toLowerCase();
  let h = 0x811c9dc5;
  for (const ch of raw.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const e = { id: opt('--id') || 'nXX', len: raw.length, mode, fnv: h, sha256: sha(key) };
  for (const [flag, field] of [['--not-before', 'notBefore'], ['--after', 'after'], ['--not-after', 'notAfter']]) {
    if (opt(flag)) e[field] = opt(flag);
  }
  console.log(JSON.stringify(e));
});
