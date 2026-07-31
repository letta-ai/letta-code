import { createHmac, randomBytes } from "node:crypto";

const CACHE_FINGERPRINT_KEY = randomBytes(32);

export function createCredentialScopedCacheKey(
  scope: string,
  identity: readonly string[],
): string {
  const fingerprint = createHmac("sha256", CACHE_FINGERPRINT_KEY)
    .update(JSON.stringify(identity))
    .digest("base64url");
  return `${scope}:${fingerprint}`;
}

export class CredentialScopedCache<T> {
  readonly #entries = new Map<string, { expiresAt: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  get(
    scope: string,
    identity: readonly string[],
    now: number,
    bypass?: boolean,
  ): T | undefined {
    if (bypass) return undefined;
    const key = createCredentialScopedCacheKey(scope, identity);
    const cached = this.#entries.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt > now) return cached.value;
    this.#entries.delete(key);
    return undefined;
  }

  set(scope: string, identity: readonly string[], now: number, value: T): void {
    for (const [key, cached] of this.#entries) {
      if (cached.expiresAt <= now) this.#entries.delete(key);
    }
    const key = createCredentialScopedCacheKey(scope, identity);
    this.#entries.set(key, {
      expiresAt: now + this.ttlMs,
      value,
    });
  }
}
