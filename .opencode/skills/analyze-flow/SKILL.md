---
name: analyze-flow
description: Trace and explain a user journey, interaction, or feature flow as a plain-language walkthrough and viewable wireframe, with a second technical stage. Use when asked to analyze a flow, explain what happens when a user clicks or logs in, or map a journey through this project.
---

# Analyze a flow

1. Clarify the starting action, goal, and relevant project. Follow the existing UI from the entry point through its state and backend owners. Read real handlers, navigation, loading/error branches, APIs and motion; do not invent screens, transitions or behavior. If a branch cannot be verified, label it unknown.
2. Create **one** Markdown file in `flows/<short-name>.flow.md` inside the active project. Create the folder if it does not exist. Use a short, descriptive filename and update that same file if the user refines the flow. A successful write or patch in the active session opens the existing right sidebar at that file; if it does not open, tell the user the path so they can open it manually.
3. Use the exact sections below, in order. The first stage is for someone who has never seen the code: numbered actions in everyday words using `->` to show what follows. Include what the user sees, where they click, what happens next, alternatives, and errors. Do not use internal names, filenames, APIs or acronyms in this stage. The second stage matches the same numbered steps and gives exact file paths with line references, relevant components, state, endpoints, animations and response/error paths. Omit an implementation detail rather than guess.
4. End with `## Wireframe`. It drives the sidebar Wireframe tab, using Markdown boxes (`>`), numbered scenes and `->` arrows to show screen, user action, result and choices. Keep it readable without technical knowledge. Include failure or back paths where they exist. Do not describe source modules in the wireframe.
5. Inspect the finished file against the source and the user's question. The wireframe and both stages must describe the same sequence. Do not claim a browser walkthrough unless it was performed. Respect the user's browser-verification preference.

## For everyone

1. **Start:** The person opens the sign-in screen.
   -> They see the email and password fields.
2. **Continue:** They enter their details and press Sign in.
   -> They see a loading state while the app checks the details.
3. **Result:** If the details match, they reach their account. If not, they see an error and can try again.

## Technical details

1. **Start:** `src/...:42` mounts the sign-in form; describe only verified behavior.
2. **Continue:** `src/...:73` submits to the verified API; mention real loading state and animation if present.
3. **Result:** `src/...:96` handles success and failure; include navigation and state ownership.

## Wireframe

> **1. Sign in**
> Email and password fields
> Press Sign in -> 2. Checking details

> **2. Checking details**
> Loading state
> Accepted -> 3. Your account
> Rejected -> 4. Try again

> **3. Your account**
> Account opens

> **4. Try again**
> Error appears
> Edit details -> 1. Sign in

Replace the example completely with observed project behavior. The example is a format, not evidence that this project has a sign-in screen.
