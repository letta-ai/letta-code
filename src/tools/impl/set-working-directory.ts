import { resolveWorkingDirectory } from "@/helpers/working-directory";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { switchRuntimeWorkingDirectory } from "./runtime-working-directory";

interface SetWorkingDirectoryResult {
  content: Array<{ type: "text"; text: string }>;
  status: "success" | "error";
  working_directory?: string;
}

function textResult(
  text: string,
  status: "success" | "error",
  workingDirectory?: string,
): SetWorkingDirectoryResult {
  return {
    content: [{ type: "text", text }],
    status,
    ...(workingDirectory ? { working_directory: workingDirectory } : {}),
  };
}

export async function set_working_directory(
  rawArgs: Record<string, unknown>,
): Promise<SetWorkingDirectoryResult> {
  const requestedPath =
    typeof rawArgs.path === "string" ? rawArgs.path.trim() : "";
  if (!requestedPath) {
    return textResult("Provide a directory path.", "error");
  }

  try {
    const currentWorkingDirectory = getCurrentWorkingDirectory();
    const workingDirectory = await resolveWorkingDirectory(
      requestedPath,
      currentWorkingDirectory,
    );
    await switchRuntimeWorkingDirectory({
      workingDirectory,
      runtimeContext: getRuntimeContext(),
    });

    return textResult(
      [
        `Working directory changed to ${workingDirectory}.`,
        "Relative paths and later tool calls in this turn now use this directory.",
        "Project instructions and skills from this directory will be available on the next turn.",
      ].join("\n"),
      "success",
      workingDirectory,
    );
  } catch (error) {
    return textResult(
      `Failed to change working directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}
