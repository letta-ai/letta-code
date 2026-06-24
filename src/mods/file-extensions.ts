export const MOD_FILE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx"] as const;
export const TYPESCRIPT_MOD_FILE_EXTENSIONS = [".ts", ".tsx"] as const;

export type ModFileExtension = (typeof MOD_FILE_EXTENSIONS)[number];
export type TypeScriptModFileExtension =
  (typeof TYPESCRIPT_MOD_FILE_EXTENSIONS)[number];

const MOD_FILE_EXTENSION_SET = new Set<string>(MOD_FILE_EXTENSIONS);
const TYPESCRIPT_MOD_FILE_EXTENSION_SET = new Set<string>(
  TYPESCRIPT_MOD_FILE_EXTENSIONS,
);

export function isModFileExtension(value: string): value is ModFileExtension {
  return MOD_FILE_EXTENSION_SET.has(value);
}

export function isTypeScriptModFileExtension(
  value: string,
): value is TypeScriptModFileExtension {
  return TYPESCRIPT_MOD_FILE_EXTENSION_SET.has(value);
}
