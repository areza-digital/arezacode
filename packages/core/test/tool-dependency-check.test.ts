import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { DependencyCheckTool } from "../src/tool/dependency-check"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

it.live("exposes the shared dependency check and enforces permission before scanning", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const assertions: PermissionV2.AssertInput[] = []
    let deny = false
    const permission = Layer.succeed(
      PermissionV2.Service,
      PermissionV2.Service.of({
        assert: (input) =>
          Effect.suspend(() => {
            assertions.push(input)
            return deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void
          }),
        ask: () => Effect.die("unused"),
        reply: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        forSession: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
      }),
    )
    const layer = AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, DependencyCheckTool.node]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      expect(definitions.map((tool) => tool.name)).toEqual(["dependency_check"])
      expect(definitions[0].description).toContain("first use dependency_check")
      const run = () =>
        executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_dependency_check"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call-dependencies", name: "dependency_check", input: {} },
        })
      const result = yield* run()
      expect(result).toEqual({ type: "json", value: { status: "noPackage" } })
      expect(assertions).toMatchObject([
        {
          action: "dependency_check",
          resources: [tmp.path],
          source: { type: "tool", callID: "call-dependencies" },
        },
      ])
      deny = true
      expect((yield* run()).type).toBe("error")
    }).pipe(Effect.provide(layer))
  }),
)
