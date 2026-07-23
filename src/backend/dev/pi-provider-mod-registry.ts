import {
  registerOAuthProvider,
  unregisterOAuthProvider,
} from "@earendil-works/pi-ai/oauth";
import type {
  PiProviderOAuthLoginCallbacks,
  PiProviderRegistration,
  RegisteredPiProvider,
} from "./pi-provider-mod-types";
import {
  clonePiProviderRegistration,
  resolvePiProviderRegistrationHeaders,
  validatePiProviderRegistration,
} from "./pi-provider-mod-validation";

export type {
  PiProviderConnectConfig,
  PiProviderConnectField,
  PiProviderConnection,
  PiProviderInputType,
  PiProviderModelRegistration,
  PiProviderOAuthConfig,
  PiProviderOAuthDeviceCodeInfo,
  PiProviderOAuthLoginCallbacks,
  PiProviderRegistration,
  RegisteredPiProvider,
} from "./pi-provider-mod-types";

type PiProviderRegistryListener = () => void;

const registeredProviders = new Map<string, RegisteredPiProvider>();
const registryListeners = new Set<PiProviderRegistryListener>();
const providerRevisions = new Map<string, number>();
let revisionCounter = 0;

function bumpProviderRevision(providerName: string): void {
  revisionCounter += 1;
  providerRevisions.set(providerName, revisionCounter);
}

/**
 * Monotonic per-provider registration revision. Bumps on every register or
 * unregister of that provider name, letting per-backend Models runtimes
 * detect that a registration changed and rebuild only that provider.
 */
export function getRegisteredPiProviderRevision(providerName: string): number {
  return providerRevisions.get(providerName) ?? 0;
}

function notifyRegistryListeners(): void {
  for (const listener of [...registryListeners]) {
    try {
      listener();
    } catch {
      // Registry listeners are observers; a UI refresh failure should not make
      // mod provider registration fail.
    }
  }
}

export function subscribePiProviderRegistry(
  listener: PiProviderRegistryListener,
): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function registerPiOAuthProvider(
  providerName: string,
  config: PiProviderRegistration,
): void {
  unregisterOAuthProvider(providerName);
  if (!config.oauth) return;
  registerOAuthProvider({
    id: providerName,
    name: config.oauth.name ?? config.name ?? providerName,
    login: (callbacks) =>
      config.oauth?.login(callbacks as PiProviderOAuthLoginCallbacks) ??
      Promise.reject(
        new Error(`Provider "${providerName}" OAuth is not registered`),
      ),
    refreshToken: (credentials) => {
      if (!config.oauth) {
        throw new Error(`Provider "${providerName}" OAuth is not registered`);
      }
      return config.oauth.refreshToken(credentials);
    },
    getApiKey: (credentials) => {
      if (!config.oauth) {
        throw new Error(`Provider "${providerName}" OAuth is not registered`);
      }
      return config.oauth.getApiKey(credentials);
    },
    ...(config.oauth.modifyModels
      ? {
          modifyModels: (models, credentials) =>
            config.oauth?.modifyModels?.(models, credentials) ?? models,
        }
      : {}),
  });
}

function unregisterPiOAuthProvider(providerName: string): void {
  unregisterOAuthProvider(providerName);
}

export function registerPiProvider(
  providerName: string,
  config: PiProviderRegistration,
  owner?: { id?: string; path?: string },
): RegisteredPiProvider {
  validatePiProviderRegistration(providerName, config);
  const registered: RegisteredPiProvider = {
    providerName,
    config: clonePiProviderRegistration(config),
    ...(owner?.id ? { ownerId: owner.id } : {}),
    ...(owner?.path ? { path: owner.path } : {}),
  };
  registeredProviders.set(providerName, registered);
  bumpProviderRevision(providerName);
  registerPiOAuthProvider(providerName, registered.config);
  notifyRegistryListeners();
  return getRegisteredPiProvider(providerName) as RegisteredPiProvider;
}

export function unregisterPiProvider(
  providerName: string,
  ownerId?: string,
): void {
  const existing = registeredProviders.get(providerName);
  if (!existing) return;
  if (ownerId && existing.ownerId && existing.ownerId !== ownerId) return;
  registeredProviders.delete(providerName);
  bumpProviderRevision(providerName);
  unregisterPiOAuthProvider(providerName);
  notifyRegistryListeners();
}

export function unregisterPiProvidersForOwner(ownerId: string): void {
  let changed = false;
  for (const [providerName, provider] of registeredProviders.entries()) {
    if (provider.ownerId === ownerId) {
      registeredProviders.delete(providerName);
      bumpProviderRevision(providerName);
      unregisterPiOAuthProvider(providerName);
      changed = true;
    }
  }
  if (changed) notifyRegistryListeners();
}

export function clearRegisteredPiProviders(): void {
  if (registeredProviders.size === 0) return;
  for (const providerName of registeredProviders.keys()) {
    bumpProviderRevision(providerName);
    unregisterPiOAuthProvider(providerName);
  }
  registeredProviders.clear();
  notifyRegistryListeners();
}

export function getRegisteredPiProvider(
  providerName: string,
): RegisteredPiProvider | undefined {
  const provider = registeredProviders.get(providerName);
  if (!provider) return undefined;
  return {
    ...provider,
    config: clonePiProviderRegistration(provider.config),
  };
}

export function listRegisteredPiProviders(): RegisteredPiProvider[] {
  return [...registeredProviders.values()].map((provider) => ({
    ...provider,
    config: clonePiProviderRegistration(provider.config),
  }));
}

export function resolveRegisteredPiProviderFromModelHandle(
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  return [...registeredProviders.keys()].find((providerName) =>
    model.startsWith(`${providerName}/`),
  );
}

export function stripRegisteredProviderHandlePrefix(
  model: string | undefined,
  providerName: string,
): string | undefined {
  if (!model) return undefined;
  const prefix = `${providerName}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function resolveRegisteredPiProviderApiKey(
  apiKey: string | undefined,
): string | undefined {
  if (!apiKey) return undefined;
  return process.env[apiKey] ?? apiKey;
}

export function resolveRegisteredPiProviderHeaders(
  headers: PiProviderRegistration["headers"],
): Record<string, string> | undefined {
  return resolvePiProviderRegistrationHeaders(headers);
}
