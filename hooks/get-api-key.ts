#!/usr/bin/env bun
// Helper script to get API key from keychain using Bun's secrets API
// Used by memory_logger.py to avoid separate keychain authorization

const SERVICE_NAME = "letta-code";
const API_KEY_NAME = "letta-api-key";

try {
  const apiKey = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: API_KEY_NAME,
  });
  if (apiKey) {
    process.stdout.write(apiKey);
  }
} catch {
  // Silent failure - Python will try other sources
}
