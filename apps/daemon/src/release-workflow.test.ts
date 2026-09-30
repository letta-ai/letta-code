import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readWorkflow(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
    ),
    "utf8",
  );
}

test("daemon signing runs only from the default-branch dispatch workflow", () => {
  const workflow = readWorkflow("daemon-release.yml");

  expect(workflow).toContain("repository_dispatch:");
  expect(workflow).not.toContain("workflow_dispatch:");
  expect(workflow).toContain("environment: daemon-signing");
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).toContain("Validate immutable release source");
});

test("main release stays draft until daemon artifacts are complete", () => {
  const workflow = readWorkflow("release.yml");

  expect(workflow).not.toContain("  workflow_dispatch:");
  expect(workflow).toContain("draft: true");
  expect(workflow).toContain('event_type: "publish_letta_daemon"');
  expect(workflow).toContain("Publish complete GitHub Release");
  expect(workflow).toContain('test "$TAG_COMMIT" = "$GITHUB_SHA"');
});
