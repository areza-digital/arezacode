import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Ref, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionHealth } from "@opencode-ai/core/session/health"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionSchema.ID.make("ses_revert_context")
const original = SessionMessage.ID.make("msg_original")
const first = SessionMessage.ID.make("msg_first_task")
const second = SessionMessage.ID.make("msg_second_task")
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: "/project",
      slug: "test",
      title: "test",
      version: "test",
      metadata: { instructions: "Keep these instructions", approvalMode: "full" },
    })
    .run()
  const prompt = (id: SessionMessage.ID, time: number, independent = false) =>
    events.publish(SessionEvent.Prompted, {
      sessionID,
      messageID: id,
      timestamp: DateTime.makeUnsafe(time),
      delivery: independent ? "queue" : "steer",
      prompt: Prompt.make({ text: id, independent }),
    })
  yield* prompt(original, 1)
  return { db, events, prompt }
})

describe("revert context reconciliation", () => {
  it.effect("rebuilds current instructions after reverting their chronological update", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const instruction = yield* Ref.make("instruction A")
      const context = Effect.succeed(
        SystemContext.make({
          key: SystemContext.Key.make("test/instruction"),
          codec: Schema.toCodecJson(Schema.String),
          load: Ref.get(instruction),
          baseline: String,
          update: (_previous, current) => current,
        }),
      )
      yield* SessionContextEpoch.initialize(db, context, sessionID)
      yield* Ref.set(instruction, "instruction B")
      yield* SessionContextEpoch.prepare(db, events, context, sessionID)
      expect((yield* SessionHistory.load(db, sessionID)).map((message) => message.type)).toEqual(["user", "system"])

      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: original,
        timestamp: DateTime.makeUnsafe(3),
      })

      expect(yield* db.select().from(SessionContextEpochTable).all()).toEqual([])
      const initialized = yield* SessionContextEpoch.initialize(db, context, sessionID)
      const prepared = yield* SessionContextEpoch.prepare(db, events, context, sessionID, initialized)
      expect(prepared.baseline).toContain("instruction B")
      expect(prepared.baseline).not.toContain("instruction A")
      expect(
        (yield* SessionHistory.loadForRunner(db, sessionID, prepared.baselineSeq)).map((message) => message.id),
      ).toEqual([original])
    }),
  )
  ;([original, first, second] as const).forEach((boundary) => {
    it.effect(`restores the surviving task and its lock when reverting to ${boundary}`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* fixture.prompt(first, 2, true)
        yield* fixture.prompt(second, 3, true)
        yield* SessionHealth.observe(fixture.db, sessionID, { inputTokens: 250_000 })

        yield* fixture.events.publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: boundary,
          timestamp: DateTime.makeUnsafe(4),
        })

        const taskID = boundary === original ? null : boundary
        expect(yield* SessionHealth.taskID(fixture.db, sessionID)).toBe(taskID)
        expect((yield* SessionHistory.taskBoundary(fixture.db, sessionID))?.id ?? null).toBe(taskID)
        expect((yield* SessionHealth.get(fixture.db, sessionID)).locked).toBe(boundary === second)
        const session = yield* fixture.db.select().from(SessionTable).get()
        expect(session?.metadata).toMatchObject({ instructions: "Keep these instructions", approvalMode: "full" })
        expect(session?.metadata?.contextStart).toEqual(
          taskID ? { messageID: taskID, time: boundary === first ? 2 : 3 } : undefined,
        )
        expect((yield* SessionHistory.load(fixture.db, sessionID)).map((message) => message.id)).toEqual([boundary])
      }),
    )
  })

  it.effect("rolls back transcript, task identity and epoch together if revert projection fails", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.prompt(first, 2, true)
      yield* SessionContextEpoch.initialize(fixture.db, Effect.succeed(SystemContext.empty), sessionID)
      const before = {
        messages: yield* fixture.db.select().from(SessionMessageTable).all(),
        epoch: yield* fixture.db.select().from(SessionContextEpochTable).all(),
        session: yield* fixture.db.select().from(SessionTable).all(),
      }
      yield* fixture.events.project(SessionEvent.RevertEvent.Committed, () => Effect.die("projection failed"))

      const result = yield* fixture.events
        .publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: original,
          timestamp: DateTime.makeUnsafe(3),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* fixture.db.select().from(SessionMessageTable).all()).toEqual(before.messages)
      expect(yield* fixture.db.select().from(SessionContextEpochTable).all()).toEqual(before.epoch)
      expect(yield* fixture.db.select().from(SessionTable).all()).toEqual(before.session)
    }),
  )
})
