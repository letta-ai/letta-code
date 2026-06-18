import { describe, expect, test } from "bun:test";
import { getLettaCodeHeaders } from "@/backend/api/http-headers";
import { getVersion } from "@/version";

describe("getLettaCodeHeaders", () => {
  test("adds auth and shared Letta Code client metadata headers", () => {
    const headers = getLettaCodeHeaders("test-key");

    expect(headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      "User-Agent": `letta-code/${getVersion()}`,
      "X-Letta-Source": "letta-code",
      "X-Letta-Client-Name": "letta-code",
      "X-Letta-Client-Version": getVersion(),
      "X-Letta-Client-Platform": process.platform,
    });
  });
});
