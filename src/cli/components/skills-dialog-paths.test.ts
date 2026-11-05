import { expect, test } from "bun:test";
import {
  getSkillsCreationHint,
  getSkillsTabDescription,
} from "./skills-dialog-paths";

const env = {
  HOME: "/Users/alice",
  LETTA_CONFIG_DIR: "/Users/alice/.dream",
} as NodeJS.ProcessEnv;

test("skills dialog locations follow the active product root", () => {
  expect(getSkillsTabDescription("project", "agent-123", env)).toBe(
    ".agents/skills/",
  );
  expect(getSkillsTabDescription("agent", "agent-123", env)).toBe(
    "/Users/alice/.dream/agents/agent-123/memory/skills/",
  );
  expect(getSkillsTabDescription("global", "agent-123", env)).toBe(
    "/Users/alice/.dream/skills/",
  );
  expect(getSkillsCreationHint("agent-123", env)).not.toContain(
    "/Users/alice/.letta",
  );
});
