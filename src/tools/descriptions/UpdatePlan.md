Updates the task plan.

Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.

Use a plan to break down complex or multi-step tasks into meaningful, logically ordered steps that are easy to verify as you go. Plans help demonstrate that you've understood the task and convey how you're approaching it.

Do not use plans for simple or single-step tasks that you can just do immediately.

Before running a command or making changes, consider whether you have completed the previous step, and make sure to mark it as completed before moving on to the next step.

Sometimes you may need to change plans in the middle of a task: call update_plan with the updated plan and make sure to provide an explanation of the rationale when doing so.

**Arguments**:
- **plan**: Required array of plan items. Each item must have:
  - **step**: String description of the step
  - **status**: One of "pending", "in_progress", or "completed"
- **explanation**: Optional explanation for the plan or changes

**Returns**: Confirmation message that the plan was updated.

