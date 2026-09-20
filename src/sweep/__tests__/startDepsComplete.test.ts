// SPDX-License-Identifier: Apache-2.0
/**
 * `start()`'s dependency list is COMPLETE — checked against the source.
 *
 * ── WHY A SOURCE-LEVEL TEST AND NOT A BEHAVIOURAL ONE ───────────────────
 *
 * This list has now been short FOUR times, and every round is recorded in a
 * comment beside it:
 *
 *   2026-08-31  `lockCamera`, `meteringSettleMs`
 *   P5 review   `lens`, `jogGuard`
 *   S7          `frameSource`, `vcPluginArm`, `vcCameraId`
 *   2026-09-19  `attitudeMagFree`, `arPluginArm`, `hostChromeTopPt` (+ `arArmed`)
 *
 * The failure is always the same and is invisible to every other kind of
 * test: a prop resolves asynchronously AFTER the callback was last built —
 * the plugin handle lands, the AR view mounts, the host lays out — and a
 * sweep started from the stale closure sends the PREVIOUS frame's value,
 * while the pack records it as though it had been chosen. Nothing throws,
 * nothing renders wrong, and the A/B looks like it produced two identical
 * arms.
 *
 * `react-hooks/exhaustive-deps` is the tool for this, and it has never run
 * here: the package has no eslint config and neither eslint nor the plugin is
 * installed. Rather than add a toolchain in a bug fix, this asserts the same
 * property directly, for the one callback that has actually gone wrong, with
 * no new dependency. It is the same idiom as the `@ReactMethod` binding guard
 * in CI: a structural fact the type checker cannot see, asserted by reading
 * the source.
 *
 * SCOPE, stated so it is not mistaken for more than it is: it checks the
 * component's PROPS. Every one of the misses above was a prop. Derived state
 * read by `start` (`arArmed`) is not enumerable this way and is not covered.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'PanoPlusCaptureSurface.tsx');

/** Strip comments so a prop NAMED in prose does not read as a use. */
function decomment(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe("PanoPlusCaptureSurface start()'s deps", () => {
  const src = readFileSync(SRC, 'utf8');

  /** The component's destructured props, in declaration order. */
  const props: string[] = (() => {
    const from = src.indexOf('function PanoPlusCaptureSurface({');
    expect(from).toBeGreaterThan(-1);
    const to = src.indexOf('}: PanoPlusCaptureSurfaceProps', from);
    const block = to > -1 ? src.slice(from, to) : src.slice(from, from + 4000);
    const out: string[] = [];
    for (const line of decomment(block).split('\n')) {
      const m = /^ {2}([A-Za-z_$][\w$]*)\s*(?:=[^,]*)?,\s*$/.exec(line);
      if (m != null) out.push(m[1]);
    }
    return out;
  })();

  /** `start`'s body and its declared deps. */
  const { body, deps } = (() => {
    const from = src.indexOf('const start = useCallback(() => {');
    expect(from).toBeGreaterThan(-1);
    const close = src.indexOf('\n  }, [', from);
    expect(close).toBeGreaterThan(from);
    const end = src.indexOf('\n  ]);', close);
    expect(end).toBeGreaterThan(close);
    return {
      body: decomment(src.slice(from, close)),
      deps: decomment(src.slice(close, end))
        .split(/[,\n]/)
        .map((t) => t.trim().replace(/\?\.$/, ''))
        .filter((t) => /^[A-Za-z_$][\w$.]*$/.test(t))
        .map((t) => t.split('.')[0]),
    };
  })();

  it('⚑ the extraction found a real component and a real callback', () => {
    // Guard against the whole file passing because a regex stopped matching
    // — the way a source-reading test dies silently.
    expect(props.length).toBeGreaterThan(20);
    expect(props).toContain('lockCamera');
    expect(body.length).toBeGreaterThan(2000);
    expect(deps.length).toBeGreaterThan(15);
  });

  it('⚑ every PROP that start() reads is declared as a dependency', () => {
    const declared = new Set(deps);
    const missing = props.filter((p) => {
      if (declared.has(p)) return false;
      return new RegExp(`(^|[^\\w$.])${p}([^\\w$]|$)`).test(body);
    });
    expect(missing).toEqual([]);
  });

  it('⚑ NEGATIVE CONTROL: the check can actually fail', () => {
    // Without this, a broken extraction (empty `props`, or a `body` that
    // matched nothing) passes the case above for free — which is exactly how
    // a source-reading test rots into a no-op.
    const declared = new Set(deps.filter((d) => d !== 'lockCamera'));
    const missing = props.filter((p) => (
      !declared.has(p)
      && new RegExp(`(^|[^\\w$.])${p}([^\\w$]|$)`).test(body)
    ));
    expect(missing).toContain('lockCamera');
  });
});
