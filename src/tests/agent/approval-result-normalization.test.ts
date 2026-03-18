import { describe, expect, test } from "bun:test";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "../../agent/approval-execution";
import {
  normalizeApprovalResultsForPersistence,
  normalizeOutgoingApprovalMessages,
} from "../../agent/approval-result-normalization";
import { INTERRUPTED_BY_USER } from "../../constants";

describe("normalizeApprovalResultsForPersistence", () => {
  test("converts legacy approved approval payloads with tool_return into tool results", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "approval",
        tool_call_id: "call-legacy",
        approve: true,
        tool_return: "legacy result",
      } as unknown as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals);

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-legacy",
      tool_return: "legacy result",
      status: "success",
    });
  });

  test("forces status=error for structured interrupted tool_call_ids", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-1",
        tool_return: "some return",
        status: "success",
      } as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals, {
      interruptedToolCallIds: ["call-1"],
    });

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-1",
      status: "error",
    });
  });

  test("does not modify non-interrupted tool results", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-2",
        tool_return: "ok",
        status: "success",
      } as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals, {
      interruptedToolCallIds: ["other-id"],
    });

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-2",
      status: "success",
    });
  });

  test("supports legacy fallback on interrupt text when explicitly enabled", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-3",
        tool_return: [{ type: "text", text: INTERRUPTED_BY_USER }],
        status: "success",
      } as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals, {
      allowInterruptTextFallback: true,
    });

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-3",
      status: "error",
    });
  });

  test("prepends verbose approval comment to string tool returns", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-4",
        tool_return: "bash output",
        status: "success",
        reason: "Ship it",
      } as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals);

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-4",
      status: "success",
      tool_return: [
        {
          type: "text",
          text: 'The user approved the tool execution with the following comment: "Ship it"',
        },
        { type: "text", text: "bash output" },
      ],
    });
  });

  test("prepends verbose approval comment to structured tool returns", () => {
    const approvals: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call-5",
        tool_return: [{ type: "text", text: "line 1" }],
        status: "success",
        reason: "Run exactly this",
      } as ApprovalResult,
    ];

    const normalized = normalizeApprovalResultsForPersistence(approvals);

    expect(normalized[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-5",
      status: "success",
      tool_return: [
        {
          type: "text",
          text: 'The user approved the tool execution with the following comment: "Run exactly this"',
        },
        { type: "text", text: "line 1" },
      ],
    });
  });
});

describe("normalizeOutgoingApprovalMessages", () => {
  test("canonicalizes malformed approved approval payloads before sending", () => {
    const approvalMessage: ApprovalCreate = {
      type: "approval",
      approvals: [
        {
          type: "approval",
          tool_call_id: "call-legacy",
          approve: true,
          tool_return: "legacy result",
        } as unknown as ApprovalResult,
      ],
    };

    const messages = normalizeOutgoingApprovalMessages([approvalMessage]);
    const normalizedApproval = messages[0] as ApprovalCreate;
    const approvals = normalizedApproval.approvals ?? [];

    expect(approvals[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-legacy",
      tool_return: "legacy result",
      status: "success",
    });
  });

  test("normalizes approvals and preserves non-approval messages", () => {
    const approvalMessage: ApprovalCreate = {
      type: "approval",
      approvals: [
        {
          type: "tool",
          tool_call_id: "call-7",
          tool_return: "foo",
          status: "success",
        } as ApprovalResult,
      ],
    };

    const messages = normalizeOutgoingApprovalMessages(
      [{ role: "user", content: "hello" }, approvalMessage],
      { interruptedToolCallIds: ["call-7"] },
    );

    expect(messages[0]).toMatchObject({ role: "user", content: "hello" });
    const normalizedApproval = messages[1] as ApprovalCreate;
    const approvals = normalizedApproval.approvals ?? [];
    expect(approvals[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-7",
      status: "error",
    });
  });
});
