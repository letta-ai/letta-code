import { afterEach, beforeEach, expect, test } from "bun:test";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";

beforeEach(() => permissionMode.setMode("standard"));
afterEach(() => permissionMode.reset());

const agentId = "agent-heredoc-security-test";
const target = `${getScopedMemoryFilesystemRoot(agentId)}/note.md`;
function check(command: string) {
  return checkPermission(
    "Bash",
    { command },
    { allow: [], deny: [], ask: [], alwaysAsk: ["Bash(sudo:*)"] },
    "/tmp",
    undefined,
    agentId,
  ).decision;
}

// Permission checks only: these commands are never executed.
for (const body of [
  "$(sudo id)",
  "`sudo id`",
  "'$(sudo id)'",
  "$(bash -c 'sudo id')",
  "\\$(sudo id)",
  "literal\\\nEOF\n$(sudo id)",
  "$VALUE",
]) {
  test(`unquoted heredoc with ${JSON.stringify(body)} requires approval`, () => {
    expect(check(`cat > ${target} <<EOF\n${body}\nEOF`)).toBe("ask");
  });
}
for (const delimiter of ["'EOF'", '"EOF"']) {
  test(`quoted ${delimiter} leaves the body literal`, () => {
    expect(check(`cat > ${target} <<${delimiter}\n$(sudo id)\nEOF`)).toBe(
      "allow",
    );
  });
}
for (const delimiter of ["E'OF'", "\\EOF", "EOF$VALUE"]) {
  test(`uncertain delimiter ${delimiter} requires approval`, () => {
    expect(check(`cat > ${target} <<${delimiter}\ntext\nEOF`)).toBe("ask");
  });
}
test("ordinary unquoted content remains allowed", () => {
  expect(check(`cat > ${target} <<EOF\nplain text\nEOF`)).toBe("allow");
});
test("quoted body cannot hide a trailing unsafe command", () => {
  expect(check(`cat > ${target} <<'EOF'\ntext\nEOF\nsudo id`)).toBe("ask");
});
test("strict mode still requires approval for literal memory heredocs", () => {
  permissionMode.setMode("strict");
  expect(check(`cat > ${target} <<'EOF'\ntext\nEOF`)).toBe("ask");
});
