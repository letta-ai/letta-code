import { loadSlackWebApiModule } from "./runtime";

type SlackWebClientConstructor = new (
  token: string,
  options?: Record<string, unknown>,
) => unknown;

type SlackWebApiModule = {
  WebClient?: unknown;
  default?: unknown;
};

type Constructor = abstract new (...args: never[]) => unknown;

function isConstructorFunction<T extends Constructor>(
  value: unknown,
): value is T {
  return typeof value === "function";
}

function resolveSlackWebClientModule(
  value: unknown,
): SlackWebClientConstructor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const webClient = Reflect.get(value, "WebClient");
  return isConstructorFunction<SlackWebClientConstructor>(webClient)
    ? webClient
    : null;
}

function resolveSlackWebClientConstructor(
  mod: SlackWebApiModule,
): SlackWebClientConstructor {
  const defaultExport =
    mod && typeof mod === "object" ? Reflect.get(mod, "default") : undefined;
  const nestedDefault =
    defaultExport && typeof defaultExport === "object"
      ? Reflect.get(defaultExport, "default")
      : undefined;

  const WebClient =
    resolveSlackWebClientModule(mod) ??
    resolveSlackWebClientModule(defaultExport) ??
    resolveSlackWebClientModule(nestedDefault) ??
    (isConstructorFunction<SlackWebClientConstructor>(defaultExport)
      ? defaultExport
      : null);

  if (!WebClient) {
    throw new Error(
      'Installed Slack runtime did not export constructor "WebClient".',
    );
  }
  return WebClient;
}

export async function createSlackWebApiClient<TClient = unknown>(
  token: string,
  options?: Record<string, unknown>,
): Promise<TClient> {
  const webApi = await loadSlackWebApiModule();
  const WebClient = resolveSlackWebClientConstructor(webApi);
  return new WebClient(token, options) as TClient;
}
