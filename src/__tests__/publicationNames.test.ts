// SPDX-License-Identifier: Apache-2.0
/**
 * publicationNames.test.ts — runs scripts/publication-names.js under `npm test`.
 *
 * The scanner lives in a plain script because it is 90x slower inside a jest
 * worker (measured 0.6 s in node, 55 s under jest's vm context) and because
 * CI runs the same script with --messages over the pushed commit range.  See
 * the script's header for what it scans and why the names are hashed.
 *
 * This file must stay name-free: the script scans it like any other file.
 * It is the one other place the canary's plaintext may appear.
 */
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'publication-names.js');

describe('publication names', () => {
  // The script exits 1 on a hit; read its JSON either way.
  let res: { ok: boolean; problems: string[]; hits: string[]; counts: Record<string, number> };
  beforeAll(() => {
    let out: string;
    try {
      out = execFileSync(process.execPath, [SCRIPT, '--json'], { cwd: ROOT, maxBuffer: 64 << 20 }).toString();
    } catch (e) {
      const err = e as { stdout?: Buffer; message: string };
      if (!err.stdout || !err.stdout.length) throw new Error(`scanner did not run: ${err.message}`);
      out = err.stdout.toString();
    }
    res = JSON.parse(out);
  }, 120_000);

  it('the scanner is armed (floors + canary)', () => {
    expect(res.problems).toEqual([]);
    expect(res.counts.entries).toBeGreaterThanOrEqual(20);
  });

  it('no tracked or published path or text carries a denylisted name', () => {
    expect(res.hits.slice(0, 40).join('\n')).toBe('');
  });
});
