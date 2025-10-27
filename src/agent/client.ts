import Letta from "@letta-ai/letta-client";

export function getClient() {
  const token = process.env.LETTA_API_KEY;
  if (!token) {
    console.error("Missing LETTA_API_KEY");
    process.exit(1);
  }
  // add baseUrl if you're not hitting the default
  return new Letta({ apiKey: token /*, baseURL: "http://localhost:8283"*/ });
}
