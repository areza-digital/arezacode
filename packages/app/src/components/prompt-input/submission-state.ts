import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"
import { unwrap } from "solid-js/store"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  const revision = (value: PromptTarget) =>
    JSON.stringify([value.current(), value.context.items(), value.model.current()])
  const original = revision(initial)
  const originalPrompt = initial.current()
  const prompt = structuredClone(unwrap(input.prompt))
  const context = structuredClone(unwrap(input.context))
  let target = input.target
  let expected = original
  let expectedPrompt = originalPrompt
  let cleared: string | undefined
  let clearedPrompt: Prompt | undefined
  const unchanged = () => initial.current() === originalPrompt && revision(initial) === original

  return {
    prompt,
    context,
    target: () => target,
    unchanged,
    clear() {
      if (initial !== target && unchanged()) initial.reset()
      if (target.current() !== expectedPrompt || revision(target) !== expected) return false
      target.reset()
      clearedPrompt = target.current()
      cleared = JSON.stringify(target.current())
      return true
    },
    retarget(next: PromptTarget) {
      context.forEach(next.context.add)
      target = next
      expected = revision(target)
      expectedPrompt = target.current()
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (target.current() !== (clearedPrompt ?? expectedPrompt)) return
      if (cleared === undefined ? revision(target) !== expected : JSON.stringify(target.current()) !== cleared) return
      return { target, prompt, context }
    },
  }
}
