#!/usr/bin/env bun

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
} catch {}
