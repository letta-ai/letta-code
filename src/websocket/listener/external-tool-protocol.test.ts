import { expect, test } from "bun:test";
import { isRuntimeStartExternalToolsGroup } from "./external-tool-protocol";

test("accepts the Agent wrapper marker but rejects arbitrary execution instructions", () => {
  const tool = {
    name: "review_task",
    description: "Start a review worker",
    parameters: {},
  };
  expect(isRuntimeStartExternalToolsGroup({ tools: [tool] })).toBe(true);
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [{ ...tool, execution: "agent" }],
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
