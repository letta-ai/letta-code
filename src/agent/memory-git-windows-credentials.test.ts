import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepositoryCheckout } from "@/utils/repository-checkout";
import { writeWindowsCredentialHelper } from "./memory-git-windows-credentials";

test("the configured Windows helper survives atomic checkout publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "letta-credential-path-"));
  const directory = join(root, "profile with spaces", "memory");
  const configKey = "credential.https://example.test.helper";
  try {
    await mkdir(join(root, "profile with spaces"));
    await withRepositoryCheckout(directory, async (staging) => {
      execFileSync("git", ["init", "-b", "main", staging], { stdio: "ignore" });
      const helper = writeWindowsCredentialHelper(
        staging,
        "test-token",
        directory,
      );
      execFileSync("git", [
        "-C",
        staging,
        "config",
        "--local",
        configKey,
        helper,
      ]);
    });
    const configuredHelper = execFileSync(
      "git",
      ["-C", directory, "config", "--get", configKey],
      { encoding: "utf8" },
    ).trim();
    const helperPath = configuredHelper.replace(/\\(\s)/g, "$1");
    expect(existsSync(helperPath)).toBe(true);
    expect(helperPath).toBe(
      join(directory, ".git", "letta-credential-helper.cmd").replaceAll(
        "\\",
        "/",
      ),
    );
    if (process.platform === "win32") {
      const credentials = execFileSync(
        "git",
        ["-C", directory, "credential", "fill"],
        {
          input: "protocol=https\nhost=example.test\n\n",
          encoding: "utf8",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      expect(credentials).toContain("username=letta");
      expect(credentials).toContain("password=test-token");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
