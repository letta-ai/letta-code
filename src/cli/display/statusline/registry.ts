import { defaultStatuslineRenderer } from "@/cli/display/statusline/renderers/Default";
import type { StatuslineRenderer } from "@/cli/display/statusline/types";

export const DEFAULT_STATUSLINE_RENDERER_ID = "default";

const BUILTIN_STATUSLINE_RENDERERS = [
  defaultStatuslineRenderer,
] as const satisfies readonly StatuslineRenderer[];

export function getBuiltinStatuslineRenderers(): readonly StatuslineRenderer[] {
  return BUILTIN_STATUSLINE_RENDERERS;
}

export function getBuiltinStatuslineRenderer(
  id: string | null | undefined,
): StatuslineRenderer {
  return (
    BUILTIN_STATUSLINE_RENDERERS.find((renderer) => renderer.id === id) ??
    defaultStatuslineRenderer
  );
}
