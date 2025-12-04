import { backgroundProcesses } from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface BashOutputArgs {
  shell_id: string;
  filter?: string;
}
interface BashOutputResult {
  message: string;
}

export async function bash_output(
  args: BashOutputArgs,
): Promise<BashOutputResult> {
  validateRequiredParams(args, ["shell_id"], "BashOutput");
  const { shell_id, filter } = args;
  const proc = backgroundProcesses.get(shell_id);
  if (!proc)
    return { message: `No background process found with ID: ${shell_id}` };
  const stdout = proc.stdout.join("\n");
  const stderr = proc.stderr.join("\n");
  let text = stdout;
  if (stderr) text = text ? `${text}\n${stderr}` : stderr;
  if (filter) {
    text = text
      .split("\n")
      .filter((line) => line.includes(filter))
      .join("\n");
  }

  // Apply character limit to prevent excessive token usage (same as Bash)
  const { content: truncatedOutput } = truncateByChars(
    text || "(no output yet)",
    LIMITS.BASH_OUTPUT_CHARS,
    "BashOutput",
  );

  return { message: truncatedOutput };
}
