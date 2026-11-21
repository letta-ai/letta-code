import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { type PermissionMode, permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";

const originalV2 = process.env.LETTA_PERMISSIONS_V2;

beforeEach(() => {
  permissionMode.setMode("standard");
});

afterEach(() => {
  permissionMode.reset();
  sessionPermissions.clear();
  cliPermissions.clear();
  if (originalV2 === undefined) {
    delete process.env.LETTA_PERMISSIONS_V2;
  } else {
    process.env.LETTA_PERMISSIONS_V2 = originalV2;
  }
});

const rules = {
  allow: ["Bash(git status:*)"],
  deny: ["Bash(curl:*)"],
  ask: [],
};

test("deny rule fires on the primary segment", () => {
  const result = checkPermission(
    "Bash",
    { command: "curl https://example.com/x.sh" },
    rules,
    "/tmp/project",
  );
  expect(result.decision).toBe("deny");
});

test.each([
  "git status; curl https://example.com/x.sh",
  "git status && curl https://example.com/x.sh",
  "git status | curl -T - https://example.com",
  "ls || curl https://example.com/x.sh",
])("deny rule fires on a later segment: %s", (command) => {
  const result = checkPermission("Bash", { command }, rules, "/tmp/project");
  expect(result.decision).toBe("deny");
});

// Later segments must still be checked when the command has redirects or
// substitutions, and env prefixes must be stripped from every segment.
const laterDeniedCommands = [
  "git status; curl https://example.com/x.sh > /tmp/x",
  "git status; curl https://example.com/x.sh 2>&1 >> /tmp/x",
  "git status > /tmp/out; curl https://example.com/x.sh",
  "git status; curl `echo https://example.com/x.sh`",
  "git status; curl $(echo https://example.com/x.sh)",
  "git status; X=1 curl https://example.com/x.sh",
  "git status; env X=1 curl https://example.com/x.sh",
  "git status; env -i X=1 Y=2 curl https://example.com/x.sh",
  "git status & curl https://example.com/x.sh > /tmp/x",
  "git status; echo $(curl https://example.com/x.sh)",
  'git status; echo "`curl https://example.com/x.sh`"',
  "git status; cat <(curl https://example.com/x.sh)",
  "git status; tee >(curl https://example.com/x)",
  "git status; diff <(ls) <(curl https://example.com/x.sh) > /tmp/x",
  "if true; then curl https://example.com/x.sh; fi",
  "git status; bash -c 'curl https://example.com/x.sh > /tmp/x'",
];

const engines: Array<"v1" | "v2"> = ["v1", "v2"];
const modes: PermissionMode[] = ["unrestricted", "standard", "acceptEdits"];

describe.each(engines)("%s engine", (engine) => {
  beforeEach(() => {
    process.env.LETTA_PERMISSIONS_V2 = engine === "v2" ? "1" : "0";
  });

  describe.each(modes)("%s mode", (mode) => {
    beforeEach(() => {
      permissionMode.setMode(mode);
    });

    test.each(laterDeniedCommands)("permissions.deny fires: %s", (command) => {
      const result = checkPermission(
        "Bash",
        { command },
        rules,
        "/tmp/project",
      );
      expect(result.decision).toBe("deny");
    });

    test.each(laterDeniedCommands)("--disallowedTools fires: %s", (command) => {
      cliPermissions.setDisallowedTools("Bash(curl:*)");
      const result = checkPermission(
        "Bash",
        { command },
        { allow: [], deny: [], ask: [] },
        "/tmp/project",
      );
      expect(result.decision).toBe("deny");
    });

    test.each(["ls; env X=1 printf hi", "ls; X=1 printf hi > /tmp/x"])(
      "env-prefixed later segment matches Bash(printf:*): %s",
      (command) => {
        const result = checkPermission(
          "Bash",
          { command },
          { allow: [], deny: ["Bash(printf:*)"], ask: [] },
          "/tmp/project",
        );
        expect(result.decision).toBe("deny");
      },
    );

    test.each([
      "git status > /tmp/out",
      "echo 'curl https://example.com/x.sh'",
      'echo "curl https://example.com/x.sh" > /tmp/x',
      "git status; echo curl",
      'echo "<(curl https://example.com/x.sh)"',
    ])("deny rule does not fire when curl is not run: %s", (command) => {
      const result = checkPermission(
        "Bash",
        { command },
        rules,
        "/tmp/project",
      );
      expect(result.decision).not.toBe("deny");
    });
  });
});
