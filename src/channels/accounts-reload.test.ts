import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearChannelAccountStores,
  listChannelAccounts,
  reloadChannelAccounts,
} from "@/channels/accounts";
import {
  __testOverrideChannelsRoot,
  getChannelAccountsPath,
} from "@/channels/config";

let channelsRoot: string;

function writeAccounts(accounts: unknown): void {
  const path = getChannelAccountsPath("demo");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ accounts }, null, 2)}\n`);
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-account-reload-"));
  __testOverrideChannelsRoot(channelsRoot);
  clearChannelAccountStores();
});

afterEach(() => {
  clearChannelAccountStores();
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("account reload replaces cached account configuration from disk", () => {
  writeAccounts([
    {
      channel: "demo",
      accountId: "acct-demo",
      enabled: true,
      dmPolicy: "open",
      allowedUsers: [],
      config: { version: "one" },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  reloadChannelAccounts("demo");
  expect(listChannelAccounts("demo")).toMatchObject([
    { accountId: "acct-demo", config: { version: "one" } },
  ]);

  writeAccounts([
    {
      channel: "demo",
      accountId: "acct-new",
      enabled: true,
      dmPolicy: "open",
      allowedUsers: [],
      config: { version: "two" },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  reloadChannelAccounts("demo");
  expect(listChannelAccounts("demo")).toMatchObject([
    { accountId: "acct-new", config: { version: "two" } },
  ]);
});

test("invalid account reload preserves the previous working cache", () => {
  const workingAccount = {
    channel: "demo",
    accountId: "acct-working",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: {},
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
  writeAccounts([workingAccount]);
  reloadChannelAccounts("demo");
  writeAccounts({ invalid: true });

  expect(() => reloadChannelAccounts("demo")).toThrow(
    "accounts must be an array",
  );
  expect(listChannelAccounts("demo")).toMatchObject([
    { accountId: "acct-working" },
  ]);

  writeAccounts([workingAccount, workingAccount]);
  expect(() => reloadChannelAccounts("demo")).toThrow(
    "duplicate accountId: acct-working",
  );
  expect(listChannelAccounts("demo")).toHaveLength(1);
});
