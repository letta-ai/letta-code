# SgPredicateRegistryApplyOps

Apply an ops batch to update Smarty Graph's predicate registries.

This is a structured editing surface:
- You provide a PredicateRegistryOps v1 ops array.
- The tool validates ops structurally, applies to a scratch copy of the registries, and then swaps the updated registries into place atomically.
- If validation fails, it returns deterministic errors and makes no changes.

Usage:
- Use this tool instead of editing registry JSON files directly.
- If the tool returns errors, adjust the ops and retry.
- This tool can be called multiple times in a loop until it returns ok=true.
