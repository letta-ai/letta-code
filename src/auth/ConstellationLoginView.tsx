import { hostname } from "node:os";
import { Box, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { configureBackendMode } from "@/backend";
import { Text } from "@/cli/components/Text";
import { settingsManager } from "@/settings-manager";
import { pollForToken, requestDeviceCode } from "./oauth";

interface ConstellationLoginViewProps {
  onComplete?: () => void;
  onAlreadyLoggedIn?: () => void;
  onCancel?: () => void;
}

export function ConstellationLoginView({
  onComplete,
  onAlreadyLoggedIn,
  onCancel,
}: ConstellationLoginViewProps) {
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      cancelledRef.current = true;
      abortControllerRef.current?.abort();
      onCancel?.();
    }
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    abortControllerRef.current = new AbortController();

    const run = async () => {
      try {
        const currentSettings =
          await settingsManager.getSettingsWithSecureTokens();
        const hasApiKey =
          process.env.LETTA_API_KEY || currentSettings.env?.LETTA_API_KEY;

        if (hasApiKey) {
          onAlreadyLoggedIn?.();
          return;
        }

        const deviceData = await requestDeviceCode();
        setUserCode(deviceData.user_code);
        setVerificationUri(deviceData.verification_uri_complete);

        import("open")
          .then(({ default: open }) =>
            open(deviceData.verification_uri_complete, { wait: false }),
          )
          .then((subprocess) => {
            subprocess.on("error", () => {
              // Silently ignore - user can manually visit the URL shown above
            });
          })
          .catch(() => {
            // Silently ignore any failures
          });

        const deviceId = settingsManager.getOrCreateDeviceId();
        const deviceName = hostname();
        const controller = abortControllerRef.current;
        if (!controller) {
          return;
        }
        const tokens = await pollForToken(
          deviceData.device_code,
          deviceData.interval,
          deviceData.expires_in,
          deviceId,
          deviceName,
          controller.signal,
        );

        const now = Date.now();
        settingsManager.updateSettings({
          env: {
            ...settingsManager.getSettings().env,
            LETTA_API_KEY: tokens.access_token,
          },
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: now + tokens.expires_in * 1000,
          preferredBackendMode: "api",
        });
        await settingsManager.flush();
        configureBackendMode("api");

        setDoneMessage(
          "Signed in to Constellation. Switch to a Constellation agent with /agents.",
        );
        setTimeout(() => onComplete?.(), 500);
      } catch (err) {
        if (
          cancelledRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    return () => {
      cancelledRef.current = true;
      abortControllerRef.current?.abort();
    };
  }, [onAlreadyLoggedIn, onComplete]);

  if (doneMessage) {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Login complete!</Text>
        <Text dimColor>{doneMessage}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>Opening browser for authorization...</Text>
      <Text> </Text>
      <Text>
        Your authorization code:{" "}
        <Text color="yellow" bold>
          {userCode}
        </Text>
      </Text>
      <Text dimColor>If browser didn't open, visit: {verificationUri}</Text>
      <Text> </Text>
      <Text dimColor>Waiting for you to authorize in the browser...</Text>
      <Text dimColor>Press Esc to cancel</Text>
    </Box>
  );
}
