import { Jev } from "@opencode-ai/core/jev"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { SkillV2 } from "@opencode-ai/core/skill"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const JevHandler = HttpApiBuilder.group(Api, "server.jev", (handlers) =>
  handlers
    .handle("jev.get", () => Effect.promise(() => Jev.status()))
    .handle("jev.update", (ctx) => Effect.promise(() => Jev.update(ctx.payload)))
    .handle(
      "jev.prepare",
      Effect.fn(function* (ctx) {
        const agents = yield* AgentV2.Service
        const skills = yield* SkillV2.Service
        const catalog = yield* Catalog.Service
        const agent = yield* agents.resolve(ctx.payload.agent)
        const available = agent
          ? (yield* skills.list()).filter(
              (skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect === "allow",
            )
          : []
        const models = (yield* catalog.model.available()).filter(
          (model) =>
            SessionRunnerModel.supported(model) &&
            model.enabled &&
            model.capabilities.tools &&
            model.status !== "deprecated" &&
            (!ctx.payload.images || model.capabilities.input.includes("image")),
        )
        return yield* Effect.promise(() =>
          Jev.prepare(ctx.payload, {
            skills: available,
            models: models.flatMap((model) =>
              [undefined, ...model.variants.map((variant) => variant.id)].map((variant) => ({
                providerID: model.providerID,
                modelID: model.id,
                variant,
                name: model.name,
                reasoningEffort: variant ?? model.request.variant ?? (model.variants.length ? "unknown" : undefined),
                description: JSON.stringify({
                  family: model.family,
                  context: model.limit.context,
                  cost: model.cost,
                  inputs: model.capabilities.input,
                }),
              })),
            ),
          }),
        )
      }),
    ),
)
