# Raw Chrome DevTools Protocol fallback

Use this fallback only for Chrome, Chromium, Edge, or Brave when no suitable
browser controller or installed automation library is available.

## Launch a controlled browser

Find an installed Chromium-family browser. Common locations:

```bash
# macOS
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  [ -x "$c" ] && { printf '%s\n' "$c"; break; }
done

# Linux
for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  command -v "$c" && break
done
```

On Windows, check `%ProgramFiles%`, `%ProgramFiles(x86)%`, and `%LocalAppData%`
under `Google\Chrome\Application`, `Microsoft\Edge\Application`, and the
equivalent Brave path.

Launch a separate profile and keep the endpoint on loopback:

```bash
"$BROWSER" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/letta-browser-profile \
  --window-size=1440,900 \
  --force-device-scale-factor=1 \
  --no-first-run \
  --no-default-browser-check \
  https://example.com
```

Add `--headless=new` only when the task should run invisibly. When using
`--remote-debugging-port=0`, read the selected port from
`<profile>/DevToolsActivePort`. Poll `/json/version` until it responds.

Useful endpoints:

- `/json/version`: browser metadata and browser-level WebSocket URL
- `/json/list`: page and worker targets
- `PUT /json/new?<url>`: open a tab
- `/json/activate/<id>` and `/json/close/<id>`: target lifecycle
- `/json/protocol`: the exact protocol schema supported by the running browser

Attach to a **page** target for `Page`, `DOM`, `Runtime`, and `Input`. Use the
browser target only for browser-wide operations.

## Minimal client

Node 22 and Bun provide a global `WebSocket`, so a small CDP client needs no
extra package:

```ts
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find(
  (candidate: { type: string; url: string }) =>
    candidate.type === "page" && candidate.url.startsWith("https://example.com"),
);
if (!target) throw new Error("No matching page target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("CDP socket failed to open"));
});

let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return handleEvent(message);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};

function send(method: string, params: object = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Runtime.enable");
```

Reject all pending requests when the socket closes. Navigations destroy
execution contexts, so wait for the new document before retrying evaluation.

## Inspect and interact

Use `Runtime.evaluate` to build a concise inventory of buttons, links, inputs,
labels, and accessible names. For user-like interaction:

1. Resolve the element immediately before acting.
2. Scroll it into view.
3. Read its current bounding box.
4. Send `Input.dispatchMouseEvent` or `Input.insertText`.
5. Verify the resulting rendered state.

Use paired `Input.dispatchKeyEvent` events for Enter, Escape, arrows, Tab, and
shortcuts. Directly setting a DOM value is not equivalent to browser input and
may bypass framework event handlers.

Wait on a condition that proves completion. `Page.loadEventFired` is useful for
document navigation, but SPA transitions may require polling URL, text, or
element state instead.

## Capture and debug

Capture screenshots with `Page.captureScreenshot`; use
`Page.getLayoutMetrics` and `clip` for exact regions. Use `Page.printToPDF` for
PDF output.

For failures, enable `Network`, `Runtime`, and `Log`, then inspect:

- `Network.loadingFailed`
- `Runtime.exceptionThrown`
- `Runtime.consoleAPICalled`
- `Log.entryAdded`

Common causes:

- `ECONNREFUSED`: the browser exited, the port is wrong, or debugging is off.
- No matching page: inspect `/json/list` and match by URL/title.
- Execution context destroyed: navigation occurred; wait for the new document.
- Click misses: scroll and recalculate the box immediately before dispatch.
- Controlled input ignores text: focus it and use native input events.
- Page commands fail: the client attached to the browser target instead of the
  page target.

Close the WebSocket and browser process created for the task unless the user
asked to keep the visible window for review or takeover.

