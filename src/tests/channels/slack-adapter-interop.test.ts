import { expect, mock, test } from "bun:test";

class FakeSlackApp {
  readonly client = {
    auth: {
      test: mock(async () => ({
        team: "Interop Workspace",
        user: "interop_slack_bot",
        user_id: "UINTEROP",
      })),
    },
    users: {
      info: mock(async () => ({
        user: {
          name: "interop_slack_bot",
          profile: {
            display_name: "Interop Slack Bot",
          },
        },
      })),
    },
    chat: {
      postMessage: mock(async () => ({ ts: "1712800000.000100" })),
    },
    reactions: {
      add: mock(async () => ({ ok: true })),
      remove: mock(async () => ({ ok: true })),
    },
    files: {
      getUploadURLExternal: mock(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload/F123",
        file_id: "F123",
      })),
      completeUploadExternal: mock(async () => ({ ok: true })),
    },
  };

  readonly init = mock(async () => {});
  readonly start = mock(async () => {});
  readonly stop = mock(async () => {});

  message(): void {}

  event(): void {}

  error(): void {}
}

mock.module("../../channels/slack/runtime", () => ({
  loadSlackBoltModule: async () => ({
    default: {
      default: {
        App: FakeSlackApp,
      },
    },
  }),
}));

mock.module("../../channels/slack/media", () => ({
  resolveSlackInboundAttachments: async () => [],
}));

test("resolveSlackAccountDisplayName supports nested default Slack Bolt exports", async () => {
  const adapterModuleUrl = new URL(
    "../../channels/slack/adapter.ts?interop=nested-default",
    import.meta.url,
  ).href;
  const { resolveSlackAccountDisplayName } = await import(adapterModuleUrl);

  await expect(
    resolveSlackAccountDisplayName(
      "xoxb-test-token-1234567890",
      "xapp-test-token-1234567890",
    ),
  ).resolves.toBe("Interop Slack Bot");
});
