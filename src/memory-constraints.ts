export {
  type MemoryFileFrontmatterInput,
  validateMemoryFileFrontmatter,
} from "./memory-frontmatter";

export interface MemoryFileCharacterLimit {
  pattern: string;
  maxCharacters: number | null;
}

export interface MemoryConstraintsConfig {
  version: 1;
  maxDepth?: number;
  maxFileCharacters?: number;
  maxCoreMemoryCharacters?: number;
  fileCharacterLimits?: MemoryFileCharacterLimit[];
  /** Repo-relative globs. Matching paths cannot be created, changed or removed. */
  readOnlyFiles?: string[];
  /** Opt-in Markdown hygiene checks; never rewrite staged contents. */
  formatting?: {
    lineEndings?: "lf";
    finalNewline?: boolean;
    trailingWhitespace?: boolean;
  };
}

export interface MemoryTreeReader {
  listFiles(): Promise<Array<{ path: string; mode: string }>>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Optional streaming count in Unicode code points, avoiding buffering large blobs. */
  countCharacters?(path: string): Promise<number>;
}

export interface MemoryTreeConstraintsOptions {
  config: MemoryConstraintsConfig;
  layout: "root-marker" | "legacy-only" | "shared-memory";
  requireRootMarker: boolean;
  /** Trusted tree before this change; required when readOnlyFiles is non-empty. */
  acceptedTree?: MemoryTreeReader;
}

/** Shared budget/index checks. Caller supplies trusted policy and layout.
 * Self-contained so the local hook can embed the same implementation.
 */
