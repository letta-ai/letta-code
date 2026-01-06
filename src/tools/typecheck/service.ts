import ts from "typescript";
import * as path from "node:path";
import { promises as fs } from "node:fs";

export interface TypeInfo {
	type: string;
	documentation?: string;
	signature?: string;
	errors?: string[];
}

/**
 * TypeChecker service for analyzing TypeScript/JavaScript code
 * Provides type information, signatures, and diagnostics using TypeScript Compiler API
 */
export class TypeCheckerService {
	private programCache = new Map<string, ts.Program>();
	private configCache = new Map<string, string | undefined>();

	/**
	 * Get type information for a file or specific symbol
	 * @param filePath - Path to TypeScript/JavaScript file
	 * @param symbolName - Optional: specific symbol to analyze
	 * @returns Type information including type string, signature, documentation, and errors
	 */
	async getTypeInfo(
		filePath: string,
		symbolName?: string,
	): Promise<TypeInfo> {
		try {
			// 1. Find tsconfig.json in workspace
			const configPath = await this.findTsConfig(filePath);

			// 2. Create or get cached program
			const program = await this.getProgram(configPath, filePath);
			const checker = program.getTypeChecker();
			const sourceFile = program.getSourceFile(filePath);

			if (!sourceFile) {
				return {
					type: "unknown",
					errors: ["File not found in TypeScript program"],
				};
			}

			// 3. If symbolName provided, find and return its type
			if (symbolName) {
				const symbol = this.findSymbol(sourceFile, symbolName, checker);
				if (symbol) {
					const type = checker.getTypeOfSymbolAtLocation(symbol, sourceFile);
					return {
						type: checker.typeToString(type),
						signature: this.getSignature(symbol, checker),
						documentation: this.getDocumentation(symbol),
					};
				}
				return {
					type: "unknown",
					errors: [`Symbol "${symbolName}" not found in ${filePath}`],
				};
			}

			// 4. Otherwise run diagnostics on the whole file
			const diagnostics = [
				...program.getSemanticDiagnostics(sourceFile),
				...program.getSyntacticDiagnostics(sourceFile),
			];

			const errors = diagnostics.map((d) => {
				const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
				if (d.file && d.start !== undefined) {
					const { line, character } =
						d.file.getLineAndCharacterOfPosition(d.start);
					return `Line ${line + 1}, Col ${character + 1}: ${message}`;
				}
				return message;
			});

			return {
				type: "file",
				errors: errors.length > 0 ? errors : undefined,
			};
		} catch (error) {
			return {
				type: "error",
				errors: [
					`Type check failed: ${error instanceof Error ? error.message : String(error)}`,
				],
			};
		}
	}

	/**
	 * Get or create a TypeScript program for the given file
	 */
	private async getProgram(
		configPath: string | undefined,
		filePath: string,
	): Promise<ts.Program> {
		const cacheKey = configPath || filePath;

		// Return cached program if available
		if (this.programCache.has(cacheKey)) {
			return this.programCache.get(cacheKey)!;
		}

		let program: ts.Program;

		if (configPath) {
			// Use tsconfig.json if found
			const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
			const parsedConfig = ts.parseJsonConfigFileContent(
				configFile.config,
				ts.sys,
				path.dirname(configPath),
			);

			program = ts.createProgram({
				rootNames: parsedConfig.fileNames,
				options: parsedConfig.options,
			});
		} else {
			// Create program with default options
			program = ts.createProgram([filePath], {
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				allowJs: true,
				checkJs: false,
				noEmit: true,
				skipLibCheck: true,
				jsx: ts.JsxEmit.ReactJSX,
			});
		}

		this.programCache.set(cacheKey, program);
		return program;
	}

	/**
	 * Find a symbol by name in the source file
	 */
	private findSymbol(
		sourceFile: ts.SourceFile,
		name: string,
		checker: ts.TypeChecker,
	): ts.Symbol | undefined {
		let foundSymbol: ts.Symbol | undefined;

		const visit = (node: ts.Node) => {
			// Check for named declarations
			if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
				if (node.name?.getText(sourceFile) === name) {
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol) {
						foundSymbol = symbol;
						return;
					}
				}
			}

			// Check for variable declarations
			if (ts.isVariableDeclaration(node)) {
				if (node.name.getText(sourceFile) === name) {
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol) {
						foundSymbol = symbol;
						return;
					}
				}
			}

			// Check for interface/type declarations
			if (
				ts.isInterfaceDeclaration(node) ||
				ts.isTypeAliasDeclaration(node)
			) {
				if (node.name.getText(sourceFile) === name) {
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol) {
						foundSymbol = symbol;
						return;
					}
				}
			}

			// Check for property declarations (in interfaces/classes)
			if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
				if (node.name.getText(sourceFile) === name) {
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol) {
						foundSymbol = symbol;
						return;
					}
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(sourceFile);
		return foundSymbol;
	}

	/**
	 * Extract function signature from symbol
	 */
	private getSignature(
		symbol: ts.Symbol,
		checker: ts.TypeChecker,
	): string | undefined {
		const type = checker.getTypeOfSymbol(symbol);
		const signatures = type.getCallSignatures();

		if (signatures.length > 0) {
			return signatures
				.map((sig) => checker.signatureToString(sig))
				.join("\n");
		}

		// For non-function symbols, return the type string
		return checker.typeToString(type);
	}

	/**
	 * Extract JSDoc documentation from symbol
	 */
	private getDocumentation(symbol: ts.Symbol): string | undefined {
		const docs = symbol.getDocumentationComment(undefined);
		if (docs.length > 0) {
			return docs.map((d) => d.text).join("\n");
		}
		return undefined;
	}

	/**
	 * Find tsconfig.json by walking up directory tree
	 */
	private async findTsConfig(startPath: string): Promise<string | undefined> {
		// Check cache first
		if (this.configCache.has(startPath)) {
			return this.configCache.get(startPath);
		}

		let currentDir = path.dirname(startPath);
		const root = path.parse(currentDir).root;

		while (currentDir !== root) {
			const configPath = path.join(currentDir, "tsconfig.json");
			try {
				await fs.access(configPath);
				this.configCache.set(startPath, configPath);
				return configPath;
			} catch {
				// tsconfig.json not found, continue up the tree
			}

			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) {
				break; // Reached root
			}
			currentDir = parentDir;
		}

		this.configCache.set(startPath, undefined);
		return undefined;
	}

	/**
	 * Clear caches (useful for testing or when files change)
	 */
	clearCache(): void {
		this.programCache.clear();
		this.configCache.clear();
	}
}
