import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Logger, References, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { schemaErrorReason } from "@opencode-ai/server/schema-error"
import { schemaErrorLayer, SchemaErrorMiddleware } from "@opencode-ai/server/middleware/schema-error"
import { testEffect } from "../lib/effect"

const legacy = await import("../../src/server/routes/instance/httpapi/middleware/schema-error")

for (const entry of [
  { name: "current", middleware: SchemaErrorMiddleware, layer: schemaErrorLayer },
  { name: "legacy", middleware: legacy.SchemaErrorMiddleware, layer: legacy.schemaErrorLayer },
]) {
  const logs: unknown[] = []
  const Api = HttpApi.make(`privacy-${entry.name}`).add(
    HttpApiGroup.make("credential")
      .add(
        HttpApiEndpoint.post("set", "/credential", {
          payload: Schema.Union([
            Schema.Struct({ type: Schema.Literal("key"), key: Schema.String }),
            Schema.Struct({ type: Schema.Literal("oauth"), access: Schema.String }),
          ]),
          success: Schema.Boolean,
        }),
      )
      .middleware(entry.middleware),
  )
  const handlers = HttpApiBuilder.group(Api, "credential", (handlers) =>
    handlers.handle("set", () => Effect.die("Invalid credentials reached the handler")),
  )
  const it = testEffect(
    HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(entry.layer)), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push({ message: options.message, annotations: options.fiber.getRef(References.CurrentLogAnnotations) })
          }),
        ]),
      ),
    ),
  )

  it.live(`${entry.name} credential validation omits rejected values from responses and logs`, () =>
    Effect.gen(function* () {
      const marker = "credential-canary-not-a-secret"
      for (const payload of [{ type: "key", key: [marker] }, { type: "unknown", key: marker }, [marker]]) {
        const response = yield* HttpClientRequest.post("/credential").pipe(
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClient.execute,
        )
        expect(response.status).toBe(400)
        const body = yield* response.text
        expect(body).toContain("Invalid value")
        expect(body).not.toContain(marker)
      }
      expect(logs.length).toBeGreaterThan(0)
      if (entry.name === "current")
        expect(logs).toContainEqual(
          expect.objectContaining({
            annotations: expect.objectContaining({ reason: expect.stringContaining("Invalid value") }),
          }),
        )
      expect(JSON.stringify(logs)).toContain("schema rejection")
      expect(JSON.stringify(logs)).not.toContain(marker)
    }),
  )

  it.effect(`${entry.name} validation preserves field paths without formatting input values`, () =>
    Effect.gen(function* () {
      const error = yield* Schema.decodeUnknownEffect(Schema.Struct({ key: Schema.String }))({ key: ["canary"] }).pipe(
        Effect.flip,
      )
      expect(schemaErrorReason(error)).toBe("Invalid value at key")
    }),
  )
}
