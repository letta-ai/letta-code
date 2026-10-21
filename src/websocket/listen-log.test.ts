import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSessionLog } from "./listen-log";

describe("RemoteSessionLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letta-listen-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes lifecycle lines to a timestamped file", () => {
    const log = new RemoteSessionLog({ dir });
    log.init();
    log.log("hello");
    const content = readFileSync(log.path, "utf8");
    expect(content).toContain("hello");
    expect(log.path.startsWith(dir)).toBe(true);
  });

  test("redacts parsed and malformed WS events before writing", () => {
    const log = new RemoteSessionLog({ dir });
    log.init();
    log.wsEvent("recv", "client", {
      type: "browser_device_mcp_oauth",
      handoff_key: "live-bearer-handoff",
      nested: {
        code: "oauth-code",
        state: "oauth-state",
        access_token: "provider-token",
        error: "raw-provider-error",
      },
    });
    log.wsEvent("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: '{"handoff_key":"malformed-live-bearer"',
    });

    const content = readFileSync(log.path, "utf8");
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("[REDACTED_UNPARSEABLE_WS_PAYLOAD]");
    for (const secret of [
      "live-bearer-handoff",
      "oauth-code",
      "oauth-state",
      "provider-token",
      "raw-provider-error",
      "malformed-live-bearer",
    ]) {
      expect(content).not.toContain(secret);
    }
  });

  test("rotates to a new file once the size cap is exceeded", () => {
    const log = new RemoteSessionLog({ dir, maxBytes: 128 });
    log.init();
    const firstPath = log.path;
    for (let i = 0; i < 20; i++) {
      log.log(`line ${i} ${"x".repeat(40)}`);
    }
    expect(log.path).not.toBe(firstPath);
    const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeGreaterThan(1);
    // The newest file records why rotation happened.
    const latest = readFileSync(log.path, "utf8");
    expect(latest).toContain("rotated from");
    expect(latest).toContain("exceeded 128 bytes");
  });

  test("bounds total directory size by pruning to maxFiles on rotation", () => {
    const log = new RemoteSessionLog({ dir, maxBytes: 64, maxFiles: 3 });
    log.init();
    for (let i = 0; i < 100; i++) {
      log.log(`line ${i} ${"x".repeat(40)}`);
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeLessThanOrEqual(3);
    for (const file of files) {
      const size = statSync(join(dir, file)).size;
      // One line may push a file past the cap; rotation happens on the next write.
      expect(size).toBeLessThan(64 + 128);
    }
  });

  test("prunes pre-existing files beyond maxFiles at init", () => {
    const stale = new RemoteSessionLog({ dir, maxFiles: 3 });
    stale.init();
    for (let i = 0; i < 5; i++) {
      const log = new RemoteSessionLog({ dir, maxFiles: 3 });
      log.init();
      log.log(`session ${i}`);
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
