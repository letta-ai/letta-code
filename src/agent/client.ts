import { LettaClient } from "@letta-ai/letta-client";
import { loadSettings } from "../settings";

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

  return new LettaClient({ token, baseUrl });
}
