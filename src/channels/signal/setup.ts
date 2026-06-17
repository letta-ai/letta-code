import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "@/channels/accounts";
import type {
  DmPolicy,
  SignalChannelAccount,
  SignalGroupMode,
} from "@/channels/types";
import { SignalRestClient } from "./client";
import {
  ensureSignalRuntimeInstalled,
  loadSignalQrCodeTerminalModule,
  renderSignalQrTerminal,
} from "./runtime";

const DEFAULT_SIGNAL_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SIGNAL_ACCOUNT_ID = "personal";
const DEFAULT_SIGNAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const SIGNAL_DOCKER_CONTAINER = "letta-signal-cli";
const SIGNAL_DOCKER_VOLUME = "letta-signal-cli-data";
const SIGNAL_DOCKER_IMAGE = "bbernhard/signal-cli-rest-api:latest";
const SIGNAL_CAPTCHA_URL =
  "https://signalcaptchas.org/registration/generate.html";

function parseYesNo(input: string, defaultValue: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return /^(y|yes|true|1)$/i.test(trimmed);
}

export function parseSignalCsv(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeSignalPhoneInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.startsWith("+")
    ? `+${trimmed.slice(1).replace(/\D/g, "")}`
    : `+${trimmed.replace(/\D/g, "")}`;
  return /^\+\d{5,15}$/.test(normalized) ? normalized : undefined;
}

export function normalizeSignalBaseUrl(input: string): string | undefined {
  const trimmed = input.trim() || DEFAULT_SIGNAL_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isDmPolicy(value: string): value is DmPolicy {
  return value === "pairing" || value === "allowlist" || value === "open";
}

function isSignalGroupMode(value: string): value is SignalGroupMode {
  return value === "disabled" || value === "mention" || value === "open";
}

function parseMediaMaxBytes(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_SIGNAL_MEDIA_MAX_BYTES;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

export function getSignalDockerRunCommand(): string {
  return [
    "docker run -d",
    `--name ${SIGNAL_DOCKER_CONTAINER}`,
    "-p 8080:8080",
    "-e MODE=json-rpc",
    `-v ${SIGNAL_DOCKER_VOLUME}:/home/.local/share/signal-cli`,
    SIGNAL_DOCKER_IMAGE,
  ].join(" ");
}

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function getDefaultSignalCliConfigDir(): string {
  return `${process.env.HOME ?? ""}/.local/share/signal-cli`;
}

export function parseNativeSignalCliDaemonConfigDir(
  processText: string,
): string | null {
  const match = processText.match(
    /(?:^|\s)(?:-c|--config|--data-dir|-d)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function detectNativeSignalCliConfigDir(): string | null {
  try {
    const output = execFileSync("ps", ["axo", "command"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("signal-cli") || !line.includes(" daemon")) {
        continue;
      }
      const configDir = parseNativeSignalCliDaemonConfigDir(line);
      if (configDir) return configDir;
    }
  } catch {
    // Fall through to default path.
  }
  const defaultDir = getDefaultSignalCliConfigDir();
  return defaultDir && existsSync(defaultDir) ? defaultDir : null;
}

function runNativeSignalCli(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync("signal-cli", args, {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120_000,
    });
    return { ok: true };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const detail = [err.stderr, err.stdout, err.message]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .join("\n")
      .trim();
    return { ok: false, error: detail || String(error) };
  }
}

function runNativeSignalCliInteractive(
  args: string[],
  onOutput?: (output: string) => void | Promise<void>,
): Promise<
  { ok: true; output: string } | { ok: false; output: string; error: string }
> {
  return new Promise((resolve) => {
    const child = spawn("signal-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
      void onOutput?.(output);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
      void onOutput?.(output);
    });
    child.on("error", (error) => {
      resolve({ ok: false, output, error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, output });
      } else {
        resolve({
          ok: false,
          output,
          error: `signal-cli exited with code ${code ?? "unknown"}`,
        });
      }
    });
  });
}

export function parseSignalLinkAssociatedAccount(
  output: string,
): string | null {
  const match = output.match(/Associated with:\s*(\+\d{5,15})/i);
  return match?.[1] ?? null;
}

export function parseSignalLinkExistingAccount(output: string): string | null {
  const match = output.match(/The user\s+(\+\d{5,15})\s+already exists/i);
  return match?.[1] ?? null;
}

export function parseSignalCliDeletePath(output: string): string | null {
  const match = output.match(/Delete\s+"([^"]+)"\s+before trying again/i);
  return match?.[1] ?? null;
}

