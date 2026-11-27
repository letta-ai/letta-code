import { settingsManager } from "@/settings-manager";

export interface ConversationTitleSettingsSnapshot {
  enabled: boolean;
}

export function getConversationTitleSettings(): ConversationTitleSettingsSnapshot {
  try {
    return {
      enabled: settingsManager.getSettings().autoConversationTitles === true,
    };
  } catch {
    return { enabled: false };
  }
}

export function setConversationTitleSettings(
  enabled: boolean,
): ConversationTitleSettingsSnapshot {
  settingsManager.updateSettings({ autoConversationTitles: enabled });
  return getConversationTitleSettings();
}
