import { type Tool, type TSchema, Type } from "@earendil-works/pi-ai";
import { isRecord } from "@/utils/type-guards";

export const APPLY_PATCH_FREEFORM_DESCRIPTION =
  "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export type PiCustomTool = {
  type: "custom";
  name: string;
  description: string;
  format: {
    type: "grammar";
    syntax: "lark";
    definition: string;
  };
  fallback: {
    parameters: TSchema;
  };
};

export type PiToolDefinition = Tool | PiCustomTool;

type ProjectableClientTool = {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
};

function isClientTool(value: unknown): value is ProjectableClientTool {
  return isRecord(value) && typeof value.name === "string";
}

function isApplyPatchToolName(name: string): boolean {
  return name === "apply_patch" || name === "ApplyPatch";
}

function toPiApplyPatchTool(
  tool: ProjectableClientTool,
  schema: TSchema,
): PiCustomTool {
  return {
    type: "custom",
    name: tool.name,
    description: APPLY_PATCH_FREEFORM_DESCRIPTION,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_LARK_GRAMMAR,
    },
    fallback: {
      parameters: schema,
    },
  };
}

export function toPiTools(
  clientTools: unknown[],
): PiToolDefinition[] | undefined {
  const tools: PiToolDefinition[] = [];
  for (const value of clientTools) {
    if (!isClientTool(value)) continue;
    const schema = isRecord(value.parameters)
      ? (value.parameters as unknown as TSchema)
      : Type.Object({});
    if (isApplyPatchToolName(value.name)) {
      tools.push(toPiApplyPatchTool(value, schema));
      continue;
    }
    tools.push({
      name: value.name,
      description: value.description ?? "",
      parameters: schema,
    });
  }
  return tools.length > 0 ? tools : undefined;
}
