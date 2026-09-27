import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable, SessionTaskTable } from "@opencode-ai/core/session/sql"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionExecutionLocal cancellation", () => {
  ;(["none", "wake", "resume", "child-resume", "late-completion"] as const).forEach((followup) => {
    it.live(
      `fences child completion during cancellation and preserves ${followup} followup`,
      () =>
        Effect.gen(function* () {
          const dir = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
          )
          const parent = SessionSchema.ID.make("ses_cancel_parent")
          const first = SessionSchema.ID.make("ses_cancel_first")
          const second = SessionSchema.ID.make("ses_cancel_second")
          const started = yield* Deferred.make<void>()
          const firstStarted = yield* Deferred.make<void>()
          const secondStarted = yield* Deferred.make<void>()
          const cleanupStarted = yield* Deferred.make<void>()
          const cleanupRelease = yield* Deferred.make<void>()
          const secondRelease = yield* Deferred.make<void>()
          const delivering = yield* Deferred.make<void>()
          const deliveryRelease = yield* Deferred.make<void>()
          const restarted = yield* Deferred.make<void>()
          const childRestarted = yield* Deferred.make<void>()
          const parentRuns: SessionSchema.ID[] = []
          const childRuns: SessionSchema.ID[] = []
          const runner = Layer.succeed(
            SessionRunner.Service,
            SessionRunner.Service.of({
              run: ({ sessionID }) => {
                if (sessionID === parent)
                  return Effect.sync(() => parentRuns.push(sessionID)).pipe(
                    Effect.flatMap((count) => Deferred.succeed(count === 1 ? started : restarted, undefined)),
                    Effect.andThen(Effect.never),
                  )
                if (sessionID === first)
                  return Effect.sync(() => childRuns.push(sessionID)).pipe(
                    Effect.flatMap((count) => Deferred.succeed(count === 1 ? firstStarted : childRestarted, undefined)),
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupRelease))),
                    ),
                  )
                return Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondRelease)))
              },
            }),
          )
          const layer = AppNodeBuilder.build(
            LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionExecutionLocal.node]),
            [
              [
                Global.node,
                Layer.succeed(Global.Service, Global.make({ home: dir.path, config: `${dir.path}/config` })),
              ],
              [node, runner],
            ],
          )

          yield* Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const events = yield* EventV2.Service
            const execution = yield* SessionExecution.Service
            if (followup === "late-completion")
              yield* events.listen((event) =>
                event.type === SessionEvent.PromptAdmitted.type &&
                Schema.is(SessionEvent.PromptAdmitted.data)(event.data) &&
                event.data.prompt.text.startsWith(`Subtask ${second}`)
                  ? Deferred.succeed(delivering, undefined).pipe(Effect.andThen(Deferred.await(deliveryRelease)))
                  : Effect.void,
              )
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir.path), sandboxes: [] })
              .run()
            yield* db
              .insert(SessionTable)
              .values(
                [parent, first, second].map((id) => ({
                  id,
                  project_id: Project.ID.global,
                  directory: dir.path,
                  slug: id,
                  title: id,
                  version: "test",
                })),
              )
              .run()
            const messageID = SessionMessage.ID.make("msg_cancel_parent")
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: parent,
              messageID,
              timestamp: DateTime.makeUnsafe(1),
              delivery: "steer",
              prompt: Prompt.make({ text: "parent task" }),
            })
            yield* db
              .insert(SessionTaskTable)
              .values(
                [first, second].map((id) => ({
                  session_id: id,
                  parent_id: parent,
                  input_id: messageID,
                  status: "pending" as const,
                  time_created: 1,
                  time_updated: 1,
                })),
              )
              .run()
            yield* execution.wake(parent)
            yield* Deferred.await(started)
            yield* Deferred.await(firstStarted)
            yield* Deferred.await(secondStarted)
            if (followup === "late-completion") {
              yield* Deferred.succeed(secondRelease, undefined)
              yield* Deferred.await(delivering)
            }
            const stopping = yield* execution.interrupt(parent).pipe(Effect.forkChild)
            yield* Deferred.await(cleanupStarted)
            if (followup !== "late-completion") {
              yield* Deferred.succeed(secondRelease, undefined)
              while ((yield* execution.active).has(second)) yield* Effect.yieldNow
            }
            expect(parentRuns).toHaveLength(1)
            expect((yield* execution.active).has(parent)).toBe(true)
            expect(yield* execution.withIdle([parent], Effect.void)).toBe(false)

            const resumed = followup === "resume" ? yield* execution.resume(parent).pipe(Effect.forkChild) : undefined
            const childResumed =
              followup === "child-resume" ? yield* execution.resume(first).pipe(Effect.forkChild) : undefined
            if (followup === "wake") {
              yield* SessionInput.admit(db, events, {
                sessionID: parent,
                id: SessionMessage.ID.make("msg_followup"),
                delivery: "steer",
                prompt: Prompt.make({ text: "new user work" }),
              })
              yield* execution.wake(parent)
            }
            yield* Effect.yieldNow
            expect(parentRuns).toHaveLength(1)
            yield* Deferred.succeed(cleanupRelease, undefined)
            yield* Fiber.join(stopping)
            if (childResumed) {
              yield* Deferred.await(childRestarted)
              expect(childRuns).toHaveLength(2)
              expect(
                (yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, first)).get())?.status,
              ).toBe("running")
              expect(parentRuns).toHaveLength(1)
              yield* Fiber.interrupt(childResumed)
              yield* execution.interrupt(first)
              expect(yield* execution.active).toEqual(new Set())
              return
            }
            if (followup === "late-completion") {
              yield* Deferred.succeed(deliveryRelease, undefined)
              while ((yield* execution.active).has(second)) yield* Effect.yieldNow
              expect(parentRuns).toHaveLength(1)
              expect(yield* execution.active).toEqual(new Set())
              yield* execution.wake(parent)
            }
            if (followup === "none") {
              expect(parentRuns).toHaveLength(1)
              expect(yield* execution.active).toEqual(new Set())
              return
            }
            yield* Deferred.await(restarted)
            expect(parentRuns).toHaveLength(2)
            if (resumed) yield* Fiber.interrupt(resumed)
            yield* execution.interrupt(parent)
            expect(yield* execution.active).toEqual(new Set())
          }).pipe(
            Effect.ensuring(Deferred.succeed(cleanupRelease, undefined)),
            Effect.ensuring(Deferred.succeed(secondRelease, undefined)),
            Effect.ensuring(Deferred.succeed(deliveryRelease, undefined)),
            Effect.scoped,
            Effect.provide(layer),
          )
        }),
      15000,
    )
  })
})
