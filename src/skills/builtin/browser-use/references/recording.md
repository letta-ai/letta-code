# Recording CDP video

Use `Page.startScreencast` only for a Chromium browser controlled through CDP.
Prefer the environment's existing screen recorder when the task needs the full
browser chrome, OS cursor, or non-Chromium output.

Screencast frames arrive when the page paints rather than at a constant frame
rate. Acknowledge every frame immediately:

```ts
let latestFrame: Buffer | undefined;

function handleEvent(message: any) {
  if (message.method !== "Page.screencastFrame") return;
  latestFrame = Buffer.from(message.params.data, "base64");
  void send("Page.screencastFrameAck", {
    sessionId: message.params.sessionId,
  });
}

await send("Page.startScreencast", {
  format: "jpeg",
  quality: 88,
  maxWidth: 1440,
  maxHeight: 900,
  everyNthFrame: 1,
});
```

Sample the latest frame on a fixed timer, then encode the numbered files at the
same frame rate:

```ts
let frameNumber = 0;
const sampler = setInterval(() => {
  if (latestFrame) {
    const name = `frames/frame-${String(frameNumber++).padStart(6, "0")}.jpg`;
    void Bun.write(name, latestFrame);
  }
}, 100);

// Perform the browser flow.

clearInterval(sampler);
await send("Page.stopScreencast");
```

```bash
ffmpeg -y -framerate 10 -i frames/frame-%06d.jpg \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart demo.mp4
```

- Seed `latestFrame` with `Page.captureScreenshot` so an idle opening scene is
  not blank.
- Stop the screencast in a `finally` block.
- Fix viewport size and device scale factor for deterministic output.
- Add a synthetic cursor only when the recording needs to show pointer motion;
  CDP screencast frames do not include the OS pointer.
- Verify the video with `ffprobe` and inspect representative extracted frames.
- Never expose credentials or sensitive fields in the recording.
