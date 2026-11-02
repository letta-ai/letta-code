import { describe, expect, test } from "bun:test";
import {
  acceptsDefaultComputer,
  DEFAULT_SUBAGENT_COMPUTER_ENV_VAR,
  isLocalComputerSelector,
  resolveLaunchComputer,
  resolveSubagentComputer,
} from "./subagent-computer";

const implementation = { fork: false, launchProfile: "default" } as const;
const forked = { fork: true, launchProfile: "default" } as const;
const memory = { fork: false, launchProfile: "memory-subagent" } as const;

function resolve(
  requested: unknown,
  config: Parameters<typeof resolveSubagentComputer>[0]["config"],
  value?: string,
  subagentType = "general-purpose",
) {
  return resolveSubagentComputer({
    requested,
    subagentType,
    config,
    env:
      value === undefined ? {} : { [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: value },
  });
}

describe("resolveSubagentComputer", () => {
  test.each([undefined, null, "", " \t\n ", 42, {}])(
    "stays local for %j with no default set",
    (requested) => {
      expect(resolve(requested, implementation)).toEqual({
        computer: undefined,
        source: "none",
      });
    },
  );

  test("uses the env default when no computer is requested", () => {
    expect(resolve(undefined, implementation, "cloud")).toEqual({
      computer: "cloud",
      source: "default",
    });
  });

  test.each(["", "   "])("treats a blank env default %j as unset", (value) => {
    expect(resolve(undefined, implementation, value)).toEqual({
      computer: undefined,
      source: "none",
    });
  });

  test("trims the env default", () => {
    expect(resolve(undefined, implementation, "  cloud \n")).toEqual({
      computer: "cloud",
      source: "default",
    });
  });

  test("forwards a non-cloud env default unchanged", () => {
    expect(resolve(undefined, implementation, "office-mac")).toEqual({
      computer: "office-mac",
      source: "default",
    });
  });

  test("an explicit computer overrides the env default", () => {
    expect(resolve(" office-mac ", implementation, "cloud")).toEqual({
      computer: "office-mac",
      source: "explicit",
    });
  });

  test.each(["local", "self", "LOCAL", " Self "])(
    "explicit %j forces the current machine over the env default",
    (requested) => {
      expect(resolve(requested, implementation, "cloud")).toEqual({
        computer: undefined,
        source: "explicit",
      });
    },
  );

  test.each(["local", "self"])("an env default of %j is a no-op", (value) => {
    expect(resolve(undefined, implementation, value)).toEqual({
      computer: undefined,
      source: "none",
    });
  });

  test.each([
    ["forks", forked],
    ["memory-profile subagents", memory],
  ])("%s ignore the env default", (_label, config) => {
    expect(resolve(undefined, config, "cloud")).toEqual({
      computer: undefined,
      source: "none",
    });
  });

  test.each([
    ["forks", forked],
    ["memory-profile subagents", memory],
  ])("%s still accept an explicit computer", (_label, config) => {
    expect(resolve("office-mac", config, "cloud")).toEqual({
      computer: "office-mac",
      source: "explicit",
    });
  });

  test("a subagent named memory ignores the default even without the profile", () => {
    expect(resolve(undefined, implementation, "cloud", "memory")).toEqual({
      computer: undefined,
      source: "none",
    });
  });

  test("reads process.env when no env is injected", () => {
    const previous = process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR];
    process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR] = "cloud";
    try {
      expect(
        resolveSubagentComputer({
          requested: undefined,
          subagentType: "general-purpose",
          config: implementation,
        }),
      ).toEqual({ computer: "cloud", source: "default" });
    } finally {
      if (previous === undefined) {
        delete process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR];
      } else {
        process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR] = previous;
      }
    }
  });
});

describe("acceptsDefaultComputer", () => {
  test("accepts plain subagent types", () => {
    expect(
      acceptsDefaultComputer({
        subagentType: "general-purpose",
        config: implementation,
      }),
    ).toBe(true);
  });

  test.each([
    ["fork", "fork", forked],
    ["memory-subagent", "reflection", memory],
    ["memory by name", "memory", implementation],
  ])("rejects %s", (_label, subagentType, config) => {
    expect(acceptsDefaultComputer({ subagentType, config })).toBe(false);
  });
});

