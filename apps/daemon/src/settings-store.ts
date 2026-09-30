import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DaemonSettings {
  environmentName: string | null;
  startAtLogin: boolean;
}

const DEFAULT_SETTINGS: DaemonSettings = {
  environmentName: null,
  startAtLogin: true,
};

export function validateEnvironmentName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Environment name must be text.");
  }

  const name = value.trim();
  if (name.length === 0) {
    throw new Error("Environment name is required.");
  }
  if (name.length > 64) {
    throw new Error("Environment name must be 64 characters or fewer.");
  }
  if (/\p{Cc}/u.test(name)) {
    throw new Error("Environment name cannot contain control characters.");
  }
  return name;
}

export class SettingsStore {
  readonly #path: string;
  #settings: DaemonSettings = { ...DEFAULT_SETTINGS };
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get current(): Readonly<DaemonSettings> {
    return this.#settings;
  }

  async load(): Promise<Readonly<DaemonSettings>> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.#settings = { ...DEFAULT_SETTINGS };
        return this.current;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.#settings = {
        environmentName:
          parsed.environmentName === null ||
          parsed.environmentName === undefined
            ? null
            : validateEnvironmentName(parsed.environmentName),
        startAtLogin:
          typeof parsed.startAtLogin === "boolean"
            ? parsed.startAtLogin
            : DEFAULT_SETTINGS.startAtLogin,
      };
    } catch {
      await rename(this.#path, `${this.#path}.corrupt-${Date.now()}`);
      this.#settings = { ...DEFAULT_SETTINGS };
      await this.#persist(this.#settings);
    }
    return this.current;
  }

  async setEnvironmentName(environmentName: string): Promise<void> {
    const next = {
      ...this.#settings,
      environmentName: validateEnvironmentName(environmentName),
    };
    await this.#setAndPersist(next);
  }

  async setStartAtLogin(startAtLogin: boolean): Promise<void> {
    await this.#setAndPersist({ ...this.#settings, startAtLogin });
  }

  async #setAndPersist(next: DaemonSettings): Promise<void> {
    const previous = this.#settings;
    this.#settings = next;
    try {
      await this.#persist(next);
    } catch (error) {
      if (this.#settings === next) this.#settings = previous;
      throw error;
    }
  }

  #persist(settings: DaemonSettings): Promise<void> {
    const write = this.#writeQueue.then(() => this.#write(settings));
    this.#writeQueue = write.catch(() => undefined);
    return write;
  }

  async #write(settings: DaemonSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
