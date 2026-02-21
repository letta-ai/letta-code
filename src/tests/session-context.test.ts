import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "../cli/helpers/sessionContext";

describe("session context reminder", () => {
  test("includes device information section", () => {
    const context = buildSessionContext();

    expect(context).toContain("## Device Information");
    expect(context).toContain("**Local time**");
    expect(context).toContain("**Device type**");
    expect(context).toContain("**Letta Code version**");
    expect(context).toContain("**Current working directory**");
  });

  test("does not include agent information section", () => {
    const context = buildSessionContext();

    expect(context).not.toContain("## Agent Information");
    expect(context).not.toContain("Agent ID");
    expect(context).not.toContain("Agent name");
    expect(context).not.toContain("Server location");
  });
});
