import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { __listenerAuthTestUtils } from "@/websocket/listener/auth";
import { __listenerIdentityTestUtils } from "@/websocket/listener/identity";

// `mock.restore()` does not undo `mock.module()` swaps, so both mocked modules
// stay replaced for the lifetime of this process. This file is registered in
// scripts/isolated-unit-tests.json and runs in its own bun process so the fake
// ink render and listener client cannot leak into other test files.

// Ink is faked so tests can observe whether the interactive status UI render
// path is taken. The mock mirrors ink's real export surface (components, hooks,
// helpers) with inert stand-ins: nothing is actually rendered here because
// `render` itself is faked. Registered before `@/cli/subcommands/listen` is
// loaded below so its static `import { render } from "ink"` binds to the fake.
const inkRenderCalls: unknown[] = [];

mock.module("ink", () => {
  const renderMock = mock(() => {
    inkRenderCalls.push(1);
    return { unmount: () => {}, rerender: () => {} };
  });
  const inertComponent = () => null;
  return {
    render: renderMock,
    Box: inertComponent,
    Text: inertComponent,
    Static: inertComponent,
    Spacer: inertComponent,
    Newline: inertComponent,
    Transform: inertComponent,
    measureElement: () => ({ width: 0, height: 0 }),
    useApp: () => ({ exit: () => {} }),
    useFocus: () => ({ isFocused: false }),
    useFocusManager: () => ({
      enableFocus: () => {},
      disableFocus: () => {},
      isActive: false,
    }),
    useInput: () => {},
    useStderr: () => ({ write: () => {} }),
    useStdin: () => ({ write: () => {}, setRawMode: () => {} }),
    useStdout: () => ({ write: () => {} }),
  };
});

// The listener client is faked so `letta server` startup stops right after the
// output-mode decision instead of opening a real WebSocket. Throwing keeps the
// subcommand's own error path in play: it exits 1 quickly without process.exit.
// The options object is captured so tests can inspect how the subcommand wired
// the WS event logger (undefined = no capture, defined = file capture on).
let startListenerClientCalls = 0;
let capturedListenerOptions: {
  onWsEvent?: (
    direction: "send" | "recv",
    label: "client" | "protocol" | "control" | "lifecycle",
    event: unknown,
  ) => void;
} | null = null;
const startListenerClientMock = mock(
  async (options?: typeof capturedListenerOptions) => {
    startListenerClientCalls += 1;
    capturedListenerOptions = options ?? null;
    throw new Error("fixture listener client stopped");
  },
);

mock.module("@/websocket/listen-client", () => ({
  __listenClientTestUtils: {},
  emitInterruptedStatusDelta: () => {},
  isListenerActive: () => false,
  parseServerMessage: () => null,
  rejectPendingApprovalResolvers: () => {},
  requestApprovalOverWS: async () => null,
  resolvePendingApprovalResolver: () => {},
  startListenerClient: startListenerClientMock,
  startLocalChannelListener: async () => {},
  stopListenerClient: () => {},
}));

// Load the subcommand after the module mocks are registered so its static
// `import { render } from "ink"` resolves to the fake ink module.
const { runListenSubcommand } = await import("@/cli/subcommands/listen");

afterAll(() => {
  mock.restore();
});