export async function validateMemoryTreeConstraints(
  reader: MemoryTreeReader,
  options: MemoryTreeConstraintsOptions,
): Promise<string[]> {
  const errors: string[] = [];
  const allFiles = await reader.listFiles();
  const files = allFiles.filter((file) => file.path.endsWith(".md"));
  const paths = new Set(files.map((file) => file.path));
  const v2 =
    options.layout === "root-marker" &&
    (options.requireRootMarker || paths.has("MEMORY.md"));
  if (v2 && !paths.has("MEMORY.md")) {
    errors.push("MEMORY.md: root memory index is required for MemFS v2");
  }
  const memoryFiles = files.filter(({ path }) => {
    if (path.startsWith("skills/")) return false;
    return (
      v2 ||
      options.layout === "shared-memory" ||
      /^(?:memory\/)?(?:system|reference)\/.*\.md$/.test(path)
    );
  });
  if (v2) {
    for (const { path } of memoryFiles) {
      const directories = path.split("/").slice(0, -1);
      let current = "";
      for (const directory of directories) {
        current = current ? `${current}/${directory}` : directory;
        const index = `${current}/MEMORY.md`;
        if (!paths.has(index)) {
          errors.push(`${path}: missing required index ${index}`);
          break;
        }
      }
    }
  }
  function compilePattern(pattern: string): RegExp {
    let source = "^";
    for (let index = 0; index < pattern.length; index++) {
      const character = pattern.charAt(index);
      if (character === "*") {
        if (pattern[index + 1] === "*") {
          if (pattern[index + 2] === "/") {
            source += "(?:.*/)?";
            index += 2;
          } else {
            source += ".*";
            index++;
          }
        } else source += "[^/]*";
      } else if (character === "?") source += "[^/]";
      else
        source +=
          "^$.*+?()[]{}|".includes(character) || character.charCodeAt(0) === 92
            ? String.fromCharCode(92) + character
            : character;
    }
    return new RegExp(`${source}$`);
  }
  const overrides = (options.config.fileCharacterLimits ?? []).map(
    (override) => ({ ...override, regex: compilePattern(override.pattern) }),
  );
  const protectedPatterns = (options.config.readOnlyFiles ?? []).map(
    compilePattern,
  );
  if (protectedPatterns.length) {
    const accepted = options.acceptedTree;
    if (!accepted)
      throw new Error("readOnlyFiles requires the accepted memory tree");
    const previous = new Map(
      (await accepted.listFiles()).map((file) => [file.path, file.mode]),
    );
    const proposed = new Map(allFiles.map((file) => [file.path, file.mode]));
    for (const path of new Set([...previous.keys(), ...proposed.keys()])) {
      if (!protectedPatterns.some((pattern) => pattern.test(path))) continue;
      let changed = previous.get(path) !== proposed.get(path);
      if (!changed) {
        const before = await accepted.readFile(path);
        const after = await reader.readFile(path);
        if (before === null || after === null)
          throw new Error(`${path}: cannot read protected file`);
        changed =
          before.length !== after.length ||
          before.some((value, index) => value !== after[index]);
      }
      if (changed)
        errors.push(
          `${path}: read-only file cannot be created, changed or removed`,
        );
    }
  }
  let coreCharacters = 0;
  for (const { path, mode } of memoryFiles) {
    if (!mode.startsWith("100")) {
      errors.push(`${path}: memory Markdown must be a regular file`);
      continue;
    }
    if (options.config.formatting) {
      const bytes = await reader.readFile(path);
      if (bytes === null)
        throw new Error(`${path}: listed memory file is missing`);
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes,
      );
      const format = options.config.formatting;
      if (format.lineEndings === "lf" && content.includes("\r")) {
        errors.push(`${path}: formatting requires LF line endings`);
      }
      if (format.finalNewline && content.length && !content.endsWith("\n")) {
        errors.push(`${path}: formatting requires a final newline`);
      }
      if (format.trailingWhitespace) {
        let fence = "";
        for (const [index, line] of content
          .replaceAll("\r\n", "\n")
          .split("\n")
          .entries()) {
          const proseLine = line.replace(/^(?: {0,3}> ?)+/, "");
          const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(proseLine);
          if (
            marker &&
            (!fence ||
              (marker[1]?.[0] === fence[0] &&
                (marker[1]?.length ?? 0) >= fence.length &&
                !marker[2]?.trim()))
          ) {
            fence = fence ? "" : (marker[1] ?? "");
            continue;
          }
          // Two spaces are a Markdown hard break; whitespace in code is content.
          if (fence || /^( {4}|\t)/.test(proseLine)) continue;
          const trailing = /[ \t]+$/.exec(proseLine)?.[0];
          if (trailing && !(trailing === "  " && proseLine.trim())) {
            errors.push(
              `${path}:${index + 1}: formatting disallows trailing whitespace`,
            );
          }
        }
      }
    }
    const depth = path.split("/").length - 1;
    if (
      options.config.maxDepth !== undefined &&
      depth > options.config.maxDepth
    ) {
      errors.push(
        `${path}: depth ${depth} exceeds maxDepth ${options.config.maxDepth}`,
      );
    }
    const override = overrides.find((item) => item.regex.test(path));
    const limit = override
      ? override.maxCharacters
      : options.config.maxFileCharacters;
    const source = override
      ? `glob '${override.pattern}'`
      : "maxFileCharacters";
    const countCore =
      options.layout === "root-marker" &&
      !path.includes("/") &&
      options.config.maxCoreMemoryCharacters !== undefined;
    if ((limit === null || limit === undefined) && !countCore) continue;
    let characters = 0;
    if (reader.countCharacters) {
      characters = await reader.countCharacters(path);
    } else {
      const bytes = await reader.readFile(path);
      if (bytes === null)
        throw new Error(`${path}: listed memory file is missing`);
      for (const _character of new TextDecoder("utf-8", {
        ignoreBOM: true,
      }).decode(bytes))
        characters++;
    }
    if (countCore) coreCharacters += characters;
    if (limit !== undefined && limit !== null && characters > limit) {
      errors.push(
        `${path}: ${characters} characters exceeds ${limit} from ${source}`,
      );
    }
  }
  if (
    options.layout === "root-marker" &&
    options.config.maxCoreMemoryCharacters !== undefined &&
    coreCharacters > options.config.maxCoreMemoryCharacters
  ) {
    errors.push(
      `core memory: ${coreCharacters} characters exceeds ${options.config.maxCoreMemoryCharacters} from maxCoreMemoryCharacters`,
    );
  }
  return errors;
}

export const MEMORY_CONSTRAINTS_CONFIG_PATH = ".memfs.config.json";
export const MEMORY_CONSTRAINTS_CONFIG_VERSION = 1;

/** Parse the tracked policy without filling defaults or changing override order.
 * Keep this function self-contained: the installed Git hook embeds its source.
 */
