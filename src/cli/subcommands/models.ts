import { parseArgs } from "node:util";
import { type Backend, getBackend, type ModelsListOptions } from "@/backend";
import { refreshByokProviders } from "@/backend/api/providers";
import { settingsManager } from "@/settings-manager";

type OutputFormat = "json" | "text";
type ModelListQuery = NonNullable<ModelsListOptions>;
type ProviderCategory = NonNullable<
  ModelListQuery["provider_category"]
>[number];
type ListedModel = Awaited<ReturnType<Backend["listModels"]>>[number];

const VALID_PROVIDER_CATEGORIES: ProviderCategory[] = ["base", "byok"];

const MODELS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  format: { type: "string" },
  "provider-name": { type: "string" },
  provider: { type: "string" },
  "provider-type": { type: "string" },
  "provider-category": { type: "string" },
  refresh: { type: "boolean" },
} as const;

type ModelsSubcommandDeps = {
  initializeSettings?: () => Promise<void>;
  getBackend?: typeof getBackend;
  refreshByokProviders?: typeof refreshByokProviders;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

function printUsage(stdout: (message: string) => void): void {
  stdout(
    `
Usage:
  letta models [list] [options]

Options:
  --format <json|text>           Output format (default: json)
  --provider-name <name>         Filter by provider name
  --provider <name>              Alias for --provider-name
  --provider-type <type>         Filter by provider type, e.g. anthropic
  --provider-category <base|byok> Filter by category; comma-separated allowed
  --refresh                      Refresh connected BYOK providers first

Notes:
  - Default output is JSON for agent/script consumption.
  - Uses CLI auth and the selected backend; pass --backend local for local models.
`.trim(),
  );
}

function parseModelsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MODELS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function readStringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOutputFormat(value: unknown): OutputFormat | null {
  const raw = readStringOption(value);
  if (!raw) return "json";
  if (raw === "json" || raw === "text") return raw;
  return null;
}

function parseProviderCategories(value: unknown): ProviderCategory[] | null {
  const raw = readStringOption(value);
  if (!raw) return [];

  const categories = raw
    .split(",")
    .map((category) => category.trim())
    .filter(Boolean);

  if (categories.length === 0) return [];

  for (const category of categories) {
    if (!VALID_PROVIDER_CATEGORIES.includes(category as ProviderCategory)) {
      return null;
    }
  }

  return categories as ProviderCategory[];
}

function buildModelListQuery(
  values: ReturnType<typeof parseModelsArgs>["values"],
): ModelListQuery | undefined {
  const query: ModelListQuery = {};
  const providerName =
    readStringOption(values["provider-name"]) ??
    readStringOption(values.provider);
  if (providerName) {
    query.provider_name = providerName;
  }

  const providerType = readStringOption(values["provider-type"]);
  if (providerType) {
    query.provider_type = providerType as ModelListQuery["provider_type"];
  }

  const providerCategories = parseProviderCategories(
    values["provider-category"],
  );
  if (providerCategories === null) {
    throw new Error(
      "--provider-category must be base, byok, or comma-separated",
    );
  }
  if (providerCategories.length > 0) {
    query.provider_category = providerCategories;
  }

  return Object.keys(query).length > 0 ? query : undefined;
}

function formatTextModels(models: ListedModel[]): string {
  if (models.length === 0) return "No models found.";

  const rows = models.map((model) => {
    const handle = model.handle ?? model.model ?? model.name;
    const provider =
      model.provider_name ?? model.provider_type ?? model.model_endpoint_type;
    const contextWindow = model.max_context_window ?? model.context_window;
    const name = model.display_name ?? model.name ?? model.model;
    return {
      handle: String(handle ?? ""),
      provider: String(provider ?? ""),
      context: typeof contextWindow === "number" ? String(contextWindow) : "",
      name: String(name ?? ""),
    };
  });

  const handleWidth = Math.max(
    "HANDLE".length,
    ...rows.map((r) => r.handle.length),
  );
  const providerWidth = Math.max(
    "PROVIDER".length,
    ...rows.map((r) => r.provider.length),
  );
  const contextWidth = Math.max(
    "CONTEXT".length,
    ...rows.map((r) => r.context.length),
  );

  return [
    `${"HANDLE".padEnd(handleWidth)}  ${"PROVIDER".padEnd(providerWidth)}  ${"CONTEXT".padEnd(contextWidth)}  NAME`,
    ...rows.map(
      (row) =>
        `${row.handle.padEnd(handleWidth)}  ${row.provider.padEnd(providerWidth)}  ${row.context.padEnd(contextWidth)}  ${row.name}`,
    ),
  ].join("\n");
}

function getModelProviderName(model: ListedModel): string | undefined {
  if (model.provider_name) return model.provider_name;
  const handlePrefix = model.handle?.split("/", 1)[0];
  return handlePrefix && handlePrefix.length > 0 ? handlePrefix : undefined;
}

function getModelProviderType(model: ListedModel): string | undefined {
  return model.provider_type ?? model.model_endpoint_type ?? undefined;
}

function filterModelsForQuery(
  models: ListedModel[],
  query: ModelListQuery | undefined,
): ListedModel[] {
  if (!query) return models;

  return models.filter((model) => {
    if (
      query.provider_name &&
      getModelProviderName(model) !== query.provider_name
    ) {
      return false;
    }
    if (
      query.provider_type &&
      getModelProviderType(model) !== query.provider_type
    ) {
      return false;
    }
    if (
      query.provider_category &&
      query.provider_category.length > 0 &&
      (!model.provider_category ||
        !query.provider_category.includes(model.provider_category))
    ) {
      return false;
    }
    return true;
  });
}

export async function runModelsSubcommand(
  argv: string[],
  deps: ModelsSubcommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((message) => console.log(message));
  const stderr = deps.stderr ?? ((message) => console.error(message));

  let parsed: ReturnType<typeof parseModelsArgs>;
  try {
    parsed = parseModelsArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`Error: ${message}`);
    printUsage(stdout);
    return 1;
  }

  const [action, ...rest] = parsed.positionals;
  if (parsed.values.help || action === "help") {
    printUsage(stdout);
    return 0;
  }

  if (action && action !== "list") {
    stderr(`Unknown action: ${action}`);
    printUsage(stdout);
    return 1;
  }

  if (rest.length > 0) {
    stderr(`Unexpected arguments: ${rest.join(" ")}`);
    printUsage(stdout);
    return 1;
  }

  const outputFormat = parseOutputFormat(parsed.values.format);
  if (!outputFormat) {
    stderr("Error: --format must be json or text");
    printUsage(stdout);
    return 1;
  }

  let query: ModelListQuery | undefined;
  try {
    query = buildModelListQuery(parsed.values);
  } catch (error) {
    stderr(error instanceof Error ? `Error: ${error.message}` : String(error));
    printUsage(stdout);
    return 1;
  }

  try {
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
    const backend = (deps.getBackend ?? getBackend)();

    if (parsed.values.refresh && backend.capabilities.byokProviderRefresh) {
      await (deps.refreshByokProviders ?? refreshByokProviders)();
    }

    const models = filterModelsForQuery(await backend.listModels(query), query);
    stdout(
      outputFormat === "json"
        ? JSON.stringify(models, null, 2)
        : formatTextModels(models),
    );
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
