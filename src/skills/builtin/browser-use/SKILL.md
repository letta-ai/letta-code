---
name: browser-use
description: Control a real browser — navigate, click, type, fill forms, take screenshots, record video. Use when the user asks to automate a browser, test or debug a web page, extract content from a site, or record a browser demo.
---

# Browser Use with CDP

Drive the browser through its native Chrome DevTools Protocol over the
remote-debugging WebSocket. This works with zero dependencies: launch the
browser with `--remote-debugging-port`, then talk JSON over `fetch` and the
built-in `WebSocket` global (available in Bun and Node ≥ 22 — no `ws` package).

If the project already has Playwright or Puppeteer installed, using it is
usually simpler — reach for raw CDP when no automation library is available,
when protocol-level control is needed, or when recording a deterministic
visual demo.

Protocol reference: https://chromedevtools.github.io/devtools-protocol/.
The running browser's exact schema is at `http://127.0.0.1:<port>/json/protocol`;
tip-of-tree docs can differ from the installed version.

## Workflow

1. Find a Chromium-based browser (below). If none exists, see "No Chrome installed".
2. Launch it with a dedicated profile and remote debugging. Never attach to the
   user's normal profile unless explicitly asked.
3. Discover targets via `/json/list`; pick the `"page"` target by URL or title.
4. Connect to its `webSocketDebuggerUrl` and enable only the domains you need
   (usually `Page`, `Runtime`, `DOM`, `Input`; add `Network`, `Log` when debugging).
5. Inspect before acting: find elements by accessible name, label, text, role,
   stable ID, or placeholder — not generated classes or child indexes.
6. Act through `Input.*` for user-like interactions; use `Runtime.evaluate` for
   inspection, coordinate math, and setup with no meaningful user interaction.
7. Wait on observable state, never fixed sleeps alone.
8. Verify the result (DOM state, URL, screenshot, console/network events).
9. Clean up: stop screencasts, close the WebSocket, kill the browser you launched.

## Finding the browser

Any Chromium-based browser supports CDP (Chrome, Chromium, Edge, Brave). Probe
in order:

```bash
# macOS
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  [ -x "$c" ] && { echo "$c"; break; }
done

# Linux
for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  command -v "$c" && break
done
```

On Windows, check `%ProgramFiles%\Google\Chrome\Application\chrome.exe`,
`%ProgramFiles(x86)%\...`, `%LocalAppData%\Google\Chrome\Application\chrome.exe`,
and the same patterns for `Microsoft\Edge`.

### No Chrome installed

Any browser found by the probe above works identically — use it. If truly no
Chromium-based browser exists, download a standalone copy with
`@puppeteer/browsers` (no system install, no admin rights; the binary lands in
a deletable cache directory). Pick by whether the user needs to watch:

- **Task runs invisibly** (scraping, testing, screenshots, PDFs — nothing the
  user watches live): download the smaller headless-only binary and launch it
  directly (it has no window mode):
  ```bash
  bunx @puppeteer/browsers install chrome-headless-shell@stable --path "$HOME/.cache/letta-browsers"
  ```
- **The user needs to see the browser** (live demos, "show me", debugging
  together, recording where headful rendering matters): download full Chrome
  and launch it headful:
  ```bash
  bunx @puppeteer/browsers install chrome@stable --path "$HOME/.cache/letta-browsers"
  ```

Both print the executable path; launch it exactly like Chrome. Tell the user
you're downloading (~150–200 MB, needs network) — don't hide it. Reuse the
cache directory on later runs instead of re-downloading.

If the download fails on a minimal Linux system with missing shared libraries
(`libnss3`, `libatk`, …), a distro package brings its dependencies:
`sudo apt install chromium`. If no download or install is possible, say
browser automation is unavailable and fall back to non-browser approaches
where the task allows (e.g. `curl`/`fetch` for plain HTTP content). Do not
fake browser results.

## Launching

Use a disposable profile and a fixed port:

```bash
"$CHROME" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-profile \
  --window-size=1440,900 \
  --force-device-scale-factor=1 \
  --no-first-run \
  --no-default-browser-check \
  https://example.com
```

Add `--headless=new` when no visible window is needed (or no display exists).
With `--remote-debugging-port=0`, read the chosen port from
`<user-data-dir>/DevToolsActivePort`. Launch in the background and poll
`http://127.0.0.1:9222/json/version` until it responds.

HTTP endpoints: `/json/version` (browser metadata + browser-level WebSocket URL),
`/json/list` (targets), `PUT /json/new?<url>` (open tab),
`/json/activate/<id>`, `/json/close/<id>`, `/json/protocol` (schema).

Attach to the **page** target for `Page`/`DOM`/`Runtime`/`Input` work; use the
**browser** target only for browser-wide commands (target control, downloads,
browser contexts).

## Minimal CDP client

CDP messages are JSON with monotonically increasing request ids. Run with `bun`:

