import { useEffect, useState } from "react";
import {
  buildByokProviderAliases,
  listProviders,
} from "@/providers/byok-providers";
import type {
  ProviderAuthByName,
  ProviderAuthType,
} from "./model-selector-helpers";

/**
 * Loads BYOK alias map (Constellation) or local provider auth types (local
 * backend) for ModelSelector labeling — e.g. SuperGrok OAuth vs API key.
 */
export function useModelSelectorProviders(localModelCatalog?: boolean): {
  byokProviderAliases: Record<string, string>;
  providerAuthByName: ProviderAuthByName;
} {
  const [byokProviderAliases, setByokProviderAliases] = useState<
    Record<string, string>
  >(() => buildByokProviderAliases([]));
  const [providerAuthByName, setProviderAuthByName] =
    useState<ProviderAuthByName>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const providers = await listProviders(
          localModelCatalog ? { target: "local" } : undefined,
        );
        if (cancelled) return;
        if (localModelCatalog) {
          setByokProviderAliases(buildByokProviderAliases([]));
          const authMap = new Map<string, ProviderAuthType>();
          for (const provider of providers) {
            if (
              provider.auth_type === "oauth" ||
              provider.auth_type === "api"
            ) {
              authMap.set(provider.name, provider.auth_type);
            }
          }
          setProviderAuthByName(authMap);
          return;
        }
        setByokProviderAliases(buildByokProviderAliases(providers));
        setProviderAuthByName(new Map());
      } catch {
        if (cancelled) return;
        setByokProviderAliases(buildByokProviderAliases([]));
        setProviderAuthByName(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localModelCatalog]);

  return { byokProviderAliases, providerAuthByName };
}
