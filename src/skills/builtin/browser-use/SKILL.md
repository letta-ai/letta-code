---
name: browser-use
description: Control a rendered web browser to navigate, inspect pages, click, type, fill forms, test interactions, capture screenshots, or record demos. Load when the user asks to use or automate a browser, interact with a rendered website, test browser behavior, or provide visual browser proof.
---

# Browser Use

Use the browser capability that actually exists in the current execution
environment. Browser capabilities are environment-scoped: after moving between
computers, ignore earlier availability claims and inspect the current tools,
skills, installed applications, and project dependencies again.

## Choose the control path

Prefer the first suitable option:

1. **Environment-provided browser or GUI controller.** Use a dedicated browser,
   computer-use, or GUI capability when one is currently available. Follow its
   instructions; environment-specific skills with this same name override this
   bundled fallback.
2. **Existing project automation.** Use Playwright, Puppeteer, Selenium, or the
   project's established browser test framework when it is already installed.
   Reuse its configuration, browser choice, fixtures, and artifact paths.
3. **Installed browser automation.** Use an installed automation library or
   driver that supports the requested browser.
4. **Raw CDP fallback.** For Chrome, Chromium, Edge, or Brave, launch a
   disposable profile with a loopback Chrome DevTools Protocol endpoint. Read
   [references/cdp.md](references/cdp.md) before implementing a raw client.

Do not substitute `curl`, backend requests, static source inspection, or a
component render when the requested behavior depends on a real rendered page.
Those methods can support diagnosis but do not prove browser behavior.

## Respect browser and visibility requirements

- Honor an explicitly requested browser. CDP is Chromium-only; use Playwright,
  Selenium/WebDriver, or visible GUI control for Firefox, Safari, or WebKit.
- Treat “open,” “show,” “use my browser,” “watch,” and “take over” as visible
  browser requests. Leave the relevant window open when the user needs to
  inspect or take over.
- Use headless mode for background tests, CI, extraction, screenshots, or PDFs
  when visibility and handoff do not matter.
- Do not claim control of the user's existing browser merely because a browser
  is installed. Verify that the selected controller can reach the exact window
  or launch a separate controlled window.
- Use a disposable profile by default. Attach to the user's normal profile only
  when explicitly requested and supported safely by the selected controller.
- Do not change OS or browser configuration, enable remote automation, install
  system packages, or download a large browser binary without explaining the
  change first. Prefer an already installed browser.

## Workflow

1. Establish the active computer, OS, working directory, and available browser
   capabilities. Do not reuse paths or processes from another environment.
2. Identify whether the user needs a particular browser, an existing signed-in
   session, visible interaction, background automation, or visual evidence.
3. Select one control path and one browser instance. Avoid parallel automation
   stacks or hidden windows that the user cannot inspect.
4. Inspect the rendered state before acting. Locate controls by accessible
   name, label, role, text, stable ID, or placeholder rather than brittle child
   indexes or generated classes.
5. Act through the selected browser controller. Use real input events for the
   interaction being tested; use direct DOM evaluation for inspection and
   deterministic setup only.
6. Wait for observable state—URL, element state, text, network completion, or a
   browser event—instead of relying on fixed sleeps.
7. Verify the outcome in the rendered browser. For visual work, capture and
   inspect a screenshot or recording before claiming completion.
8. Clean up temporary profiles, drivers, sockets, and background browser
   processes. Preserve a visible handoff window when requested.

## Engine guidance

### Chromium family

Chrome, Chromium, Edge, and Brave support CDP. Prefer an existing Playwright or
Puppeteer setup; otherwise use the raw CDP fallback. Bind debugging endpoints
to `127.0.0.1`, use a dedicated profile, and select the page target by URL or
title rather than assuming the first target is correct.

### Firefox

Use an existing Playwright, Selenium, or WebDriver setup, or visible GUI
control. Do not send CDP commands to Firefox or silently replace it with
Chromium when Firefox behavior is the subject of the task.

### Safari and WebKit

Use the project's WebKit automation when engine compatibility is sufficient.
Use Safari itself only through an already configured Safari/WebDriver or GUI
path. Enabling `safaridriver`, Remote Automation, or Develop-menu settings is a
configuration change and requires user approval.

## Evidence and failures

- A successful automation command is not proof that the page reached the
  intended state. Verify the state that matters.
- Report the actual browser and control path used. Distinguish a WebKit test
  build from Safari and Chromium from Google Chrome.
- If the requested browser or controller is unavailable, state that directly.
  Do not fabricate browser output or weaken the task into plain HTTP without
  saying so.
- For deterministic CDP video recording, read
  [references/recording.md](references/recording.md).

## Safety

Browser automation acts with the authority of the controlled profile.

- Stay within the requested origins and workflow.
- Do not inspect unrelated tabs, history, cookies, saved passwords, tokens, or
  profile data.
- Do not submit purchases, publish content, send messages, delete data, or
  accept consequential dialogs without explicit authorization.
- Never print credentials, cookies, authorization headers, or sensitive page
  bodies into logs or the conversation.