```ts
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find((t: any) => t.type === "page");
if (!target) throw new Error("No page target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (!msg.id) return handleEvent(msg); // Page.loadEventFired, Log.entryAdded, ...
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
};
ws.onclose = () => {
  for (const p of pending.values()) p.reject(new Error("socket closed"));
  pending.clear();
};

function send(method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Runtime.enable");
```

Navigations destroy execution contexts and can invalidate in-flight
`Runtime.evaluate` calls; retry after observing the new document.

## Inspecting the page

Start with a concise UI inventory:

```ts
const result = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    buttons: [...document.querySelectorAll('button')].map((el) => ({
      text: el.innerText.trim(), aria: el.getAttribute('aria-label'), title: el.title
    })).filter((x) => x.text || x.aria || x.title),
    inputs: [...document.querySelectorAll('input, textarea, [contenteditable=true]')].map((el) => ({
      tag: el.tagName, type: el.type, placeholder: el.placeholder,
      aria: el.getAttribute('aria-label'), value: el.value
    }))
  })`,
  returnByValue: true,
});
```

Use `awaitPromise: true` for async expressions and `userGesture: true` when the
page requires user activation. Treat `exceptionDetails` in the result as an
error even though the CDP command itself succeeded.

`document.querySelector` does not cross shadow boundaries — traverse open
shadow roots explicitly; for closed shadow roots or remote-object work use the
`DOM` domain (`DOM.getDocument`, `DOM.querySelector`, `DOM.getBoxModel`).

## Clicking and typing

Compute coordinates in CSS pixels immediately before acting, then send native
input events:

```ts
async function point(expr: string) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const el = ${expr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`,
    returnByValue: true,
  });
  if (!r.result.value) throw new Error(`Element not found: ${expr}`);
  return r.result.value;
}

async function click(expr: string) {
  const { x, y } = await point(expr);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
```

Focus an editable element (click it), then insert text:

```ts
await click(`document.querySelector('input[aria-label="Search"]')`);
await send("Input.insertText", { text: "search terms" });
```

Use `Input.insertText` for text and Unicode; use paired `Input.dispatchKeyEvent`
(`keyDown` + `keyUp` with `key`, `code`, `windowsVirtualKeyCode`) for Enter,
Escape, arrows, Tab, and shortcuts. Modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.

Native `<select>` and framework-controlled inputs may need the prototype setter
plus bubbling events:

```ts
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
setter.call(input, "new value");
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new Event("change", { bubbles: true }));
```

Prefer real `Input.*` events for the behavior being demonstrated or tested;
direct DOM mutation is fine for deterministic setup and inspection.

## Waiting reliably

A returned command does not mean the action completed. Poll the state that
proves completion:

```ts
async function waitFor(expr: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await send("Runtime.evaluate", { expression: `Boolean(${expr})`, returnByValue: true });
    if (r.result.value) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`Timed out waiting for ${expr}`);
}

await waitFor(`document.body.innerText.includes('Saved')`);
```

For navigation, wait on `Page.loadEventFired` or a lifecycle `networkIdle`
event — but SPA route changes may emit neither, so prefer the UI condition
that actually matters.

## Screenshots, PDF, and video

```ts
const shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write("screenshot.png", Buffer.from(shot.data, "base64"));
```

`captureBeyondViewport: true` for full-page; `Page.getLayoutMetrics` + `clip`
for exact regions; `Page.printToPDF` for PDFs. For video recording with
`Page.startScreencast` and demo-polish tips, read
[references/recording.md](references/recording.md).

## Debugging failures

Enable `Network` and `Log`, then watch `Network.requestWillBeSent`,
`Network.responseReceived`, `Network.loadingFailed`, `Runtime.consoleAPICalled`,
`Runtime.exceptionThrown`, and `Log.entryAdded`. Fetch bodies with
`Network.getResponseBody`. Never log authorization headers, cookies, API keys,
passwords, or response bodies containing secrets — scrub before returning
output to context.

Common failure modes:

- **ECONNREFUSED on the port**: browser exited, wrong port, or debugging not
  enabled — check `/json/version` first.
- **No matching target**: inspect `/json/list`; match by URL/title, don't take
  the first page blindly.
- **Execution context destroyed**: the page navigated; wait for the new
  document and re-evaluate.
- **Click misses an existing element**: scroll into view and recalculate the
  box immediately before dispatching.
- **Typed text doesn't stick in a controlled input**: focus + `Input.insertText`,
  or the prototype-setter pattern above.
- **Opening DevTools disconnects automation**: embedded DevTools can detach
  other clients — don't open DevTools during a run.
- **Page commands fail on the browser endpoint**: attach to the page target.

## Safety

Browser automation acts with the user's browser authority.

- Use a disposable profile by default.
- Do not submit purchases, publish content, send messages, delete data, or
  accept consequential dialogs without explicit authorization.
- Do not extract saved passwords, tokens, cookies, or unrelated browsing data.
- Stay within the requested origin and workflow.
- Keep the remote-debugging listener on loopback (`127.0.0.1`) unless the user
  explicitly needs remote access and has authentication in place.
