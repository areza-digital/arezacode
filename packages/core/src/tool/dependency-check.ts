export * as DependencyCheckTool from "./dependency-check"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { checkProjectDependencies, Input, Output, workflow } from "../project-dependencies"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "dependency_check"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: workflow,
          input: Input,
          output: Output,
          execute: (_input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [location.directory],
                save: [location.directory],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* Effect.tryPromise({
                try: (signal) => checkProjectDependencies(location.directory, signal),
                catch: () => new ToolFailure({ message: "Unable to check project dependencies" }),
              })
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/dependency-check",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node],
})
