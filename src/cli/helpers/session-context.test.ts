import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "@/cli/helpers/session-context";

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

  test("uses environment-changed intro for intra-session environment switches", () => {
    const context = buildSessionContext({ reason: "environment_changed" });

    expect(context).toContain(
      "The execution environment for this conversation has changed. Updated environment context follows.",
    );
  });
});
