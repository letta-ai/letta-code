# Recording video with Page.startScreencast

Screencast frames arrive when Chrome paints, not at a constant frame rate.
Acknowledge every frame immediately or Chrome stops sending them:

```ts
let latestFrame: Buffer | undefined;

function handleEvent(msg: any) {
  if (msg.method !== "Page.screencastFrame") return;
  latestFrame = Buffer.from(msg.params.data, "base64");
  void send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
}

await send("Page.startScreencast", {
  format: "jpeg",
  quality: 88,
  maxWidth: 1440,
  maxHeight: 900,
  everyNthFrame: 1,
});
```

To produce a standard constant-frame-rate video, sample `latestFrame` on a
fixed timer into numbered JPEGs while the flow runs, then encode:

```ts
let frameNo = 0;
const sampler = setInterval(() => {
  if (latestFrame) {
    void Bun.write(`frames/frame-${String(frameNo++).padStart(6, "0")}.jpg`, latestFrame);
  }
}, 100); // 10 fps
// ... perform the flow ...
clearInterval(sampler);
await send("Page.stopScreencast");
```

```bash
ffmpeg -y -framerate 10 -i frames/frame-%06d.jpg \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart demo.mp4
```

- Seed `latestFrame` with a `Page.captureScreenshot` before starting so an
  idle opening scene is not blank.
- Stop the screencast in a `finally` block.
- Verify with `ffprobe`, extract a few representative frames with `ffmpeg`,
  and inspect them before reporting success.

## Demo polish

- Fix the viewport size and `--force-device-scale-factor=1`.
- Use a clean profile and reset app state before the final take.
- Rehearse the entire flow once before recording.
- Add a visible synthetic cursor (an absolutely-positioned element moved via
  `Runtime.evaluate`) — CDP frames do not include the OS pointer.
- Pause briefly after meaningful actions so viewers can follow.
- Never expose credentials: use a dedicated non-sensitive demo token and mask
  password fields.
- End on the completed result for several seconds.
