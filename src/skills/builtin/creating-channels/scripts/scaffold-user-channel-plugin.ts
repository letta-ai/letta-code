import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function usage(): never {
  console.error(
    `Usage: npx tsx scaffold-user-channel-plugin.ts <id> <display-name> [--dir <channels-root>] [--runtime-package <pkg>] [--runtime-module <module>] [--force]`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const id = args[0];
const displayName = args[1];
if (!id || !displayName) usage();
if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
  throw new Error(`Invalid channel id: ${id}`);
}
if (["telegram", "slack", "discord"].includes(id)) {
  throw new Error(`User plugins cannot shadow first-party channel id: ${id}`);
}

let channelsRoot = join(homedir(), ".letta", "channels");
let runtimePackage = "";
let runtimeModule = "";
let force = false;
for (let i = 2; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === "--dir" && next) {
    channelsRoot = next;
    i++;
  } else if (arg === "--runtime-package" && next) {
    runtimePackage = next;
    i++;
  } else if (arg === "--runtime-module" && next) {
    runtimeModule = next;
    i++;
  } else if (arg === "--force") {
    force = true;
  } else {
    usage();
  }
}

if (runtimePackage && !runtimeModule) runtimeModule = runtimePackage.replace(/@[^/@]+$/, "");
if (runtimeModule && !runtimePackage) runtimePackage = runtimeModule;

const dir = resolve(channelsRoot, id);
const outputFiles = [
  join(dir, "channel.json"),
  join(dir, "plugin.mjs"),
  join(dir, "accounts.example.json"),
];
const existingFiles = outputFiles.filter((filePath) => existsSync(filePath));
if (existingFiles.length > 0 && !force) {
  throw new Error(
    `Refusing to overwrite existing files: ${existingFiles.join(", ")}. Pass --force to overwrite.`,
  );
}
mkdirSync(dir, { recursive: true });

const runtimePackages = runtimePackage ? [runtimePackage] : [];
const runtimeModules = runtimeModule ? [runtimeModule] : [];

writeFileSync(
  join(dir, "channel.json"),
  `${JSON.stringify(
    {
      id,
      displayName,
      entry: "./plugin.mjs",
      runtimePackages,
      runtimeModules,
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(dir, "accounts.example.json"),
  `${JSON.stringify(
    {
      accounts: [
        {
          channel: id,
          accountId: "main",
          displayName,
          enabled: true,
          dmPolicy: "pairing",
          allowedUsers: [],
          config: {
            token: "TODO",
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(dir, "plugin.mjs"),
  `// ${displayName} dynamic channel plugin skeleton.\n// TODO: replace start/stop/inbound/sendMessage with the real platform SDK.\n\nimport { randomUUID } from "node:crypto";\n\nexport const channelPlugin = {\n  metadata: {\n    id: ${JSON.stringify(id)},\n    displayName: ${JSON.stringify(displayName)},\n    runtimePackages: ${JSON.stringify(runtimePackages)},\n    runtimeModules: ${JSON.stringify(runtimeModules)}\n  },\n\n  async createAdapter(account) {\n    let running = false;\n    let onMessageHandler = null;\n\n    return {\n      id: \`${id}:\${account.accountId}\`,\n      channelId: ${JSON.stringify(id)},\n      accountId: account.accountId,\n      name: account.displayName ?? ${JSON.stringify(displayName)},\n\n      async start() {\n        running = true;\n        console.log(\"[${id}] adapter running.\");\n      },\n\n      async stop() {\n        running = false;\n      },\n\n      isRunning() {\n        return running;\n      },\n\n      async sendMessage(msg) {\n        if (!running) throw new Error(\"[${id}] adapter not running.\");\n        // TODO: send msg.text to msg.chatId with the platform SDK.\n        console.log(\"[${id}] sendMessage\", { chatId: msg.chatId, text: msg.text });\n        return { messageId: randomUUID() };\n      },\n\n      async sendDirectReply(chatId, text, options) {\n        if (!running) return;\n        // TODO: send pairing/no-route messages directly to chatId.\n        console.log(\"[${id}] sendDirectReply\", { chatId, text, options });\n      },\n\n      get onMessage() {\n        return onMessageHandler;\n      },\n\n      set onMessage(handler) {\n        onMessageHandler = handler;\n      }\n    };\n  },\n\n  messageActions: {\n    describeMessageTool() {\n      return { actions: [\"send\"] };\n    },\n\n    async handleAction({ adapter, request, formatText }) {\n      if (request.action !== \"send\") {\n        return \`Error: Action \"\${request.action}\" is not supported on ${id}.\`;\n      }\n      const text = request.message?.trim();\n      if (!text) return \"Error: send requires message.\";\n\n      const formatted = formatText(text);\n      const result = await adapter.sendMessage({\n        channel: ${JSON.stringify(id)},\n        chatId: request.chatId,\n        text: formatted.text,\n        parseMode: formatted.parseMode,\n        replyToMessageId: request.replyToMessageId,\n        threadId: request.threadId\n      });\n      return \`Message sent to ${id} (message_id: \${result.messageId})\`;\n    }\n  }\n};\n\nexport default channelPlugin;\n`,
);

console.log(`Created ${id} channel plugin skeleton at ${dir}`);
console.log("Next: copy accounts.example.json to accounts.json and fill config secrets.");
