import { expect, test } from "bun:test";
import { terminalCommands } from "@/cli/app/terminal-commands";
import { THINKING_TIPS } from "@/cli/helpers/thinking-messages";

test("terminal thinking tips refer to available session commands", () => {
  const commands = terminalCommands.map(({ cmd }) => cmd);
  for (const tip of THINKING_TIPS) {
    expect(commands).toContain(tip.match(/\/[-\w]+/)?.[0] ?? "");
  }
});
