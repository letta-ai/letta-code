export type SignalMessageTarget =
  | { kind: "recipient"; recipient: string }
  | { kind: "group"; groupId: string }
  | { kind: "username"; username: string };

function assertSignalHttpProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Signal base URL protocol must be http or https, got ${url.protocol}`,
    );
  }
}

function trimPrefix(value: string, prefix: string): string | null {
  if (!value.toLowerCase().startsWith(prefix)) {
    return null;
  }
  return value.slice(prefix.length).trim();
}

export function normalizeSignalBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  assertSignalHttpProtocol(parsed);
  if (parsed.username || parsed.password) {
    throw new Error("Signal base URL must not include credentials.");
  }
  return withScheme.replace(/\/+$/, "");
}

export function parseSignalTarget(input: string): SignalMessageTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Signal target is required.");
  }

  const signalTarget = trimPrefix(trimmed, "signal:");
  const value = signalTarget !== null ? signalTarget : trimmed;
  if (!value) {
    throw new Error("Signal target is required.");
  }

  const groupId = trimPrefix(value, "group:");
  if (groupId) {
    return { kind: "group", groupId };
  }

  const username = trimPrefix(value, "username:");
  if (username) {
    return { kind: "username", username };
  }

  const usernameAlias = trimPrefix(value, "u:");
  if (usernameAlias) {
    return { kind: "username", username: `u:${usernameAlias}` };
  }

  const recipient = value;
  if (!recipient) {
    throw new Error("Signal recipient is required.");
  }
  return { kind: "recipient", recipient };
}

export function signalTargetToSendRpcParams(
  target: SignalMessageTarget,
): Record<string, unknown> {
  switch (target.kind) {
    case "group":
      return { groupId: target.groupId };
    case "username":
      return { username: [target.username] };
    case "recipient":
      return { recipient: [target.recipient] };
  }
}

export function signalTargetToReactionRpcParams(
  target: SignalMessageTarget,
): Record<string, unknown> {
  switch (target.kind) {
    case "group":
      return { groupIds: [target.groupId] };
    case "recipient":
      return { recipients: [target.recipient] };
    case "username":
      throw new Error("Signal reactions require a recipient or group target.");
  }
}

export const signalTargetToRpcParams = signalTargetToSendRpcParams;

export function normalizeSignalSenderId(
  value: string | null | undefined,
): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.toLowerCase();
}

export function normalizeSignalPhone(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.toLowerCase().startsWith("signal:")
    ? trimmed.slice("signal:".length)
    : trimmed;
  return withoutPrefix.replace(/[^0-9+]/g, "");
}

export function signalAllowedUsersIncludes(
  allowedUsers: string[],
  senderId: string,
): boolean {
  const normalizedSender = normalizeSignalSenderId(senderId);
  const senderPhone = normalizeSignalPhone(senderId);
  return allowedUsers.some((entry) => {
    const normalizedEntry = normalizeSignalSenderId(entry);
    if (normalizedEntry === normalizedSender) {
      return true;
    }
    const entryPhone = normalizeSignalPhone(entry);
    return !!senderPhone && !!entryPhone && senderPhone === entryPhone;
  });
}

export function isSignalGroupAllowed(
  allowedGroups: string[] | undefined,
  groupId: string,
): boolean {
  if (!allowedGroups || allowedGroups.length === 0) {
    return true;
  }
  const normalized = groupId.trim();
  return allowedGroups.some((entry) => entry.trim() === normalized);
}

export function matchesSignalMentionPatterns(
  text: string,
  mentionPatterns: string[] | undefined,
): boolean {
  const normalizedText = text.toLowerCase();
  return (mentionPatterns ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => normalizedText.includes(entry));
}
