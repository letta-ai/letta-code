import type { XChatApiClientLike, XChatSdkAdapterLike } from "./runtime";

const pinnedClientVersions = new WeakMap<object, string>();

function publicKeyVersion(row: Record<string, unknown>): string {
  const value =
    row.publicKeyVersion ?? row.public_key_version ?? row.version ?? "";
  return String(value).trim();
}

function patchPublicKeyClient(
  client: XChatApiClientLike,
  signingKeyVersion: string,
): void {
  const existingVersion = pinnedClientVersions.get(client);
  if (existingVersion === signingKeyVersion) return;
  if (existingVersion) {
    throw new Error(
      `X Chat API client is already pinned to public key version ${existingVersion}.`,
    );
  }
  pinnedClientVersions.set(client, signingKeyVersion);

  const getPublicKey = client.users.getPublicKey.bind(client.users);
  client.users.getPublicKey = async (userId, options) => {
    const response = await getPublicKey(userId, options);
    if (!options?.publicKeyFields?.includes("juicebox_config")) {
      return response;
    }
    const rows = response.data ?? [];
    const selected = rows.find(
      (row) => publicKeyVersion(row) === signingKeyVersion,
    );
    if (!selected) {
      const available = rows.map(publicKeyVersion).filter(Boolean).join(", ");
      throw new Error(
        `X Chat public key version ${signingKeyVersion} was not found` +
          (available ? `. Available versions: ${available}.` : "."),
      );
    }
    return { ...response, data: [selected] };
  };
}

/**
 * Work around @chat-adapter/x 4.38.1 selecting the newest Juicebox config even
 * when signingKeyVersion is configured. The upstream adapter creates its XDK
 * client during initialize(), so intercept that assignment and filter its own
 * Juicebox-config responses to the configured version. Participant signing-key
 * lookups remain unfiltered. This covers the initial config fetch and later
 * realm-token refreshes.
 */
export function patchXChatPublicKeyVersionSelection(
  sdkAdapter: XChatSdkAdapterLike,
  signingKeyVersion: string,
): () => void {
  const version = signingKeyVersion.trim();
  if (!version) return () => {};

  const target = sdkAdapter as XChatSdkAdapterLike & {
    xdkClient?: XChatApiClientLike | null;
  };
  let client = target.xdkClient ?? null;
  if (client) patchPublicKeyClient(client, version);

  Object.defineProperty(target, "xdkClient", {
    configurable: true,
    enumerable: true,
    get: () => client,
    set: (next: XChatApiClientLike | null) => {
      client = next;
      if (next) patchPublicKeyClient(next, version);
    },
  });

  return () => {
    if (!client || pinnedClientVersions.get(client) !== version) {
      throw new Error(
        "The installed X Chat adapter did not expose the API client needed to pin " +
          `Juicebox configuration to public key version ${version}. ` +
          "Refusing to continue with an unverified key/config pairing.",
      );
    }
  };
}
