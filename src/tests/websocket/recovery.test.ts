import { describe, expect, test } from "bun:test";
import { isRetriablePostStopError } from "../../websocket/listener/recovery";

describe("websocket post-stop retry fallback", () => {
  test("retries formatted Cloudflare 521 detail without a run id", async () => {
    const detail =
      "Cloudflare 521: Web server is down for api.letta.com (Ray ID: 9e829917ee973824). This is usually a temporary edge/origin outage. Please retry in a moment.";

    await expect(isRetriablePostStopError("error", null, detail)).resolves.toBe(
      true,
    );
  });
});
