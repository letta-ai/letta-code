import { expect, test } from "bun:test";
import {
  consumeSubagentLaunch,
  SUBAGENT_LAUNCH_ENV,
} from "./subagent-launch-marker";

test("only the Agent-launched process consumes the marker; descendants still inherit parent identity", () => {
  const env = {
    [SUBAGENT_LAUNCH_ENV]: "1",
    LETTA_CODE_AGENT_ROLE: "subagent",
    LETTA_PARENT_AGENT_ID: "agent-parent",
  };
  expect(consumeSubagentLaunch(env)).toBe(true);
  expect(env[SUBAGENT_LAUNCH_ENV]).toBeUndefined();
  expect(env.LETTA_PARENT_AGENT_ID).toBe("agent-parent");
  expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
  expect(consumeSubagentLaunch({ ...env })).toBe(false);
});
