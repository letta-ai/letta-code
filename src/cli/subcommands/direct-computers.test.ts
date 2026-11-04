import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectComputers } from "@/backend/direct-computers";
import { runDirectComputersAction } from "./direct-computers";

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "letta-direct-cli-"));
  dirs.push(dir);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "secret\n");
  return { env: { LETTA_CONFIG_DIR: dir }, tokenFile };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("letta computers add-direct / remove-direct / list-direct", () => {
  test("adds, lists with a probe, and removes a direct computer", async () => {
    const { env, tokenFile } = setup();
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await runDirectComputersAction(
          [
            "add-direct",
            "box",
            "ws://10.0.0.5:4500",
            "--token-file",
            tokenFile,
          ],
          { env },
        ),
      ).toBe(0);
      expect(warn.mock.calls.join("\n")).toContain("unencrypted");
      expect(listDirectComputers(env)).toEqual([
        { name: "box", url: "ws://10.0.0.5:4500", tokenFile },
      ]);

      log.mockClear();
      expect(
        await runDirectComputersAction(["list-direct", "--check"], {
          env,
          probe: async () => "1.2.3",
        }),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        computers: [
          {
            name: "box",
            url: "ws://10.0.0.5:4500",
            tokenFile,
            selector: "direct:box",
            isOnline: true,
            lettaCodeVersion: "1.2.3",
          },
        ],
      });

      expect(
        await runDirectComputersAction(["remove-direct", "box"], { env }),
      ).toBe(0);
      expect(listDirectComputers(env)).toEqual([]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("does not save a record whose token file is unreadable", async () => {
    const { env } = setup();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await runDirectComputersAction(
          ["add-direct", "box", "wss://h", "--token-file", "/nonexistent/tok"],
          { env },
        ),
      ).toBe(1);
      expect(listDirectComputers(env)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
