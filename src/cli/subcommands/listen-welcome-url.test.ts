import { describe, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  type BrowserOpener,
  decideWelcomeOpen,
  handleWelcomeUrl,
  openWelcomeUrl,
  reportWelcomeUrlResult,
} from "@/cli/subcommands/listen-welcome-url";

const DESKTOP = { DISPLAY: ":0" };

describe("decideWelcomeOpen", () => {
  test("opens on a desktop session on each platform", () => {
    expect(decideWelcomeOpen({}, "darwin")).toEqual({ open: true });
    expect(decideWelcomeOpen({}, "win32")).toEqual({ open: true });
    expect(decideWelcomeOpen(DESKTOP, "linux")).toEqual({ open: true });
    expect(
      decideWelcomeOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux"),
    ).toEqual({ open: true });
  });

  test("skips Linux with no display server", () => {
    expect(decideWelcomeOpen({}, "linux")).toEqual({
      open: false,
      reason: "headless",
    });
  });

  test("skips SSH sessions even when a display is forwarded", () => {
    for (const env of [
      { SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" },
      { SSH_TTY: "/dev/pts/1" },
    ]) {
      expect(decideWelcomeOpen(env, "darwin")).toEqual({
        open: false,
        reason: "ssh",
      });
      expect(decideWelcomeOpen({ ...DESKTOP, ...env }, "linux")).toEqual({
        open: false,
        reason: "ssh",
      });
    }
  });

  test("the opt-out wins over everything else; other values do not opt out", () => {
    expect(
      decideWelcomeOpen({ LETTA_DISABLE_WELCOME_URL: "1" }, "darwin"),
    ).toEqual({ open: false, reason: "opted-out" });
    expect(
      decideWelcomeOpen(
        { LETTA_DISABLE_WELCOME_URL: "TRUE", SSH_TTY: "/dev/pts/1" },
        "darwin",
      ),
    ).toEqual({ open: false, reason: "opted-out" });
    expect(
      decideWelcomeOpen({ LETTA_DISABLE_WELCOME_URL: "0" }, "darwin"),
    ).toEqual({ open: true });
  });
});

function fakeOpener(
  act: (child: EventEmitter) => void,
): BrowserOpener & ReturnType<typeof mock> {
  return mock(async () => {
    const child = new EventEmitter();
    setTimeout(() => act(child), 0);
    return child as unknown as ChildProcess;
  });
}

describe("openWelcomeUrl", () => {
  test("a clean opener exit is opened", async () => {
    const opener = fakeOpener((child) => child.emit("exit", 0, null));
    expect(await openWelcomeUrl("https://example.com/w", opener)).toBe(
      "opened",
    );
    expect(opener).toHaveBeenCalledWith("https://example.com/w");
  });

  test("an opener still running after the settle window is opened", async () => {
    const opener = fakeOpener(() => {});
    expect(await openWelcomeUrl("https://example.com/w", opener, 10)).toBe(
      "opened",
    );
  });

  test("a non-zero exit, a spawn error, or a throwing opener is failed", async () => {
    expect(
      await openWelcomeUrl(
        "https://example.com/w",
        fakeOpener((child) => child.emit("exit", 4, null)),
      ),
    ).toBe("failed:exit-4");
    expect(
      await openWelcomeUrl(
        "https://example.com/w",
        fakeOpener((child) =>
          child.emit(
            "error",
            Object.assign(new Error("x"), { code: "ENOENT" }),
          ),
        ),
      ),
    ).toBe("failed:ENOENT");
    expect(
      await openWelcomeUrl("https://example.com/w", async () => {
        throw new Error("no opener");
      }),
    ).toBe("failed:error");
  });
});

const report = {
  serverUrl: "https://api.example.com",
  apiKey: "sk-test",
  connectionId: "conn-1",
};

describe("reportWelcomeUrlResult", () => {
  test("posts the result for this registration's connection", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    expect(
      await reportWelcomeUrlResult(
        report,
        "skipped:ssh",
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.example.com/v1/environments/conn-1/welcome-result",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ result: "skipped:ssh" });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  test("rejections and network errors resolve false instead of throwing", async () => {
    expect(
      await reportWelcomeUrlResult(
        report,
        "opened",
        (async () =>
          new Response(null, { status: 404 })) as unknown as typeof fetch,
      ),
    ).toBe(false);
    expect(
      await reportWelcomeUrlResult(report, "opened", (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch),
    ).toBe(false);
  });
});

describe("handleWelcomeUrl", () => {
  test("a skipped session reports the skip without touching the opener", async () => {
    const opener = fakeOpener((child) => child.emit("exit", 0, null));
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const result = await handleWelcomeUrl("https://example.com/w", report, {
      env: {},
      platform: "linux",
      opener,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBe("skipped:headless");
    expect(opener).not.toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      result: "skipped:headless",
    });
  });

  test("an open that succeeds is reported, and a failed report does not throw", async () => {
    const result = await handleWelcomeUrl("https://example.com/w", report, {
      env: {},
      platform: "darwin",
      opener: fakeOpener((child) => child.emit("exit", 0, null)),
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result).toBe("opened");
  });
});
