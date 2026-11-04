import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { findSelfMatchingPgrepPattern } from "./self-matching-pgrep";

describe("findSelfMatchingPgrepPattern", () => {
  test("flags wait loops whose pgrep -f pattern is in the command itself", () => {
    expect(
      findSelfMatchingPgrepPattern(
        "while pgrep -f runall.py >/dev/null; do sleep 3; done; ls out",
      ),
    ).toBe("runall.py");
    expect(
      findSelfMatchingPgrepPattern(
        "until ! pgrep -f install-agent-dependencies; do sleep 10; done",
      ),
    ).toBe("install-agent-dependencies");
    expect(
      findSelfMatchingPgrepPattern("pgrep -af 'node server.js' || echo gone"),
    ).toBe("node server.js");
  });

  test("flags pkill -f, which would kill its own shell", () => {
    expect(findSelfMatchingPgrepPattern("pkill -f vite; npm run dev")).toBe(
      "vite",
    );
  });

  test("allows patterns that cannot match their own text", () => {
    expect(
      findSelfMatchingPgrepPattern(
        "while pgrep -f '[r]unall.py' >/dev/null; do sleep 3; done",
      ),
    ).toBeNull();
  });

  test("allows pgrep without -f, which matches process names only", () => {
    expect(
      findSelfMatchingPgrepPattern("while pgrep node; do sleep 1; done"),
    ).toBeNull();
  });

  test("ignores pgrep in argument position", () => {
    expect(findSelfMatchingPgrepPattern("echo pgrep -f foo")).toBeNull();
  });

  test("the flagged pattern really matches its own shell in pgrep", () => {
    if (process.platform === "win32") return;
    const probe = spawnSync("pgrep", ["--version"]);
    if (probe.error) return;
    const command = "pgrep -f self-match-probe-7f3a >/dev/null && echo matched";
    expect(findSelfMatchingPgrepPattern(command)).toBe("self-match-probe-7f3a");
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("matched");
  });
});
