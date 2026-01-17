import { describe, expect, test } from "bun:test";
import {
  isApprovalPendingError,
  isApprovalStateDesyncError,
} from "../agent/approval-recovery";

/**
 * Tests for approval error detection helpers (LET-7101).
 *
 * These functions detect two opposite error conditions:
 * 1. isApprovalStateDesyncError: Sent approval, but server has no pending approval
 * 2. isApprovalPendingError: Sent user message, but server has pending approval waiting
 */

describe("isApprovalStateDesyncError", () => {
  test("detects desync error in detail string", () => {
    const detail = "No tool call is currently awaiting approval";
    expect(isApprovalStateDesyncError(detail)).toBe(true);
  });

  test("detects desync error case-insensitively", () => {
    const detail = "NO TOOL CALL IS CURRENTLY AWAITING APPROVAL";
    expect(isApprovalStateDesyncError(detail)).toBe(true);
  });

  test("detects desync error in longer message", () => {
    const detail =
      "Error: No tool call is currently awaiting approval. The approval request may have expired.";
    expect(isApprovalStateDesyncError(detail)).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isApprovalStateDesyncError("Connection timeout")).toBe(false);
    expect(isApprovalStateDesyncError("Internal server error")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isApprovalStateDesyncError(null)).toBe(false);
    expect(isApprovalStateDesyncError(undefined)).toBe(false);
    expect(isApprovalStateDesyncError(123)).toBe(false);
    expect(isApprovalStateDesyncError({ error: "test" })).toBe(false);
  });
});

describe("isApprovalPendingError", () => {
  // This is the actual error format from the Letta backend (screenshot from LET-7101)
  const REAL_ERROR_DETAIL =
    "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.";

  test("detects approval pending error in real error format", () => {
    expect(isApprovalPendingError(REAL_ERROR_DETAIL)).toBe(true);
  });

  test("detects approval pending error case-insensitively", () => {
    expect(isApprovalPendingError("CANNOT SEND A NEW MESSAGE")).toBe(true);
    expect(isApprovalPendingError("cannot send a new message")).toBe(true);
  });

  test("detects partial match in longer message", () => {
    const detail = "Error occurred: Cannot send a new message while processing";
    expect(isApprovalPendingError(detail)).toBe(true);
  });

  test("returns false for desync errors (opposite case)", () => {
    // These are the OPPOSITE error - when we send approval but there's nothing pending
    expect(
      isApprovalPendingError("No tool call is currently awaiting approval"),
    ).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isApprovalPendingError("Connection timeout")).toBe(false);
    expect(isApprovalPendingError("Rate limit exceeded")).toBe(false);
    expect(isApprovalPendingError("Invalid API key")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isApprovalPendingError(null)).toBe(false);
    expect(isApprovalPendingError(undefined)).toBe(false);
    expect(isApprovalPendingError(123)).toBe(false);
    expect(isApprovalPendingError({ detail: REAL_ERROR_DETAIL })).toBe(false);
  });
});

/**
 * Note: Full integration testing of lazy approval recovery requires:
 * 1. Starting CLI without --yolo
 * 2. Sending a prompt that triggers a tool call requiring approval
 * 3. Instead of approving, sending another user message
 * 4. Verifying the CONFLICT error is detected and recovery happens
 *
 * This is complex to automate reliably in unit tests.
 * Manual testing or a dedicated integration test suite is recommended.
 */
