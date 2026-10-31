import { describe, expect, test } from "bun:test";
import {
  type RunCommand,
  readLinuxClipboardImage,
  runCommand,
} from "./clipboard-linux";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);

const WAYLAND_ENV = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };
const WAYLAND_ONLY_ENV = { WAYLAND_DISPLAY: "wayland-1" };
const X11_ENV = { DISPLAY: ":0" };

function commandError(fields: Record<string, unknown>) {
  return Object.assign(new Error("Command failed"), fields);
}

const missing = () => commandError({ code: "ENOENT" });
const timedOut = () => commandError({ killed: true, signal: "SIGKILL" });
const tooLarge = () =>
  commandError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
const failed = (stderr: string) =>
  commandError({ code: 1, stderr: Buffer.from(stderr) });

function fakeRunner(responses: Record<string, Buffer | string | Error>) {
  const calls: string[] = [];
  const run: RunCommand = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    const response = responses[line] ?? missing();
    if (response instanceof Error) throw response;
    return Buffer.from(response);
  };
  return { calls, run, notice: { shown: false } };
}

const WL_LIST = "wl-paste --list-types";
const WL_PNG = "wl-paste --no-newline --type image/png";
const WL_JPEG = "wl-paste --no-newline --type image/jpeg";
const XCLIP_LIST = "xclip -selection clipboard -t TARGETS -o";
const XCLIP_PNG = "xclip -selection clipboard -t image/png -o";

describe("readLinuxClipboardImage", () => {
  test("returns the png bytes from wl-paste on Wayland", async () => {
    const runner = fakeRunner({
      [WL_LIST]: "text/plain\nimage/png\n",
      [WL_PNG]: PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toEqual({ data: PNG_BYTES, mediaType: "image/png" });
    expect(runner.calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("reads jpeg when it is the only image type offered", async () => {
    const runner = fakeRunner({
      [WL_LIST]: "text/html\nimage/jpeg\n",
      [WL_JPEG]: JPEG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toEqual({ data: JPEG_BYTES, mediaType: "image/jpeg" });
  });

  test("prefers png over jpeg when both are offered", async () => {
    const runner = fakeRunner({
      [WL_LIST]: "image/jpeg\nimage/png\n",
      [WL_PNG]: PNG_BYTES,
    });

    await readLinuxClipboardImage({ env: WAYLAND_ENV, ...runner });

    expect(runner.calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("falls back to any other image type", async () => {
    const runner = fakeRunner({
      [WL_LIST]: "image/bmp\n",
      "wl-paste --no-newline --type image/bmp": PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toMatchObject({ mediaType: "image/bmp" });
    expect(runner.calls).toHaveLength(2);
  });

  test("returns null without calling xclip when the Wayland clipboard has only text", async () => {
    const runner = fakeRunner({ [WL_LIST]: "text/plain\nUTF8_STRING\n" });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toBeNull();
    expect(runner.calls).toEqual([WL_LIST]);
  });

  test("returns null when wl-paste reports an empty clipboard", async () => {
    const runner = fakeRunner({ [WL_LIST]: failed("Nothing is copied") });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toBeNull();
    expect(runner.calls).toEqual([WL_LIST]);
  });

  test("uses xclip when wl-paste is missing and DISPLAY is set", async () => {
    const runner = fakeRunner({
      [XCLIP_LIST]: "TARGETS\nimage/png\n",
      [XCLIP_PNG]: PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toEqual({ data: PNG_BYTES, mediaType: "image/png" });
    expect(runner.calls).toEqual([WL_LIST, XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip alone on a plain X11 session", async () => {
    const runner = fakeRunner({
      [XCLIP_LIST]: "image/png\n",
      [XCLIP_PNG]: PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({ env: X11_ENV, ...runner });

    expect(result).not.toBeNull();
    expect(runner.calls).toEqual([XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip when wl-paste times out", async () => {
    const runner = fakeRunner({
      [WL_LIST]: timedOut(),
      [XCLIP_LIST]: "image/png\n",
      [XCLIP_PNG]: PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).not.toBeNull();
    expect(runner.calls).toEqual([WL_LIST, XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip when wl-paste fails with an unexpected error", async () => {
    const runner = fakeRunner({
      [WL_LIST]: failed("Failed to connect to a Wayland server"),
      [XCLIP_LIST]: "image/png\n",
      [XCLIP_PNG]: PNG_BYTES,
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).not.toBeNull();
  });

  test("returns null when xclip reports the target is not available", async () => {
    const runner = fakeRunner({
      [XCLIP_LIST]: failed("Error: target TARGETS not available"),
    });

    const result = await readLinuxClipboardImage({ env: X11_ENV, ...runner });

    expect(result).toBeNull();
  });

  test("throws when wl-paste times out and there is no X11 display", async () => {
    const runner = fakeRunner({ [WL_LIST]: timedOut() });

    await expect(
      readLinuxClipboardImage({ env: WAYLAND_ONLY_ENV, ...runner }),
    ).rejects.toThrow("wl-paste timed out");
  });

  test("throws when the image exceeds the size cap", async () => {
    const runner = fakeRunner({
      [WL_LIST]: "image/png\n",
      [WL_PNG]: tooLarge(),
    });

    await expect(
      readLinuxClipboardImage({ env: WAYLAND_ENV, ...runner }),
    ).rejects.toThrow("clipboard image is too large");
    expect(runner.calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("asks once for the clipboard tools when neither wl-paste nor xclip exist", async () => {
    const runner = fakeRunner({});

    await expect(
      readLinuxClipboardImage({ env: WAYLAND_ENV, ...runner }),
    ).rejects.toThrow("install wl-clipboard (Wayland) or xclip (X11)");
    expect(
      await readLinuxClipboardImage({ env: WAYLAND_ENV, ...runner }),
    ).toBeNull();
    expect(runner.calls).toEqual([WL_LIST, XCLIP_LIST, WL_LIST, XCLIP_LIST]);
  });

  test("spawns nothing when neither display variable is set", async () => {
    const runner = fakeRunner({});

    const result = await readLinuxClipboardImage({
      env: { XDG_SESSION_TYPE: "wayland" },
      ...runner,
    });

    expect(result).toBeNull();
    expect(runner.calls).toEqual([]);
  });

  test("treats a zero-byte image read as empty", async () => {
    const runner = fakeRunner({ [WL_LIST]: "image/png\n", [WL_PNG]: "" });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      ...runner,
    });

    expect(result).toBeNull();
  });
});

describe("runCommand", () => {
  test("kills a command that exceeds the timeout", async () => {
    await expect(
      runCommand([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
        timeout: 200,
        maxBuffer: 1024,
      }),
    ).rejects.toMatchObject({ killed: true });
  });
});
