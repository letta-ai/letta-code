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
}

export const MEMORY_CONSTRAINTS_CONFIG_PATH = ".memfs.config.json";
export const MEMORY_CONSTRAINTS_CONFIG_VERSION = 1;

export const DEFAULT_MEMORY_CONSTRAINTS_CONFIG: Readonly<MemoryConstraintsConfig> =
  Object.freeze({
    version: MEMORY_CONSTRAINTS_CONFIG_VERSION,
    maxDepth: 2,
    maxFileCharacters: 20_000,
    maxCoreMemoryCharacters: 80_000,
  });

export const DEFAULT_MEMORY_CONSTRAINTS_CONFIG_CONTENT = `${JSON.stringify(
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  null,
  2,
)}\n`;
