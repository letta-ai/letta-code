class ToolFilterManager {
  private enabledTools: string[] | null = null;

  setEnabledTools(toolsString: string): void {
    if (toolsString === "") {
      this.enabledTools = [];
    } else {
      this.enabledTools = toolsString
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }

  getEnabledTools(): string[] | null {
    return this.enabledTools === null ? null : [...this.enabledTools];
  }

  reset(): void {
    this.enabledTools = null;
  }
}

const FILTER_KEY = Symbol.for("@letta/toolFilter");

type GlobalWithFilter = typeof globalThis & {
  [key: symbol]: ToolFilterManager;
};

function getFilter(): ToolFilterManager {
  const global = globalThis as GlobalWithFilter;
  if (!global[FILTER_KEY]) {
    global[FILTER_KEY] = new ToolFilterManager();
  }
  return global[FILTER_KEY];
}

export const toolFilter = getFilter();
