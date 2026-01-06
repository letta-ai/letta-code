import { expect, test } from "bun:test";
import { checkTypes } from "../tools/impl/CheckTypes";
import { TypeCheckerService } from "../tools/typecheck/service";

// Enable CheckTypes for tests
process.env.LETTA_ENABLE_CHECKTYPES = "true";

test("CheckTypes: analyzes function signature correctly", async () => {
	const result = await checkTypes({
		file_path: "./src/tools/impl/Read.ts",
		symbol_name: "read",
	});

	expect(result.type).toBe("(args: ReadArgs) => Promise<ReadResult>");
	expect(result.signature).toBe("(args: ReadArgs): Promise<ReadResult>");
	expect(result.message).toContain("Type info for 'read'");
});

test("CheckTypes: validates file with no errors", async () => {
	const result = await checkTypes({
		file_path: "./src/tools/impl/CheckTypes.ts",
		validate: true,
	});

	expect(result.message).toContain("Type check passed");
	expect(result.errors).toBeUndefined();
});

test("CheckTypes: reports error for non-existent symbol", async () => {
	const result = await checkTypes({
		file_path: "./src/tools/impl/Read.ts",
		symbol_name: "nonExistentFunction",
	});

	expect(result.errors).toBeDefined();
	expect(result.errors?.[0]).toContain("not found");
});

test("CheckTypes: rejects non-TypeScript/JavaScript files", async () => {
	await expect(
		checkTypes({
			file_path: "./README.md",
			symbol_name: "something",
		}),
	).rejects.toThrow("Unsupported file type");
});

test("TypeCheckerService: caches programs for performance", async () => {
	const service = new TypeCheckerService();

	// First call - should create program
	const start1 = performance.now();
	await service.getTypeInfo("./src/tools/impl/Read.ts", "read");
	const duration1 = performance.now() - start1;

	// Second call - should use cached program (faster)
	const start2 = performance.now();
	await service.getTypeInfo("./src/tools/impl/Read.ts", "read");
	const duration2 = performance.now() - start2;

	// Cached call should be faster (at least 2x)
	expect(duration2).toBeLessThan(duration1 / 2);
});

test("TypeCheckerService: clears cache", async () => {
	const service = new TypeCheckerService();

	// Populate cache
	await service.getTypeInfo("./src/tools/impl/Read.ts", "read");

	// Clear cache
	service.clearCache();

	// Should work after clearing
	const result = await service.getTypeInfo("./src/tools/impl/Read.ts", "read");
	expect(result.type).toBe("(args: ReadArgs) => Promise<ReadResult>");
});

test("CheckTypes: handles TypeScript interface", async () => {
	const result = await checkTypes({
		file_path: "./src/tools/impl/CheckTypes.ts",
		symbol_name: "CheckTypesArgs",
	});

	expect(result.type).toBeDefined();
	expect(result.message).toContain("Type info for 'CheckTypesArgs'");
});

test("CheckTypes: validates file_path is required", async () => {
	await expect(
		// @ts-expect-error - Testing validation
		checkTypes({}),
	).rejects.toThrow();
});

test("CheckTypes: requires environment variable to be set", async () => {
	// Temporarily disable the feature
	const originalValue = process.env.LETTA_ENABLE_CHECKTYPES;
	delete process.env.LETTA_ENABLE_CHECKTYPES;

	await expect(
		checkTypes({
			file_path: "./src/tools/impl/Read.ts",
			symbol_name: "read",
		}),
	).rejects.toThrow("experimental feature");

	// Restore
	if (originalValue) {
		process.env.LETTA_ENABLE_CHECKTYPES = originalValue;
	}
});
