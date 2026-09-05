import type { Agent } from "node:http";
import type { BotConfig, Context as GrammYContext } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

const TELEGRAM_API_ROOT = "https://api.telegram.org";

export function resolveTelegramProxyAgent(url: string): Agent | undefined {
  const proxyUrl = getProxyForUrl(url);
  if (!proxyUrl) {
    return undefined;
  }

  let protocol: string;
  try {
    protocol = new URL(proxyUrl).protocol.slice(0, -1).toLowerCase();
  } catch {
    throw new Error("Invalid proxy URL configured for Telegram.");
  }

  if (protocol === "http" || protocol === "https") {
    return new HttpsProxyAgent(proxyUrl);
  }

  throw new Error(
    `Unsupported Telegram proxy protocol "${protocol}". Use an http or https proxy.`,
  );
}

export function resolveTelegramBotConfig():
  | BotConfig<GrammYContext>
  | undefined {
  const agent = resolveTelegramProxyAgent(TELEGRAM_API_ROOT);
  if (!agent) {
    return undefined;
  }

  return {
    client: {
      baseFetchConfig: {
        agent,
      },
    },
  };
}
