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
    expect(isInteractiveApprovalTool("RequestFileUpload")).toBe(true);
    expect(isInteractiveApprovalTool("TodoWrite")).toBe(false);
  });

  test("marks runtime user input tools", () => {
    expect(requiresRuntimeUserInput("AskUserQuestion")).toBe(true);
    expect(requiresRuntimeUserInput("RequestFileUpload")).toBe(true);
    expect(requiresRuntimeUserInput("TodoWrite")).toBe(false);
  });

  test("marks headless auto-allow tools", () => {
    expect(isHeadlessAutoAllowTool("AskUserQuestion")).toBe(false);
    expect(isHeadlessAutoAllowTool("RequestFileUpload")).toBe(false);
  });

  test("leaves file uploads on generic channel approval", () => {
    expect(getInteractiveApprovalKind("RequestFileUpload")).toBeNull();
  });
});
