import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The rm guard (hooks/block-rm-rf.sh) is a bash script that parses JSON
// with jq. Skip where either is unavailable (e.g. Windows CI has no bash
// on PATH), mirroring the skip approach of src/hooks/executor.test.ts.
const canRunGuard = Bun.which("bash") !== null && Bun.which("jq") !== null;

describe.skipIf(!canRunGuard)("block-rm-rf hook", () => {
  const hookPath = join(import.meta.dir, "..", "..", "hooks", "block-rm-rf.sh");

  async function runGuard(command: string): Promise<number> {
    const proc = Bun.spawn(["bash", hookPath], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(
      JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    );
    proc.stdin.end();
    return await proc.exited;
  }

  test("blocks combined recursive+force spellings", async () => {
    expect(await runGuard("rm -rf /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -fr /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -rfi /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("sudo rm -rf /tmp/letta-guard-probe")).toBe(2);
  });

  test("blocks split short flags and long forms", async () => {
    expect(await runGuard("rm -r -f /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -f -r /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -R -f /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -Rf /tmp/letta-guard-probe")).toBe(2);
    expect(await runGuard("rm -r --force /tmp/letta-guard-probe")).toBe(2);
    expect(
      await runGuard("rm --recursive --force /tmp/letta-guard-probe"),
    ).toBe(2);
    expect(
      await runGuard("rm --force --recursive /tmp/letta-guard-probe"),
    ).toBe(2);
  });

  test("still allows rm without both recursive and force", async () => {
    expect(await runGuard("rm /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("rm -r /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("rm -f /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("rm -v /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("rm --recursive /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("rm --force /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("mkdir -p /tmp/letta-guard-probe")).toBe(0);
  });

  test("flags of other commands in the same line do not trip the guard", async () => {
    expect(await runGuard("ls -f /tmp; rm -r /tmp/letta-guard-probe")).toBe(0);
    expect(await runGuard("grep -rf pattern /tmp; echo done")).toBe(0);
  });
});
