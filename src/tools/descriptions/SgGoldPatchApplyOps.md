# SgGoldPatchApplyOps

Apply an ops batch to patch (or create) a Smarty Graph gold proposals JSON file.

This is a structured editing surface:
- You provide an ops array (GoldProposalsPatchOps v1).
- The tool constructs a full ops batch, validates, applies transactionally, and then re-validates.
- If the proposals file does not exist yet, the applier bootstraps a minimal proposals object (segment metadata inferred from a sibling `segments/plan.json`).
- If validation fails, it returns deterministic errors and makes no changes.

Usage:
- Use this tool instead of editing proposal JSON files directly.
- If the tool returns errors, adjust the ops and retry.
- This tool can be called multiple times in a loop until it returns ok=true.
