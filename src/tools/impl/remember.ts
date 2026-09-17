import {
  type EnqueueMemoryWriterJobResult,
  enqueueMemoryWriterJob,
} from "@/agent/memory-writer-launcher";
import { spawnBackgroundSubagentTask } from "./task";
import { validateRequiredParams } from "./validation";

interface RememberArgs {
  instruction: string;
  wait?: boolean;
}

export async function remember(
  args: RememberArgs,
): Promise<EnqueueMemoryWriterJobResult> {
  validateRequiredParams(args, ["instruction"], "remember");

  const instruction = args.instruction.trim();
  if (!instruction) {
    throw new Error("remember: 'instruction' must be a non-empty string");
  }

  return enqueueMemoryWriterJob(
    {
      instruction,
      source: "remember",
      wait: args.wait === true,
    },
    { spawnBackgroundSubagentTask },
  );
}
