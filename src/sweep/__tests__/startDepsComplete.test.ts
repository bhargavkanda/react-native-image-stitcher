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
    // ⚠ THIS ANCHORED ON '}: PanoPlusCaptureSurfaceProps', WHICH IS NEVER
    // FOUND AFTER `from` — the type name appears in the `forwardRef<>`
    // arguments ABOVE the function, not after its parameter list, which ends
    // `}, ref): React.JSX.Element {`. So the search returned -1 every time
    // and the extraction silently fell back to an ARBITRARY 4000-character
    // window: a guard reading a block whose end it had never located, which
    // is the same silent-degradation class it exists to catch.
    const to = src.indexOf('}, ref)', from);
    expect(to).toBeGreaterThan(from);
    const block = src.slice(from, to);
    // ⚠ THE FIRST VERSION OF THIS REGEX REQUIRED A TRAILING COMMA, A
    // SINGLE-LINE DEFAULT AND NO RENAME — and silently yielded NO MATCH for
    // three legal, type-clean shapes:
    //
    //   `liveTwinBudgetMs = 0`          the LAST entry, no trailing comma
    //   `poseSource: pose,`             a renamed destructure
    //   `box = { w: 1, h: 2 },`         a default containing a comma
    //
    // A prop it cannot see is a prop it cannot require, so the guard was
    // open on exactly the shapes a future edit is most likely to use. Proved
    // by adding a real prop in the last position and reading it inside
    // `start()` without declaring it: tsc clean, 1253 cases green, all three
    // of this file's own cases ticked.
    //
    // Now: split on commas at DEPTH ZERO so a default containing a comma
    // cannot end an entry, tolerate a missing trailing comma on the last
    // one, and take the LOCAL binding after a rename (that is the name the
    // body reads and the deps must list).
    const src2 = decomment(block);
    const entries: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of src2.slice(src2.indexOf('{') + 1)) {
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) {
        if (depth === 0) break;
        depth -= 1;
      }
      if (ch === ',' && depth === 0) { entries.push(cur); cur = ''; continue; }
      cur += ch;
    }
    entries.push(cur);
    const out: string[] = [];
    for (const raw of entries) {
      const head = raw.split('=')[0].trim();
      // `a: b` binds the LOCAL name `b`; a bare `a` binds `a`.
      const name = head.includes(':')
        ? head.slice(head.lastIndexOf(':') + 1).trim()
        : head;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
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
    // ⚠ PER-SHAPE, NOT JUST AN AGGREGATE. A count and one known name are
    // both satisfied while a whole SHAPE of entry is being dropped, which
    // is how the old regex passed its own self-check while blind to three
    // of them. These are the shapes actually present in the component.
    expect(props).toContain('hostChromeTopPt');   // has a default
    expect(props).toContain('onComplete');        // no default
    expect(props).toContain('engineOptions');     // no default, mid-list
    // …and the LAST entry, whatever it is, must have been seen: the
    // component's destructuring ends with one, and a regex requiring a
    // trailing comma silently loses it.
    expect(props[props.length - 1]).toMatch(/^[A-Za-z_$][\w$]*$/);
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
