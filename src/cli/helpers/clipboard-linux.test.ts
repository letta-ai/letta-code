import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  type LinuxClipboardDeps,
  readLinuxClipboardImage,
  spawnCommand,
} from "./clipboard-linux";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);

const WAYLAND_ENV = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };
const WAYLAND_ONLY_ENV = { WAYLAND_DISPLAY: "wayland-1" };
const X11_ENV = { DISPLAY: ":0" };

function ok(stdout: string | Buffer): CommandResult {
  return {
    status: "ok",
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
  };
}

function failed(stderr: string): CommandResult {
  return { status: "failed", stderr };
}

function fakeRunner(responses: Record<string, CommandResult>) {
  const calls: string[] = [];
  const runCommand: LinuxClipboardDeps["runCommand"] = async (
    command,
    args,
  ) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return responses[line] ?? { status: "missing" };
  };
  return { calls, runCommand };
}

const WL_LIST = "wl-paste --list-types";
const WL_PNG = "wl-paste --no-newline --type image/png";
const WL_JPEG = "wl-paste --no-newline --type image/jpeg";
const XCLIP_LIST = "xclip -selection clipboard -t TARGETS -o";
const XCLIP_PNG = "xclip -selection clipboard -t image/png -o";

describe("readLinuxClipboardImage", () => {
  test("returns the png bytes from wl-paste on Wayland", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: ok("text/plain\nimage/png\n"),
      [WL_PNG]: ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "image",
      data: PNG_BYTES,
      mediaType: "image/png",
    });
    expect(calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("reads jpeg when it is the only image type offered", async () => {
    const { runCommand } = fakeRunner({
      [WL_LIST]: ok("text/html\nimage/jpeg\n"),
      [WL_JPEG]: ok(JPEG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "image",
      data: JPEG_BYTES,
      mediaType: "image/jpeg",
    });
  });

  test("prefers png over jpeg when both are offered", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: ok("image/jpeg\nimage/png\n"),
      [WL_PNG]: ok(PNG_BYTES),
    });

    await readLinuxClipboardImage({ env: WAYLAND_ENV, runCommand });

    expect(calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("falls back to any other image type", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: ok("image/bmp\n"),
      "wl-paste --no-newline --type image/bmp": ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toMatchObject({ kind: "image", mediaType: "image/bmp" });
    expect(calls).toHaveLength(2);
  });

  test("returns empty without calling xclip when the Wayland clipboard has only text", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: ok("text/plain\nUTF8_STRING\n"),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({ kind: "empty" });
    expect(calls).toEqual([WL_LIST]);
  });

  test("returns empty when wl-paste reports an empty clipboard", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: failed("Nothing is copied"),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({ kind: "empty" });
    expect(calls).toEqual([WL_LIST]);
  });

  test("uses xclip when wl-paste is missing and DISPLAY is set", async () => {
    const { runCommand, calls } = fakeRunner({
      [XCLIP_LIST]: ok("TARGETS\nimage/png\n"),
      [XCLIP_PNG]: ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "image",
      data: PNG_BYTES,
      mediaType: "image/png",
    });
    expect(calls).toEqual([WL_LIST, XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip alone on a plain X11 session", async () => {
    const { runCommand, calls } = fakeRunner({
      [XCLIP_LIST]: ok("image/png\n"),
      [XCLIP_PNG]: ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({ env: X11_ENV, runCommand });

    expect(result.kind).toBe("image");
    expect(calls).toEqual([XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip when wl-paste times out", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: { status: "timeout" },
      [XCLIP_LIST]: ok("image/png\n"),
      [XCLIP_PNG]: ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result.kind).toBe("image");
    expect(calls).toEqual([WL_LIST, XCLIP_LIST, XCLIP_PNG]);
  });

  test("uses xclip when wl-paste fails with an unexpected error", async () => {
    const { runCommand } = fakeRunner({
      [WL_LIST]: failed("Failed to connect to a Wayland server"),
      [XCLIP_LIST]: ok("image/png\n"),
      [XCLIP_PNG]: ok(PNG_BYTES),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result.kind).toBe("image");
  });

  test("returns empty when xclip reports the target is not available", async () => {
    const { runCommand } = fakeRunner({
      [XCLIP_LIST]: failed("Error: target TARGETS not available"),
    });

    const result = await readLinuxClipboardImage({ env: X11_ENV, runCommand });

    expect(result).toEqual({ kind: "empty" });
  });

  test("returns an error when wl-paste times out and there is no X11 display", async () => {
    const { runCommand } = fakeRunner({
      [WL_LIST]: { status: "timeout" },
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ONLY_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "error",
      message: "wl-paste timed out listing types",
    });
  });

  test("returns an error when the image read times out", async () => {
    const { runCommand } = fakeRunner({
      [WL_LIST]: ok("image/png\n"),
      [WL_PNG]: { status: "timeout" },
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ONLY_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "error",
      message: "wl-paste timed out reading the image",
    });
  });

  test("returns an error when the image exceeds the size cap", async () => {
    const { runCommand, calls } = fakeRunner({
      [WL_LIST]: ok("image/png\n"),
      [WL_PNG]: { status: "too-large" },
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({
      kind: "error",
      message: "Clipboard image is too large",
    });
    expect(calls).toEqual([WL_LIST, WL_PNG]);
  });

  test("returns tools-missing when neither wl-paste nor xclip exist", async () => {
    const { runCommand, calls } = fakeRunner({});

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({ kind: "tools-missing" });
    expect(calls).toEqual([WL_LIST, XCLIP_LIST]);
  });

  test("returns tools-missing on a Wayland-only session without wl-paste", async () => {
    const { runCommand } = fakeRunner({});

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ONLY_ENV,
      runCommand,
    });

    expect(result).toEqual({ kind: "tools-missing" });
  });

  test("spawns nothing when neither display variable is set", async () => {
    const { runCommand, calls } = fakeRunner({});

    const result = await readLinuxClipboardImage({
      env: { XDG_SESSION_TYPE: "wayland" },
      runCommand,
    });

    expect(result).toEqual({ kind: "empty" });
    expect(calls).toEqual([]);
  });

  test("treats a zero-byte image read as empty", async () => {
    const { runCommand } = fakeRunner({
      [WL_LIST]: ok("image/png\n"),
      [WL_PNG]: ok(""),
    });

    const result = await readLinuxClipboardImage({
      env: WAYLAND_ENV,
      runCommand,
    });

    expect(result).toEqual({ kind: "empty" });
  });
});

describe("spawnCommand", () => {
  const node = process.execPath;

  test("reports a missing binary", async () => {
    const result = await spawnCommand("letta-no-such-binary", [], {
      timeoutMs: 1000,
      maxBytes: 1024,
    });

    expect(result).toEqual({ status: "missing" });
  });

  test("captures stdout from a successful command", async () => {
    const result = await spawnCommand(
      node,
      ["-e", "process.stdout.write('abc')"],
      { timeoutMs: 5000, maxBytes: 1024 },
    );

    expect(result).toEqual({ status: "ok", stdout: Buffer.from("abc") });
  });

  test("reports stderr from a failing command", async () => {
    const result = await spawnCommand(
      node,
      ["-e", "process.stderr.write('Nothing is copied'); process.exit(1)"],
      { timeoutMs: 5000, maxBytes: 1024 },
    );

    expect(result).toEqual({ status: "failed", stderr: "Nothing is copied" });
  });

  test("kills a command that exceeds the timeout", async () => {
    const result = await spawnCommand(
      node,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        timeoutMs: 200,
        maxBytes: 1024,
      },
    );

    expect(result).toEqual({ status: "timeout" });
  });

  test("kills a command whose output exceeds the byte cap", async () => {
    const result = await spawnCommand(
      node,
      [
        "-e",
        "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 30000)",
      ],
      { timeoutMs: 5000, maxBytes: 1024 },
    );

    expect(result).toEqual({ status: "too-large" });
  });
});
