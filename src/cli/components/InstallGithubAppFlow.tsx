import { Box, useInput } from "ink";
import RawTextInput from "ink-text-input";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  getDefaultWorkflowPath,
  getRepoSetupState,
  type InstallGithubAppResult,
  installGithubApp,
  runGhPreflight,
  validateRepoSlug,
} from "../commands/install-github-app";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { Text } from "./Text";

type TextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
};

const TextInput =
  RawTextInput as unknown as React.ComponentType<TextInputProps>;

type Step =
  | "check-gh"
  | "choose-repo"
  | "enter-repo"
  | "secret-decision"
  | "api-key"
  | "creating"
  | "done"
  | "error";

interface InstallGithubAppFlowProps {
  onComplete: (result: InstallGithubAppResult) => void;
  onCancel: () => void;
}

const SOLID_LINE = "─";

export const InstallGithubAppFlow = memo(function InstallGithubAppFlow({
  onComplete,
  onCancel,
}: InstallGithubAppFlowProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const [step, setStep] = useState<Step>("check-gh");
  const [status, setStatus] = useState<string>(
    "Checking GitHub CLI prerequisites...",
  );
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [repoInput, setRepoInput] = useState<string>("");
  const [repo, setRepo] = useState<string>("");
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [repoChoiceIndex, setRepoChoiceIndex] = useState<number>(0);
  const [repoError, setRepoError] = useState<string>("");

  const [workflowPath, setWorkflowPath] = useState<string>(
    ".github/workflows/letta.yml",
  );

  const [secretExists, setSecretExists] = useState<boolean>(false);
  const [secretChoiceIndex, setSecretChoiceIndex] = useState<number>(0);
  const [apiKeyInput, setApiKeyInput] = useState<string>("");

  const repoChoices = useMemo(() => {
    if (currentRepo) {
      return [
        {
          label: `Use current repository: ${currentRepo}`,
          value: "current" as const,
        },
        {
          label: "Enter a different repository",
          value: "manual" as const,
        },
      ];
    }

    return [
      {
        label: "Enter a repository",
        value: "manual" as const,
      },
    ];
  }, [currentRepo]);

  const secretChoices = useMemo(
    () =>
      secretExists
        ? [
            {
              label: "Reuse existing LETTA_API_KEY (recommended)",
              value: "reuse" as const,
            },
            { label: "Overwrite LETTA_API_KEY", value: "overwrite" as const },
          ]
        : [{ label: "Set LETTA_API_KEY", value: "set" as const }],
    [secretExists],
  );

  const beginInstall = useCallback(
    async (reuseExistingSecret: boolean) => {
      if (!repo) {
        setErrorMessage("Repository not set.");
        setStep("error");
        return;
      }

      if (!reuseExistingSecret && !apiKeyInput.trim()) {
        setErrorMessage("LETTA_API_KEY is required.");
        setStep("error");
        return;
      }

      setStep("creating");
      setStatus("Preparing setup...");

      try {
        const result = await installGithubApp({
          repo,
          workflowPath,
          reuseExistingSecret,
          apiKey: reuseExistingSecret ? null : apiKeyInput.trim(),
          onProgress: (message) => setStatus(message),
        });
        setStatus("Setup complete.");
        setStep("done");
        onComplete(result);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStep("error");
      }
    },
    [apiKeyInput, onComplete, repo, workflowPath],
  );

  const runPreflightAndAdvance = useCallback(() => {
    try {
      const preflight = runGhPreflight(process.cwd());
      if (!preflight.ok) {
        const lines = [preflight.details];
        if (preflight.remediation) {
          lines.push(`How to fix: ${preflight.remediation}`);
        }
        setErrorMessage(lines.join("\n"));
        setStep("error");
        return;
      }

      if (preflight.currentRepo) {
        setCurrentRepo(preflight.currentRepo);
        setRepoInput(preflight.currentRepo);
        setRepoChoiceIndex(0);
      } else {
        setCurrentRepo(null);
        setRepoChoiceIndex(0);
      }

      setStep("choose-repo");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStep("error");
    }
  }, []);

  // One-time kickoff
  useEffect(() => {
    if (step === "check-gh") {
      runPreflightAndAdvance();
    }
  }, [runPreflightAndAdvance, step]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      if (step === "enter-repo") {
        setStep("choose-repo");
        return;
      }
      if (step === "secret-decision") {
        if (currentRepo) {
          setStep("choose-repo");
        } else {
          setStep("enter-repo");
        }
        return;
      }
      if (step === "api-key") {
        setStep("secret-decision");
        return;
      }
      if (step === "error") {
        onCancel();
        return;
      }
      onCancel();
      return;
    }

    if (step === "choose-repo") {
      if (key.upArrow || input === "k") {
        setRepoChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow || input === "j") {
        setRepoChoiceIndex((prev) =>
          Math.min(repoChoices.length - 1, prev + 1),
        );
      } else if (key.return) {
        const selected = repoChoices[repoChoiceIndex] ?? repoChoices[0];
        if (!selected) return;

        if (selected.value === "current" && currentRepo) {
          void handleRepoSubmit(currentRepo);
        } else {
          setRepoError("");
          setStep("enter-repo");
        }
      }
      return;
    }

    if (step === "secret-decision") {
      if (key.upArrow || input === "k") {
        setSecretChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow || input === "j") {
        setSecretChoiceIndex((prev) =>
          Math.min(secretChoices.length - 1, prev + 1),
        );
      } else if (key.return) {
        const selected = secretChoices[secretChoiceIndex] ?? secretChoices[0];
        if (!selected) return;

        if (selected.value === "reuse") {
          void beginInstall(true);
        } else {
          setStep("api-key");
        }
      }
    }
  });

  const handleRepoSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!validateRepoSlug(trimmed)) {
      setRepoError("Repository must be in owner/repo format.");
      return;
    }

    setRepoError("");
    setStatus("Inspecting repository setup...");

    try {
      const setup = getRepoSetupState(trimmed);
      setRepo(trimmed);
      setSecretExists(setup.secretExists);
      setWorkflowPath(getDefaultWorkflowPath(setup.workflowExists));
      setSecretChoiceIndex(0);
      setStep("secret-decision");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStep("error");
    }
  };

  const handleApiKeySubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setErrorMessage("LETTA_API_KEY cannot be empty.");
      setStep("error");
      return;
    }
    setApiKeyInput(trimmed);
    await beginInstall(false);
  };

  if (step === "check-gh") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text color="yellow">{status}</Text>
        </Box>
      </Box>
    );
  }

  if (step === "choose-repo") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text>Select GitHub repository</Text>
        </Box>
        <Box height={1} />
        <Box flexDirection="column">
          {repoChoices.map((choice, index) => {
            const selected = index === repoChoiceIndex;
            return (
              <Box key={choice.label}>
                <Text
                  color={selected ? colors.selector.itemHighlighted : undefined}
                >
                  {selected ? "> " : "  "}
                  {choice.label}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text dimColor>↑↓ navigate · Enter continue · Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === "enter-repo") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text>Enter repository (owner/repo):</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={repoInput}
            onChange={(next) => {
              setRepoInput(next);
              setRepoError("");
            }}
            onSubmit={handleRepoSubmit}
            placeholder="owner/repo"
          />
        </Box>
        {repoError ? (
          <Box paddingLeft={2} marginTop={1}>
            <Text color="red">{repoError}</Text>
          </Box>
        ) : null}
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text dimColor>Enter continue · Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (step === "secret-decision") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text>Repository: {repo}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text>Workflow: {workflowPath}</Text>
        </Box>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text>LETTA_API_KEY setup:</Text>
        </Box>
        <Box height={1} />
        <Box flexDirection="column">
          {secretChoices.map((choice, index) => {
            const selected = index === secretChoiceIndex;
            return (
              <Box key={choice.label}>
                <Text
                  color={selected ? colors.selector.itemHighlighted : undefined}
                >
                  {selected ? "> " : "  "}
                  {choice.label}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text dimColor>↑↓ navigate · Enter select · Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (step === "api-key") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text>Enter LETTA_API_KEY (input is masked):</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSubmit={handleApiKeySubmit}
            placeholder="sk-..."
            mask="*"
          />
        </Box>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text dimColor>Enter continue · Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (step === "creating") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text color="yellow">{status}</Text>
        </Box>
      </Box>
    );
  }

  if (step === "error") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> /install-github-app"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text bold color={colors.selector.title}>
          Install GitHub App
        </Text>
        <Box height={1} />
        <Box paddingLeft={2} flexDirection="column">
          <Text color="red">Setup failed:</Text>
          <Text color="red">{errorMessage}</Text>
        </Box>
        <Box height={1} />
        <Box paddingLeft={2}>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    );
  }

  return null;
});

InstallGithubAppFlow.displayName = "InstallGithubAppFlow";
