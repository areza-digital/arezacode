import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FileSystem } from "@opencode-ai/schema/filesystem"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { Sse } from "effect/unstable/encoding"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(Layer.mergeAll(LayerNode.compile(EventV2.node), httpApiLayer))

describe("event HttpApi", () => {
  it.instance(
    "current event stream ignores legacy deltas and continues delivering public events",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const events = yield* EventV2.Service
        const response = yield* requestInDirectory("/api/event", directory)
        const reader = yield* Queue.unbounded<string>()
        yield* response.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.runForEach((event) => Queue.offer(reader, event.data)),
          Effect.forkScoped,
        )
        const next = Queue.take(reader).pipe(
          Effect.timeout("5 seconds"),
          Effect.map((value) => JSON.parse(value)),
        )
        expect(yield* next).toMatchObject({ type: "server.connected" })
        yield* events.publish(SessionV1.Event.PartDelta, {
          sessionID: SessionV1.SessionInfo.fields.id.make("ses_event"),
          messageID: SessionV1.MessageID.make("msg_event"),
          partID: SessionV1.PartID.make("prt_event"),
          field: "text",
          delta: "ignored",
        })
        yield* events.publish(FileSystem.Event.Edited, { file: "first.txt" })
        yield* events.publish(FileSystem.Event.Edited, { file: "second.txt" })
        expect(yield* next).toMatchObject({ type: "file.edited", data: { file: "first.txt" } })
        expect(yield* next).toMatchObject({ type: "file.edited", data: { file: "second.txt" } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
