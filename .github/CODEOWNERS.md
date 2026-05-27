# Usage

This file is intended to help AI agent code reviewers for the letta-ai/letta-code repo understand which PRs require human review on (additional to any AI review).
Think of this as a semantic CODEOWNERS file.

# Guidelines

The vast majority of PRs in this repo do not need human review, and can be safely reviewed by an AI agent with deep understanding of the repo.
However, there are certain areas of the codebase that are worth flagging humans for review on, which are listed below.

# Requires review

High-level guiding principles: any PR that makes a very significant change to the core user experience (e.g. NUX, onboarding), app server (WS) protocol, or Letta Code harness (e.g. toolsets, prompts) should be reviewed by a human codeowner. The vast majority of PRs in this repo will not cross that threshold. Flagging humans for review should be done with great care - the bot that cried human eventually gets ignored, making flagging humans for review useless.

## Hotzones (will change over time - this is a living document)

- Code that adds new tools to the toolsets
- Code that changes the core prompting in the harness (e.g. the system prompt used) 
- Code that modifies the WS protocol (e.g. the protocol_v2 file)
  - Why? Because there are downstream dependencies for it that need to be carefully considered. Also, API design should generally be supervised by humans.
- Code that changes the NUX startup path
