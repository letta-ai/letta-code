import { afterEach, expect, test } from "bun:test";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";
import {
  __testOverrideVariablesBackend,
  refreshAndListVariables,
} from "@/utils/variables-store";
import {
  createSharedReminderState,
  markPostCompactionContextRemindersPending,
} from "./state";
import { buildVariablesInfoReminder } from "./variables";

const id = "agent-variable-reminder";
afterEach(() => {
  __testOverrideVariablesBackend(null);
  clearSecretsCache(id);
});
test("reminder tracks value changes, removals, and compaction", async () => {
  let values = [{ key: "USERNAME", value: "first-account" }];
  __testOverrideVariablesBackend({
    retrieveAgent: async () => ({ variables: values }),
  });
  __testSeedSecretsCache(id, {});
  const context = { agent: { id }, state: createSharedReminderState() };
  expect(await buildVariablesInfoReminder(context)).toContain("first-account");
  expect(await buildVariablesInfoReminder(context)).toBeNull();
  values = [{ key: "USERNAME", value: "second-account" }];
  await refreshAndListVariables(id);
  expect(await buildVariablesInfoReminder(context)).toContain("second-account");
  markPostCompactionContextRemindersPending(context.state);
  expect(await buildVariablesInfoReminder(context)).toContain("second-account");
  values = [];
  await refreshAndListVariables(id);
  expect(await buildVariablesInfoReminder(context)).toContain(
    "No variables are currently set.",
  );
  expect(await buildVariablesInfoReminder(context)).toBeNull();
});
