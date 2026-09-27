import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { GlobTool } from "../src/tool/glob"
import { GrepTool } from "../src/tool/grep"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

it.live("search leaves bound collection and disclose incomplete results while allowing narrower searches", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    yield* Effect.forEach(
      Array.from({ length: 1002 }, (_, index) => index),
      (index) => Effect.promise(() => fs.writeFile(path.join(tmp.path, `file-${index}.txt`), `needle ${index}\n`)),
      { concurrency: 16, discard: true },
    )
    const layer = AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node, GlobTool.node]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [
          PermissionV2.node,
          Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: () => Effect.void,
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          ),
        ],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const name of ["grep", "glob"]) {
        for (const [limit, count] of [
          [undefined, 100],
          [50, 50],
          [10_000, 1000],
        ] as const) {
          const settled = yield* settleTool(registry, {
            sessionID: SessionV2.ID.make("ses_search_limits"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: `${name}-${limit}`,
              name,
              input: { pattern: name === "grep" ? "needle" : "*.txt", limit },
            },
          })
          expect(settled.output?.structured).toHaveLength(count)
          expect(JSON.stringify(settled.output?.content)).toContain(`Result limit reached (${count})`)
        }
        const complete = yield* settleTool(registry, {
          sessionID: SessionV2.ID.make("ses_search_limits"),
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `${name}-narrow`,
            name,
            input: { pattern: name === "grep" ? "needle" : "file-0.txt", include: "file-0.txt" },
          },
        })
        expect(complete.output?.structured).toHaveLength(1)
        expect(JSON.stringify(complete.output?.content)).not.toContain("Result limit reached")
      }
      const external = yield* settleTool(registry, {
        sessionID: SessionV2.ID.make("ses_search_limits"),
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "reuse-external",
          name: "reuse_check",
          input: { target: "../outside.ts", query: "needle" },
        },
      })
      expect(external.result.type).toBe("error")
      expect(JSON.stringify(external.result)).toContain("source creation remains blocked")
    }).pipe(Effect.provide(layer))
  }),
)
