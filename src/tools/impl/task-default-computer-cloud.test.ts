import { afterEach, expect, spyOn, test } from "bun:test";
import * as backendModule from "@/backend";
import { DEFAULT_SUBAGENT_COMPUTER_ENV_VAR } from "./subagent-computer";
import { launchSubagent } from "./task";

const originalDefault = process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR];

afterEach(() => {
  if (originalDefault === undefined)
    delete process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR];
  else process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR] = originalDefault;
});

function withRouting() {
  const backend = backendModule.getBackend();
  return spyOn(backendModule, "getBackend").mockReturnValue({
    ...backend,
    capabilities: { ...backend.capabilities, environmentRouting: true },
  } as ReturnType<typeof backendModule.getBackend>);
}

test.each([
  {
    computer: undefined,
    error: "cloud.sandbox_size must be regular, large, or xlarge",
  },
  { computer: "local", error: 'cloud requires computer: "cloud"' },
])(
  "validates cloud options against the resolved default computer (%j)",
  async ({ computer, error }) => {
    process.env[DEFAULT_SUBAGENT_COMPUTER_ENV_VAR] = "cloud";
    const spy = withRouting();
    try {
      const result = await launchSubagent({
        harness: "claude-code",
        description: "Fix the bug",
        prompt: "Fix the bug",
        computer,
        cloud: { sandbox_size: "huge" },
      });
      expect(result).toEqual({ success: false, error });
    } finally {
      spy.mockRestore();
    }
  },
);
