# CheckTypes Tool - TypeScript Intellisense for Letta Code

## Overview

The CheckTypes tool provides TypeScript/JavaScript type information to agents, helping prevent type-related hallucinations when editing code.

## Status

⚠️ **Experimental Feature** - Requires opt-in via `LETTA_ENABLE_CHECKTYPES=true` environment variable.

## Architecture

### Components

1. **TypeChecker Service** (`service.ts`)
   - Uses TypeScript Compiler API
   - Manages program creation and caching
   - Finds and uses tsconfig.json automatically
   - Provides type information and diagnostics

2. **CheckTypes Tool** (`../impl/CheckTypes.ts`)
   - Agent-facing tool interface
   - Validates inputs and file types
   - Formats results for agent consumption
   - Gated by environment variable

3. **Tests** (`../../tests/checkTypes.test.ts`)
   - Comprehensive test suite
   - Tests caching, validation, and edge cases
   - Runs via `bun test`

## Usage

### Enable the Feature

```bash
export LETTA_ENABLE_CHECKTYPES=true
```

### Agent Usage Examples

**Check function signature:**
```typescript
CheckTypes({
  file_path: "src/components/UserCard.tsx",
  symbol_name: "UserCard"
})
```

**Validate file for type errors:**
```typescript
CheckTypes({
  file_path: "src/utils/helpers.ts",
  validate: true
})
```

## Capabilities

- ✅ Query specific symbol types (functions, classes, interfaces)
- ✅ Get function signatures with parameter types
- ✅ Extract JSDoc documentation
- ✅ Validate entire files for type errors
- ✅ Support TypeScript (.ts, .tsx) and JavaScript (.js, .jsx)
- ✅ Program caching for performance
- ✅ Automatic tsconfig.json discovery

## Performance

The TypeChecker service caches TypeScript programs per file/config to avoid recreating them on every query. Tests show cached queries are >2x faster than initial queries.

## Preventing Hallucinations

### Without CheckTypes
Agent might:
- ❌ Invent non-existent props on React components
- ❌ Pass wrong argument types to functions
- ❌ Misspell property names on interfaces
- ❌ Use incorrect number of arguments

### With CheckTypes
Agent can:
- ✅ Check actual prop types before editing components
- ✅ Verify function signatures before calling them
- ✅ Validate edits don't introduce type errors
- ✅ Understand interface structures accurately

## Testing

Run the test suite:

```bash
bun test src/tests/checkTypes.test.ts
```

All tests automatically enable the feature flag.

## Future Enhancements

See the plan at `/Users/shubhamnaik/.letta/plans/keen-humble-elm.md`:

- **Phase 2**: Upgrade to LSP for better performance
- **Phase 3**: Multi-language support (Python, Go, etc.)
- **Phase 4**: Memory block caching, type-aware Read tool

## Implementation Details

### TypeScript Compiler API

The service uses `ts.createProgram()` to analyze TypeScript files. Key features:

- **Symbol resolution**: Walks AST to find declarations by name
- **Type extraction**: Uses TypeChecker to get type strings
- **Signature extraction**: Gets function signatures and parameter info
- **Documentation**: Extracts JSDoc comments from symbols
- **Diagnostics**: Runs semantic and syntactic type checking

### Caching Strategy

Two-level cache:
1. **Program cache**: Maps config/file paths to TypeScript programs
2. **Config cache**: Maps file paths to nearest tsconfig.json

Cache can be cleared with `service.clearCache()`.

### Error Handling

- Unsupported file types throw immediately
- Missing symbols return structured error responses
- Type errors are formatted with line/column numbers
- Graceful fallback when tsconfig.json not found

## Environment Variable Gate

The tool checks `process.env.LETTA_ENABLE_CHECKTYPES` on every invocation. This allows:

- Safe experimentation without affecting production
- Easy rollback if issues are discovered
- Clear opt-in signal for users
- Testing in controlled environments

To remove the gate in the future, simply delete the check in `CheckTypes.ts`.
