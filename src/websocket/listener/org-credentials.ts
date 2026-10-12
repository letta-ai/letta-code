import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getSecretValue,
  isKeychainAvailable,
  setSecretValue,
} from "@/utils/secrets";

/**
 * Credentials a listener holds for one organization (`letta server --org`).
 * Kept apart from the global sign-in so a computer registered into a Slack
 * organization does not replace the credentials `letta` itself uses.
 */
export interface OrgCredentials {
  apiKey?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

export interface OrgCredentialStore {
  load(organizationId: string): Promise<OrgCredentials>;
  save(organizationId: string, credentials: OrgCredentials): Promise<void>;
}

/**
 * Cloud revokes a user's earlier refresh tokens per device id when it issues
 * new ones, so an organization listener signs in as its own device. The id is
 * stable across restarts so re-registration finds the same environment.
 */
export function deriveOrgDeviceId(
  deviceId: string,
  organizationId: string,
): string {
  return createHash("sha256")
    .update(`${deviceId}\0${organizationId}`)
    .digest("hex")
    .slice(0, 32);
}

function secretName(organizationId: string): string {
  return `letta-listener-org-auth:${organizationId}`;
}

function fallbackPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".letta", "listener-org-auth.json");
}

function readFallback(): Record<string, OrgCredentials> {
  const path = fallbackPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseCredentials(value: string | null): OrgCredentials {
  if (!value) return {};
  try {
    return JSON.parse(value) as OrgCredentials;
  } catch {
    return {};
  }
}

export const orgCredentialStore: OrgCredentialStore = {
  async load(organizationId) {
    if (await isKeychainAvailable()) {
      const stored = await getSecretValue(
        secretName(organizationId),
        `organization ${organizationId} credentials`,
      );
      if (stored) return parseCredentials(stored);
    }
    return readFallback()[organizationId] ?? {};
  },

  async save(organizationId, credentials) {
    if (await isKeychainAvailable()) {
      try {
        await setSecretValue(
          secretName(organizationId),
          JSON.stringify(credentials),
        );
        return;
      } catch {
        // Fall through to the file, as the global sign-in does.
      }
    }
    const path = fallbackPath();
    const all = readFallback();
    all[organizationId] = credentials;
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  },
};