export function parseMemoryConstraintsConfig(
  content: string,
): MemoryConstraintsConfig {
  const path = ".memfs.config.json";
  const errors: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const config = value as Record<string, unknown>;
  const keys = new Set([
    "version",
    "maxDepth",
    "maxFileCharacters",
    "maxCoreMemoryCharacters",
    "fileCharacterLimits",
    "readOnlyFiles",
    "formatting",
  ]);
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) errors.push(`${path}: unknown field '${key}'`);
  }
  if (config.version !== 1) errors.push(`${path}: version must be 1`);
  if (
    config.maxDepth !== undefined &&
    !(Number.isSafeInteger(config.maxDepth) && Number(config.maxDepth) >= 0)
  ) {
    errors.push(`${path}: maxDepth must be a non-negative integer`);
  }
  for (const key of ["maxFileCharacters", "maxCoreMemoryCharacters"]) {
    if (
      config[key] !== undefined &&
      !(Number.isSafeInteger(config[key]) && Number(config[key]) > 0)
    ) {
      errors.push(`${path}: ${key} must be a positive integer`);
    }
  }
  const overrides = config.fileCharacterLimits;
  function validatePattern(pattern: unknown, label: string): void {
    if (
      typeof pattern !== "string" ||
      !pattern ||
      pattern.startsWith("/") ||
      pattern.includes(String.fromCharCode(92)) ||
      pattern.split("/").includes("..")
    ) {
      errors.push(
        `${label}: pattern must be a non-empty repo-relative glob using '/'`,
      );
    } else if (
      pattern
        .split("/")
        .some((segment) => segment.includes("**") && segment !== "**")
    ) {
      errors.push(`${label}: '**' must be a complete path segment`);
    }
  }
  if (config.readOnlyFiles !== undefined) {
    if (!Array.isArray(config.readOnlyFiles))
      errors.push(`${path}: readOnlyFiles must be an array`);
    else
      config.readOnlyFiles.forEach((pattern, index) => {
        validatePattern(pattern, `${path}: readOnlyFiles[${index}]`);
      });
  }
  if (config.formatting !== undefined) {
    const format = config.formatting;
    if (!format || typeof format !== "object" || Array.isArray(format))
      errors.push(`${path}: formatting must be an object`);
    else
      for (const [key, value] of Object.entries(format)) {
        if (key === "lineEndings") {
          if (value !== "lf")
            errors.push(`${path}: formatting.lineEndings must be 'lf'`);
        } else if (key === "finalNewline" || key === "trailingWhitespace") {
          if (typeof value !== "boolean")
            errors.push(`${path}: formatting.${key} must be a boolean`);
        } else errors.push(`${path}: formatting: unknown field '${key}'`);
      }
  }
  if (overrides !== undefined && !Array.isArray(overrides)) {
    errors.push(`${path}: fileCharacterLimits must be an array`);
  }
  if (Array.isArray(overrides)) {
    overrides.forEach((override: unknown, index: number) => {
      const label = `${path}: fileCharacterLimits[${index}]`;
      if (
        override === null ||
        typeof override !== "object" ||
        Array.isArray(override)
      ) {
        errors.push(`${label} must be an object`);
        return;
      }
      const item = override as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (key !== "pattern" && key !== "maxCharacters")
          errors.push(`${label}: unknown field '${key}'`);
      }
      validatePattern(item.pattern, label);
      if (
        item.maxCharacters !== null &&
        !(
          Number.isSafeInteger(item.maxCharacters) &&
          Number(item.maxCharacters) > 0
        )
      ) {
        errors.push(
          `${label}: maxCharacters must be a positive integer or null`,
        );
      }
    });
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return config as unknown as MemoryConstraintsConfig;
}

export const DEFAULT_MEMORY_CONSTRAINTS_CONFIG: Readonly<MemoryConstraintsConfig> =
  Object.freeze({
    version: MEMORY_CONSTRAINTS_CONFIG_VERSION,
    maxDepth: 2,
    maxFileCharacters: 20_000,
    maxCoreMemoryCharacters: 65_536,
  });

export const DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT = `${JSON.stringify(
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  null,
  2,
)}\n`;
