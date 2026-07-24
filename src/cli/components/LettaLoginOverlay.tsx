import { useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { LettaLoginView } from "@/auth/LettaLoginView";
import {
  LETTA_CLOUD_API_URL,
  validateCredentialsWithResult,
} from "@/auth/oauth";
import { OverlayShell } from "@/cli/components/OverlayShell";
import { Text } from "@/cli/components/Text";
import { settingsManager } from "@/settings-manager";

interface LettaLoginOverlayProps {
  onComplete: () => void;
  onAlreadyLoggedIn: () => void;
  onCancel: () => void;
}

export function LettaLoginOverlay({
  onComplete,
  onAlreadyLoggedIn,
  onCancel,
}: LettaLoginOverlayProps) {
  const onAlreadyLoggedInRef = useRef(onAlreadyLoggedIn);
  const onCancelRef = useRef(onCancel);
  onAlreadyLoggedInRef.current = onAlreadyLoggedIn;
  onCancelRef.current = onCancel;

  const [preflight, setPreflight] = useState<
    | { status: "checking" }
    | { status: "login" }
    | { status: "error"; message: string }
  >({ status: "checking" });

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) {
        onCancelRef.current();
      }
    },
    { isActive: preflight.status !== "login" },
  );

  useEffect(() => {
    let cancelled = false;

    const runPreflight = async () => {
      try {
        const currentSettings =
          await settingsManager.getSettingsWithSecureTokens();
        const envApiKey = process.env.LETTA_API_KEY;
        const storedApiKey = currentSettings.env?.LETTA_API_KEY;
        const apiKey = envApiKey || storedApiKey;

        if (!apiKey) {
          if (!cancelled) {
            setPreflight({ status: "login" });
          }
          return;
        }

        const baseURL =
          process.env.LETTA_BASE_URL ||
          currentSettings.env?.LETTA_BASE_URL ||
          LETTA_CLOUD_API_URL;
        const validation = await validateCredentialsWithResult(baseURL, apiKey);

        if (cancelled) {
          return;
        }

        if (validation.ok) {
          onAlreadyLoggedInRef.current();
          return;
        }

        if (envApiKey) {
          setPreflight({
            status: "error",
            message:
              "LETTA_API_KEY is set in your environment but is not valid. Unset or update LETTA_API_KEY, then run /login again.",
          });
          return;
        }

        if (
          validation.reason === "network_error" ||
          validation.reason === "server_unreachable"
        ) {
          setPreflight({
            status: "error",
            message: `Could not verify current credentials: ${validation.message}`,
          });
          return;
        }

        setPreflight({ status: "login" });
      } catch (error) {
        if (!cancelled) {
          setPreflight({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    void runPreflight();

    return () => {
      cancelled = true;
    };
  }, []);

  if (preflight.status === "checking") {
    return (
      <OverlayShell command="/login" title="Sign in with Letta">
        <Text dimColor>Checking current credentials...</Text>
      </OverlayShell>
    );
  }

  if (preflight.status === "error") {
    return (
      <OverlayShell command="/login" title="Sign in with Letta">
        <Text color="red">✗ Error: {preflight.message}</Text>
        <Text dimColor>Press Esc to cancel</Text>
      </OverlayShell>
    );
  }

  return (
    <OverlayShell command="/login" title="Sign in with Letta">
      <LettaLoginView onComplete={onComplete} onCancel={onCancel} />
    </OverlayShell>
  );
}
