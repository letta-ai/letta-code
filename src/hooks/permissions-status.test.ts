import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The permissions-status hook (hooks/permissions-status.sh) is a bash script
// that parses JSON with jq. Skip where either is unavailable (e.g. Windows CI
// has no bash on PATH), mirroring src/hooks/block-rm-rf.test.ts.
const canRunHook = Bun.which("bash") !== null && Bun.which("jq") !== null;

const SECTION_HEADERS = [
  "User Settings (XDG)",
  "User Settings (Legacy)",
  "Project Settings",
  "Project Local Settings",
] as const;

/** Extract the output block printed for one settings file section. */
function section(
  stdout: string,
  label: (typeof SECTION_HEADERS)[number],
): string {
  const idx = stdout.indexOf(label);
  if (idx === -1) {
    return "";
  }
  const rest = stdout.slice(idx + label.length);
  const stopPattern = SECTION_HEADERS.filter((header) => header !== label)
    .map((header) => header.replace(/[()]/g, "\\$&"))
    .concat(["═"]);
  const stop = rest.search(new RegExp(stopPattern.join("|")));
  return stop === -1 ? rest : rest.slice(0, stop);
}

describe.skipIf(!canRunHook)("permissions-status hook", () => {
  const hookPath = join(
    import.meta.dir,
    "..",
    "..",
    "hooks",
    "permissions-status.sh",
  );

  function makeProject(localSettings?: string): string {
    const projectDir = mkdtempSync(join(tmpdir(), "perm-status-hook-"));
    if (localSettings !== undefined) {
      mkdirSync(join(projectDir, ".letta"), { recursive: true });
      writeFileSync(
        join(projectDir, ".letta", "settings.local.json"),
        localSettings,
      );
    }
    return projectDir;
  }

  async function runHook(projectDir: string): Promise<string> {
    const proc = Bun.spawn(["bash", hookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      JSON.stringify({
        tool_name: "Bash",
        working_directory: projectDir.replaceAll("\\", "/"),
      }),
    );
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  }

  function cleanup(projectDir: string): void {
    rmSync(projectDir, { recursive: true, force: true });
  }

  test("malformed settings file is reported instead of showing (none)", async () => {
    const projectDir = makeProject('{"permissions":');
    try {
      const stdout = await runHook(projectDir);
      const local = section(stdout, "Project Local Settings");
      expect(local).toContain("malformed");
      expect(local).not.toContain("(none)");
    } finally {
      cleanup(projectDir);
    }
  });

  test("valid settings with empty permission arrays still show (none)", async () => {
    const projectDir = makeProject("{}");
    try {
      const stdout = await runHook(projectDir);
      const local = section(stdout, "Project Local Settings");
      expect(local).toContain("(none)");
      expect(local).not.toContain("malformed");
    } finally {
      cleanup(projectDir);
    }
  });

  test("valid permission rules are still listed", async () => {
    const projectDir = makeProject(
      '{"permissions":{"allow":["Bash(ls:*)"],"deny":["Read(.env)"]}}',
    );
    try {
      const stdout = await runHook(projectDir);
      const local = section(stdout, "Project Local Settings");
      expect(local).toContain("Allow:");
      expect(local).toContain("Bash(ls:*)");
      expect(local).toContain("Deny:");
      expect(local).toContain("Read(.env)");
      expect(local).not.toContain("malformed");
    } finally {
      cleanup(projectDir);
    }
  });

  test("missing settings file still shows (file not found)", async () => {
    const projectDir = makeProject();
    try {
      const stdout = await runHook(projectDir);
      const local = section(stdout, "Project Local Settings");
      expect(local).toContain("(file not found)");
    } finally {
      cleanup(projectDir);
    }
  });
});
