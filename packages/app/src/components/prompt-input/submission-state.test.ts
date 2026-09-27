import { expect, test } from "bun:test"
import { createPromptState } from "@/context/prompt-state"
import { createPromptSubmissionState } from "./submission-state"

test("submission preserves edits made before creation finishes", () => {
  const target = createPromptState({ prompt: "submitted" })
  const submission = createPromptSubmissionState({ target, prompt: target.current(), context: [] })
  target.set([{ type: "text", content: "newer draft", start: 0, end: 11 }])
  expect(submission.unchanged()).toBe(false)
  expect(submission.clear()).toBe(false)
  expect(submission.restore()).toBeUndefined()
  expect(target.current()[0]).toMatchObject({ content: "newer draft" })
  expect(submission.prompt[0]).toMatchObject({ content: "submitted" })
})

test("submission snapshots in-place edits and preserves new context", () => {
  const target = createPromptState({ prompt: "submitted" })
  const submission = createPromptSubmissionState({ target, prompt: target.current(), context: [] })
  target.store[1]("prompt", 0, { type: "text", content: "edited", start: 0, end: 6 })
  target.context.add({ type: "file", path: "new.ts" })
  expect(submission.clear()).toBe(false)
  expect(target.store[0]().context.items).toHaveLength(1)
  expect(submission.prompt[0]).toMatchObject({ content: "submitted" })
})

test("retargeted failure restores only the originating session", () => {
  const draft = createPromptState({ prompt: "submitted" })
  const session = createPromptState()
  const sibling = createPromptState({ prompt: "sibling" })
  const submission = createPromptSubmissionState({ target: draft, prompt: draft.current(), context: [] })
  submission.retarget(session)
  expect(submission.clear()).toBe(true)
  const restored = submission.restore()!
  restored.target.set(restored.prompt)
  expect(draft.current()[0]).toMatchObject({ content: "" })
  expect(session.current()[0]).toMatchObject({ content: "submitted" })
  expect(sibling.current()[0]).toMatchObject({ content: "sibling" })
  session.set([{ type: "text", content: "new followup", start: 0, end: 12 }])
  expect(submission.restore()).toBeUndefined()
})

test("clearing a newer edit back to empty does not resurrect a failed submission", () => {
  const target = createPromptState({ prompt: "submitted" })
  const submission = createPromptSubmissionState({ target, prompt: target.current(), context: [] })
  submission.clear()
  target.set([{ type: "text", content: "new draft", start: 0, end: 9 }])
  target.reset()
  expect(submission.restore()).toBeUndefined()
})
