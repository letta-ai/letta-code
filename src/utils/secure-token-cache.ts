import type { SecureTokens } from "./secrets.js";

export type SecureTokenLoadResult = {
  complete: boolean;
  tokens: SecureTokens;
};

type SecureTokenLoader = () => Promise<SecureTokenLoadResult | null>;

export class SecureTokenCache {
  private tokens: SecureTokens = {};
  private hydrated = false;
  private hydrationPromise: Promise<SecureTokens> | null = null;
  private generation = 0;
  private failedHydrations = 0;

  get(): SecureTokens {
    return { ...this.tokens };
  }

  update(tokens: SecureTokens): void {
    this.generation += 1;
    this.failedHydrations = 0;
    this.merge(tokens);
  }

  clear(): void {
    this.generation += 1;
    this.tokens = {};
    this.hydrated = false;
    this.hydrationPromise = null;
    this.failedHydrations = 0;
  }

  markHydrated(): void {
    this.hydrated = true;
    this.failedHydrations = 0;
  }

  async hydrateOnce(
    enabled: boolean,
    load: SecureTokenLoader,
  ): Promise<SecureTokens> {
    if (!enabled || this.hydrated) return this.get();
    if (this.hydrationPromise) return this.hydrationPromise;

    const generation = this.generation;
    const hydrationPromise = (async () => {
      const loaded = await load();
      if (loaded && generation === this.generation) {
        this.merge(loaded.tokens);
        if (loaded.complete || this.failedHydrations > 0) {
          this.hydrated = true;
        } else {
          this.failedHydrations += 1;
        }
      }
      return this.get();
    })();
    this.hydrationPromise = hydrationPromise;

    try {
      return await hydrationPromise;
    } finally {
      if (this.hydrationPromise === hydrationPromise) {
        this.hydrationPromise = null;
      }
    }
  }

  private merge(tokens: SecureTokens): void {
    if (tokens.apiKey) this.tokens.apiKey = tokens.apiKey;
    if (tokens.refreshToken) this.tokens.refreshToken = tokens.refreshToken;
  }
}
