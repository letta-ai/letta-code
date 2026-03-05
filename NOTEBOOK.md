# Jupyter Notebook Support for Letta Code

Letta Code now has first-class support for Jupyter notebooks. You get **5 new tools** for reading, creating, editing, deleting, and executing notebook cells — plus a **shared memory system** that lets multiple agents share context across notebooks.

---

## Getting Started

### 1. Install Letta Code

```bash
npm install -g @letta-ai/letta-code
```

Or from this fork:

```bash
git clone https://github.com/jayavibhavnk/letta-code.git
cd letta-code
npm install --legacy-peer-deps
npm run build
```

### 2. Navigate to a project with notebooks

```bash
cd ~/my-project
letta
```

Letta Code will detect `.ipynb` files in your workspace and make the notebook tools available automatically.

---

## Notebook Tools

### Read a notebook

Ask the agent to read any notebook:

```
> Read the cells in analysis.ipynb
```

The agent uses `NotebookRead` to display every cell with its index, type, source code, and outputs.

You can also ask for a specific cell:

```
> Show me cell 3 from analysis.ipynb
```

### Create cells

Ask the agent to add cells to a notebook:

```
> Add a code cell to analysis.ipynb that imports pandas and loads data.csv
```

```
> Add a markdown cell at the top of analysis.ipynb with the title "Sales Analysis Q1 2026"
```

The agent uses `NotebookCreateCell` to insert code, markdown, or raw cells at any position.

### Edit cells

Ask the agent to modify existing cells:

```
> In cell 4 of analysis.ipynb, change the variable name 'df' to 'sales_df'
```

```
> Rewrite cell 2 of analysis.ipynb to use seaborn instead of matplotlib
```

The agent uses `NotebookEditCell` with find-and-replace (same pattern as the standard Edit tool).

### Delete cells

```
> Delete cell 7 from analysis.ipynb — it's a scratch cell I don't need
```

### Execute cells

```
> Run cell 3 from analysis.ipynb and show me the output
```

The agent uses `NotebookExecuteCell` to run Python code and return stdout/stderr.

> **Note:** Execution runs in a standalone Python process. For stateful execution where cells share variables, use the Bash tool with `python3` or run the notebook in Jupyter.

---

## Shared Memory Groups

This is the standout feature. Multiple agents can share memory through named groups — so when you learn something in one notebook, the knowledge is available in another.

### Join a group

```
/group join my-project
```

Any agent that joins `my-project` can read and write to the same shared memory blocks.

### How it works in practice

**Terminal 1 — working on data cleaning:**

```
> /group join sales-analysis

Joined group 'sales-analysis' (1 member(s)).

> Clean the data in cleaning.ipynb. The CSV has columns: 
  order_id, customer_name, amount, date, region.
  Remove nulls and fix the date format.

(Agent works on the notebook, learns the schema, and stores it in shared memory)
```

**Terminal 2 — working on modeling (same group):**

```
> /group join sales-analysis

Joined group 'sales-analysis' (2 member(s)).

> Build a regression model in modeling.ipynb to predict order amounts.

(Agent reads shared memory → already knows the column names, 
data types, and cleaning steps from the other notebook)
```

### View shared memory

```
/shared-memory
```

Shows all memory blocks from every connected group:

```
## Shared Memory — group: sales-analysis (2 agent(s))

[project_context]
Analyzing Q1 2026 sales data. Goal: predict order amounts by region.

[data_schema]
Columns: order_id (int), customer_name (str), amount (float), 
date (datetime), region (str). Nulls removed, dates normalized to ISO 8601.

[model_results]
Linear regression baseline: R² = 0.73. XGBoost: R² = 0.91.
```

### Group commands

| Command | Description |
|---------|-------------|
| `/group join <name>` | Join a shared memory group |
| `/group leave <name>` | Leave a group |
| `/group list` | List all groups you belong to |
| `/group members <name>` | See who's in a group |
| `/shared-memory` | View all shared memory blocks |

### Where shared memory lives

```
~/.letta/groups/
├── sales-analysis/
│   ├── shared_memory.json    ← shared blocks (readable by all members)
│   └── members.json          ← list of agent IDs in this group
├── ml-experiments/
│   ├── shared_memory.json
│   └── members.json
```

---

## Examples

### Example 1: Build a notebook from scratch

```
> Create a new notebook called eda.ipynb with:
  - A markdown title cell
  - Import pandas, numpy, matplotlib
  - Load iris.csv
  - Show df.describe()
  - Create a pairplot
```

The agent will create the file and add each cell, executing them to verify they work.

### Example 2: Fix a broken notebook

```
> Read broken_analysis.ipynb. Cell 5 is throwing a KeyError. Fix it.
```

The agent reads the notebook, identifies the issue, edits the cell, and re-executes to confirm.

### Example 3: Cross-notebook workflow

```
> /group join research

> Read features.ipynb and summarize what features were engineered.
  Store the feature list in shared memory so the training notebook can use it.
```

Then in another terminal:

```
> /group join research

> What features are available from the feature engineering notebook?
  Use them to build a model in training.ipynb.
```

### Example 4: Refactor a notebook

```
> Read messy_notebook.ipynb. Reorganize it:
  - Group imports at the top
  - Add markdown headers between sections
  - Remove empty cells and scratch code
  - Make sure all cells execute in order
```

---

## Tool Reference

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `NotebookRead` | Read cells from a notebook | `notebook_path`, `cell_index?`, `include_outputs?` |
| `NotebookCreateCell` | Insert a new cell | `notebook_path`, `source`, `cell_type?`, `cell_index?` |
| `NotebookEditCell` | Edit a cell via find-and-replace | `notebook_path`, `cell_index`, `old_string`, `new_string` |
| `NotebookDeleteCell` | Remove a cell | `notebook_path`, `cell_index` |
| `NotebookExecuteCell` | Run a code cell | `notebook_path`, `cell_index`, `timeout?` |

All tools require approval before execution (except `NotebookRead` which is read-only).

---

## Architecture

```
src/
├── notebook/
│   ├── types.ts              ← NotebookDocument, NotebookCell, CellSnapshot
│   └── controller.ts         ← Read/write .ipynb files, cell CRUD operations
├── agent/
│   └── sharedMemory.ts       ← Group membership + shared block storage
├── tools/
│   ├── impl/
│   │   ├── NotebookRead.ts
│   │   ├── NotebookEditCell.ts
│   │   ├── NotebookCreateCell.ts
│   │   ├── NotebookDeleteCell.ts
│   │   └── NotebookExecuteCell.ts
│   ├── schemas/               ← JSON schemas for each tool
│   ├── descriptions/          ← Markdown descriptions for each tool
│   ├── toolDefinitions.ts     ← Tool registration (modified)
│   └── manager.ts             ← NOTEBOOK_TOOLS toolset + permissions (modified)
└── cli/commands/
    └── registry.ts            ← /group and /shared-memory commands (modified)
```

The notebook controller operates directly on the `.ipynb` JSON structure — no Python or nbformat dependency required.
