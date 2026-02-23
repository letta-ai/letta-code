import { Box, useInput } from "ink";
import Link from "ink-link";
import RawTextInput from "ink-text-input";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentAgentId } from "../../agent/context";
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
  | "choose-agent"
  | "enter-agent-name"
  | "enter-agent-id"
  | "enter-api-key-for-agent"
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

const SOLID_LINE = "─";

function buildProgressSteps(
  agentMode: "current" | "existing" | "create",
  agentName: string | null,
  reuseExistingSecret: boolean,
): { key: string; label: string }[] {
  const steps: { key: string; label: string }[] = [];
  steps.push({
    key: "Getting repository information",
    label: "Getting repository information",
  });
  if (agentMode === "create" && agentName) {
    steps.push({
      key: "Creating agent",
      label: `Creating agent ${agentName}`,
    });
  }
  steps.push({ key: "Creating branch", label: "Creating branch" });
  steps.push({
    key: "Creating workflow files",
    label: "Creating workflow files",
  });
  if (!reuseExistingSecret) {
    steps.push({
      key: "Setting up LETTA_API_KEY secret",
      label: "Setting up LETTA_API_KEY secret",
    });
  }
  if (agentMode !== "create") {
    // create mode sets variable inline during agent creation step
    steps.push({ key: "Configuring agent", label: "Configuring agent" });
  }
  steps.push({
    key: "Opening pull request page",
    label: "Opening pull request page",
  });
  return steps;
}

