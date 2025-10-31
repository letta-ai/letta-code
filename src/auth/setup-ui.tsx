/**
 * Ink UI components for OAuth setup flow
 */

import crypto from "crypto";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";
import { settingsManager } from "../settings-manager";
import {
  OAUTH_CONFIG,
  pollForToken,
  requestDeviceCode,
  validateCredentials,
} from "./oauth";
import {asciiLogo} from "../cli/components/AsciiArt.ts";

type SetupMode = "menu" | "device-code" | "auth-code" | "self-host" | "done";

interface SetupUIProps {
  onComplete: () => void;
}

export function SetupUI({ onComplete }: SetupUIProps) {
  const [mode, setMode] = useState<SetupMode>("menu");
  const [selectedOption, setSelectedOption] = useState(0);
  const [baseUrl, setBaseUrl] = useState("https://api.letta.com");
  const [apiKey, setApiKey] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [selfHostStep, setSelfHostStep] = useState<"url" | "apikey">("url");

  const { exit } = useApp();

  // Handle menu navigation
  useInput(
    (_input, key) => {
      if (mode === "menu") {
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedOption((prev) => Math.min(2, prev + 1));
        } else if (key.return) {
          if (selectedOption === 0) {
            // Login to Letta Cloud - start device code flow
            setMode("device-code");
            startDeviceCodeFlow();
          } else if (selectedOption === 1) {
            setMode("self-host");
            setSelfHostStep("url"); // Reset to first step
          } else if (selectedOption === 2) {
            exit();
          }
        }
      }
    },
    { isActive: mode === "menu" },
  );

  const startDeviceCodeFlow = async () => {
    try {
      const deviceData = await requestDeviceCode();
      setDeviceCode(deviceData.device_code);
      setUserCode(deviceData.user_code);
      setVerificationUri(deviceData.verification_uri_complete);

      // Auto-open browser
      try {
        const { default: open } = await import("open");
        await open(deviceData.verification_uri_complete);
      } catch (openErr) {
        // If auto-open fails, user can still manually visit the URL
        console.error("Failed to auto-open browser:", openErr);
      }

      // Start polling in background
      pollForToken(
        deviceData.device_code,
        deviceData.interval,
        deviceData.expires_in,
      )
        .then((tokens) => {
          // Save tokens
          const now = Date.now();
          settingsManager.updateSettings({
            env: {
              ...settingsManager.getSettings().env,
              LETTA_API_KEY: tokens.access_token,
              LETTA_BASE_URL: OAUTH_CONFIG.apiBaseUrl,
            },
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: now + tokens.expires_in * 1000,
          });
          setMode("done");
          setTimeout(() => onComplete(), 1000);
        })
        .catch((err) => {
          setError(err.message);
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBaseUrlSubmit = () => {
    if (!baseUrl) {
      setError("Base URL is required");
      return;
    }
    setError(null);
    setSelfHostStep("apikey");
  };

  const handleApiKeySubmit = async () => {
    setIsValidating(true);
    setError(null);

    // Validate credentials
    const isValid = await validateCredentials(baseUrl, apiKey || "no-key");

    if (!isValid) {
      setError(
        "Failed to connect to server. Please check the URL and API key.",
      );
      setIsValidating(false);
      return;
    }

    // Save settings
    settingsManager.updateSettings({
      env: {
        ...settingsManager.getSettings().env,
        LETTA_BASE_URL: baseUrl,
        ...(apiKey ? { LETTA_API_KEY: apiKey } : {}),
      },
    });

    setMode("done");
    setTimeout(() => onComplete(), 1000);
  };

  if (mode === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">✓ Setup complete!</Text>
        <Text dimColor>Starting Letta Code...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">✗ Error: {error}</Text>
        <Text dimColor>Press Ctrl+C to exit</Text>
      </Box>
    );
  }

  if (mode === "device-code") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>{asciiLogo}</Text>
        <Text bold>Login to Letta Cloud</Text>
        <Text> </Text>
        <Text dimColor>Opening browser for authorization...</Text>
        <Text> </Text>
        <Text>
          Your authorization code:{" "}
          <Text color="yellow" bold>
            {userCode}
          </Text>
        </Text>
        <Text dimColor>URL: {verificationUri}</Text>
        <Text> </Text>
        <Text dimColor>Waiting for you to authorize in the browser...</Text>
      </Box>
    );
  }

  if (mode === "self-host") {
    if (selfHostStep === "url") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Self-Hosted Setup</Text>
          <Text> </Text>
          <Text>What is your Letta server base URL?</Text>
          <Text dimColor>
            (e.g., https://api.letta.com or http://localhost:8283)
          </Text>
          <Text> </Text>
          <Box>
            <Text>Base URL: </Text>
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onSubmit={handleBaseUrlSubmit}
            />
          </Box>
          <Text> </Text>
          <Text dimColor>Press Enter to continue</Text>
        </Box>
      );
    }

    // selfHostStep === "apikey"
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Self-Hosted Setup</Text>
        <Text> </Text>
        <Text>Do you have an API key? (optional, press Enter to skip)</Text>
        <Text dimColor>Base URL: {baseUrl}</Text>
        <Text> </Text>
        <Box>
          <Text>API Key: </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={handleApiKeySubmit}
          />
        </Box>
        <Text> </Text>
        {isValidating ? (
          <Text dimColor>Validating connection...</Text>
        ) : (
          <Text dimColor>Press Enter to validate and save</Text>
        )}
      </Box>
    );
  }

  // Main menu
  return (
    <Box flexDirection="column" padding={1}>
      <Text>{asciiLogo}</Text>
      <Text bold>Welcome to Letta Code!</Text>
      <Text> </Text>
      <Text>Please choose how you'd like to authenticate:</Text>
      <Text> </Text>
      <Box>
        <Text color={selectedOption === 0 ? "cyan" : undefined}>
          {selectedOption === 0 ? "→" : " "} Login to Letta Cloud
        </Text>
      </Box>
      <Box>
        <Text color={selectedOption === 1 ? "cyan" : undefined}>
          {selectedOption === 1 ? "→" : " "} Setup Self-Hosting
        </Text>
      </Box>
      <Box>
        <Text color={selectedOption === 2 ? "cyan" : undefined}>
          {selectedOption === 2 ? "→" : " "} Exit
        </Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Use ↑/↓ to navigate, Enter to select</Text>
    </Box>
  );
}
