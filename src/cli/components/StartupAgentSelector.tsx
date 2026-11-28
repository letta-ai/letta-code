import { Box, Text } from "ink";
import { useState } from "react";
import {
  getReasoningTierOptionsForHandle,
  type ModelReasoningSelection,
} from "@/agent/model";
import { AgentSelector } from "./AgentSelector";
import { ModelReasoningSelector } from "./ModelReasoningSelector";
import { SingleSelectPicker } from "./SingleSelectPicker";

export function StartupAgentSelector({
  failedAgentMessage,
  serverModelsForNewAgent,
  defaultModelHandle,
  onSelect,
  onCreateNew,
  onCreateNewWithModel,
  onExit,
}: {
  failedAgentMessage?: string;
  serverModelsForNewAgent?: string[];
  defaultModelHandle?: string;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  onCreateNewWithModel: (
    model: string,
    effort?: ModelReasoningSelection,
  ) => void;
  onExit: () => void;
}) {
  const [choosing, setChoosing] = useState(
    Boolean(serverModelsForNewAgent?.length),
  );
  const [model, setModel] = useState<string>();
  if (model) {
    const options = getReasoningTierOptionsForHandle(model);
    return (
      <ModelReasoningSelector
        modelLabel={model}
        initialModelId={model}
        options={options}
        onSelect={(option) => onCreateNewWithModel(model, option.effort)}
        onCancel={() => setModel(undefined)}
      />
    );
  }
  if (choosing && serverModelsForNewAgent?.length) {
    return (
      <Box flexDirection="column">
        <Text bold>Model for new agent</Text>
        <SingleSelectPicker
          items={serverModelsForNewAgent.map((handle) => ({
            key: handle,
            label: handle,
          }))}
          initialCursorIndex={Math.max(
            0,
            serverModelsForNewAgent.indexOf(defaultModelHandle ?? ""),
          )}
          onSelect={(handle) => {
            if (getReasoningTierOptionsForHandle(handle).length > 1)
              setModel(handle);
            else onCreateNewWithModel(handle);
          }}
          onCancel={() => setChoosing(false)}
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {failedAgentMessage && <Text color="red">{failedAgentMessage}</Text>}
      <AgentSelector
        currentAgentId=""
        onSelect={onSelect}
        onCreateNewAgent={() => {
          if (serverModelsForNewAgent?.length) setChoosing(true);
          else onCreateNew();
        }}
        onCancel={onExit}
        allowDelete={false}
        allowPinActions={false}
      />
    </Box>
  );
}
