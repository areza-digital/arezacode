import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { SystemContext } from "../../src/system-context/index"
import { SystemContextBuiltIns } from "../../src/system-context/builtins"
import { SystemContextRegistry } from "../../src/system-context/registry"
import { engineAction } from "../../src/util/native-command"
import { location } from "../fixture/location"

const directory = process.env.OPENCODE_TEST_HOME
if (!directory) throw new Error("Expected isolated test home")
await engineAction("context7", "disable")
await engineAction("ponytail", "disable")
await Effect.gen(function* () {
  const registry = yield* SystemContextRegistry.Service
  const initialized = yield* SystemContext.initialize(yield* registry.load())
  assert.match(initialized.baseline, /Context7 is disabled\./)
  assert.match(initialized.baseline, /Ponytail development guidance is disabled\./)
  const replaced = yield* SystemContext.replace(yield* registry.load(), initialized.snapshot)
  assert.equal(replaced._tag, "ReplacementReady")
  yield* Effect.promise(() => engineAction("context7", "enable"))
  yield* Effect.promise(() => engineAction("ponytail", "enable"))
  const enabled = yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)
  assert.equal(enabled._tag, "Updated")
  if (enabled._tag !== "Updated") throw new Error("Expected enabled guidance")
  assert.match(enabled.text, /context7_resolve_library_id/)
  assert.match(enabled.text, /Ponytail build and review workflow/)
  yield* Effect.promise(() => engineAction("context7", "disable"))
  yield* Effect.promise(() => engineAction("ponytail", "disable"))
  const disabled = yield* SystemContext.reconcile(yield* registry.load(), enabled.snapshot)
  assert.equal(disabled._tag, "Updated")
  if (disabled._tag !== "Updated") throw new Error("Expected disabled guidance")
  assert.match(disabled.text, /Context7 is disabled\./)
  assert.match(disabled.text, /Ponytail development guidance is disabled\./)
}).pipe(
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node]), [
      [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
    ]),
  ),
  Effect.scoped,
  Effect.runPromise,
)
