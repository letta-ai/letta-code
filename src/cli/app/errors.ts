export function extractErrorMeta(e: unknown) {
  return {
    errorType: e instanceof Error ? e.constructor.name : "UnknownError",
    httpStatus:
      e &&
      typeof e === "object" &&
      "status" in e &&
      typeof e.status === "number"
        ? e.status
        : undefined,
  };
}
