type DedupeClaim = {
  generation: number;
  committed: boolean;
};

type WhatsAppDedupeClaims = {
  tryClaim: (key: string, generation: number) => boolean;
  commit: (key: string, generation: number) => void;
  release: (key: string, generation: number) => void;
};

export function createWhatsAppDedupeClaims(
  maxSize: number,
): WhatsAppDedupeClaims {
  const claims = new Map<string, DedupeClaim>();

  function cap(): void {
    while (claims.size > maxSize) {
      const first = claims.keys().next().value;
      if (typeof first !== "string") return;
      claims.delete(first);
    }
  }

  return {
    tryClaim(key, generation) {
      const existing = claims.get(key);
      if (existing?.committed || existing?.generation === generation) {
        return false;
      }
      claims.delete(key);
      claims.set(key, { generation, committed: false });
      cap();
      return true;
    },
    commit(key, generation) {
      const claim = claims.get(key);
      if (claim?.generation === generation) claim.committed = true;
    },
    release(key, generation) {
      const claim = claims.get(key);
      if (claim?.generation === generation && !claim.committed) {
        claims.delete(key);
      }
    },
  };
}
