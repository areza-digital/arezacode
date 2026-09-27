export * as UiVerification from "./ui-verification"

import { Jev } from "./jev"
import { UiPolicy } from "./ui-policy"

export type Snapshot = { revision?: string; files: Map<string, string> }
export type Evidence = { id: string; tool: string; input: string; output: string; visual: boolean; ok: boolean }
export type Context = { promptID: string; requests: string[]; tools: Evidence[]; response: string }

export function create(sessionID: string, initial: Snapshot | undefined, review = Jev.reviewUI) {
  let previous = initial
  let promptID = ""
  let attempts = 0
  let notice = ""
  let context: Context = { promptID: "", requests: [], tools: [], response: "" }
  const changed = new Set<string>()
  const seen = new Set<string>()
  const evidence = new Map<string, Evidence>()
  return {
    observe(current: Snapshot | undefined, next: Context) {
      if (promptID !== next.promptID) {
        promptID = next.promptID
        attempts = 0
      }
      context = next
      const updates =
        current && previous
          ? [...new Set([...previous.files.keys(), ...current.files.keys()])].filter(
              (name) => UiPolicy.applies(name) && previous!.files.get(name) !== current.files.get(name),
            )
          : []
      updates.forEach((name) => changed.add(name))
      if (current && initial)
        for (const name of changed) if (current.files.get(name) === initial.files.get(name)) changed.delete(name)
      if (updates.length) evidence.clear()
      for (const item of next.tools) {
        if (!updates.length && !seen.has(item.id)) evidence.set(item.id, item)
        seen.add(item.id)
      }
      while (evidence.size > 24) evidence.delete(evidence.keys().next().value!)
      previous = current
      if (updates.length)
        notice =
          "UI completion requires fresh visual evidence after the latest edit, exercised affected states, comparison with the existing component, and verification of the actual requested target. Preserve product language and scoped preferences. Tests/builds alone are insufficient. Use permitted tools; never bypass a user's manual-only preference. If verification is unavailable, report the concrete blocker without claiming completion."
    },
    guidance() {
      return notice
    },
    async check(canRetry = true, problem = "") {
      if (!changed.size && !problem) {
        notice = ""
        return { status: "pass" as const, notice }
      }
      const missing = problem
        ? [problem]
        : !previous
          ? ["The current checkout could not be inspected."]
          : ![...evidence.values()].some((item) => item.ok && item.visual)
            ? [
                "No successful visual tool result was recorded after the latest UI edit. Capture and inspect the affected UI in the actual target.",
              ]
            : await review(sessionID, {
                requests: context.requests.slice(-8),
                files: [...changed],
                tools: [
                  ...context.tools
                    .filter(
                      (item) => item.ok && /^(?:read|grep|glob|reuse_check)$/.test(item.tool) && !evidence.has(item.id),
                    )
                    .slice(-4),
                  ...evidence.values(),
                ],
                response: context.response,
              }).catch(() => ["The UI verification review failed."])
      if (!missing.length) {
        notice = ""
        return { status: "pass" as const, notice }
      }
      notice = `UI verification incomplete: ${missing.join(" ")} Correct the missing checks before claiming completion. Do not substitute a manual checklist or change unrelated code.`
      return { status: canRetry && attempts++ < 2 ? ("retry" as const) : ("blocked" as const), notice }
    },
  }
}
