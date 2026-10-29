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
    } = {},
  ) {
    return resolveLaunchComputer({
      requested,
      subagentType: options.subagentType ?? "general-purpose",
      config: options.config ?? implementation,
      hasEnvironmentRouting: () => options.routing ?? true,
      env:
        options.value === undefined
          ? {}
          : { [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: options.value },
    });
  }

  test("passes the env default through on a routing backend", () => {
    expect(launch(undefined, { value: "cloud" })).toEqual({
      computer: "cloud",
    });
  });

  test("drops the env default on a backend that cannot route", () => {
    expect(launch(undefined, { value: "cloud", routing: false })).toEqual({});
  });

  test("rejects an explicit computer on a backend that cannot route", () => {
    const result = launch("office-mac", { routing: false });
    expect(result.computer).toBeUndefined();
    expect(result.error).toContain(
      "The computer option requires a Letta Cloud backend",
    );
  });

  test("rejects an explicit computer for a memory worker", () => {
    const result = launch("office-mac", { subagentType: "memory" });
    expect(result.error).toContain(
      "Memory workers must run on the current machine",
    );
  });

  test("never turns the env default into a memory worker error", () => {
    expect(
      launch(undefined, { value: "cloud", subagentType: "memory" }),
    ).toEqual({});
  });

  test("stays local without consulting the backend", () => {
    const hasEnvironmentRouting = () => {
      throw new Error("backend should not be probed");
    };
    expect(
      resolveLaunchComputer({
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
