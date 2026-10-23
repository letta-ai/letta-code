export interface RecentModel {
  handle: string;
  modelId: string | null;
}

export function getRecentModels(value: unknown): RecentModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is RecentModel => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const model = candidate as Partial<RecentModel>;
    return (
      typeof model.handle === "string" &&
      model.handle.length > 0 &&
      (typeof model.modelId === "string" || model.modelId === null)
    );
  });
}

export function addRecentModel(
  current: unknown,
  model: RecentModel,
): RecentModel[] {
  const models = getRecentModels(current);
  if (!getRecentModels([model]).length) return models;
  return [
    model,
    ...models.filter(
      (candidate) =>
        candidate.handle !== model.handle ||
        candidate.modelId !== model.modelId,
    ),
  ].slice(0, 10);
}
