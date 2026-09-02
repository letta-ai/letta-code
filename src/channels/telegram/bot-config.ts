import type { BotConfig, Context as GrammYContext } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

const TELEGRAM_API_ROOT = "https://api.telegram.org";

export function resolveTelegramBotConfig():
  | BotConfig<GrammYContext>
  | undefined {
  const proxyUrl = getProxyForUrl(TELEGRAM_API_ROOT);
  if (!proxyUrl) {
    return undefined;
  }

  return {
    client: {
      baseFetchConfig: {
        agent: new HttpsProxyAgent(proxyUrl),
      },
    },
  };
}
