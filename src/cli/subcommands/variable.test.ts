import { expect, test } from "bun:test";
import { runVariableSubcommand } from "./variable";

test("variable CLI sets plain values from argv, environment, and stdin", async () => {
  const writes: Array<[string, string, string | undefined]> = [];
  const deps = {
    initializeSettings: async () => {},
    setVariable: async (key: string, value: string, id?: string) => {
      writes.push([key, value, id]);
    },
    readStdin: async () => "piped-account\n",
  };
  expect(
    await runVariableSubcommand(
      ["set", "username", "example-user", "--agent", "agent-example"],
      deps,
    ),
  ).toBe(0);
  expect(
    await runVariableSubcommand(["set", "username", "--stdin"], deps),
  ).toBe(0);
  expect(writes).toEqual([
    ["USERNAME", "example-user", "agent-example"],
    ["USERNAME", "piped-account", undefined],
  ]);
  expect(
    await runVariableSubcommand(
      ["set", "USERNAME", "--env", "A", "--stdin"],
      deps,
    ),
  ).toBe(1);
});
