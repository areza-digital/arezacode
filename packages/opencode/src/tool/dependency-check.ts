import { Effect } from "effect"
import { checkProjectDependencies, Input, workflow } from "@opencode-ai/core/project-dependencies"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

export const DependencyCheckTool = Tool.define(
  "dependency_check",
  Effect.succeed({
    description: workflow,
    parameters: Input,
    execute: (_input, ctx) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        yield* ctx.ask({
          permission: "dependency_check",
          patterns: [instance.directory],
          always: [instance.directory],
          metadata: { directory: instance.directory },
        })
        const result = yield* Effect.promise((signal) =>
          checkProjectDependencies(instance.directory, AbortSignal.any([signal, ctx.abort])),
        )
        return { title: "Project dependencies", output: JSON.stringify(result), metadata: { status: result.status } }
      }),
  }),
)
