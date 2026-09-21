import { expect, test } from "bun:test";
import { isRuntimeStartExternalToolsGroup } from "./external-tool-protocol";

test("accepts the closed Slack wrapper marker but rejects arbitrary execution instructions", () => {
  const tool = {
    name: "start_thread_session",
    description: "Start a thread worker",
    parameters: {},
  };
  expect(isRuntimeStartExternalToolsGroup({ tools: [tool] })).toBe(true);
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [{ ...tool, execution: "slack_thread_dispatch" }],
    }),
  ).toBe(true);
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [{ ...tool, execution: "arbitrary-agent-command" }],
    }),
  ).toBe(false);
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [{ ...tool, execution: { shell: "unsafe" } }],
    }),
  ).toBe(false);
});
