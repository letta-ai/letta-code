export class ChannelCredentialHydrationError extends Error {
  constructor(
    channelId: string,
    accountId: string,
    fieldPath: string,
    cause?: unknown,
  ) {
    const detail =
      cause instanceof Error && cause.message.trim().length > 0
        ? ` ${cause.message}`
        : "";
    super(
      `Could not load ${channelId}/${accountId}/${fieldPath} from the channel credential store.${detail} Re-add this channel credential or set LETTA_CHANNEL_CREDENTIALS_STORE=file and update the account before restarting the channel listener. The saved secret reference was preserved.`,
      { cause },
    );
    this.name = "ChannelCredentialHydrationError";
  }
}

export class ChannelCredentialPersistenceError extends Error {
  constructor(channelId: string, accountId: string, fieldPath: string) {
    super(
      `Cannot save ${channelId}/${accountId}/${fieldPath} while the account still references a secure-store secret that is not loaded. Re-add this channel credential or switch back to LETTA_CHANNEL_CREDENTIALS_STORE=keyring before updating the account. The saved secret reference was preserved.`,
    );
    this.name = "ChannelCredentialPersistenceError";
  }
}

export class ChannelAccountMutationConflictError extends Error {
  constructor(channelId: string, accountId: string) {
    super(
      `Channel account "${accountId}" for ${channelId} changed while this operation was saving credentials. Retry the operation.`,
    );
    this.name = "ChannelAccountMutationConflictError";
  }
}
