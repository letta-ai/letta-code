import { backgroundProcesses } from "./process_manager.js";

interface BashOutputArgs {
  bash_id: string;
  filter?: string;
}
interface BashOutputResult {
  message: string;
}

export async function bash_output(
  args: BashOutputArgs,
): Promise<BashOutputResult> {
  const { bash_id, filter } = args;
  const proc = backgroundProcesses.get(bash_id);
  if (!proc)
    return { message: `No background process found with ID: ${bash_id}` };
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
  return { message: text || "(no output yet)" };
}
