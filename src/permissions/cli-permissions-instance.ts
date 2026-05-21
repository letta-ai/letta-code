/**
 * Singleton instance of CliPermissions.
 *
 * Kept in a standalone file so that memoryScope.ts can import the singleton
 * without creating a circular dependency with cli.ts (which imports
 * parseScopeList from memoryScope.ts).
 */
import { CliPermissions } from "./cli";

export const cliPermissions = new CliPermissions();
