import { loadGrammyModule } from "./runtime";
import { resolveTelegramBotConstructor } from "./utils";

export async function validateTelegramToken(
  token: string,
): Promise<{ username: string; id: number }> {
  const grammy = await loadGrammyModule();
  const Bot = resolveTelegramBotConstructor(grammy);
  const bot = new Bot(token);
  await bot.init();
  const info = bot.botInfo;
  return {
    username: info.username ?? "",
    id: info.id,
  };
}
