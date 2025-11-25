import { ls } from "./LS.js";
import { validateRequiredParams } from "./validation.js";

interface ListDirCodexArgs {
  dir_path: string;
  offset?: number;
  limit?: number;
  depth?: number;
}

type ListDirCodexResult = Awaited<ReturnType<typeof ls>>;

/**
 * Codex-style list_dir tool.
 * Delegates to the existing LS implementation; offset/limit/depth are accepted but currently ignored.
 */
export async function list_dir(
  args: ListDirCodexArgs,
): Promise<ListDirCodexResult> {
  validateRequiredParams(args, ["dir_path"], "list_dir");

  const { dir_path } = args;

  // LS handles path resolution and formatting.
  return ls({ path: dir_path, ignore: [] });
}
