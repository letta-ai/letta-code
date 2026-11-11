import { afterEach, expect, test } from "bun:test";
import { setCurrentAgentId } from "@/agent/context";
import { __testOverrideVariablesRequest } from "@/utils/variables-store";
import { handleVariableCommand } from "./variable";

afterEach(() => {
  __testOverrideVariablesRequest(null);
  setCurrentAgentId(null);
});
test("slash command writes values, lists values, and removes values", async () => {
  const values: Record<string, string> = {};
  __testOverrideVariablesRequest(
    async <T>(method: string, path: string, body?: Record<string, unknown>) => {
      const key = path.split("/").at(-1) as string;
      if (method === "PUT") values[key] = body?.value as string;
      if (method === "DELETE") delete values[key];
      return Object.entries(values).map(([key, value]) => ({
        key,
        value,
      })) as T;
    },
  );
  setCurrentAgentId("agent-variable-command");
  expect(
    (await handleVariableCommand(["set", "username", "example-account"]))
      .output,
  ).toContain("set.");
  expect((await handleVariableCommand(["list"])).output).toContain(
    '$USERNAME = "example-account"',
  );
  expect((await handleVariableCommand(["unset", "USERNAME"])).output).toContain(
    "unset.",
  );
  expect((await handleVariableCommand(["list"])).output).toContain(
    "No variables stored.",
  );
});
