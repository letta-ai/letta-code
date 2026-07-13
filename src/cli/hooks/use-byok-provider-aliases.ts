import { useEffect, useState } from "react";
import {
  buildByokProviderAliases,
  listProviders,
} from "@/providers/byok-providers";

export function useByokProviderAliases(localModelCatalog?: boolean) {
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    buildByokProviderAliases([]),
  );

  useEffect(() => {
    let cancelled = false;
    void listProviders(localModelCatalog ? { target: "local" } : undefined)
      .then((providers) => {
        if (!cancelled) setAliases(buildByokProviderAliases(providers));
      })
      .catch(() => {
        if (!cancelled) setAliases(buildByokProviderAliases([]));
      });
    return () => {
      cancelled = true;
    };
  }, [localModelCatalog]);

  return aliases;
}
