import { describe, expect, test } from "bun:test";
import {
  getRandomThinkingTip,
  SYSTEM_PROMPT_UPGRADE_TIP,
  THINKING_TIPS,
} from "@/cli/helpers/thinking-messages";

describe("Thinking messages", () => {
  test("returns a tip from the configured tip list", () => {
    const tip = getRandomThinkingTip({
      includeSystemPromptUpgradeTip: false,
    });

    expect(tip.length).toBeGreaterThan(0);
    expect((THINKING_TIPS as readonly string[]).includes(tip)).toBe(true);
  });

  test("can exclude /system upgrade tip from the selection pool", () => {
    const tips = Array.from({ length: 50 }, () =>
      getRandomThinkingTip({ includeSystemPromptUpgradeTip: false }),
    );

    expect(tips.every((tip) => tip !== SYSTEM_PROMPT_UPGRADE_TIP)).toBe(true);
  });
});
