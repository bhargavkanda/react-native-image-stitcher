#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Stream the app's JS console from a device, to a terminal.
//
// ⚠ WHY THIS EXISTS. On RN 0.84 `console.log` NO LONGER REACHES logcat —
// Metro says so on startup ("JavaScript logs have moved! They can now be
// viewed in React Native DevTools"). So `adb logcat -s ReactNativeJS` prints
// nothing, and every instruction to watch it is wrong. The logs are on the
// CDP channel Metro proxies, which is what this reads.
//
//   node scripts/tail-js-console.mjs            # every attached device
//   node scripts/tail-js-console.mjs iPhone     # substring-match one
//
// Filters to the lines a device session cares about by default; pass --all
// for everything.
const PORT = process.env.RN_METRO_PORT ?? '8082';
const want = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
const all = process.argv.includes('--all');
const KEEP = /\[example\]|\[pano\+\]|\[panMotion\]|\[rnimagestitcher\]|warning|abandon/i;

const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const targets = list.filter(t => t.webSocketDebuggerUrl
  && (!want || (t.title ?? '').toLowerCase().includes(want.toLowerCase())));
if (targets.length === 0) {
  console.error(`no debugger target on :${PORT}`
    + (want ? ` matching "${want}"` : '')
    + ' — is the app running and attached to Metro?');
  process.exit(1);
}
for (const t of targets) {
  const tag = (t.title ?? 'app').replace(/\s+/g, ' ').slice(0, 28);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  ws.onopen = () => {
    for (const m of ['Runtime.enable', 'Log.enable', 'Console.enable']) {
      ws.send(JSON.stringify({ id: ++id, method: m, params: {} }));
    }
    console.error(`── attached: ${tag}`);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log(`[${tag}] !! ${d.text} ${d.exception?.description ?? ''}`);
      return;
    }
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const txt = (m.params.args ?? [])
      .map(a => a.value ?? a.description ?? a.preview?.description ?? a.type)
      .join(' ');
    if (!all && !KEEP.test(txt)) return;
    console.log(`[${tag}] ${txt}`);
  };
  ws.onclose = () => console.error(`── detached: ${tag}`);
}
