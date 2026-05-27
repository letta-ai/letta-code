import type { Tool, TSchema } from "@earendil-works/pi-ai";

function applyPatchFreeformDescription(toolName: string): string {
  return `Use the \`${toolName}\` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.`;
}

export const APPLY_PATCH_FREEFORM_DESCRIPTION =
  applyPatchFreeformDescription("apply_patch");
export const APPLY_PATCH_PASCAL_FREEFORM_DESCRIPTION =
  applyPatchFreeformDescription("ApplyPatch");

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

export type PiCustomToolFormat = {
  type: "grammar";
  syntax: "lark";
  definition: string;
};

export type PiCustomToolSpec = {
  type: "custom";
  description: string;
  format: PiCustomToolFormat;
};

export type PiCustomToolDefinition = PiCustomToolSpec & {
  name: string;
  fallback: {
    description: string;
    parameters: TSchema;
  };
};

export type PiToolDefinition = Tool | PiCustomToolDefinition;

function applyPatchPiCustomTool(description: string): PiCustomToolSpec {
  return {
    type: "custom",
    description,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_LARK_GRAMMAR,
    },
  };
}

export const APPLY_PATCH_PI_CUSTOM_TOOL = applyPatchPiCustomTool(
  APPLY_PATCH_FREEFORM_DESCRIPTION,
);
export const APPLY_PATCH_PASCAL_PI_CUSTOM_TOOL = applyPatchPiCustomTool(
  APPLY_PATCH_PASCAL_FREEFORM_DESCRIPTION,
);

export function buildPiToolDefinition(input: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  piCustomTool?: PiCustomToolSpec;
}): PiToolDefinition {
  if (input.piCustomTool?.type === "custom") {
    return {
      type: "custom",
      name: input.name,
      description: input.piCustomTool.description,
      format: input.piCustomTool.format,
      fallback: {
        description: input.description,
        parameters: input.parameters as unknown as TSchema,
      },
    };
  }

  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters as unknown as TSchema,
  };
}
