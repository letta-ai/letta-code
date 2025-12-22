# Workflow Patterns

## Sequential Workflows

For complex tasks, break operations into clear, sequential steps. It is often helpful to give the Letta Code agent an overview of the process towards the beginning of SKILL.md:

```markdown
Filling a PDF form involves these steps:

1. Analyze the form (run analyze-form.ts)
2. Create field mapping (edit fields.json)
3. Validate mapping (run validate-fields.ts)
4. Fill the form (run fill-form.ts)
5. Verify output (run verify-output.ts)
```

## Conditional Workflows

For tasks with branching logic, guide the Letta Code agent through decision points:

```markdown
1. Determine the modification type:
   **Creating new content?** → Follow "Creation workflow" below
   **Editing existing content?** → Follow "Editing workflow" below

2. Creation workflow: [steps]
3. Editing workflow: [steps]
```
