import { describe, expect, test } from "bun:test";
import {
  checkZaiError,
  formatZaiError,
  isZaiNonRetryableError,
  parseZaiError,
} from "../../cli/helpers/zaiErrors";

describe("parseZaiError", () => {
  test("extracts error from Python repr format", () => {
    const text =
      "Rate limited by OpenAI: Error code: 429 - {'error': {'code': 1302, 'message': 'High concurrency usage exceeds limits'}}";
    const result = parseZaiError(text);
    expect(result).toEqual({
      code: 1302,
      message: "High concurrency usage exceeds limits",
    });
  });

  test("extracts error from JSON format", () => {
    const text =
      'Rate limited by OpenAI: Error code: 429 - {"error": {"code": 1302, "message": "High concurrency usage exceeds limits"}}';
    const result = parseZaiError(text);
    expect(result).toEqual({
      code: 1302,
      message: "High concurrency usage exceeds limits",
    });
  });

  test("extracts auth error code", () => {
    const text =
      "Error from OpenAI: {'error': {'code': 1001, 'message': 'Token expired'}}";
    const result = parseZaiError(text);
    expect(result).toEqual({ code: 1001, message: "Token expired" });
  });

  test("extracts account error code", () => {
    const text =
      "Error: {'error': {'code': 1110, 'message': 'Account in arrears'}}";
    const result = parseZaiError(text);
    expect(result).toEqual({ code: 1110, message: "Account in arrears" });
  });

  test("extracts internal server error code", () => {
    const text =
      "Error: {'error': {'code': 500, 'message': 'Internal server error'}}";
    const result = parseZaiError(text);
    expect(result).toEqual({ code: 500, message: "Internal server error" });
  });

  test("returns null for non-Z.ai errors", () => {
    expect(parseZaiError("Connection timed out")).toBeNull();
    expect(parseZaiError("OpenAI API error: rate limit")).toBeNull();
    expect(parseZaiError("")).toBeNull();
  });

  test("returns null for out-of-range codes", () => {
    const text = "Error: {'error': {'code': 9999, 'message': 'Unknown'}}";
    expect(parseZaiError(text)).toBeNull();
  });

  test("returns null for codes between known ranges", () => {
    const text =
      "Error: {'error': {'code': 1050, 'message': 'Not a real code'}}";
    expect(parseZaiError(text)).toBeNull();
  });
});

describe("formatZaiError", () => {
  test("formats auth errors (1000-1004)", () => {
    const result = formatZaiError(1001, "Token expired");
    expect(result).toBe(
      "Z.ai authentication error: Token expired. Check your Z.ai API key with /connect.",
    );
  });

  test("formats account errors (1100-1121)", () => {
    const result = formatZaiError(1110, "Account in arrears");
    expect(result).toBe(
      "Z.ai account issue: Account in arrears. Check your Z.ai account status.",
    );
  });

  test("formats API errors (1200-1234)", () => {
    const result = formatZaiError(1210, "Unsupported model");
    expect(result).toBe(
      "Z.ai API error: Unsupported model. Try again later or switch providers with /model.",
    );
  });

  test("formats rate/policy errors (1300-1310)", () => {
    const result = formatZaiError(
      1302,
      "High concurrency usage exceeds limits",
    );
    expect(result).toBe(
      "Z.ai rate limit: High concurrency usage exceeds limits. This is a Z.ai limitation. Try again later or switch providers with /model.",
    );
  });

  test("formats internal server error (500)", () => {
    const result = formatZaiError(500, "Internal server error");
    expect(result).toBe(
      "Z.ai internal error. Try again later or switch providers with /model.",
    );
  });
});

describe("checkZaiError", () => {
  test("returns formatted message for realistic server error", () => {
    const errorText =
      "Rate limited by OpenAI: Error code: 429 - {'error': {'code': 1302, 'message': 'Rate limit reached for requests'}}";
    const result = checkZaiError(errorText);
    expect(result).toBe(
      "Z.ai rate limit: Rate limit reached for requests. This is a Z.ai limitation. Try again later or switch providers with /model.",
    );
  });

  test("returns undefined for non-Z.ai errors", () => {
    expect(checkZaiError("Connection timed out")).toBeUndefined();
    expect(checkZaiError("OpenAI rate limit exceeded")).toBeUndefined();
  });
});

describe("isZaiNonRetryableError", () => {
  test("returns true for auth errors", () => {
    const detail =
      "Error: {'error': {'code': 1001, 'message': 'Token expired'}}";
    expect(isZaiNonRetryableError(detail)).toBe(true);
  });

  test("returns true for account errors", () => {
    const detail =
      "Error: {'error': {'code': 1110, 'message': 'Account locked'}}";
    expect(isZaiNonRetryableError(detail)).toBe(true);
  });

  test("returns true for rate/policy errors", () => {
    const detail = "Error: {'error': {'code': 1302, 'message': 'Rate limit'}}";
    expect(isZaiNonRetryableError(detail)).toBe(true);
  });

  test("returns false for API errors (retryable)", () => {
    const detail =
      "Error: {'error': {'code': 1210, 'message': 'Network error'}}";
    expect(isZaiNonRetryableError(detail)).toBe(false);
  });

  test("returns false for internal server errors (retryable)", () => {
    const detail = "Error: {'error': {'code': 500, 'message': 'Server error'}}";
    expect(isZaiNonRetryableError(detail)).toBe(false);
  });

  test("returns false for non-Z.ai errors", () => {
    expect(isZaiNonRetryableError("Connection timed out")).toBe(false);
  });
});
