import {
  createScriptToolScope,
  resolveScriptParentAgentId,
} from "@/tools/script-tool-scope";
import { executeToolScript } from "@/tools/workflow/workflow-engine";

interface CodeModeArgs {
  code: string;
  args?: unknown;
  signal?: AbortSignal;
  parentScope?: { agentId: string; conversationId: string };
}

/** Foreground tool composition; no Workflow metadata, model calls, or SDK setup. */
export async function code_mode(args: CodeModeArgs) {
  let scope: Awaited<ReturnType<typeof createScriptToolScope>> | undefined;
  try {
    if (typeof args.code !== "string" || !args.code.trim()) {
      throw new Error("Provide a non-empty JavaScript function body in code.");
    }
    scope = await createScriptToolScope(
      await resolveScriptParentAgentId(args),
      args.signal,
    );
    const output: string[] = [];
    const result = await executeToolScript({
      ...scope,
      script: args.code,
      args: args.args,
      signal: args.signal,
      onProgress: (event) => {
        if (event.kind === "log") output.push(event.message);
      },
    });
    return {
      content: JSON.stringify({ result, output }),
      status: "success",
    };
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  } finally {
    await scope?.cleanup();
  }
}
