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

// M7 — the engine (and `start`) moved out of the surface into the hook; the
// guard is re-anchored on the hook's own props destructuring.
const SRC = join(__dirname, '..', 'useSweepEngine.ts');

/** Strip comments so a prop NAMED in prose does not read as a use. */
function decomment(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe("useSweepEngine start()'s deps", () => {
  const src = readFileSync(SRC, 'utf8');

  /** The component's destructured props, in declaration order. */
  const props: string[] = (() => {
    const from = src.indexOf('export function useSweepEngine(');
    expect(from).toBeGreaterThan(-1);
    // ⚠ THIS ANCHORED ON '}: PanoPlusCaptureSurfaceProps', WHICH IS NEVER
    // FOUND AFTER `from` — the type name appears in the `forwardRef<>`
    // arguments ABOVE the function, not after its parameter list, which ends
    // `}, ref): React.JSX.Element {`. So the search returned -1 every time
    // and the extraction silently fell back to an ARBITRARY 4000-character
    // window: a guard reading a block whose end it had never located, which
    // is the same silent-degradation class it exists to catch.
    // ⚠ AND THE ANCHOR IS SEARCHED IN THE DECOMMENTED SOURCE. The previous
    // version searched the RAW text and applied `decomment` only to the
    // already-sliced block — so a COMMENT containing the literal `}, ref)`
    // anywhere before the real parameter-list close truncates the props
    // list, and every prop after it becomes invisible to the guard. In a
    // file whose comments routinely quote code, that is not a remote shape.
    // M7: the props are destructured from `props` at the top of the hook —
    // `const { … } = props;` — rather than in a parameter list.
    const clean = decomment(src);
    const hookFrom = clean.indexOf('export function useSweepEngine(');
    expect(hookFrom).toBeGreaterThan(-1);
    const cleanFrom = clean.indexOf('const {', hookFrom);
    expect(cleanFrom).toBeGreaterThan(hookFrom);
    const to = clean.indexOf('} = props;', cleanFrom);
    expect(to).toBeGreaterThan(cleanFrom);
    const block = clean.slice(cleanFrom, to + 1);
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
      if (head === '') continue;
      // ⚠ A REST ELEMENT IS A HARD FAILURE, NOT A SKIP. `...rest` binds
      // every prop added after it, so a guard that silently drops it is
      // blind to all of them from then on — permanently, and worse the
      // longer it survives. There is no way to enumerate what it captures
      // from the source, so the guard refuses to pretend it can.
      if (head.startsWith('...')) {
        throw new Error(
          'the props destructuring uses a REST element (' + head + '). This '
          + 'guard cannot see what it binds, so every prop arriving through '
          + 'it would be unchecked. Destructure the props explicitly, or '
          + 'teach this guard to resolve the rest element.',
        );
      }
      // ⚠ A NESTED DESTRUCTURE BINDS THE INNER NAMES, NOT THE OUTER ONE.
      // `probeNest: { inner: probeInner } = {}` binds `probeInner`, and
      // taking the text after the last `:` gave `{ inner: probeInner }`,
      // which fails the identifier test and was dropped — so the prop was
      // invisible. Recurse into the braces and take every local binding.
      const names: string[] = [];
      const collect = (h: string): void => {
        const t = h.trim();
        const open = t.indexOf('{');
        if (open === -1) {
          const n = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1).trim() : t;
          if (/^[A-Za-z_$][\w$]*$/.test(n)) names.push(n);
          return;
        }
        const close = t.lastIndexOf('}');
        const innerSrc = close > open ? t.slice(open + 1, close) : '';
        let d = 0;
        let cur = '';
        for (const ch of innerSrc) {
          if ('([{'.includes(ch)) d += 1;
          else if (')]}'.includes(ch)) d -= 1;
          if (ch === ',' && d === 0) { collect(cur.split('=')[0]); cur = ''; continue; }
          cur += ch;
        }
        collect(cur.split('=')[0]);
      };
      collect(head);
      out.push(...names);
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

  // ⚠ M7 REVIEW: `props.x` IS INVISIBLE TO THE CHECK ABOVE. Since M7 the
  // hook takes `props` whole and destructures it, so `props` is in scope in
  // start(). A read spelled `props.hostChromeTopPt` compiles, skips the name
  // matcher (a name after '.' is deliberately not a read of that prop), and
  // would send the value from whichever render start() was last built in.
  it('⚑ start() never reads the whole-props binding (unless it depends on it)', () => {
    // The binding this checks IS the hook's first parameter.
    expect(src).toMatch(/export function useSweepEngine\(\s*props:/);
    const readsProps = (b: string) => /(^|[^\w$.])props\s*(\?\.|[.[])/.test(b);
    if (!deps.includes('props')) expect(readsProps(body)).toBe(false);
    // NEGATIVE CONTROL — the same body with one read respelled fails.
    expect(body).toContain('hostChromeTopPt');
    expect(readsProps(body.replace('hostChromeTopPt', 'props.hostChromeTopPt'))).toBe(true);
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
