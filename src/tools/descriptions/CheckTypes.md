# CheckTypes

⚠️ **Experimental Feature** - Requires `LETTA_ENABLE_CHECKTYPES=true` environment variable.

Provides type information for TypeScript and JavaScript files to help prevent type-related hallucinations when editing code.

## Purpose

Use this tool to:
- Get type information for functions, classes, interfaces, and variables before using them
- Validate that your edits won't introduce type errors
- Understand function signatures and parameter types
- Check what props/arguments a component or function accepts

## Usage

### Query Specific Symbol Type
```typescript
CheckTypes({
  file_path: "/path/to/file.ts",
  symbol_name: "UserProfile"
})
// Returns: Type, signature, and documentation for UserProfile
```

### Validate Entire File
```typescript
CheckTypes({
  file_path: "/path/to/file.ts",
  validate: true
})
// Returns: List of type errors if any, or success message
```

### Check Function Signature
```typescript
CheckTypes({
  file_path: "/path/to/utils.ts",
  symbol_name: "formatDate"
})
// Returns: Function signature showing parameter types and return type
```

## Best Practices

1. **Before editing**: Check the type of symbols you're about to modify
2. **After editing**: Validate the file to ensure no type errors were introduced
3. **When unsure**: Query specific symbols to understand their exact types
4. **Prevent hallucinations**: Always verify prop types before adding/modifying React component props

## Supported Files

- TypeScript: .ts, .tsx
- JavaScript: .js, .jsx (if in TypeScript project with checkJs enabled)

## Examples

### Example 1: Check React Component Props
```typescript
// Before adding a new prop to UserCard component:
CheckTypes({
  file_path: "src/components/UserCard.tsx",
  symbol_name: "UserCard"
})
// Returns: "React.FC<{ name: string; age: number; email?: string }>"
// Now you know exactly what props are already defined
```

### Example 2: Validate After Edit
```typescript
// After modifying a function:
CheckTypes({
  file_path: "src/utils/helpers.ts",
  validate: true
})
// Returns: List of any type errors, or confirmation that types are valid
```

### Example 3: Understand API Before Using
```typescript
// Before calling a function:
CheckTypes({
  file_path: "src/api/client.ts",
  symbol_name: "fetchUserData"
})
// Returns: "(userId: string, options?: RequestOptions) => Promise<User>"
// Now you know the exact parameter types and return type
```

## Notes

- **Experimental**: Requires `LETTA_ENABLE_CHECKTYPES=true` environment variable
- The tool uses TypeScript Compiler API for accurate type information
- Will attempt to find and use tsconfig.json in the workspace
- Type information is cached for performance
- Only works with TypeScript/JavaScript files

## Enabling CheckTypes

To use this tool, set the environment variable before starting Letta Code:

```bash
export LETTA_ENABLE_CHECKTYPES=true
# or inline:
LETTA_ENABLE_CHECKTYPES=true letta
```
