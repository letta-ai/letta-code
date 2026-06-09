import type { LettaExtensionFactory } from "@/extensions/extension-engine";
import { installGoalExtension } from "./goal";

export interface BuiltinExtensionDefinition {
  id: string;
  activate: LettaExtensionFactory;
}

export const BUILTIN_EXTENSIONS: BuiltinExtensionDefinition[] = [
  {
    id: "goal",
    activate: installGoalExtension,
  },
];

export const BUNDLED_EXTENSION_SOURCE_ROOT = "bundled:";

export function getBundledExtensionPath(id: string): string {
  return `${BUNDLED_EXTENSION_SOURCE_ROOT}${id}`;
}

export function getBundledExtensionSourceFiles(): string[] {
  return BUILTIN_EXTENSIONS.map((extension) =>
    getBundledExtensionPath(extension.id),
  );
}
