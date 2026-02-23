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
  | "checking"
  | "choose-repo"
  | "enter-repo"
  | "choose-secret"
  | "enter-api-key"
  | "creating"
  | "success"
  | "error";

interface InstallGithubAppFlowProps {
  onComplete: (result: InstallGithubAppResult) => void;
  onCancel: () => void;
}

interface ProgressItem {
  label: string;
  done: boolean;
  active: boolean;
}

const PROGRESS_STEPS = [
  {
    key: "Setting LETTA_API_KEY secret",
    label: "Setting up LETTA_API_KEY secret",
  },
  {
    key: "Cloning repository",
    label: "Getting repository information",
  },
  {
    key: "Creating installation branch",
    label: "Creating branch",
  },
  {
    key: "Writing workflow file",
    label: "Creating workflow files",
  },
  {
    key: "Opening pull request",
    label: "Opening pull request page",
  },
] as const;

const SOLID_LINE = "─";

function buildProgress(
  currentStatus: string,
  reuseExistingSecret: boolean,
): ProgressItem[] {
  const normalized = currentStatus.toLowerCase();

  const visibleSteps = PROGRESS_STEPS.filter((step) => {
    if (step.key === "Setting LETTA_API_KEY secret" && reuseExistingSecret) {
      return false;
    }
    return true;
  });

  const activeIndex = visibleSteps.findIndex((step) =>
    normalized.includes(step.key.toLowerCase()),
  );

  return visibleSteps.map((step, index) => {
    const done = activeIndex > index;
    const active = activeIndex === index;
    return {
      label: step.label,
      done,
      active,
    };
  });
}

