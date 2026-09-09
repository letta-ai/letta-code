import { redactGithubWriteAuthority } from "@/github-write-authority";
import { isDebugEnabled } from "@/utils/debug";
import { safeEmitWsEvent } from "./runtime";

export function logInboundMessage(parsed: unknown, raw: string): void {
  const event = redactGithubWriteAuthority(parsed);
  if (parsed) {
    safeEmitWsEvent("recv", "client", event);
  } else {
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_unparseable",
      raw: redactGithubWriteAuthority(raw),
    });
  }
  if (isDebugEnabled()) {
    console.log(`[Listen] Received message: ${JSON.stringify(event, null, 2)}`);
  }
}
