import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDirectComputer,
  getDirectComputersPath,
  isInsecureRemoteUrl,
  listDirectComputers,
  parseDirectComputerSelector,
  readDirectComputerToken,
  removeDirectComputer,
  saveDirectComputer,
} from "./direct-computers";

const dirs: string[] = [];
function tempEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "letta-direct-computers-"));
  dirs.push(dir);
  return { LETTA_CONFIG_DIR: dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("direct computers store", () => {
  test("saves, replaces, lists and removes records with private permissions", () => {
    const env = tempEnv();
    expect(listDirectComputers(env)).toEqual([]);
    saveDirectComputer(
      { name: "box", url: "ws://127.0.0.1:4500", tokenFile: "/tok/a" },
      env,
    );
    saveDirectComputer(
      { name: "box", url: "wss://box.example.test/ws", tokenFile: "/tok/b" },
      env,
    );
    expect(listDirectComputers(env)).toEqual([
      { name: "box", url: "wss://box.example.test/ws", tokenFile: "/tok/b" },
    ]);
    if (process.platform !== "win32")
      expect(statSync(getDirectComputersPath(env)).mode & 0o777).toBe(0o600);
    expect(removeDirectComputer("box", env)).toBe(true);
    expect(removeDirectComputer("box", env)).toBe(false);
    expect(() => getDirectComputer("box", env)).toThrow("add-direct box");
  });

  test.each([
    [{ name: "bad name", url: "ws://h", tokenFile: "/t" }, "names"],
    [{ name: "ok", url: "http://h", tokenFile: "/t" }, "ws:// or wss://"],
    [{ name: "ok", url: "ws://u:p@h", tokenFile: "/t" }, "credentials"],
    [{ name: "ok", url: "ws://h?token=x", tokenFile: "/t" }, "query"],
    [{ name: "ok", url: "ws://h", tokenFile: "relative" }, "absolute"],
  ])("rejects %o", (computer, message) => {
    expect(() => saveDirectComputer(computer, tempEnv())).toThrow(message);
  });

  test("parses selectors", () => {
    expect(parseDirectComputerSelector("direct:box")).toBe("box");
    expect(parseDirectComputerSelector(" direct:box ")).toBe("box");
    expect(parseDirectComputerSelector("direct:")).toBeNull();
    expect(parseDirectComputerSelector("box")).toBeNull();
  });

  test("flags plain ws:// only off loopback", () => {
    expect(isInsecureRemoteUrl("ws://10.0.0.5:4500")).toBe(true);
    expect(isInsecureRemoteUrl("ws://127.0.0.1:4500")).toBe(false);
    expect(isInsecureRemoteUrl("ws://[::1]:4500")).toBe(false);
    expect(isInsecureRemoteUrl("wss://box.example.test")).toBe(false);
  });

  test("reads the token without exposing it in errors", () => {
    const env = tempEnv();
    const tokenFile = join(env.LETTA_CONFIG_DIR as string, "token");
    const computer = { name: "box", url: "ws://127.0.0.1:1", tokenFile };
    expect(() => readDirectComputerToken(computer)).toThrow("ENOENT");
    writeFileSync(tokenFile, "  \n");
    expect(() => readDirectComputerToken(computer)).toThrow("empty");
    writeFileSync(tokenFile, "secret-value\n");
    expect(readDirectComputerToken(computer)).toBe("secret-value");
  });
});
