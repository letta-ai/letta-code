import type { RuntimeToolPolicy } from "@/types/external-tool-protocol";
import type { ClientToolsetConfig } from "@/types/input-create-message";
import { getInternalToolName } from "./tool-name-mapping";

/** The tool selection fields one turn sends; each applies to that turn only. */
export interface TurnToolSelection {
  clientToolset?: ClientToolsetConfig;
  clientToolAllowlist?: string[];
  excludeInteractiveTools?: boolean;
}

/** Keep entries of `narrower` that `ceiling` also allows. */
export function intersectToolAllowlists(
  ceiling: readonly string[],
  narrower: readonly string[],
): string[] {
  return narrower.filter((name) =>
    ceiling.some(
      (allowed) => getInternalToolName(allowed) === getInternalToolName(name),
    ),
  );
}

/**
 * Merge per field: a turn's own fields win over field values from the
 * connection's tool policy. A turn allowlist can only narrow the policy's.
 */
export function resolveTurnToolSelection(
  turn: TurnToolSelection,
  policy: RuntimeToolPolicy | undefined,
): TurnToolSelection {
  const base = turn.clientToolset?.base ?? policy?.toolset?.base;
  const include = turn.clientToolset?.include ?? policy?.toolset?.include;
  const clientToolset =
    base === undefined && include === undefined
      ? undefined
      : {
          ...(base !== undefined ? { base } : {}),
          ...(include !== undefined ? { include: [...include] } : {}),
        };
  const policyAllowlist = policy?.allowlist;
  const clientToolAllowlist =
    policyAllowlist === undefined
      ? turn.clientToolAllowlist
      : turn.clientToolAllowlist === undefined
        ? [...policyAllowlist]
        : intersectToolAllowlists(policyAllowlist, turn.clientToolAllowlist);
  const excludeInteractiveTools =
    turn.excludeInteractiveTools ?? policy?.exclude_interactive;
  return {
    ...(clientToolset ? { clientToolset } : {}),
    ...(clientToolAllowlist !== undefined ? { clientToolAllowlist } : {}),
    ...(excludeInteractiveTools !== undefined
      ? { excludeInteractiveTools }
      : {}),
  };
}

/** Fill toolset fields the turn left unset from the saved conversation choice. */
export function mergeClientToolsetFields(
  primary: ClientToolsetConfig | undefined,
  fallback: ClientToolsetConfig | undefined,
): ClientToolsetConfig | undefined {
  const base = primary?.base ?? fallback?.base;
  const include = primary?.include ?? fallback?.include;
  if (base === undefined && include === undefined) return undefined;
  return {
    ...(base !== undefined ? { base } : {}),
    ...(include !== undefined ? { include } : {}),
  };
}
