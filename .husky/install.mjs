if (process.env.NODE_ENV === "production" || process.env.CI === "true") {
  process.exit(0);
}

try {
  const husky = (await import("husky")).default;
  husky();
} catch {}
