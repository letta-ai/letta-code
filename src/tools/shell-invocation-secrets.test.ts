import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { GITHUB_WRITE_CAPABILITY_ENV } from "@/github-write-authority";
import { prepareShellInvocationSecrets } from "./shell-invocation-secrets";

test("uses captured authority instead of hidden model-supplied shell secrets", () => {
  const chunks: string[] = [];
  const invocation = prepareShellInvocationSecrets(
    {
      command: "echo ready",
      secretEnv: { [GITHUB_WRITE_CAPABILITY_ENV]: "forged" },
    },
    undefined,
    "alice-token",
    (chunk) => chunks.push(chunk),
  );
  expect(invocation.args.secretEnv).toEqual({
    [GITHUB_WRITE_CAPABILITY_ENV]: "alice-token",
  });
  (invocation.args.onOutput as (text: string, stream: "stdout") => void)(
    "alice-token",
    "stdout",
  );
  expect(chunks.join("")).not.toContain("alice-token");
});

test("a real child process receives only the authority from its invocation", () => {
  for (const capability of ["alice-token", "bob-token", null]) {
    const invocation = prepareShellInvocationSecrets(
      { cmd: "node" },
      undefined,
      capability,
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(process.env.${GITHUB_WRITE_CAPABILITY_ENV} || 'autonomous')`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [GITHUB_WRITE_CAPABILITY_ENV]: "stale-parent",
          ...invocation.secrets,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(capability ?? "autonomous");
  }
});