function renderPanel(
  solidLine: string,
  title: string,
  subtitle: string,
  body: React.ReactNode,
) {
  return (
    <Box flexDirection="column" width="100%">
      <Text dimColor>{"> /install-github-app"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      <Box
        borderStyle="round"
        borderColor={colors.approval.border}
        width="100%"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color={colors.approval.header}>
          {title}
        </Text>
        <Text dimColor>{subtitle}</Text>
        <Box height={1} />
        {body}
      </Box>
    </Box>
  );
}

export const InstallGithubAppFlow = memo(function InstallGithubAppFlow({
  onComplete,
  onCancel,
}: InstallGithubAppFlowProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const [step, setStep] = useState<Step>("checking");
  const [status, setStatus] = useState<string>(
    "Checking GitHub CLI prerequisites...",
  );
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [repoChoiceIndex, setRepoChoiceIndex] = useState<number>(0);
  const [repoInput, setRepoInput] = useState<string>("");
  const [repo, setRepo] = useState<string>("");
  const [repoError, setRepoError] = useState<string>("");

  const [secretExists, setSecretExists] = useState<boolean>(false);
  const [secretChoiceIndex, setSecretChoiceIndex] = useState<number>(0);
  const [apiKeyInput, setApiKeyInput] = useState<string>("");
  const [reuseExistingSecret, setReuseExistingSecret] =
    useState<boolean>(false);

  const [workflowPath, setWorkflowPath] = useState<string>(
    ".github/workflows/letta.yml",
  );
  const [result, setResult] = useState<InstallGithubAppResult | null>(null);

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
    return [{ label: "Enter a repository", value: "manual" as const }];
  }, [currentRepo]);

  const secretChoices = useMemo(
    () =>
      secretExists
        ? [
            {
              label: "Using existing LETTA_API_KEY secret (recommended)",
              value: "reuse" as const,
            },
            {
              label: "Set or overwrite LETTA_API_KEY secret",
              value: "set" as const,
            },
          ]
        : [{ label: "Set LETTA_API_KEY secret", value: "set" as const }],
    [secretExists],
  );

  const runInstall = useCallback(
    async (useExistingSecret: boolean, maybeApiKey?: string) => {
      if (!repo) {
        setErrorMessage("Repository not set.");
        setStep("error");
        return;
      }

      setReuseExistingSecret(useExistingSecret);
      setStep("creating");
      setStatus("Preparing setup...");

      try {
        const installResult = await installGithubApp({
          repo,
          workflowPath,
          reuseExistingSecret: useExistingSecret,
          apiKey: useExistingSecret ? null : (maybeApiKey ?? null),
          onProgress: (message) => setStatus(message),
        });

        setResult(installResult);
        setStep("success");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStep("error");
      }
    },
    [repo, workflowPath],
  );

  const resolveRepo = useCallback(async (repoSlug: string) => {
    const trimmed = repoSlug.trim();
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
      setStep("choose-secret");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStep("error");
    }
  }, []);

  useEffect(() => {
    if (step !== "checking") return;

    try {
      const preflight = runGhPreflight(process.cwd());
      if (!preflight.ok) {
        const lines = [preflight.details];
        if (preflight.remediation) {
          lines.push("");
          lines.push("How to fix:");
          lines.push(`  ${preflight.remediation}`);
        }
        setErrorMessage(lines.join("\n"));
        setStep("error");
        return;
      }

      if (preflight.currentRepo) {
        setCurrentRepo(preflight.currentRepo);
        setRepoInput(preflight.currentRepo);
      }

      setStep("choose-repo");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStep("error");
    }
  }, [step]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (step === "success") {
      if (key.return || key.escape || input.length > 0) {
        if (result) {
          onComplete(result);
        } else {
          onCancel();
        }
      }
      return;
    }

    if (key.escape) {
      if (step === "choose-repo") {
        onCancel();
        return;
      }
      if (step === "enter-repo") {
        setStep("choose-repo");
        return;
      }
      if (step === "choose-secret") {
        if (currentRepo) {
          setStep("choose-repo");
        } else {
          setStep("enter-repo");
        }
        return;
      }
      if (step === "enter-api-key") {
        setStep("choose-secret");
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
          void resolveRepo(currentRepo);
        } else {
          setStep("enter-repo");
        }
      }
      return;
    }

    if (step === "choose-secret") {
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
          void runInstall(true);
        } else {
          setStep("enter-api-key");
        }
      }
    }
  });

  if (step === "checking") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Checking prerequisites",
      <Box flexDirection="column" paddingLeft={1}>
        <Text color="yellow">{status}</Text>
      </Box>,
    );
  }

  if (step === "choose-repo") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Select GitHub repository",
      <>
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
        <Text dimColor>↑/↓ to select · Enter to continue · Esc to cancel</Text>
      </>,
    );
  }

  if (step === "enter-repo") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Enter a different repository",
      <>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={repoInput}
            onChange={(next) => {
              setRepoInput(next);
              setRepoError("");
            }}
            onSubmit={(value) => {
              void resolveRepo(value);
            }}
            placeholder="owner/repo"
          />
        </Box>
        {repoError ? (
          <Box marginTop={1}>
            <Text color="red">{repoError}</Text>
          </Box>
        ) : null}
        <Box height={1} />
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "choose-secret") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Configure LETTA_API_KEY",
      <>
        <Box>
          <Text dimColor>Repository: </Text>
          <Text>{repo}</Text>
        </Box>
        <Box>
          <Text dimColor>Workflow: </Text>
          <Text>{workflowPath}</Text>
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
        <Text dimColor>↑/↓ to select · Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "enter-api-key") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Enter LETTA_API_KEY",
      <>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                setErrorMessage("LETTA_API_KEY cannot be empty.");
                setStep("error");
                return;
              }
              void runInstall(false, trimmed);
            }}
            placeholder="sk-..."
            mask="*"
          />
        </Box>
        <Box height={1} />
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "creating") {
    const progress = buildProgress(status, reuseExistingSecret);
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Create GitHub Actions workflow",
      <Box flexDirection="column">
        {progress.map((item) => (
          <Box key={item.label}>
            {item.done ? (
              <Text color="green">✓ {item.label}</Text>
            ) : item.active ? (
              <Text color="yellow">• {item.label}…</Text>
            ) : (
              <Text dimColor> {item.label}</Text>
            )}
          </Box>
        ))}
      </Box>,
    );
  }

  if (step === "success") {
    const successLines = [
      "✓ GitHub Actions workflow created!",
      "",
      reuseExistingSecret
        ? "✓ Using existing LETTA_API_KEY secret"
        : "✓ API key saved as LETTA_API_KEY secret",
      "",
      "Next steps:",
      "1. A pre-filled PR page has been created",
      "2. Merge the PR to enable Letta Code PR assistance",
      "3. Mention @letta-code in an issue or PR to test",
    ];

    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Success",
      <>
        {successLines.map((line, idx) => (
          <Box key={`${idx}-${line}`}>
            {line.startsWith("✓") ? (
              <Text color="green">{line}</Text>
            ) : (
              <Text dimColor={line === ""}>{line || " "}</Text>
            )}
          </Box>
        ))}
        <Box height={1} />
        <Text dimColor>Press any key to exit</Text>
      </>,
    );
  }

  return renderPanel(
    solidLine,
    "Install GitHub App",
    "Error",
    <>
      <Text color="red">
        Error: {errorMessage.split("\n")[0] || "Unknown error"}
      </Text>
      <Box height={1} />
      {errorMessage
        .split("\n")
        .slice(1)
        .filter((line) => line.trim().length > 0)
        .map((line, idx) => (
          <Text key={`${idx}-${line}`} dimColor>
            {line}
          </Text>
        ))}
      <Box height={1} />
      <Text dimColor>Esc to close</Text>
    </>,
  );
});

InstallGithubAppFlow.displayName = "InstallGithubAppFlow";
