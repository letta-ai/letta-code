/**
 * Secret storage for Letta Code.
 * Stores secrets in ~/.letta/secrets.json and provides
 * substitution for $SECRET_NAME in shell commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

declare const process: { env: Record<string, string | undefined> };

let cachedSecrets: Record<string, string> | null = null;

/**
 * Get the path to the secrets file.
 */
export function getSecretsPath(): string {
  return join(homedir(), ".letta", "secrets.json");
}

/**
 * Load secrets from disk (cached in memory).
 */
export function loadSecrets(): Record<string, string> {
  if (cachedSecrets !== null) {
    return cachedSecrets;
  }

  const secretsPath = getSecretsPath();

  if (!existsSync(secretsPath)) {
    cachedSecrets = {};
    return cachedSecrets;
  }

  try {
    const content = readFileSync(secretsPath, "utf-8");
    const parsed = JSON.parse(content);
    const secrets = typeof parsed === "object" && parsed !== null ? parsed : {};
    cachedSecrets = secrets;
    return secrets;
  } catch {
    cachedSecrets = {};
    return cachedSecrets;
  }
}

/**
 * Save secrets to disk.
 */
export function saveSecrets(secrets: Record<string, string>): void {
  const secretsPath = getSecretsPath();
  const secretsDir = join(homedir(), ".letta");

  // Ensure directory exists
  if (!existsSync(secretsDir)) {
    mkdirSync(secretsDir, { recursive: true });
  }

  // Write with restricted permissions
  const content = JSON.stringify(secrets, null, 2);
  writeFileSync(secretsPath, content, { mode: 0o600 });

  // Update cache
  cachedSecrets = { ...secrets };
}

/**
 * Get a specific secret value.
 */
export function getSecret(key: string): string | undefined {
  const secrets = loadSecrets();
  return secrets[key.toUpperCase()];
}

/**
 * Set a secret value.
 */
export function setSecret(key: string, value: string): void {
  const secrets = loadSecrets();
  secrets[key.toUpperCase()] = value;
  saveSecrets(secrets);
  syncSecretsToMemoryBlock();
}

/**
 * Delete a secret.
 * @returns true if the secret existed and was deleted
 */
export function deleteSecret(key: string): boolean {
  const secrets = loadSecrets();
  const normalizedKey = key.toUpperCase();

  if (!(normalizedKey in secrets)) {
    return false;
  }

  delete secrets[normalizedKey];
  saveSecrets(secrets);
  syncSecretsToMemoryBlock();
  return true;
}

/**
 * List all secret names (not values).
 */
export function listSecretNames(): string[] {
  const secrets = loadSecrets();
  return Object.keys(secrets).sort();
}

/**
 * Clear the in-memory cache (useful for testing).
 */
export function clearSecretsCache(): void {
  cachedSecrets = null;
}

/**
 * Sync secrets list to the memory block.
 * This creates/updates $MEMORY_DIR/system/secrets.md with available secret names.
 * Called after set/delete operations.
 */
export function syncSecretsToMemoryBlock(): void {
  const memoryDir = process.env.MEMORY_DIR;
  if (!memoryDir) {
    // No memory directory configured (might be in headless mode)
    return;
  }

  const names = listSecretNames();
  const secretsFilePath = join(memoryDir, "system", "secrets.md");

  // Build the memory block content
  const description =
    names.length > 0
      ? "Available secrets for shell command substitution"
      : "No secrets configured";

  const body =
    names.length > 0
      ? `Use \`$SECRET_NAME\` syntax in shell commands to reference these secrets:\n\n${names.map((n) => `- \`$${n}\``).join("\n")}`
      : "Use /secret set KEY value to add secrets.";

  const rendered = `---
description: ${description}
---

## Available Secrets

${body}
`;

  // Ensure system directory exists
  const systemDir = dirname(secretsFilePath);
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }

  writeFileSync(secretsFilePath, rendered, "utf8");
}
