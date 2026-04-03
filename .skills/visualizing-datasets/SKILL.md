---
name: visualizing-datasets
description: Generate interactive HTML viewers for memory eval datasets. Use when the user wants to browse, inspect, or visualize generated test cases from memory eval envs (reflection, placement, organization, rewrite). Supports any dataset.jsonl format.
---

# Visualizing Datasets

Generate a self-contained HTML file for browsing eval test cases.

## Usage

```bash
python <SKILL_DIR>/scripts/visualize.py <path> [--output out.html] [--case-id 4]
```

- `<path>`: A `dataset.jsonl` file or a run directory containing one
- `--output`: Output HTML path (default: `viewer.html` next to the dataset)
- `--case-id`: Render only a specific case ID

Auto-detects the env type from dataset keys and renders accordingly. Opens in browser after generation.

## Supported formats

- **reflection**: memory_before filesystem + conversation XML + expected_diff
- **placement**: memory_blocks + user message + placements ground truth
- **organization**: memory_blocks + input + ground truth
- **rewrite**: memory_blocks + convo_path + rewrites/preserve ground truth
