import { describe, expect, test } from "bun:test";
import {
  getInteractiveApprovalKind,
  isHeadlessAutoAllowTool,
  isInteractiveApprovalTool,
  requiresRuntimeUserInput,
} from "@/tools/interactive-policy";

describe("interactive tool policy", () => {
  test("marks interactive approval tools", () => {
    expect(isInteractiveApprovalTool("AskUserQuestion")).toBe(true);
    expect(isInteractiveApprovalTool("MessageChannel", { action: "ask" })).toBe(
      true,
    );
    expect(
      isInteractiveApprovalTool("MessageChannel", { action: " ASK " }),
    ).toBe(true);
    expect(
      isInteractiveApprovalTool("MessageChannel", { action: "send" }),
    ).toBe(false);
    expect(isInteractiveApprovalTool("TodoWrite")).toBe(false);
  });

  test("maps interactive approval kinds", () => {
    expect(getInteractiveApprovalKind("AskUserQuestion")).toBe(
      "ask_user_question",
    );
    expect(
      getInteractiveApprovalKind("MessageChannel", { action: "ask" }),
    ).toBe("ask_user_question");
    expect(
      getInteractiveApprovalKind("MessageChannel", { action: " ASK " }),
    ).toBe("ask_user_question");
    expect(
      getInteractiveApprovalKind("MessageChannel", { action: "send" }),
    ).toBe(null);
  });

  test("marks runtime user input tools", () => {
    expect(requiresRuntimeUserInput("AskUserQuestion")).toBe(true);
    expect(requiresRuntimeUserInput("MessageChannel", { action: "ask" })).toBe(
      true,
    );
    expect(requiresRuntimeUserInput("TodoWrite")).toBe(false);
  });

  test("marks headless auto-allow tools", () => {
    expect(isHeadlessAutoAllowTool("AskUserQuestion")).toBe(false);
  });
});
