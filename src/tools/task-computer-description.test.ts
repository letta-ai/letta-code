import { expect, test } from "bun:test";
import { DEFAULT_SUBAGENT_COMPUTER_ENV_VAR } from "./impl/subagent-computer";
import TaskSchema from "./schemas/Task.json";
import { buildTaskSchema } from "./tool-definitions";

test("describes where an Agent launch with no computer will run", () => {
  expect(buildTaskSchema({})).toBe(TaskSchema);
  expect(buildTaskSchema({ [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: "self" })).toBe(
    TaskSchema,
  );

  const cloud = buildTaskSchema({
    [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: " cloud ",
  }).properties.computer.description;
  expect(cloud).toContain(
    "Omitting computer sends eligible workers to a fresh Cloud sandbox",
  );
  expect(cloud).toContain("this machine's files are unavailable");
  expect(cloud).toContain('Pass "local" to stay on this machine');

  const remote = buildTaskSchema({
    [DEFAULT_SUBAGENT_COMPUTER_ENV_VAR]: "workstation",
  }).properties.computer.description;
  expect(remote).toContain('the connected computer "workstation"');
});
