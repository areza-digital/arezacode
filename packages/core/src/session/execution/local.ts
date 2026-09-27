import { Cause, DateTime, Deferred, Effect, Exit, Layer } from "effect"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionInput } from "../input"
import { SessionEvent } from "../event"
import { SessionInputTable, SessionTaskTable } from "../sql"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const stopping = new Map<SessionSchema.ID, { done: Deferred.Deferred<void>; wake: boolean }>()
    const completions = new Map<SessionSchema.ID, Set<{ interrupted: boolean }>>()
    yield* SessionInput.recoverTasks(db)
    const coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError> = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const task = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
        const continued = task?.status === "completed" && ((yield* SessionInput.hasPending(db, sessionID, "steer")) || (yield* SessionInput.hasPending(db, sessionID, "queue")))
        if (task && task.status !== "pending" && !continued && !(force && (task.status === "interrupted" || task.status === "failed"))) return
        if (force) {
          const inputs = yield* db.select().from(SessionInputTable).where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq))).all().pipe(Effect.orDie)
          for (const input of inputs) {
            if (!input.preparation || input.preparation.status === "completed" || input.preparation.status === "pending") continue
            yield* events.publish(SessionEvent.CommandPrepared, { sessionID, messageID: input.id, timestamp: DateTime.makeUnsafe(Date.now()), preparation: { command: input.preparation.command, status: "pending" } })
          }
        }
        if (task) yield* db.update(SessionTaskTable).set({ status: "running", owner: String(process.pid), attempt: sql`${SessionTaskTable.attempt} + 1`, output: null, error: null, result_input_id: null, time_updated: Date.now(), time_completed: null }).where(eq(SessionTaskTable.session_id, sessionID)).run().pipe(Effect.orDie)
        const completion = { interrupted: task ? stopping.has(task.parent_id) : false }
        if (task) {
          const pending = completions.get(task.parent_id) ?? new Set<typeof completion>()
          pending.add(completion)
          completions.set(task.parent_id, pending)
        }
        return yield* Effect.gen(function* () {
          const pending = yield* db.select().from(SessionTaskTable).where(and(eq(SessionTaskTable.parent_id, sessionID), eq(SessionTaskTable.status, "pending"))).all().pipe(Effect.orDie)
          for (const child of pending) yield* coordinator.wake(child.session_id)
          yield* SessionInput.deliverTasks(db, events, sessionID)
          return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.interruptible,
          Effect.onExit((exit) => Effect.gen(function* () {
            if (!task) return
            const context = yield* store.context(sessionID).pipe(Effect.orDie)
            const assistant = context.findLast((message) => message.type === "assistant")
            const output = assistant?.type === "assistant" ? assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : undefined
            yield* db.update(SessionTaskTable).set({ status: Exit.isSuccess(exit) ? assistant?.type === "assistant" && assistant.error ? "failed" : "completed" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed", output: Exit.isSuccess(exit) && !(assistant?.type === "assistant" && assistant.error) ? output ?? null : null, error: Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : assistant?.type === "assistant" ? assistant.error?.message ?? null : null, owner: null, time_updated: Date.now(), time_completed: Date.now() }).where(eq(SessionTaskTable.session_id, sessionID)).run().pipe(Effect.orDie)
            yield* SessionInput.deliverTasks(db, events, task.parent_id)
            if (
              !completion.interrupted &&
              !stopping.has(task.parent_id) &&
              (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause))
            )
              yield* coordinator.wake(task.parent_id)
          })),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (!task) return
              const pending = completions.get(task.parent_id)
              pending?.delete(completion)
              if (pending?.size === 0) completions.delete(task.parent_id)
            }),
          ),
        )
      }, Effect.uninterruptible),
    })

    const interrupt: (sessionID: SessionSchema.ID, parent?: boolean) => Effect.Effect<void> = Effect.fnUntraced(
      function* (sessionID, parent = false) {
        const existing = stopping.get(sessionID)
        if (existing) return yield* Deferred.await(existing.done)
        const fence = { done: Deferred.makeUnsafe<void>(), wake: false }
        stopping.set(sessionID, fence)
        completions.get(sessionID)?.forEach((completion) => {
          completion.interrupted = true
        })
        yield* Effect.gen(function* () {
          yield* coordinator.interrupt(sessionID)
          const children = yield* db
            .select()
            .from(SessionTaskTable)
            .where(and(eq(SessionTaskTable.parent_id, sessionID), sql`${SessionTaskTable.status} IN ('pending', 'running')`))
            .all()
            .pipe(Effect.orDie)
          for (const child of children) {
            yield* interrupt(child.session_id, true)
          }
          yield* db
            .update(SessionTaskTable)
            .set({
              status: "interrupted",
              owner: null,
              error: parent ? "Interrupted by parent" : "Interrupted",
              time_updated: Date.now(),
              time_completed: Date.now(),
            })
            .where(and(eq(SessionTaskTable.session_id, sessionID), sql`${SessionTaskTable.status} IN ('pending', 'running')`))
            .run()
            .pipe(Effect.orDie)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              stopping.delete(sessionID)
              if (fence.wake) yield* coordinator.wake(sessionID)
              yield* Deferred.succeed(fence.done, undefined)
            }),
          ),
        )
      },
      Effect.uninterruptible,
    )

    return SessionExecution.Service.of({
      withIdle: (keys, effect) =>
        Effect.suspend(() =>
          keys.some((key) => stopping.has(key)) ? Effect.succeed(false) : coordinator.withIdle(keys, effect),
        ),
      active: coordinator.active.pipe(Effect.map((active) => new Set([...active, ...stopping.keys()]))),
      interrupt,
      resume: (sessionID) =>
        Effect.suspend(() => {
          const fence = stopping.get(sessionID)
          return fence
            ? Deferred.await(fence.done).pipe(Effect.andThen(coordinator.run(sessionID)))
            : coordinator.run(sessionID)
        }),
      wake: (sessionID) =>
        Effect.suspend(() => {
          const fence = stopping.get(sessionID)
          if (!fence) return coordinator.wake(sessionID)
          fence.wake = true
          return Effect.void
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, Database.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"
