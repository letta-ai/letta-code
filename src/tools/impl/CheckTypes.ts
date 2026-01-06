import * as path from "node:path";
import { TypeCheckerService } from "../typecheck/service.js";
import { validateRequiredParams } from "./validation.js";

interface CheckTypesArgs {
	file_path: string;
	symbol_name?: string;
	validate?: boolean;
}

interface CheckTypesResult {
	type?: string;
	signature?: string;
	documentation?: string;
	errors?: string[];
	message: string;
}

// Singleton TypeChecker instance to maintain caches
const typeChecker = new TypeCheckerService();

/**
 * CheckTypes tool - provides type information for TypeScript/JavaScript files
 * Helps prevent type-related hallucinations by querying actual type information
 *
 * Usage examples:
 * 1. Check specific symbol:
 *    CheckTypes({ file_path: "src/foo.ts", symbol_name: "UserProfile" })
 *    Returns: Type and signature of UserProfile
 *
 * 2. Validate entire file:
 *    CheckTypes({ file_path: "src/foo.ts", validate: true })
 *    Returns: Type errors found in the file
 *
 * 3. Quick type lookup:
 *    CheckTypes({ file_path: "src/foo.ts", symbol_name: "myFunction" })
 *    Returns: Function signature and documentation
 */
export async function checkTypes(
	args: CheckTypesArgs,
): Promise<CheckTypesResult> {
	// Experimental feature: requires opt-in via environment variable
	if (!process.env.LETTA_ENABLE_CHECKTYPES) {
		throw new Error(
			"CheckTypes is an experimental feature. Set LETTA_ENABLE_CHECKTYPES=true to enable it.",
		);
	}

	validateRequiredParams(args, ["file_path"], "CheckTypes");
	const { file_path, symbol_name, validate } = args;

	// Resolve path
	const userCwd = process.env.USER_CWD || process.cwd();
	const resolvedPath = path.isAbsolute(file_path)
		? file_path
		: path.resolve(userCwd, file_path);

	// Check if file is TypeScript/JavaScript
	const ext = path.extname(resolvedPath).toLowerCase();
	const supportedExtensions = [".ts", ".tsx", ".js", ".jsx"];
	if (!supportedExtensions.includes(ext)) {
		throw new Error(
			`Unsupported file type: ${ext}. CheckTypes only supports TypeScript/JavaScript files (.ts, .tsx, .js, .jsx)`,
		);
	}

	try {
		const info = await typeChecker.getTypeInfo(resolvedPath, symbol_name);

		// Handle errors
		if (info.errors && info.errors.length > 0) {
			if (validate) {
				// When validating, show all errors
				return {
					...info,
					message: `Found ${info.errors.length} type error(s) in ${path.basename(file_path)}:\n${info.errors.slice(0, 10).join("\n")}${info.errors.length > 10 ? `\n... and ${info.errors.length - 10} more errors` : ""}`,
				};
			}
			// When querying specific symbol and getting errors, it means symbol not found
			return {
				...info,
				message: info.errors[0] || "Type information not available",
			};
		}

		// Success case
		if (symbol_name) {
			// Querying specific symbol
			const parts = [`Type info for '${symbol_name}': ${info.type}`];
			if (info.signature) {
				parts.push(`Signature: ${info.signature}`);
			}
			if (info.documentation) {
				parts.push(`Documentation: ${info.documentation}`);
			}
			return {
				...info,
				message: parts.join("\n"),
			};
		}
		// Validating file
		return {
			...info,
			message: `✓ Type check passed for ${path.basename(file_path)} - no errors found`,
		};
	} catch (error) {
		const err = error as Error;
		throw new Error(`Type check failed: ${err.message}`);
	}
}
