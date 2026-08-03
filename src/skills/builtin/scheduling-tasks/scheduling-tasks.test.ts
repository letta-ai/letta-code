import { describe, expect, test } from "bun:test";
import schedulingTasksSkill from "./SKILL.md";

describe("scheduling-tasks skill", () => {
  test("documents Cloud schedule creation precedence", () => {
    expect(schedulingTasksSkill).toContain(
      "No explicit choice**: create a durable Cloud timer targeted to the verified computer that runs `letta cron add`",
    );
    expect(schedulingTasksSkill).toContain(
      "**`--computer <id>`**: select another connected computer",
    );
    expect(schedulingTasksSkill).toContain(
      "**`--runner cloud`**: select the managed Cloud sandbox",
    );
    expect(schedulingTasksSkill).toContain(
      "**`--runner local`**: create an in-process schedule",
    );
    expect(schedulingTasksSkill).toContain(
      "If the current computer cannot be verified as Cloud-routable, default creation fails",
    );
    expect(schedulingTasksSkill).toContain(
      "An API server without durable Cloud schedule routes fails creation instead of silently writing a local schedule",
    );
    expect(schedulingTasksSkill).toContain(
      "can fall back to the agent sandbox when its target is offline. It never substitutes another device",
    );
    expect(schedulingTasksSkill).not.toContain(
      "**`cloud`** (default for cloud agents)",
    );
  });
});
