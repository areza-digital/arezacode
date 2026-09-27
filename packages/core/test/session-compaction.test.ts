import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { LLM, LLMEvent } from "@opencode-ai/llm"
import { configure } from "@opencode-ai/llm/providers/openai"
import { DateTime, Effect, Stream } from "effect"
import { it } from "./lib/effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
  expect(prompt).toContain("## Verification")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
  expect(SessionCompaction.serializeToolContent([], { exit: 1, stderr: "assertion failed" })).toBe(
    '{"exit":1,"stderr":"assertion failed"}',
  )
})

for (const reason of [
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "unknown",
  "eof",
  "provider-error",
  "late-text",
  "empty",
  "estimated",
  "disabled",
] as const) {
  it.effect(`compaction only commits a complete summary: ${reason}`, () =>
    Effect.gen(function* () {
      const published: string[] = []
      const accounting: unknown[] = []
      const events = EventV2.Service.of({
        transaction: (effect) => effect,
        publish: (definition, data) =>
          Effect.sync(() => {
            published.push(definition.type)
            if (definition.type === SessionEvent.Compaction.Accounted.type) accounting.push(data)
            return { id: EventV2.ID.create(), type: definition.type, data }
          }),
        subscribe: () => Stream.empty,
        all: () => Stream.empty,
        durable: () => Stream.empty,
        listen: () => Effect.succeed(Effect.void),
        project: () => Effect.void,
        replay: () => Effect.void,
        replayAll: () => Effect.succeed(undefined),
        remove: () => Effect.void,
        claim: () => Effect.void,
      })
      const model = configure({ limits: { context: 100_000, output: 4096 } }).chat("test")
      const text = LLMEvent.textDelta({ id: "summary", text: "Checkpoint" })
      const stream = [
        ...(reason === "empty" ? [] : [text]),
        ...(reason === "eof"
          ? []
          : [
              LLMEvent.finish({
                reason:
                  reason === "provider-error" ||
                  reason === "late-text" ||
                  reason === "empty" ||
                  reason === "estimated" ||
                  reason === "disabled"
                    ? "stop"
                    : reason,
                usage: {
                  inputTokens: 100,
                  outputTokens: 20,
                  cacheReadInputTokens: 50,
                  ...(reason === "estimated" ? {} : { cost: 0.01 }),
                },
              }),
            ]),
        ...(reason === "provider-error" ? [LLMEvent.providerError({ message: "failed" })] : []),
        ...(reason === "late-text" ? [text] : []),
      ]
      const compaction = SessionCompaction.make({
        events,
        config:
          reason === "disabled"
            ? [
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ compaction: new ConfigCompaction.Info({ auto: false }) }),
                }),
              ]
            : [],
        llm: {
          stream: () => {
            expect(reason).not.toBe("disabled")
            return Stream.fromIterable(stream)
          },
        },
      })
      const result = yield* compaction.compactAfterOverflow({
        sessionID: SessionV2.ID.make("ses_compaction_terminal"),
        model,
        request: LLM.request({ model, messages: [] }),
        prices: [{ input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }],
        entries: [
          {
            seq: 0,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_compaction_input"),
              type: "user",
              text: "Retain this original history. ".repeat(2000),
              time: { created: DateTime.makeUnsafe(0) },
            }),
          },
        ],
      })
      expect(result).toBe(reason === "stop" || reason === "estimated")
      if (reason === "disabled") {
        expect(accounting).toHaveLength(0)
        expect(published).toEqual([])
        return
      }
      expect(accounting).toHaveLength(1)
      if (reason === "length" || reason === "content-filter" || reason === "tool-calls")
        expect(accounting[0]).toMatchObject({ finish: reason })
      expect(accounting[0]).toMatchObject({
        usage:
          reason === "eof"
            ? { costSource: "unknown" }
            : {
                input: 100,
                output: 20,
                cacheRead: 50,
                cost: reason === "estimated" ? 0.00031 : 0.01,
                costSource: reason === "estimated" ? "estimated" : "reported",
              },
      })
      expect(published).toEqual(
        reason === "stop" || reason === "estimated"
          ? [
              SessionEvent.Compaction.Started.type,
              SessionEvent.Compaction.Accounted.type,
              SessionEvent.Compaction.Ended.type,
            ]
          : [SessionEvent.Compaction.Started.type, SessionEvent.Compaction.Accounted.type],
      )
    }),
  )
}
