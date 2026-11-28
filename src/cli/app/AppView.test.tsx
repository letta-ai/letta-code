import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { AppView } from "@/cli/app/AppView";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";

function contains(node: ReactNode, component: unknown): boolean {
  return Children.toArray(node).some(
    (child) =>
      isValidElement<{ children?: ReactNode }>(child) &&
      (child.type === component || contains(child.props.children, component)),
  );
}

test("memory yields to approvals and user questions, then resumes", () => {
  const state = { memory: { agentId: "agent", entries: [] }, notices: [] };
  const view = {
    state,
    store: {},
    input: {},
    liveItems: [],
    loadingState: "ready",
  } as unknown as Parameters<typeof AppView>[0];
  expect(contains(AppView(view), MemfsTreeViewer)).toBe(true);
  const approval = { name: "Write", input: {}, resolve: () => {} };
  const approving = AppView({
    ...view,
    approval,
    currentApproval: { toolName: "Write", toolCallId: "c", toolArgs: "{}" },
  });
  expect(contains(approving, ApprovalSwitch)).toBe(true);
  expect(contains(approving, MemfsTreeViewer)).toBe(false);
  const asking = AppView({
    ...view,
    state: {
      ...view.state,
      question: { toolCallId: "q", questions: [] } as never,
    },
  });
  expect(contains(asking, InlineQuestionApproval)).toBe(true);
  expect(contains(asking, MemfsTreeViewer)).toBe(false);
  expect(contains(AppView(view), MemfsTreeViewer)).toBe(true);
});
