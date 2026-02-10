import { describe, expect, test } from "bun:test";
import {
  isHeadlessAutoAllowTool,
  isInteractiveApprovalTool,
  requiresRuntimeUserInput,
} from "../../tools/interactivePolicy";

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

  test("marks headless auto-allow tools", () => {
    expect(isHeadlessAutoAllowTool("EnterPlanMode")).toBe(true);
    expect(isHeadlessAutoAllowTool("AskUserQuestion")).toBe(false);
    expect(isHeadlessAutoAllowTool("ExitPlanMode")).toBe(false);
  });
});
