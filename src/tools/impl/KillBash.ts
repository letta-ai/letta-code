import { backgroundProcesses } from "./process_manager.js";
import { validateRequiredParams } from "./validation.js";

interface KillBashArgs {
  shell_id: string;
}
interface KillBashResult {
  killed: boolean;
}

export async function kill_bash(args: KillBashArgs): Promise<KillBashResult> {
  validateRequiredParams(args, ["shell_id"], "KillBash");
  const { shell_id } = args;
  const proc = backgroundProcesses.get(shell_id);
  if (!proc) return { killed: false };
  try {
    proc.process.kill("SIGTERM");
    backgroundProcesses.delete(shell_id);
    return { killed: true };
  } catch {
    return { killed: false };
  }
}
