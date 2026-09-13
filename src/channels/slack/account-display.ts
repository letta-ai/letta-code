import { loadSlackBoltModule } from "./runtime";
import {
  isNonEmptyString,
  resolveSlackAppConstructor,
  resolveSlackUserDisplayName,
} from "./utils";

export async function resolveSlackAccountDisplayName(
  botToken: string,
  appToken: string,
): Promise<string | undefined> {
  const bolt = await loadSlackBoltModule();
  const App = resolveSlackAppConstructor(bolt);
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
  const auth = await app.client.auth.test({ token: botToken });
  if (isNonEmptyString(auth.user_id)) {
    try {
      const userInfo = await app.client.users.info({
        token: botToken,
        user: auth.user_id,
      });
      const displayName = resolveSlackUserDisplayName(userInfo);
      if (displayName) {
        return displayName;
      }
    } catch {}
  }
  return isNonEmptyString(auth.user) ? auth.user : undefined;
}
