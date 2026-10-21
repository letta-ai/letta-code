# AskUserQuestion

Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- This tool posts questions and returns immediately. It does not wait for the user or pause your work.
- If the user answers or dismisses the questions, you will receive a task notification identifying the original tool call and containing the questions and response.
- Continue independent work while the questions are open. Do not assume an answer or proceed with work that requires the user's decision until a response arrives.
- The user may never respond. Do not repeatedly call this tool to poll for an answer.
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
