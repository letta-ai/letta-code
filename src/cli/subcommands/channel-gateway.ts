import { parseArgs } from "node:util";
import { listenForGatewayCommands } from "@/channels/gateway-command-input";
import { startLocalChannelGateway } from "@/channels/gateway-local";
import { CHANNEL_GATEWAY_READY_SIGNAL } from "@/channels/gateway-supervisor";
import {
  type ChannelRestoreAgentScope,
  parseChannelRestoreAgentScope,
} from "@/channels/restore-scope";

const RESPONSE_PREFIX = "CHANNEL_GATEWAY_RESPONSE ";
const EVENT_PREFIX = "CHANNEL_GATEWAY_EVENT ";

type GatewayCommandEnvelope = {
  type: "command";
  requestId: string;
  command: import("@/types/service-protocol").ServiceCommandRequest;
};

function isGatewayCommandEnvelope(
  value: unknown,
): value is GatewayCommandEnvelope {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "command" &&
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "command" in value &&
      value.command &&
      typeof value.command === "object",
  );
}

/**
 * Minimal surface of `process` this module registers failure handlers on, so
 * tests can observe registration without installing global handlers.
 */
export interface ChannelFailureContainmentTarget {
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

/**
 * Keep a channel adapter's background failure from killing the gateway.
 *
 * Adapter startup is already guarded — `startChannelAccounts` catches per
 * account and reports a failure. But an adapter's own background work escapes
 * that guard: Slack's socket-mode client keeps retrying `apps.connections.open`
 * on its own timer, and once a token is revoked that rejection surfaces on the
 * gateway's event loop with nothing awaiting it.
 *
 * Left uncaught it exits the process, the supervisor restarts it, the same
 * revoked token fails again — an unkillable loop that also takes down every
 * other channel and, because the listener restarts alongside it, leaves the
 * Desktop environment permanently "Connecting...". A permanently-bad
 * credential is not something a restart can fix, so contain it here: report it
 * and keep serving the channels that do work.
 */
export function installChannelFailureContainment(
  target: ChannelFailureContainmentTarget = process,
  log: (message: string) => void = (message) => {
    console.error(message);
  },
): void {
  const report = (scope: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    log(`[ChannelGateway] contained ${scope}: ${message}`);
    if (error instanceof Error && error.stack) {
      log(error.stack);
    }
  };

  target.on("uncaughtException", (error) => {
    report("uncaughtException", error);
  });
  target.on("unhandledRejection", (reason) => {
    report("unhandledRejection", reason);
  });
}

export async function runChannelGatewaySubcommand(
  argv: string[],
): Promise<number> {
  let values: {
    "app-server-url"?: string;
    channels?: string;
    "restore-agent-scope"?: string;
    "allow-startup-errors"?: boolean;
    "install-channel-runtimes"?: boolean;
    "restore-enabled-channels"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "app-server-url": { type: "string" },
        channels: { type: "string" },
        "restore-agent-scope": { type: "string" },
        "allow-startup-errors": { type: "boolean" },
        "install-channel-runtimes": { type: "boolean" },
        "restore-enabled-channels": { type: "boolean" },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (
    !values["app-server-url"] ||
    (!values.channels && !values["restore-enabled-channels"])
  ) {
    console.error(
      "channel-gateway requires --app-server-url and a channel selection",
    );
    return 1;
  }
  const appServerUrl = values["app-server-url"];

  let channelNames = (values.channels ?? "")
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
  const restoreAgentScope: ChannelRestoreAgentScope | null =
    parseChannelRestoreAgentScope(values["restore-agent-scope"]);
  if (values["restore-enabled-channels"]) {
    const { listEnabledChannelIds } = await import("@/channels/service");
    channelNames = listEnabledChannelIds({ restoreAgentScope });
  }
  if (values["install-channel-runtimes"]) {
    const { ensureChannelRuntimeInstalled } = await import(
      "@/channels/runtime-deps"
    );
    const { isSupportedChannelId } = await import("@/channels/plugin-registry");
    for (const channelName of channelNames) {
      if (!isSupportedChannelId(channelName)) {
        console.error(`Unknown channel "${channelName}" passed to --channels.`);
        return 1;
      }
      await ensureChannelRuntimeInstalled(channelName);
    }
  }

  installChannelFailureContainment();

  return await new Promise<number>((resolve) => {
    let closing = false;
    let closeGateway: (() => Promise<void>) | null = null;
    const finish = (code: number) => {
      if (closing) return;
      closing = true;
      if (!closeGateway) {
        resolve(code);
        return;
      }
      void closeGateway().finally(() => resolve(code));
    };

    void startLocalChannelGateway({
      appServerUrl,
      channelNames,
      failOnStartupError: values["allow-startup-errors"] !== true,
      restoreAgentScope,
      logger: (message) => console.error(message),
      onDisconnect: (error) => {
        console.error(error.message);
        finish(1);
      },
      onServiceEvent: (event) => {
        console.log(`${EVENT_PREFIX}${JSON.stringify(event)}`);
      },
    })
      .then((gateway) => {
        const commandInput = listenForGatewayCommands((line) => {
          void (async () => {
            let envelope: unknown;
            try {
              envelope = JSON.parse(line);
            } catch {
              return;
            }
            if (!isGatewayCommandEnvelope(envelope)) return;
            try {
              const response = await gateway.executeCommand(envelope.command);
              console.log(
                `${RESPONSE_PREFIX}${JSON.stringify({ requestId: envelope.requestId, response })}`,
              );
            } catch (error) {
              console.log(
                `${RESPONSE_PREFIX}${JSON.stringify({
                  requestId: envelope.requestId,
                  error: error instanceof Error ? error.message : String(error),
                })}`,
              );
            }
          })();
        });
        closeGateway = async () => {
          commandInput.close();
          await gateway.close();
        };
        console.log(CHANNEL_GATEWAY_READY_SIGNAL);
        process.once("SIGINT", () => finish(0));
        process.once("SIGTERM", () => finish(0));
        if (closing) void gateway.close();
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        resolve(1);
      });
  });
}