function buildProgress(
  currentStatus: string,
  agentMode: "current" | "existing" | "create",
  agentName: string | null,
  reuseExistingSecret: boolean,
): ProgressItem[] {
  const steps = buildProgressSteps(agentMode, agentName, reuseExistingSecret);
  const normalized = currentStatus.toLowerCase();

  const activeIndex = steps.findIndex((step) =>
    normalized.includes(step.key.toLowerCase()),
  );

  return steps.map((step, index) => ({
    label: step.label,
    done: activeIndex > index,
    active: activeIndex === index,
  }));
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

function ChoiceList({
  choices,
  selectedIndex,
}: {
  choices: { label: string }[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const selected = index === selectedIndex;
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

  // Repo state
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [repoChoiceIndex, setRepoChoiceIndex] = useState<number>(0);
  const [repoInput, setRepoInput] = useState<string>("");
  const [repo, setRepo] = useState<string>("");
  const [repoError, setRepoError] = useState<string>("");

  // Secret state
  const [secretExists, setSecretExists] = useState<boolean>(false);
  const [secretChoiceIndex, setSecretChoiceIndex] = useState<number>(0);
  const [apiKeyInput, setApiKeyInput] = useState<string>("");
  const [reuseExistingSecret, setReuseExistingSecret] =
    useState<boolean>(false);

  // Agent state
  const [currentAgentId, setCurrentAgentIdState] = useState<string | null>(
    null,
  );
  const [agentChoiceIndex, setAgentChoiceIndex] = useState<number>(0);
  const [agentMode, setAgentMode] = useState<"current" | "existing" | "create">(
    "current",
  );
  const [agentNameInput, setAgentNameInput] = useState<string>("");
  const [agentIdInput, setAgentIdInput] = useState<string>("");
  const [agentApiKeyInput, setAgentApiKeyInput] = useState<string>("");

  // Workflow + result state
  const [workflowPath, setWorkflowPath] = useState<string>(
    ".github/workflows/letta.yml",
  );
  const [result, setResult] = useState<InstallGithubAppResult | null>(null);

  // Choices
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
              label: "Use existing LETTA_API_KEY secret (recommended)",
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

  const agentChoices = useMemo(() => {
    const choices: {
      label: string;
      value: "current" | "existing" | "create";
    }[] = [];
    if (currentAgentId) {
      choices.push({
        label: `Use current agent (${currentAgentId.slice(0, 20)}...)`,
        value: "current",
      });
    }
    choices.push({
      label: "Create a new agent",
      value: "create",
    });
    choices.push({
      label: "Use an existing agent",
      value: "existing",
    });
    return choices;
  }, [currentAgentId]);

  // Determine what API key we have available
  const availableApiKey = useMemo(() => {
    if (apiKeyInput.trim()) return apiKeyInput.trim();
    if (agentApiKeyInput.trim()) return agentApiKeyInput.trim();
    return null;
  }, [apiKeyInput, agentApiKeyInput]);

  const runInstall = useCallback(
    async (
      finalAgentMode: "current" | "existing" | "create",
      finalAgentId: string | null,
      finalAgentName: string | null,
      useExistingSecret: boolean,
      key: string | null,
    ) => {
      if (!repo) {
        setErrorMessage("Repository not set.");
        setStep("error");
        return;
      }

      setReuseExistingSecret(useExistingSecret);
      setAgentMode(finalAgentMode);
      setStep("creating");
      setStatus("Preparing setup...");

      try {
        const installResult = await installGithubApp({
          repo,
          workflowPath,
          reuseExistingSecret: useExistingSecret,
          apiKey: useExistingSecret ? null : key,
          agentMode: finalAgentMode,
          agentId: finalAgentId,
          agentName: finalAgentName,
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

  // Preflight check
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

      // Try to get current agent ID
      try {
        const agentId = getCurrentAgentId();
        setCurrentAgentIdState(agentId);
      } catch {
        // No agent context — that's fine
      }

      setStep("choose-repo");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStep("error");
    }
  }, [step]);

  // Determine what step to go to after agent selection
  const proceedFromAgent = useCallback(
    (
      mode: "current" | "existing" | "create",
      agentId: string | null,
      agentName: string | null,
    ) => {
      // If creating an agent and we don't have an API key yet (reused secret), need to ask
      if (mode === "create" && !availableApiKey) {
        setStep("enter-api-key-for-agent");
        return;
      }

      const key = availableApiKey;
      void runInstall(mode, agentId, agentName, reuseExistingSecret, key);
    },
    [availableApiKey, reuseExistingSecret, runInstall],
  );

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
      if (step === "choose-agent") {
        if (secretExists) {
          setStep("choose-secret");
        } else {
          setStep("enter-api-key");
        }
        return;
      }
      if (step === "enter-agent-name" || step === "enter-agent-id") {
        setStep("choose-agent");
        return;
      }
      if (step === "enter-api-key-for-agent") {
        setStep("enter-agent-name");
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
          setReuseExistingSecret(true);
          setAgentChoiceIndex(0);
          setStep("choose-agent");
        } else {
          setStep("enter-api-key");
        }
      }
      return;
    }

    if (step === "choose-agent") {
      if (key.upArrow || input === "k") {
        setAgentChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow || input === "j") {
        setAgentChoiceIndex((prev) =>
          Math.min(agentChoices.length - 1, prev + 1),
        );
      } else if (key.return) {
        const selected = agentChoices[agentChoiceIndex] ?? agentChoices[0];
        if (!selected) return;
        setAgentMode(selected.value);

        if (selected.value === "current" && currentAgentId) {
          proceedFromAgent("current", currentAgentId, null);
        } else if (selected.value === "create") {
          setStep("enter-agent-name");
        } else {
          setStep("enter-agent-id");
        }
      }
    }
  });

  // Handlers for text input steps
  const handleApiKeySubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setApiKeyInput(trimmed);
    setReuseExistingSecret(false);
    setAgentChoiceIndex(0);
    setStep("choose-agent");
  }, []);

  const handleAgentNameSubmit = useCallback(
    (value: string) => {
      const name = value.trim() || "GitHub Action Agent";
      setAgentNameInput(name);
      proceedFromAgent("create", null, name);
    },
    [proceedFromAgent],
  );

  const handleAgentIdSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setAgentIdInput(trimmed);
      proceedFromAgent("existing", trimmed, null);
    },
    [proceedFromAgent],
  );

  const handleAgentApiKeySubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setAgentApiKeyInput(trimmed);
      // Now we have a key — proceed with install
      void runInstall(
        "create",
        null,
        agentNameInput,
        reuseExistingSecret,
        trimmed,
      );
    },
    [agentNameInput, reuseExistingSecret, runInstall],
  );

  // === RENDER ===

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
        <ChoiceList choices={repoChoices} selectedIndex={repoChoiceIndex} />
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
        <ChoiceList choices={secretChoices} selectedIndex={secretChoiceIndex} />
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
            onSubmit={handleApiKeySubmit}
            placeholder="sk-..."
            mask="*"
          />
        </Box>
        <Box height={1} />
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "choose-agent") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Configure agent",
      <>
        <Box>
          <Text dimColor>Repository: </Text>
          <Text>{repo}</Text>
        </Box>
        <Box height={1} />
        <ChoiceList choices={agentChoices} selectedIndex={agentChoiceIndex} />
        <Box height={1} />
        <Text dimColor>↑/↓ to select · Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "enter-agent-name") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Create a new agent",
      <>
        <Box>
          <Text dimColor>Agent name:</Text>
        </Box>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={agentNameInput}
            onChange={setAgentNameInput}
            onSubmit={handleAgentNameSubmit}
            placeholder="GitHub Action Agent"
          />
        </Box>
        <Box height={1} />
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "enter-agent-id") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Use an existing agent",
      <>
        <Box>
          <Text dimColor>Agent ID:</Text>
        </Box>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <PasteAwareTextInput
            value={agentIdInput}
            onChange={setAgentIdInput}
            onSubmit={handleAgentIdSubmit}
            placeholder="agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </Box>
        <Box height={1} />
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </>,
    );
  }

  if (step === "enter-api-key-for-agent") {
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Enter LETTA_API_KEY for agent setup",
      <>
        <Box>
          <Text dimColor>An API key is needed to create the agent.</Text>
        </Box>
        <Box>
          <Text color={colors.selector.itemHighlighted}>{">"}</Text>
          <Text> </Text>
          <TextInput
            value={agentApiKeyInput}
            onChange={setAgentApiKeyInput}
            onSubmit={handleAgentApiKeySubmit}
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
    const progressItems = buildProgress(
      status,
      agentMode,
      agentNameInput || null,
      reuseExistingSecret,
    );
    return renderPanel(
      solidLine,
      "Install GitHub App",
      "Create GitHub Actions workflow",
      <Box flexDirection="column">
        {progressItems.map((item) => (
          <Box key={item.label}>
            {item.done ? (
              <Text color="green">
                {"✓"} {item.label}
              </Text>
            ) : item.active ? (
              <Text color="yellow">
                {"•"} {item.label}…
              </Text>
            ) : (
              <Text dimColor>
                {"•"} {item.label}
              </Text>
            )}
          </Box>
        ))}
      </Box>,
    );
  }

  if (step === "success") {
    const successLines: string[] = [
      "✓ GitHub Actions workflow created!",
      "",
      reuseExistingSecret
        ? "✓ Using existing LETTA_API_KEY secret"
        : "✓ API key saved as LETTA_API_KEY secret",
    ];

    if (result?.agentId) {
      successLines.push("");
      successLines.push(`✓ Agent configured: ${result.agentId}`);
    }

    successLines.push("");
    successLines.push("Next steps:");
    successLines.push("1. A pre-filled PR page has been created");
    successLines.push("2. Merge the PR to enable Letta Code PR assistance");
    successLines.push("3. Mention @letta-code in an issue or PR to test");

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
        {result?.agentUrl ? (
          <>
            <Box height={1} />
            <Box>
              <Text dimColor>Agent: </Text>
              <Link url={result.agentUrl}>
                <Text color={colors.link.url}>{result.agentUrl}</Text>
              </Link>
            </Box>
          </>
        ) : null}
        {result?.pullRequestUrl ? (
          <Box>
            <Text dimColor>PR: </Text>
            <Link url={result.pullRequestUrl}>
              <Text color={colors.link.url}>{result.pullRequestUrl}</Text>
            </Link>
          </Box>
        ) : null}
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
