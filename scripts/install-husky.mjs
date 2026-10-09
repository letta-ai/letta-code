import { existsSync } from "node:fs";

const isDevelopmentCheckout = existsSync(new URL("../.git", import.meta.url));

if (
  !isDevelopmentCheckout ||
  process.env.NODE_ENV === "production" ||
  process.env.CI === "true"
) {
  process.exit(0);
}

try {
  const husky = (await import("husky")).default;
  husky();
} catch {}