describe("listen subcommand output mode", () => {
  const originalInitialize = settingsManager.initialize;
  const originalLoadLocalProjectSettings =
    settingsManager.loadLocalProjectSettings;
  const originalSetListenerEnvName = settingsManager.setListenerEnvName;
  const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleClear = console.clear;
  const originalHome = process.env.HOME;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalSpawnerIdentity = process.env.LETTA_LISTENER_INSTANCE_ID;
  const originalDesktopMode = process.env.LETTA_DESKTOP_MODE;
  const originalSpawnerDevice = process.env.LETTA_LISTENER_DEVICE_ID;
  const originalRuntimeDevice = process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
  const originalDebug = process.env.LETTA_DEBUG;
  const originalLogWsEvents = process.env.LETTA_LOG_WS_EVENTS;
  const originalLocalBackendExperimental =
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  const originalRestoreEnabledChannels =
    process.env.LETTA_RESTORE_ENABLED_CHANNELS;
  const originalRestoreChannelAgentScope =
    process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
  const originalRestoreEnabledChannelsAgentScope =
    process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
  const originalIgnoreSelfHostedListenerError =
    process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;

  const originalTrackSessionEnd = telemetry.trackSessionEnd;
  const originalFlush = telemetry.flush;

  let originalStdoutIsTTY: boolean | undefined;
  let tempHome: string;
  let logs: string[];
  let errors: string[];
  let consoleClearMock: ReturnType<typeof mock>;
  let registrationFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  const setStdoutIsTTY = (value: boolean | undefined): void => {
    (process.stdout as { isTTY?: boolean }).isTTY = value;
  };

  beforeEach(async () => {
    originalStdoutIsTTY = process.stdout.isTTY;
    startListenerClientCalls = 0;
    capturedListenerOptions = null;
    inkRenderCalls.length = 0;
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    delete process.env.LETTA_LISTENER_DEVICE_ID;
    tempHome = await mkdtemp(
      path.join(tmpdir(), "letta-listener-output-mode-"),
    );
    logs = [];
    errors = [];
    process.env.HOME = tempHome;
    process.env.LETTA_API_KEY = "test-api-key";
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_LISTENER_INSTANCE_ID;
    delete process.env.LETTA_DESKTOP_MODE;
    delete process.env.LETTA_DEBUG;
    delete process.env.LETTA_LOG_WS_EVENTS;
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    delete process.env.LETTA_RESTORE_ENABLED_CHANNELS;
    delete process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
    delete process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
    delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
    });

    // Registration succeeds so the subcommand reaches the output-mode decision
    // before the (faked) WebSocket client is started.
    registrationFetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          connectionId: "conn-test",
          wsUrl: "wss://listener.invalid/v1/ws",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    settingsManager.initialize = mock(
      async () => {},
    ) as typeof settingsManager.initialize;
    settingsManager.loadLocalProjectSettings = mock(async () => ({
      lastAgent: null,
    })) as unknown as typeof settingsManager.loadLocalProjectSettings;
    settingsManager.setListenerEnvName = mock(
      () => {},
    ) as typeof settingsManager.setListenerEnvName;
    settingsManager.getOrCreateDeviceId = mock(
      () => "device-test",
    ) as typeof settingsManager.getOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    const trackSessionEndMock = mock(() => {});
    const flushMock = mock(async () => {});
    telemetry.trackSessionEnd =
      trackSessionEndMock as typeof telemetry.trackSessionEnd;
    telemetry.flush = flushMock as typeof telemetry.flush;

    console.log = mock((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }) as unknown as typeof console.log;
    console.error = mock((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    }) as unknown as typeof console.error;
    consoleClearMock = mock(() => {}) as unknown as ReturnType<typeof mock>;
    console.clear = consoleClearMock as unknown as typeof console.clear;
  });

  afterEach(async () => {
    registrationFetch.mockRestore();
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    setStdoutIsTTY(originalStdoutIsTTY);
    if (originalSpawnerDevice === undefined)
      delete process.env.LETTA_LISTENER_DEVICE_ID;
    else process.env.LETTA_LISTENER_DEVICE_ID = originalSpawnerDevice;
    if (originalRuntimeDevice === undefined)
      delete process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID;
    else
      process.env.LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID = originalRuntimeDevice;
    settingsManager.initialize = originalInitialize;
    settingsManager.loadLocalProjectSettings = originalLoadLocalProjectSettings;
    settingsManager.setListenerEnvName = originalSetListenerEnvName;
    settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.clear = originalConsoleClear;
    telemetry.cleanup();
    telemetry.trackSessionEnd = originalTrackSessionEnd;
    telemetry.flush = originalFlush;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;
    if (originalSpawnerIdentity === undefined) {
      delete process.env.LETTA_LISTENER_INSTANCE_ID;
    } else {
      process.env.LETTA_LISTENER_INSTANCE_ID = originalSpawnerIdentity;
    }
    if (originalDesktopMode === undefined) {
      delete process.env.LETTA_DESKTOP_MODE;
    } else {
      process.env.LETTA_DESKTOP_MODE = originalDesktopMode;
    }
    if (originalDebug === undefined) delete process.env.LETTA_DEBUG;
    else process.env.LETTA_DEBUG = originalDebug;
    if (originalLogWsEvents === undefined)
      delete process.env.LETTA_LOG_WS_EVENTS;
    else process.env.LETTA_LOG_WS_EVENTS = originalLogWsEvents;
    if (originalLocalBackendExperimental === undefined)
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    else
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL =
        originalLocalBackendExperimental;
    if (originalRestoreEnabledChannels === undefined)
      delete process.env.LETTA_RESTORE_ENABLED_CHANNELS;
    else
      process.env.LETTA_RESTORE_ENABLED_CHANNELS =
        originalRestoreEnabledChannels;
    if (originalRestoreChannelAgentScope === undefined)
      delete process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE;
    else
      process.env.LETTA_RESTORE_CHANNEL_AGENT_SCOPE =
        originalRestoreChannelAgentScope;
    if (originalRestoreEnabledChannelsAgentScope === undefined)
      delete process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE;
    else
      process.env.LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE =
        originalRestoreEnabledChannelsAgentScope;
    if (originalIgnoreSelfHostedListenerError === undefined)
      delete process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR;
    else
      process.env.IGNORE_SELF_HOSTED_LISTENER_ERROR =
        originalIgnoreSelfHostedListenerError;

    __listenerAuthTestUtils.setOAuthDepsForTests(null);

    await rm(tempHome, { recursive: true, force: true });
  });

  test("falls back to plain logging instead of the Ink UI when stdout is not a TTY", async () => {
    // systemd units (StandardOutput=journal) run with piped stdout: isTTY is
    // undefined. The listener must not render the interactive Ink UI there;
    // every Ink repaint becomes new journald lines and floods syslog.
    setStdoutIsTTY(undefined);

    const exitCode = await runListenSubcommand(["--computer-name", "ci-env"]);

    // Startup stops at the faked listener client, so an exit is expected.
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("fixture listener client stopped");

    // The plain client path ran...
    expect(startListenerClientCalls).toBe(1);
    // ...without rendering the interactive Ink UI...
    expect(inkRenderCalls.length).toBe(0);
    expect(consoleClearMock).not.toHaveBeenCalled();
    // ...and with plain-text one-line event logs instead.
    const output = logs.join("\n");
    expect(output).toContain(
      "Registering with https://api.letta.com/v1/environments/register",
    );
    expect(output).toContain("Registered successfully");
    expect(output).toContain("Connecting WebSocket...");

    // WS payload logging stays opt-in: implicit non-TTY plain mode must not
    // enable WS event capture, so no per-frame dumps reach journald.
    expect(capturedListenerOptions?.onWsEvent).toBeUndefined();
    expect(output).not.toContain("\u2192 send");
    expect(output).not.toContain("\u2190 recv");
  });

  test("still renders the Ink status UI when stdout is a TTY", async () => {
    setStdoutIsTTY(true);

    const exitCode = await runListenSubcommand(["--computer-name", "ci-env"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("fixture listener client stopped");
    expect(startListenerClientCalls).toBe(1);
    expect(inkRenderCalls.length).toBe(1);
    expect(consoleClearMock).toHaveBeenCalled();
    // Interactive mode does not spray one-line registration event logs.
    expect(logs.join("\n")).not.toContain("Registered successfully");
  });

  test("--debug keeps forcing the plain-text path on a TTY", async () => {
    setStdoutIsTTY(true);

    const exitCode = await runListenSubcommand([
      "--computer-name",
      "ci-env",
      "--debug",
    ]);

    expect(exitCode).toBe(1);
    expect(startListenerClientCalls).toBe(1);
    expect(inkRenderCalls.length).toBe(0);
    expect(logs.join("\n")).toContain("Registered successfully");
    expect(process.env.LETTA_DEBUG).toBe("1");

    // Explicit --debug still opts into WS event capture with console dumps.
    const onWsEvent = capturedListenerOptions?.onWsEvent;
    expect(onWsEvent).toBeDefined();
    onWsEvent?.("send", "client", { type: "test_frame" });
    const output = logs.join("\n");
    expect(output).toContain("\u2192 send");
    expect(output).toContain(JSON.stringify({ type: "test_frame" }));
  });

  test("--debug keeps forcing the plain-text path when stdout is not a TTY", async () => {
    setStdoutIsTTY(undefined);

    const exitCode = await runListenSubcommand([
      "--computer-name",
      "ci-env",
      "--debug",
    ]);

    expect(exitCode).toBe(1);
    expect(startListenerClientCalls).toBe(1);
    expect(inkRenderCalls.length).toBe(0);
    expect(logs.join("\n")).toContain("Registered successfully");
    expect(process.env.LETTA_DEBUG).toBe("1");
  });

  test("LETTA_LOG_WS_EVENTS=1 on a TTY captures WS events to file without console dumps", async () => {
    setStdoutIsTTY(true);
    process.env.LETTA_LOG_WS_EVENTS = "1";

    const exitCode = await runListenSubcommand(["--computer-name", "ci-env"]);

    expect(exitCode).toBe(1);
    // The interactive Ink UI still renders (TTY, no --debug)...
    expect(inkRenderCalls.length).toBe(1);
    // ...but the opt-in env var alone enables WS event file capture.
    const onWsEvent = capturedListenerOptions?.onWsEvent;
    expect(onWsEvent).toBeDefined();

    // The subcommand echoes the session log file path at startup; invoking the
    // WS event logger must append there without dumping payloads to console.
    const logFileLine = logs.find((line) => line.startsWith("Log file: "));
    expect(logFileLine).toBeDefined();
    const logFilePath = logFileLine?.slice("Log file: ".length);

    onWsEvent?.("recv", "protocol", { type: "server_state" });

    expect(logs.join("\n")).not.toContain("\u2190 recv");
    const fileContent = await readFile(logFilePath ?? "", "utf8");
    expect(fileContent).toContain("\u2190 recv (protocol)");
    expect(fileContent).toContain(JSON.stringify({ type: "server_state" }));
  });

  test("LETTA_LOG_WS_EVENTS=1 without --debug captures WS events to file without console dumps on non-TTY stdout", async () => {
    setStdoutIsTTY(undefined);
    process.env.LETTA_LOG_WS_EVENTS = "1";

    const exitCode = await runListenSubcommand(["--computer-name", "ci-env"]);

    expect(exitCode).toBe(1);
    expect(startListenerClientCalls).toBe(1);
    expect(inkRenderCalls.length).toBe(0);
    // The env var enables WS event file capture without --debug...
    const onWsEvent = capturedListenerOptions?.onWsEvent;
    expect(onWsEvent).toBeDefined();
    // ...but the console payload dump stays gated on --debug, so systemd's
    // journald only sees the one-line status logs.
    onWsEvent?.("send", "client", { type: "test_frame" });
    expect(logs.join("\n")).not.toContain("\u2192 send");
    expect(logs.join("\n")).not.toContain(
      JSON.stringify({ type: "test_frame" }),
    );
  });
});