describe("resolveLaunchComputer", () => {
  function launch(
    requested: unknown,
    options: {
      value?: string;
      routing?: boolean;
      subagentType?: string;
      config?: Parameters<typeof resolveLaunchComputer>[0]["config"];
      repos?: unknown;
      resolveBranches?: Parameters<
        typeof resolveLaunchComputer
      >[0]["resolveBranches"];
    } = {},
  ) {
    return resolveLaunchComputer({
      requested,
      repos: options.repos,
      resolveBranches: options.resolveBranches,
      subagentType: options.subagentType ?? "general-purpose",
      config: options.config ?? implementation,
      hasEnvironmentRouting: () => options.routing ?? true,
      env:
        options.value === undefined
          ? {}
          : { [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: options.value },
    });
  }

  test("passes the env default through on a routing backend", async () => {
    expect(await launch(undefined, { value: "cloud" })).toEqual({
      computer: "cloud",
    });
  });

  test("drops the env default on a backend that cannot route", async () => {
    expect(await launch(undefined, { value: "cloud", routing: false })).toEqual(
      {},
    );
  });

  test("rejects an explicit computer on a backend that cannot route", async () => {
    const result = await launch("office-mac", { routing: false });
    expect(result.computer).toBeUndefined();
    expect(result.error).toContain(
      "The computer option requires a Letta Cloud backend",
    );
  });

  test("rejects an explicit computer for a memory worker", async () => {
    const result = await launch("office-mac", { subagentType: "memory" });
    expect(result.error).toContain(
      "Memory workers must run on the current machine",
    );
  });

  test("never turns the env default into a memory worker error", async () => {
    expect(
      await launch(undefined, { value: "cloud", subagentType: "memory" }),
    ).toEqual({});
  });

  test("repos route only to a fresh Cloud sandbox", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const repos = ["letta-ai/letta-code", `letta-ai/letta@${sha}`];
    const selector = `cloud:letta-ai/letta-code,letta-ai/letta@${sha}`;
    expect(await launch("cloud", { repos })).toEqual({ computer: selector });
    expect(await launch(undefined, { value: "cloud", repos })).toEqual({
      computer: selector,
    });
    expect(await launch("cloud", { repos: [] })).toEqual({ computer: "cloud" });

    for (const result of await Promise.all([
      launch(undefined, { repos }),
      launch("local", { value: "cloud", repos }),
      launch("office-mac", { repos }),
      launch(undefined, { value: "cloud", config: forked, repos }),
    ]))
      expect(result.error).toContain('pass computer: "cloud"');
    expect(
      await launch(undefined, { value: "cloud", routing: false, repos }),
    ).toEqual({
      error: expect.stringContaining("requires a Letta Cloud backend"),
    });
    expect((await launch("cloud", { repos: ["letta-code"] })).error).toContain(
      'Invalid repo "letta-code"',
    );
    expect(
      (await launch("cloud", { repos: ["letta-ai/letta-code@-x"] })).error,
    ).toContain("owner/repo@<branch>");
    expect(
      (await launch("cloud", { repos: Array(11).fill("letta-ai/letta-code") }))
        .error,
    ).toContain("at most 10");
  });

  test("resolves a branch to its commit before building the selector", async () => {
    const sha = "89abcdef0123456789abcdef0123456789abcdef";
    const seen: unknown[] = [];
    const result = await launch("cloud", {
      repos: ["owner/repo@feature/wip", "owner/other"],
      resolveBranches: async (specs) => {
        seen.push(specs);
        return specs.map(({ branch, ...repository }) =>
          branch ? { ...repository, commit: sha } : repository,
        );
      },
    });
    expect(seen).toEqual([
      [
        { owner: "owner", repo: "repo", branch: "feature/wip" },
        { owner: "owner", repo: "other" },
      ],
    ]);
    expect(result).toEqual({
      computer: `cloud:owner/repo@${sha},owner/other`,
    });
  });

  test("fails the launch when a branch cannot be resolved", async () => {
    const result = await launch("cloud", {
      repos: ["owner/repo@missing"],
      resolveBranches: async () => {
        throw new Error('Branch "missing" not found in owner/repo.');
      },
    });
    expect(result).toEqual({
      error: 'Branch "missing" not found in owner/repo.',
    });
  });

  test("stays local without consulting the backend", async () => {
    const hasEnvironmentRouting = () => {
      throw new Error("backend should not be probed");
    };
    expect(
      await resolveLaunchComputer({
        requested: undefined,
        subagentType: "general-purpose",
        config: implementation,
        hasEnvironmentRouting,
        env: {},
      }),
    ).toEqual({});
  });
});

describe("isLocalComputerSelector", () => {
  test.each(["local", "self", " LOCAL ", "Self"])("accepts %j", (value) => {
    expect(isLocalComputerSelector(value)).toBe(true);
  });

  test.each(["cloud", "office-mac", "localhost", "myself", ""])(
    "rejects %j",
    (value) => {
      expect(isLocalComputerSelector(value)).toBe(false);
    },
  );
});
