const { describe, expect, test } = require("bun:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  ROOT_FAMILY,
  buildFamilyImpactIndex,
  getGitChangedFiles,
  planUnitTests,
  readPullRequestShas,
} = require("./unit-test-impact.cjs");

const allTestFiles = [
  "src/agent/agent.test.ts",
  "src/channels/channel.test.ts",
  "src/cli/cli.test.tsx",
  "src/integration-tests/api.test.ts",
  "src/tools/tool.test.ts",
  "src/websocket/socket.test.ts",
  "src/startup-flow.test.ts",
  "scripts/unit-test-impact.test.cjs",
];

function impact(
  dependencies = {},
  unresolvedImports = [],
  fileDependencies = {},
) {
  return {
    familyDependencies: new Map(
      Object.entries(dependencies).map(([family, paths]) => [
        family,
        new Set(paths),
      ]),
    ),
    fileDependencies: new Map(
      Object.entries(fileDependencies).map(([file, paths]) => [
        file,
        new Set(paths),
      ]),
    ),
    unresolvedImports,
  };
}

function plan(changedFiles, impactIndex = impact()) {
  return planUnitTests({ changedFiles, allTestFiles, impactIndex });
}

describe("unit-test impact planning", () => {
  test("runs the family that owns a changed source file", () => {
    const result = plan([{ status: "M", path: "src/tools/impl/bash.ts" }]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual(["src/tools/tool.test.ts"]);
    expect(result.omittedTests).toContain("src/channels/channel.test.ts");
  });

  test("runs a family when it directly imports the changed file", () => {
    const result = plan(
      [{ status: "M", path: "src/tools/interactive-policy.ts" }],
      impact({ channels: ["src/tools/interactive-policy.ts"] }),
    );

    expect(result.selectedTests).toEqual([
      "src/channels/channel.test.ts",
      "src/tools/tool.test.ts",
    ]);
    expect(result.selectedFamilies).toEqual([
      {
        family: "channels",
        reasons: ["channels imports src/tools/interactive-policy.ts directly"],
      },
      {
        family: "tools",
        reasons: ["src/tools/interactive-policy.ts is owned by tools"],
      },
    ]);
  });

  test("channel package entrypoints select channel tests", () => {
    const result = plan(
      [{ status: "M", path: "src/channels-public.ts" }],
      impact({}, [], {
        "src/channels-public.ts": ["src/channels/gateway-core.ts"],
      }),
    );

    expect(result.selectedTests).toEqual([
      "src/channels/channel.test.ts",
      "src/startup-flow.test.ts",
    ]);
  });

  test("CLI app changes include root source-level contract tests", () => {
    const result = plan([
      { status: "M", path: "src/cli/app/use-submit-handler.ts" },
    ]);

    expect(result.selectedTests).toEqual([
      "src/cli/cli.test.tsx",
      "src/startup-flow.test.ts",
    ]);
  });

  test("documentation-only changes select no unit tests", () => {
    const result = plan([
      { status: "M", path: "README.md" },
      { status: "M", path: "docs/commands.md" },
      { status: "M", path: "assets/letta-code-demo.gif" },
    ]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual([]);
    expect(result.omittedTests).toEqual(allTestFiles);
  });

  test("documentation examples imported by source select their consumer", () => {
    const result = plan(
      [{ status: "M", path: "docs/examples/mods/example.ts" }],
      impact({ cli: ["docs/examples/mods/example.ts"] }),
    );

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual(["src/cli/cli.test.tsx"]);
  });

  test("the bundled Tutor profile selects its agent tests", () => {
    const result = plan([{ status: "M", path: "assets/tutor-profile.png" }]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual(["src/agent/agent.test.ts"]);
  });

  test.each(["assets/runtime.bin", "assets/tutor-profile.png.bak"])(
    "unknown asset %s widens to the full unit suite",
    (filePath) => {
      const result = plan([{ status: "A", path: filePath }]);

      expect(result.mode).toBe("full");
    },
  );

  test("the source-size baseline does not widen unit tests", () => {
    const result = plan([
      { status: "M", path: "scripts/source-file-size-baseline.json" },
      { status: "M", path: "src/tools/impl/bash.ts" },
    ]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual(["src/tools/tool.test.ts"]);
  });

  test("integration-only changes leave unit tests to the integration step", () => {
    const result = plan([
      { status: "M", path: "src/integration-tests/api.test.ts" },
    ]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual([]);
  });

  test.each([
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "build.js",
    ".github/workflows/ci.yml",
    "scripts/run-unit-tests.cjs",
    "scripts/isolated-unit-tests.json",
  ])("%s widens to the full unit suite", (filePath) => {
    const result = plan([{ status: "M", path: filePath }]);

    expect(result.mode).toBe("full");
    expect(result.selectedTests).toEqual(allTestFiles);
  });

  test("unknown files widen to the full unit suite", () => {
    const result = plan([{ status: "M", path: "config/runtime.yaml" }]);

    expect(result.mode).toBe("full");
    expect(result.reason).toContain("not classified");
  });

  test("deleted source files widen to the full unit suite", () => {
    const result = plan([{ status: "D", path: "src/tools/removed.ts" }]);

    expect(result.mode).toBe("full");
    expect(result.reason).toContain("was deleted");
  });

  test("source files renamed into documentation still widen", () => {
    const result = plan([
      {
        status: "R100",
        path: "docs/old-tool.md",
        previousPath: "src/tools/old-tool.ts",
      },
    ]);

    expect(result.mode).toBe("full");
    expect(result.reason).toContain("was renamed");
  });

  test("documentation-only renames select no unit tests", () => {
    const result = plan([
      {
        status: "R100",
        path: "docs/new-name.md",
        previousPath: "docs/old-name.md",
      },
    ]);

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).toEqual([]);
  });

  test("unresolved local imports widen to the full unit suite", () => {
    const result = plan(
      [{ status: "M", path: "src/tools/impl/bash.ts" }],
      impact({}, [
        { file: "src/channels/broken.ts", moduleSpecifier: "@/missing" },
      ]),
    );

    expect(result.mode).toBe("full");
    expect(result.reason).toContain("could not be resolved");
  });

  test("an empty change set widens to the full unit suite", () => {
    const result = plan([]);

    expect(result.mode).toBe("full");
    expect(result.reason).toBe("no changed files were provided");
  });

  test("selection uses the shallow checkout when the event names a stale merge", () => {
    const directory = mkdtempSync(join(tmpdir(), "unit-impact-event-"));
    const eventPath = join(directory, "event.json");
    const checkout = join(directory, "checkout");
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }).trim();
    try {
      git("init", "-b", "main");
      writeFileSync(join(directory, "base.txt"), "base");
      git("add", "base.txt");
      git("-c", "core.hooksPath=", "commit", "-m", "base");
      const baseSha = git("rev-parse", "HEAD");
      git("checkout", "-b", "feature");
      writeFileSync(join(directory, "changed.txt"), "feature");
      git("add", "changed.txt");
      git("-c", "core.hooksPath=", "commit", "-m", "feature");
      const branchHead = git("rev-parse", "HEAD");
      git("checkout", "main");
      git("-c", "core.hooksPath=", "merge", "--no-ff", "feature", "-m", "merge");
      const headSha = git("rev-parse", "HEAD");
      git("clone", "--depth=2", pathToFileURL(directory).href, checkout);
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: {
            base: { sha: baseSha },
            head: { sha: branchHead },
            merge_commit_sha: "700fce0cf421cd048f810e40822d608d7c81a2bc",
          },
        }),
      );

      const shas = readPullRequestShas(eventPath, checkout);
      expect(shas).toEqual({ baseSha, headSha });
      expect(getGitChangedFiles(shas.baseSha, shas.headSha, checkout)).toEqual([
        { status: "A", path: "changed.txt", previousPath: undefined },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});

describe("current repository impact graph", () => {
  const impactIndex = buildFamilyImpactIndex(process.cwd());

  test("resolves every literal local import", () => {
    expect(impactIndex.unresolvedImports).toEqual([]);
  });

  test("the shell process refactor does not select channel tests", () => {
    const currentTests = [
      "src/channels/discord-service.test.ts",
      "src/cli/bash-mode.test.ts",
      "src/tools/bash-background.test.ts",
      "src/websocket/listen-client-protocol.test.ts",
    ];
    const result = planUnitTests({
      changedFiles: [
        { status: "M", path: "src/tools/impl/bash.ts" },
        { status: "M", path: "src/tools/impl/exec-command.ts" },
        { status: "M", path: "src/tools/impl/shell-runner.ts" },
      ],
      allTestFiles: currentTests,
      impactIndex,
    });

    expect(result.mode).toBe("selected");
    expect(result.selectedTests).not.toContain(
      "src/channels/discord-service.test.ts",
    );
    expect(result.selectedTests).toContain("src/tools/bash-background.test.ts");
  });

  test("a direct channel dependency still selects channel tests", () => {
    const result = planUnitTests({
      changedFiles: [{ status: "M", path: "src/tools/interactive-policy.ts" }],
      allTestFiles: [
        "src/channels/gateway-core.test.ts",
        "src/tools/client-toolset.test.ts",
      ],
      impactIndex,
    });

    expect(result.selectedTests).toContain("src/channels/gateway-core.test.ts");
  });

  test("source files read through literal file URLs are direct dependencies", () => {
    expect(impactIndex.familyDependencies.get("cli")).toContain(
      "src/utils/image-resize.ts",
    );
  });

  test("tracked documentation imports are direct dependencies", () => {
    expect(impactIndex.familyDependencies.get("cli")).toContain(
      "docs/examples/mods/learning/memory-citations.env.json",
    );
  });

  test("literal calls through source-reader helpers are direct dependencies", () => {
    expect(impactIndex.familyDependencies.get("cli")).toContain(
      "src/auth/setup-ui.tsx",
    );
    expect(impactIndex.familyDependencies.get("tools")).toContain(
      "src/websocket/listener/turn.ts",
    );
    expect(impactIndex.familyDependencies.get(ROOT_FAMILY)).toContain(
      "src/cli/profile-selection.tsx",
    );
  });
});
