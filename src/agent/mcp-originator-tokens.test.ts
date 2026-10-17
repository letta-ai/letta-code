import { afterEach, describe, expect, test } from "bun:test";
import {
  clearMcpOriginatorTokens,
  deleteMcpOriginatorToken,
  getMcpOriginatorToken,
  mcpOriginatorTokenCount,
  readMcpOriginatorDelivery,
  setMcpOriginatorToken,
} from "./mcp-originator-tokens";

describe("MCP originator token store", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
  });

  test("stores and resolves a token keyed by super run id", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
    expect(mcpOriginatorTokenCount()).toBe(1);
  });

  test("never leaks a token across super runs", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
    expect(getMcpOriginatorToken("sr-3")).toBeUndefined();
    deleteMcpOriginatorToken("sr-1");
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
  });

  test("a re-delivered run replaces its older token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-1", "mst_one.secret-c");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-c");
  });

  test("resolving a missing or empty super run id yields nothing", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    expect(getMcpOriginatorToken(undefined)).toBeUndefined();
    expect(getMcpOriginatorToken(null)).toBeUndefined();
    expect(getMcpOriginatorToken("")).toBeUndefined();
  });

  test("clearing the store drops every run's token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    clearMcpOriginatorTokens();
    expect(mcpOriginatorTokenCount()).toBe(0);
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
  });
});

describe("readMcpOriginatorDelivery", () => {
  test("parses a complete delivery", () => {
    expect(
      readMcpOriginatorDelivery({
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    ).toEqual({ superRunId: "sr-1", token: "mst_one.secret-a" });
  });

  test("treats a missing token as an unattributed delivery", () => {
    expect(readMcpOriginatorDelivery({ super_run_id: "sr-1" })).toEqual({
      superRunId: "sr-1",
    });
    expect(readMcpOriginatorDelivery({})).toEqual({});
  });

  test("ignores malformed wire values instead of trusting them", () => {
    expect(
      readMcpOriginatorDelivery({
        super_run_id: 42 as unknown as string,
        mcp_originator_token: "mst_one.secret-a",
      }),
    ).toEqual({ token: "mst_one.secret-a" });
    expect(
      readMcpOriginatorDelivery({
        super_run_id: "sr-1",
        mcp_originator_token: "",
      }),
    ).toEqual({ superRunId: "sr-1" });
  });
});
