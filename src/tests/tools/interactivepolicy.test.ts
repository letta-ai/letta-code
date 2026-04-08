import { describe, expect, test } from "bun:test";
import {
  getYoloPlanModeApprovalPolicy,
  isHeadlessAutoAllowTool,
  isInteractiveApprovalTool,
  requiresRuntimeUserInput,
  shouldAutoApproveEnterPlanMode,
  shouldAutoApproveExitPlanMode,
} from "../../tools/interactivePolicy";

const ENV_KEYS = [
  "LETTA_YOLO_PLAN_MODE_APPROVAL",
  "LETTA_AUTO_APPROVE_PLAN_MODE",
  "LETTA_AUTO_APPROVE_ENTER_PLAN_MODE",
  "LETTA_AUTO_APPROVE_EXIT_PLAN_MODE",
] as const;

function withCleanEnv(run: () => void): void {
  const original = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("interactive tool policy", () => {
  test("marks interactive approval tools", () => {
    expect(isInteractiveApprovalTool("AskUserQuestion")).toBe(true);
    expect(isInteractiveApprovalTool("EnterPlanMode")).toBe(true);
    expect(isInteractiveApprovalTool("ExitPlanMode")).toBe(true);
    expect(isInteractiveApprovalTool("TodoWrite")).toBe(false);
  });

  test("marks runtime user input tools", () => {
    expect(requiresRuntimeUserInput("AskUserQuestion")).toBe(true);
    expect(requiresRuntimeUserInput("ExitPlanMode")).toBe(true);
    expect(requiresRuntimeUserInput("EnterPlanMode")).toBe(false);
  });

  test("defaults YOLO plan-mode policy to manual", () => {
    withCleanEnv(() => {
      expect(getYoloPlanModeApprovalPolicy()).toBe("manual");
      expect(shouldAutoApproveEnterPlanMode()).toBe(false);
      expect(shouldAutoApproveExitPlanMode()).toBe(false);
      expect(isHeadlessAutoAllowTool("EnterPlanMode")).toBe(false);
      expect(isHeadlessAutoAllowTool("ExitPlanMode")).toBe(false);
      expect(isHeadlessAutoAllowTool("AskUserQuestion")).toBe(false);
    });
  });

  test("supports env policy values", () => {
    withCleanEnv(() => {
      process.env.LETTA_YOLO_PLAN_MODE_APPROVAL = "enter_only";
      expect(getYoloPlanModeApprovalPolicy()).toBe("enter_only");
      expect(shouldAutoApproveEnterPlanMode()).toBe(true);
      expect(shouldAutoApproveExitPlanMode()).toBe(false);
      expect(isHeadlessAutoAllowTool("EnterPlanMode")).toBe(true);
      expect(isHeadlessAutoAllowTool("ExitPlanMode")).toBe(false);

      process.env.LETTA_YOLO_PLAN_MODE_APPROVAL = "enter_and_exit";
      expect(getYoloPlanModeApprovalPolicy()).toBe("enter_and_exit");
      expect(shouldAutoApproveEnterPlanMode()).toBe(true);
      expect(shouldAutoApproveExitPlanMode()).toBe(true);
      expect(isHeadlessAutoAllowTool("EnterPlanMode")).toBe(true);
      expect(isHeadlessAutoAllowTool("ExitPlanMode")).toBe(true);
    });
  });

  test("ignores invalid env policy values", () => {
    withCleanEnv(() => {
      process.env.LETTA_YOLO_PLAN_MODE_APPROVAL = "wat";
      expect(getYoloPlanModeApprovalPolicy()).toBe("manual");
      expect(shouldAutoApproveEnterPlanMode()).toBe(false);
      expect(shouldAutoApproveExitPlanMode()).toBe(false);
    });
  });

  test("invalid env policy does not block legacy flags", () => {
    withCleanEnv(() => {
      process.env.LETTA_YOLO_PLAN_MODE_APPROVAL = "wat";
      process.env.LETTA_AUTO_APPROVE_EXIT_PLAN_MODE = "1";
      expect(getYoloPlanModeApprovalPolicy()).toBe("manual");
      expect(shouldAutoApproveEnterPlanMode()).toBe(false);
      expect(shouldAutoApproveExitPlanMode()).toBe(true);
    });
  });

  test("preserves legacy auto-approve env flags", () => {
    withCleanEnv(() => {
      process.env.LETTA_AUTO_APPROVE_ENTER_PLAN_MODE = "1";
      expect(shouldAutoApproveEnterPlanMode()).toBe(true);
      expect(shouldAutoApproveExitPlanMode()).toBe(false);

      delete process.env.LETTA_AUTO_APPROVE_ENTER_PLAN_MODE;
      process.env.LETTA_AUTO_APPROVE_EXIT_PLAN_MODE = "1";
      expect(shouldAutoApproveEnterPlanMode()).toBe(false);
      expect(shouldAutoApproveExitPlanMode()).toBe(true);

      process.env.LETTA_AUTO_APPROVE_PLAN_MODE = "1";
      expect(shouldAutoApproveEnterPlanMode()).toBe(true);
      expect(shouldAutoApproveExitPlanMode()).toBe(true);
    });
  });
});
