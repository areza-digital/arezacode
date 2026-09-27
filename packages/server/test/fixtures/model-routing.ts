import assert from "node:assert/strict"
import { spyOn } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Catalog } from "@opencode-ai/core/catalog"
import { Jev } from "@opencode-ai/core/jev"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { JevGroup } from "@opencode-ai/protocol/groups/jev"
import { ModelGroup } from "@opencode-ai/protocol/groups/model"
import { ServerAuth } from "../../src/auth"
import { JevHandler } from "../../src/handlers/jev"
import { ModelHandler } from "../../src/handlers/model"
import { LocationMiddleware } from "../../src/location"
import { authorizationLayer } from "../../src/middleware/authorization"
import { schemaErrorLayer } from "../../src/middleware/schema-error"

const seen: Parameters<typeof Jev.prepare>[1][] = []
const prepare = spyOn(Jev, "prepare").mockImplementation(async (_, candidates) => {
  seen.push(candidates)
  return { status: "ready", skills: [] }
})

try {
  const program = Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const ref = Location.Ref.make({ directory: AbsolutePath.make(process.env.OPENCODE_TEST_HOME!) })
    const services = yield* Layer.build(locations.get(ref))
    const expected = ["openai", "anthropic", "openrouter", "compatible", "text-only", "no-tools", "deprecated"]
    yield* Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((editor) => {
        editor.provider.list().forEach((record) => editor.provider.remove(record.provider.id))
        for (const [id, packageName, url] of [
          ["google", "@ai-sdk/google"],
          ["openai", "@ai-sdk/openai"],
          ["anthropic", "@ai-sdk/anthropic"],
          ["openrouter", "@ai-sdk/google"],
          ["compatible", "@ai-sdk/openai-compatible", "https://compatible.example/v1"],
          ["missing-url", "@ai-sdk/openai-compatible"],
          ["empty-url", "@ai-sdk/openai-compatible", ""],
          ["text-only", "@ai-sdk/openai"],
          ["no-tools", "@ai-sdk/openai"],
          ["deprecated", "@ai-sdk/openai"],
          ["disabled", "@ai-sdk/openai"],
        ]) {
          const providerID = ProviderV2.ID.make(id)
          editor.provider.update(providerID, (provider) => {
            provider.api = { type: "aisdk", package: packageName, url }
            provider.request.body.apiKey = "test-only-not-a-real-key"
          })
          editor.model.update(providerID, ModelV2.ID.make(id), (model) => {
            model.api = { type: "aisdk", package: packageName, url, id: ModelV2.ID.make(id) }
            model.enabled = id !== "disabled"
            model.status = id === "deprecated" ? "deprecated" : "active"
            model.capabilities.tools = id !== "no-tools"
            model.capabilities.input = id === "text-only" ? ["text"] : ["text", "image"]
            model.variants = ["low", "high"].map((variant) => ({
              id: ModelV2.VariantID.make(variant),
              body: {},
              headers: {},
            }))
            model.request.variant = ModelV2.VariantID.make("high")
          })
        }
      })
      assert.ok((yield* catalog.model.available()).some((model) => model.providerID === "google"))
      assert.ok((yield* catalog.model.available()).some((model) => model.providerID === "missing-url"))
    }).pipe(Effect.provide(services))

    const web = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(HttpApi.make("server").add(ModelGroup).add(JevGroup)).pipe(
        Layer.provide(Layer.merge(ModelHandler, JevHandler)),
        Layer.provide(
          Layer.succeed(
            LocationMiddleware,
            LocationMiddleware.of((effect) => Effect.provide(effect, services)),
          ),
        ),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() })),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
    const response = yield* Effect.promise(() =>
      web.handler(new Request(`http://localhost/api/model?location[directory]=${encodeURIComponent(ref.directory)}`)),
    )
    assert.equal(response.status, 200)
    const listed = yield* Effect.promise(() => response.json())
    assert.deepEqual(listed.data.map((model: { providerID: string }) => model.providerID).sort(), expected.sort())
    for (const images of [false, true]) {
      const routed = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/api/jev/prepare?location[directory]=${encodeURIComponent(ref.directory)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: "routes",
              text: "Inspect code",
              agent: "build",
              auto: true,
              images,
              models: [],
            }),
          }),
        ),
      )
      assert.equal(routed.status, 200)
      assert.deepEqual(
        [...new Set(seen.at(-1)!.models.map((model) => model.providerID))].sort(),
        ["openai", "anthropic", "openrouter", "compatible", ...(images ? [] : ["text-only"])].sort(),
      )
      const variants = seen.at(-1)!.models.filter((model) => model.providerID === "openai")
      assert.deepEqual(
        variants.map((model) => model.variant),
        [undefined, "low", "high"],
      )
      assert.deepEqual(
        variants.map((model) => model.reasoningEffort),
        ["high", "low", "high"],
      )
      assert.equal(new Set(variants.map((model) => model.description)).size, 1)
    }
  })
  await Effect.runPromise(program.pipe(Effect.provide(AppNodeBuilder.build(LocationServiceMap.node)), Effect.scoped))
} finally {
  prepare.mockRestore()
}