export function parseSignalLinkUri(output: string): string | null {
  const match = output.match(/sgnl:\/\/linkdevice\?\S+/i);
  return match?.[0] ?? null;
}

async function probeSignalDaemon(baseUrl: string): Promise<boolean> {
  try {
    await new SignalRestClient({ baseUrl }).check();
    return true;
  } catch {
    return false;
  }
}

async function fetchSignalSetupJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    const parsed = text.trim() ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : text || response.statusText;
      throw new Error(message);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function hasSignalSetupRestEndpoints(
  baseUrl: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/v1/about`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractSignalAccountsFromResponse(response: unknown): string[] {
  const values = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.accounts)
      ? response.accounts
      : [];
  return values
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isRecord(entry)) {
        const number = entry.number ?? entry.account ?? entry.username;
        return typeof number === "string" ? number : "";
      }
      return "";
    })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function listSignalDaemonAccounts(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetchSignalSetupJson(baseUrl, "/v1/accounts");
    return extractSignalAccountsFromResponse(response);
  } catch {
    return [];
  }
}

export function getSignalQrLinkUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/v1/qrcodelink`);
  url.searchParams.set("device_name", "Letta Code");
  return url.toString();
}

async function openUrl(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForSignalDaemon(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probeSignalDaemon(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function startSignalDockerDaemon(): Promise<void> {
  execFileSync("docker", ["volume", "create", SIGNAL_DOCKER_VOLUME], {
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync("docker", ["rm", "-f", SIGNAL_DOCKER_CONTAINER], {
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      SIGNAL_DOCKER_CONTAINER,
      "-p",
      "8080:8080",
      "-e",
      "MODE=json-rpc",
      "-v",
      `${SIGNAL_DOCKER_VOLUME}:/home/.local/share/signal-cli`,
      SIGNAL_DOCKER_IMAGE,
    ],
    { stdio: "inherit", timeout: 60_000 },
  );
}

async function configureSignalDaemonUrl(
  rl: ReturnType<typeof createInterface>,
): Promise<string | null> {
  console.log("Checking for a local signal-cli-rest-api daemon...");
  if (await probeSignalDaemon(DEFAULT_SIGNAL_BASE_URL)) {
    console.log(`✓ Found signal-cli-rest-api at ${DEFAULT_SIGNAL_BASE_URL}\n`);
    return DEFAULT_SIGNAL_BASE_URL;
  }

  console.log(`No daemon responded at ${DEFAULT_SIGNAL_BASE_URL}.`);
  if (commandExists("docker")) {
    console.log(
      "Docker is available, so Letta can start signal-cli-rest-api for you.",
    );
    console.log(
      "This creates a persistent Docker volume named letta-signal-cli-data.",
    );
    const startInput = await rl.question(
      "Start a local Signal daemon with Docker now? [Y/n]: ",
    );
    if (parseYesNo(startInput, true)) {
      try {
        await startSignalDockerDaemon();
        console.log("Waiting for signal-cli-rest-api to become ready...");
        if (await waitForSignalDaemon(DEFAULT_SIGNAL_BASE_URL)) {
          console.log(
            `✓ Started Signal daemon at ${DEFAULT_SIGNAL_BASE_URL}\n`,
          );
          return DEFAULT_SIGNAL_BASE_URL;
        }
        console.error(
          "Docker container started, but signal-cli-rest-api did not become ready in time.",
        );
      } catch (error) {
        console.error(
          `Could not start Signal Docker container: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    console.log("Docker was not found on PATH.");
  }

  console.log("\nManual Docker command:");
  console.log(`  docker volume create ${SIGNAL_DOCKER_VOLUME}`);
  console.log(`  ${getSignalDockerRunCommand()}\n`);

  const customInput = await rl.question(
    `Custom signal-cli-rest-api base URL, or blank to use ${DEFAULT_SIGNAL_BASE_URL}: `,
  );
  const baseUrl = normalizeSignalBaseUrl(customInput);
  if (!baseUrl) {
    console.error("Invalid base URL. Setup cancelled.");
    return null;
  }

  const probeInput = await rl.question("Probe that daemon now? [Y/n]: ");
  if (parseYesNo(probeInput, true)) {
    if (!(await probeSignalDaemon(baseUrl))) {
      console.error(
        `Could not reach signal-cli-rest-api at ${baseUrl}. Start it with MODE=json-rpc and try again.`,
      );
      return null;
    }
    console.log("✓ signal-cli-rest-api responded.\n");
  }
  return baseUrl;
}

async function waitForNewSignalAccount(
  baseUrl: string,
  previousAccounts: string[],
): Promise<string | null> {
  const previous = new Set(previousAccounts);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const accounts = await listSignalDaemonAccounts(baseUrl);
    const next = accounts.find((account) => !previous.has(account));
    if (next) return next;
    if (previousAccounts.length === 0 && accounts[0]) return accounts[0];
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function chooseExistingSignalAccount(
  rl: ReturnType<typeof createInterface>,
  accounts: string[],
): Promise<string | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) {
    const [account] = accounts;
    if (!account) return null;
    const useInput = await rl.question(
      `Use linked Signal account ${account}? [Y/n]: `,
    );
    return parseYesNo(useInput, true) ? account : null;
  }

  console.log("\nLinked Signal accounts:");
  accounts.forEach((account, index) => {
    console.log(`  ${index + 1}. ${account}`);
  });
  const choiceInput = await rl.question(
    "Choose account number, or blank to skip: ",
  );
  if (!choiceInput.trim()) return null;
  const index = Number(choiceInput.trim()) - 1;
  return Number.isInteger(index) && accounts[index] ? accounts[index] : null;
}

async function linkSignalAccountWithQr(
  rl: ReturnType<typeof createInterface>,
  baseUrl: string,
  previousAccounts: string[],
): Promise<string | null> {
  const qrUrl = getSignalQrLinkUrl(baseUrl);
  console.log("\nSignal QR link flow:");
  console.log("  1. Open this URL in a browser:");
  console.log(`     ${qrUrl}`);
  console.log("  2. In Signal mobile: Settings → Linked Devices → +");
  console.log("  3. Scan the QR code shown by signal-cli-rest-api.\n");
  const openInput = await rl.question("Open the QR page now? [Y/n]: ");
  if (parseYesNo(openInput, true)) {
    await openUrl(qrUrl);
  }
  const waitInput = await rl.question(
    "After scanning, wait for Letta to detect the linked account? [Y/n]: ",
  );
  if (!parseYesNo(waitInput, true)) {
    return null;
  }
  console.log("Waiting for linked Signal account...");
  const account = await waitForNewSignalAccount(baseUrl, previousAccounts);
  if (account) {
    console.log(`✓ Detected linked Signal account ${account}\n`);
  } else {
    console.log("No linked account detected before timeout.\n");
  }
  return account;
}

async function registerSignalAccountWithSms(
  rl: ReturnType<typeof createInterface>,
  baseUrl: string,
): Promise<string | null> {
  console.log("\nDedicated-number SMS registration:");
  console.log(
    "Warning: registering a number with signal-cli can de-authenticate another Signal session for that number. Use a dedicated bot number when possible.\n",
  );
  const phoneInput = await rl.question(
    "Dedicated Signal phone number in E.164 format (e.g. +15555550100): ",
  );
  const phone = normalizeSignalPhoneInput(phoneInput);
  if (!phone) {
    console.error("Invalid phone number.");
    return null;
  }

  const voiceInput = await rl.question(
    "Use voice call instead of SMS? [y/N]: ",
  );
  const useVoice = parseYesNo(voiceInput, false);
  try {
    await fetchSignalSetupJson(
      baseUrl,
      `/v1/register/${encodeURIComponent(phone)}`,
      {
        method: "POST",
        body: JSON.stringify(useVoice ? { use_voice: true } : {}),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/captcha/i.test(message)) {
      console.log(
        "Signal requires a captcha before registration can continue.",
      );
      console.log(
        "  1. Open https://signalcaptchas.org/registration/generate.html",
      );
      console.log("  2. Complete captcha and copy the signalcaptcha:// URL.");
      const captcha = await rl.question(
        "Paste captcha URL, or blank to cancel: ",
      );
      if (!captcha.trim()) return null;
      await fetchSignalSetupJson(
        baseUrl,
        `/v1/register/${encodeURIComponent(phone)}`,
        {
          method: "POST",
          body: JSON.stringify({
            captcha: captcha.trim(),
            ...(useVoice ? { use_voice: true } : {}),
          }),
        },
      );
    } else {
      console.error(`Registration request failed: ${message}`);
      return null;
    }
  }

  const code = await rl.question("Verification code from Signal SMS/voice: ");
  if (!code.trim()) return null;
  try {
    await fetchSignalSetupJson(
      baseUrl,
      `/v1/register/${encodeURIComponent(phone)}/verify/${encodeURIComponent(code.trim())}`,
      { method: "POST" },
    );
    console.log(`✓ Registered Signal account ${phone}\n`);
    return phone;
  } catch (error) {
    console.error(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function registerSignalAccountWithNativeCli(
  rl: ReturnType<typeof createInterface>,
): Promise<string | null> {
  if (!commandExists("signal-cli")) {
    console.log("signal-cli was not found on PATH.");
    return null;
  }

  const detectedConfigDir = detectNativeSignalCliConfigDir();
  const configInput = await rl.question(
    `signal-cli config directory [${detectedConfigDir ?? getDefaultSignalCliConfigDir()}]: `,
  );
  const configDir =
    configInput.trim() || detectedConfigDir || getDefaultSignalCliConfigDir();
  const phoneInput = await rl.question(
    "Dedicated Signal phone number in E.164 format (e.g. +15555550100): ",
  );
  const phone = normalizeSignalPhoneInput(phoneInput);
  if (!phone) {
    console.error("Invalid phone number.");
    return null;
  }

  const voiceInput = await rl.question(
    "Use voice call instead of SMS? [y/N]: ",
  );
  const useVoice = parseYesNo(voiceInput, false);
  const baseArgs = ["-c", configDir, "-a", phone];
  const registerArgs = [
    ...baseArgs,
    "register",
    ...(useVoice ? ["--voice"] : []),
  ];
  console.log("Requesting Signal verification...");
  let result = runNativeSignalCli(registerArgs);
  if (!result.ok && /captcha/i.test(result.error)) {
    console.log("Signal requires a captcha before registration can continue.");
    console.log(`Opening captcha page: ${SIGNAL_CAPTCHA_URL}`);
    await openUrl(SIGNAL_CAPTCHA_URL);
    const captcha = await rl.question(
      "Paste the signalcaptcha:// URL, or blank to cancel: ",
    );
    if (!captcha.trim()) return null;
    result = runNativeSignalCli([
      ...baseArgs,
      "register",
      ...(useVoice ? ["--voice"] : []),
      "--captcha",
      captcha.trim(),
    ]);
  }
  if (!result.ok) {
    console.error(`signal-cli register failed: ${result.error}`);
    if (/in use by another instance|waiting/i.test(result.error)) {
      console.error(
        "The signal-cli config appears to be in use. Stop the running signal-cli daemon, rerun configure to register/verify, then restart the daemon.",
      );
    }
    return null;
  }

  const code = await rl.question("Verification code from Signal SMS/voice: ");
  if (!code.trim()) return null;
  const verifyResult = runNativeSignalCli([...baseArgs, "verify", code.trim()]);
  if (!verifyResult.ok) {
    console.error(`signal-cli verify failed: ${verifyResult.error}`);
    return null;
  }
  console.log(`✓ Registered Signal account ${phone}\n`);
  return phone;
}

async function linkSignalAccountWithNativeCli(
  rl: ReturnType<typeof createInterface>,
): Promise<string | null> {
  if (!commandExists("signal-cli")) {
    console.log("signal-cli was not found on PATH.");
    return null;
  }
  const detectedConfigDir = detectNativeSignalCliConfigDir();
  const configInput = await rl.question(
    `signal-cli config directory [${detectedConfigDir ?? getDefaultSignalCliConfigDir()}]: `,
  );
  const configDir =
    configInput.trim() || detectedConfigDir || getDefaultSignalCliConfigDir();
  console.log('Running: signal-cli link -n "Letta Code"');
  console.log(
    "Scan the QR/link output with Signal → Settings → Linked Devices → +.",
  );
  let renderedLinkUri: string | null = null;
  const maybeRenderQr = async (output: string) => {
    const linkUri = parseSignalLinkUri(output);
    if (!linkUri || renderedLinkUri === linkUri) return;
    renderedLinkUri = linkUri;
    const qrMod = await loadSignalQrCodeTerminalModule().catch(() => null);
    const qr = renderSignalQrTerminal(qrMod, linkUri);
    if (qr) {
      console.log(
        "\nScan this QR code in Signal → Settings → Linked Devices → +:\n",
      );
      console.log(qr);
    } else {
      console.log(
        "\nCould not render an ASCII QR code. Run `letta channels install signal` to install QR rendering support, or copy the sgnl:// link above into a QR generator.\n",
      );
    }
  };
  const result = await runNativeSignalCliInteractive(
    ["-c", configDir, "link", "-n", "Letta Code"],
    maybeRenderQr,
  );
  if (!result.ok) {
    const existingAccount = parseSignalLinkExistingAccount(result.output);
    if (existingAccount) {
      const deletePath = parseSignalCliDeletePath(result.output);
      const useExisting = await rl.question(
        `Signal account ${existingAccount} is already linked in this config. Use it? [Y/n]: `,
      );
      if (parseYesNo(useExisting, true)) {
        return existingAccount;
      }
      console.log(
        deletePath
          ? `Setup cancelled. To relink from scratch, delete ${deletePath}, then rerun configure.`
          : "Setup cancelled. To relink from scratch, follow the signal-cli delete-path instruction above, then rerun configure.",
      );
      return null;
    }
    console.error(`signal-cli link failed: ${result.error}`);
    return null;
  }

  const linkedAccount = parseSignalLinkAssociatedAccount(result.output);
  if (linkedAccount) {
    console.log(`✓ Linked Signal account ${linkedAccount}\n`);
    return linkedAccount;
  }

  const phoneInput = await rl.question(
    "Could not detect the linked phone number. Enter it in E.164 format (e.g. +15555550100): ",
  );
  const phone = normalizeSignalPhoneInput(phoneInput);
  if (!phone) {
    console.error("Invalid Signal phone number. Setup cancelled.");
    return null;
  }
  return phone;
}

async function configureSignalAccountIdentity(
  rl: ReturnType<typeof createInterface>,
  baseUrl: string,
): Promise<string | null> {
  const hasSetupRest = await hasSignalSetupRestEndpoints(baseUrl);
  if (!hasSetupRest) {
    console.log(
      "\nThis daemon exposes Letta's runtime JSON-RPC endpoints, but not signal-cli-rest-api setup endpoints like /v1/accounts or /v1/qrcodelink.",
    );
    console.log("Letta can still use it after the Signal account is linked.");
    console.log(
      "To link/register the account, use one of these outside Letta:",
    );
    console.log('  QR link: signal-cli link -n "Letta Code"');
    console.log("  SMS register: signal-cli -a +<BOT_PHONE_NUMBER> register");
    console.log(
      "  If Signal asks for captcha: open https://signalcaptchas.org/registration/generate.html, copy the signalcaptcha:// URL, then run:",
    );
    console.log(
      "    signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'",
    );
    console.log(
      "  Verify SMS: signal-cli -a +<BOT_PHONE_NUMBER> verify <CODE>",
    );
    console.log(
      "After link/register succeeds, come back here and enter that Signal phone number.",
    );
    console.log(
      "If you want Letta to drive QR/SMS setup, use a signal-cli-rest-api container exposing /v1/* setup endpoints.\n",
    );
    if (commandExists("signal-cli")) {
      console.log(
        "Letta found signal-cli locally and can run native setup commands for you.",
      );
      console.log(
        "  1. Link an existing Signal account/device with native signal-cli",
      );
      console.log(
        "  2. Register a dedicated Signal number with native signal-cli",
      );
      console.log(
        "  3. I already linked/registered it; I'll type the phone number",
      );
      const nativeChoice = (await rl.question("Choose [3]: ")).trim() || "3";
      if (nativeChoice === "1") {
        const linked = await linkSignalAccountWithNativeCli(rl);
        return linked;
      } else if (nativeChoice === "2") {
        const registered = await registerSignalAccountWithNativeCli(rl);
        return registered;
      }
    }
    const accountInput = await rl.question(
      "Linked Signal account phone number in E.164 format (e.g. +15555550100): ",
    );
    const account = normalizeSignalPhoneInput(accountInput);
    if (!account) {
      console.error("Invalid Signal phone number. Setup cancelled.");
      return null;
    }
    return account;
  }

  const accounts = await listSignalDaemonAccounts(baseUrl);
  const existing = await chooseExistingSignalAccount(rl, accounts);
  if (existing) return existing;

  console.log("\nNo linked Signal account selected.");
  console.log("How do you want to connect Signal?");
  console.log("  1. Link an existing Signal account/device with a QR code");
  console.log("  2. Register a dedicated Signal number with SMS/voice");
  console.log(
    "  3. I already linked/registered it; I'll type the phone number",
  );
  const choice = (await rl.question("Choose [1]: ")).trim() || "1";

  if (choice === "1") {
    const linked = await linkSignalAccountWithQr(rl, baseUrl, accounts);
    if (linked) return linked;
  } else if (choice === "2") {
    const registered = await registerSignalAccountWithSms(rl, baseUrl);
    if (registered) return registered;
  }

  const accountInput = await rl.question(
    "Signal account phone number in E.164 format (e.g. +15555550100): ",
  );
  const account = normalizeSignalPhoneInput(accountInput);
  if (!account) {
    console.error("Invalid Signal phone number. Setup cancelled.");
    return null;
  }
  return account;
}

export async function runSignalSetup(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n📱 Signal Setup\n");
    console.log(
      "Letta talks to Signal through native signal-cli daemon or a compatible JSON-RPC/SSE bridge.",
    );
    console.log(
      "Recommended: use a dedicated Signal number for the agent. If you use your personal Signal account, self-message loop protection may ignore your own messages.",
    );
    console.log(
      "Before continuing, start a native signal-cli daemon or signal-cli-rest-api with MODE=json-rpc, and register/link the Signal account. See src/channels/signal/README.md for examples.\n",
    );

    await ensureSignalRuntimeInstalled().catch((error) => {
      console.warn(
        `Could not install optional Signal setup helpers: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const baseUrl = await configureSignalDaemonUrl(rl);
    if (!baseUrl) {
      return false;
    }

    const account = await configureSignalAccountIdentity(rl, baseUrl);
    if (!account) {
      return false;
    }

    console.log(
      "\nLetta stores each Signal connection under a local account label. Use the default unless you plan to configure multiple Signal accounts.",
    );
    const accountIdInput = await rl.question(
      `Local account label [${DEFAULT_SIGNAL_ACCOUNT_ID}]: `,
    );
    const accountId = accountIdInput.trim() || DEFAULT_SIGNAL_ACCOUNT_ID;

    let accountUuid: string | undefined;
    const advancedIdentityInput = await rl.question(
      "Configure advanced identity/loop-protection settings? [y/N]: ",
    );
    if (parseYesNo(advancedIdentityInput, false)) {
      console.log(
        "Signal can echo messages sent by the linked account from another device. Letta ignores messages from its own phone number automatically; if your daemon reports your own sender as a UUID instead of a phone number, enter that UUID here so Letta can ignore those self-echoes too.",
      );
      const accountUuidInput = await rl.question(
        "Own Signal account UUID (optional, blank if unsure): ",
      );
      accountUuid = accountUuidInput.trim() || undefined;
    }

    console.log("\nDM policy — who can message this Signal account?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only listed phone numbers/UUIDs");
    console.log("  open      — Any direct chat can route\n");
    const policyInput = await rl.question("DM policy [pairing]: ");
    const dmPolicy = policyInput.trim() || "pairing";
    if (!isDmPolicy(dmPolicy)) {
      console.error(`Invalid DM policy "${dmPolicy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (dmPolicy === "allowlist") {
      allowedUsers = parseSignalCsv(
        await rl.question(
          "Allowed Signal phone numbers/UUIDs (comma-separated): ",
        ),
      );
    }

    const envAgentId = process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "";
    let agentId: string | null = null;
    if (envAgentId) {
      const useEnv = await rl.question(
        `\nBind to agent ${envAgentId}? [Y/n]: `,
      );
      if (parseYesNo(useEnv, true)) {
        agentId = envAgentId;
      }
    }
    if (!agentId) {
      const agentInput = await rl.question(
        "\nAgent ID for account-bound DM/group routing (optional): ",
      );
      agentId = agentInput.trim() || null;
    }

    console.log(
      "\nPersonal-number mode lets you talk to the agent through Signal's Note to Self / self-chat with this linked account. In this mode, Letta ignores messages from other Signal DMs on this account.",
    );
    const selfChatInput = await rl.question(
      "Use Note to Self / self-chat mode for this Signal account? [y/N]: ",
    );
    const selfChatMode = parseYesNo(selfChatInput, false);

    const groupInput = await rl.question(
      "\nGroup mode: disabled, mention, or open [disabled]: ",
    );
    const groupMode = groupInput.trim() || "disabled";
    if (!isSignalGroupMode(groupMode)) {
      console.error(`Invalid group mode "${groupMode}". Setup cancelled.`);
      return false;
    }

    const allowedGroups =
      groupMode === "disabled"
        ? []
        : parseSignalCsv(
            await rl.question(
              "Allowed Signal group IDs (comma-separated, blank for all groups): ",
            ),
          );
    const mentionPatterns =
      groupMode === "mention"
        ? parseSignalCsv(
            await rl.question(
              "Mention text aliases/substrings (comma-separated, default: letta): ",
            ),
          )
        : [];

    const mediaInput = await rl.question("Download inbound media? [Y/n]: ");
    const downloadMedia = parseYesNo(mediaInput, true);
    const mediaMaxInput = await rl.question(
      `Maximum inbound media bytes [${DEFAULT_SIGNAL_MEDIA_MAX_BYTES}]: `,
    );
    const mediaMaxBytes = parseMediaMaxBytes(mediaMaxInput);
    if (!mediaMaxBytes) {
      console.error("Invalid media byte limit. Setup cancelled.");
      return false;
    }

    console.log(
      "\nVoice transcription requires OPENAI_API_KEY. Some Signal voice notes arrive as raw .aac and require ffmpeg on the listener machine.",
    );
    const transcriptionInput = await rl.question(
      "Auto-transcribe Signal audio when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = parseYesNo(transcriptionInput, false);

    const now = new Date().toISOString();
    const accountRecord: SignalChannelAccount = {
      channel: "signal",
      accountId,
      displayName: `Signal ${account}`,
      enabled: true,
      baseUrl,
      account,
      accountUuid,
      agentId,
      selfChatMode,
      dmPolicy,
      allowedUsers,
      groupMode,
      allowedGroups,
      mentionPatterns:
        groupMode === "mention" && mentionPatterns.length === 0
          ? ["letta"]
          : mentionPatterns,
      downloadMedia,
      mediaMaxBytes,
      transcribeVoice,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("signal", accountRecord);
    console.log("\n✓ Signal account configured!");
    console.log("Config written to: ~/.letta/channels/signal/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start/restart: letta server --channels signal");
    console.log("  2. Send the Signal account a DM to receive a pairing code");
    console.log(
      "  3. In the target ADE/Desktop conversation, run: /channels signal pair <code>",
    );
    console.log(
      "  4. If voice transcription reports ffmpeg errors, install ffmpeg on the listener machine.\n",
    );
    return true;
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return false;
  } finally {
    rl.close();
  }
}
