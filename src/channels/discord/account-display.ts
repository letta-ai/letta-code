import type { DiscordClient } from "./internal-types";
import { loadDiscordModule } from "./runtime";

export async function resolveDiscordAccountDisplayName(
  token: string,
): Promise<string | undefined> {
  const discord = await loadDiscordModule();
  const client = new discord.Client({
    intents: [discord.GatewayIntentBits.Guilds],
  }) as DiscordClient;
  try {
    await client.login(token);
    const tag = client.user?.tag ?? client.user?.username;
    client.destroy();
    return tag ?? undefined;
  } catch {
    try {
      client.destroy();
    } catch {}
    return undefined;
  }
}
