import { describe, expect, test } from "bun:test";
import {
  mergeClientToolsetFields,
  resolveTurnToolSelection,
} from "./tool-policy";

describe("resolveTurnToolSelection", () => {
  const policy = {
    toolset: { base: "none" as const, include: ["AskUserQuestion"] },
    allowlist: ["Read", "lookup_ticket"],
    exclude_interactive: true,
  };

  test("fills each field the turn leaves unset from the policy", () => {
    expect(
      resolveTurnToolSelection(
        { clientToolset: { base: "default" }, excludeInteractiveTools: false },
        policy,
      ),
    ).toEqual({
      clientToolset: { base: "default", include: ["AskUserQuestion"] },
      clientToolAllowlist: ["Read", "lookup_ticket"],
      excludeInteractiveTools: false,
    });
  });

  test("a turn allowlist only narrows the policy allowlist", () => {
    expect(
      resolveTurnToolSelection(
        { clientToolAllowlist: ["Bash", "lookup_ticket"] },
        policy,
      ).clientToolAllowlist,
    ).toEqual(["lookup_ticket"]);
    expect(
      resolveTurnToolSelection({ clientToolAllowlist: [] }, policy)
        .clientToolAllowlist,
    ).toEqual([]);
  });

  test("without a policy the turn's fields pass through unchanged", () => {
    expect(
      resolveTurnToolSelection({ clientToolAllowlist: ["Bash"] }, undefined),
    ).toEqual({ clientToolAllowlist: ["Bash"] });
    expect(resolveTurnToolSelection({}, undefined)).toEqual({});
  });
});

test("mergeClientToolsetFields keeps a saved include when the turn sets only base", () => {
  expect(
    mergeClientToolsetFields(
      { base: "none" },
      { include: ["AskUserQuestion"] },
    ),
  ).toEqual({ base: "none", include: ["AskUserQuestion"] });
  expect(
    mergeClientToolsetFields({ include: [] }, { include: ["AskUserQuestion"] }),
  ).toEqual({ include: [] });
  expect(mergeClientToolsetFields(undefined, undefined)).toBeUndefined();
});
