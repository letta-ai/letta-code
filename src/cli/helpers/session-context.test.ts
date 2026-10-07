import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "@/cli/helpers/session-context";
import { detectShellContext } from "@/utils/shell-context";

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

  test("describes refreshed context after compaction", () => {
    const context = buildSessionContext({ reason: "post_compaction" });

    expect(context).toContain(
      "Conversation history was compacted. Refreshed environment context follows.",
    );
  });

  test("names zsh as the shell on macOS", () => {
    const context = buildSessionContext({ platform: "darwin" });

    expect(context).toContain(
      "- **Device type**: macOS\n- **Shell**: zsh\n- **Letta Code version**",
    );
    expect(context).not.toContain("## Windows Shell Notes");
  });

  test("names the launcher shell on linux", () => {
    expect(
      buildSessionContext({
        platform: "linux",
        shellContext: detectShellContext({} as NodeJS.ProcessEnv, "linux"),
      }),
    ).toContain("- **Device type**: Linux\n- **Shell**: bash\n");
    expect(
      buildSessionContext({
        platform: "linux",
        shellContext: detectShellContext(
          { SHELL: "/usr/bin/zsh" } as NodeJS.ProcessEnv,
          "linux",
        ),
      }),
    ).toContain("- **Shell**: zsh\n");
  });

  test("keeps Windows shell notes and omits the Unix shell line", () => {
    const context = buildSessionContext({
      platform: "win32",
      shellContext: { family: "powershell", displayName: "PowerShell 7" },
    });

    expect(context).toContain(
      "- **Device type**: Windows\n- **Letta Code version**",
    );
    expect(context).not.toContain("**Shell**");
    expect(context).toContain("## Windows Shell Notes");
    expect(context).toContain("Detected shell: PowerShell 7");
  });
});
