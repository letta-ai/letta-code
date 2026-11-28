import type { PermissionMode } from "@/permissions/mode";
import { colors } from "./colors";
export function getPermissionModeTransientHintInfo(mode: PermissionMode): {
  name: string;
  color: string;
  glyph?: string;
} {
  switch (mode) {
    case "acceptEdits":
      return { name: "accept edits", color: colors.status.processing };
    case "standard":
      return {
        name: "standard (request approval) mode",
        color: colors.status.processingShimmer,
        glyph: "▶",
      };
    case "unrestricted":
      return {
        name: "unrestricted mode",
        color: colors.status.success,
        glyph: "⚡︎",
      };
    case "strict":
      return {
        name: "strict (all tools require approval)",
        color: colors.status.error,
        glyph: "🔒",
      };
  }
}
