import { LettaClient } from "@letta-ai/letta-client";

export function getClient() {
  const token = process.env.LETTA_API_KEY;
  if (!token) {
    console.error("Missing LETTA_API_KEY");
    process.exit(1);
  }

  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";

  return new LettaClient({ token, baseUrl });
}
