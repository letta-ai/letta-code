import { useEffect, useState } from "react";
import {
  buildByokProviderAliases,
  listProviders,
  type ProviderStorageTarget,
} from "@/providers/byok-providers";

export function useByokProviderAliases(target: ProviderStorageTarget) {
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    buildByokProviderAliases([], target),
  );

  useEffect(() => {
    let cancelled = false;
    void listProviders({ target })
      .then((providers) => {
        if (!cancelled) {
          setAliases(buildByokProviderAliases(providers, target));
        }
      })
      .catch(() => {
        if (!cancelled) setAliases(buildByokProviderAliases([], target));
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  return aliases;
}
