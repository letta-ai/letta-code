import { LettaClient } from "@letta-ai/letta-client";
import { loadSettings, updateSettings } from "../settings";

export async function getClient() {
  const settings = await loadSettings();

  const token = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  if (!token) {
    console.error("Missing LETTA_API_KEY");
    console.error(
      "Set it via environment variable or add it to ~/.letta/settings.json:",
    );
    console.error('  { "env": { "LETTA_API_KEY": "sk-let-..." } }');
    process.exit(1);
  }

  const baseUrl =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";

  // Auto-cache: if env vars are set but not in settings, write them to settings
  let needsUpdate = false;
  const updatedEnv = { ...settings.env };

  if (process.env.LETTA_API_KEY && !settings.env?.LETTA_API_KEY) {
    updatedEnv.LETTA_API_KEY = process.env.LETTA_API_KEY;
    needsUpdate = true;
  }

  if (process.env.LETTA_BASE_URL && !settings.env?.LETTA_BASE_URL) {
    updatedEnv.LETTA_BASE_URL = process.env.LETTA_BASE_URL;
    needsUpdate = true;
  }

  if (needsUpdate) {
    await updateSettings({ env: updatedEnv });
  }

  return new LettaClient({ token, baseUrl });
}
