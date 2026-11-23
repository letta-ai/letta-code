export const ACTING_USER_ID_HEADER = "X-Letta-Acting-User-Id";
export const ACTING_USER_ID_ENV = "LETTA_ACTING_USER_ID";

export function resolveActingUserId(
  explicitActingUserId?: string,
  runtimeActingUserId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitActingUserId ?? runtimeActingUserId ?? env[ACTING_USER_ID_ENV];
}

export function actingUserRequestOptions(
  actingUserId: string | undefined,
): { headers: Record<string, string> } | undefined;
export function actingUserRequestOptions(actingUserId: null): {
  actingUserId: null;
};
export function actingUserRequestOptions(
  actingUserId: string | null | undefined,
):
  | { headers: Record<string, string>; actingUserId?: never }
  | { actingUserId: null; headers?: never }
  | undefined;
export function actingUserRequestOptions(
  actingUserId: string | null | undefined,
):
  | { headers: Record<string, string>; actingUserId?: never }
  | { actingUserId: null; headers?: never }
  | undefined {
  if (actingUserId === null) {
    return { actingUserId: null };
  }
  if (!actingUserId) {
    return undefined;
  }
  return { headers: { [ACTING_USER_ID_HEADER]: actingUserId } };
}
