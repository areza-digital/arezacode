import assert from "node:assert/strict"
import { Jev } from "../../src/jev"
import { Auth } from "../../src/legacy-auth"
import { LayerNode } from "../../src/effect/layer-node"
import { Effect } from "effect"

const auth = LayerNode.compile(Auth.node)
await Effect.runPromise(
  Auth.Service.use((service) => service.set("openrouter", { type: "api", key: "test-only-not-a-real-key" })).pipe(
    Effect.provide(auth),
  ),
)
await Jev.update({ ...Jev.defaults, enabled: true })

const input = {
  sessionID: "routing-regression",
  text: "Review ambiguous authentication behavior",
  agent: "general",
  auto: true,
  independent: true,
}
type Body = {
  state: {
    task: string
    previousTask?: string
    descriptions: string[]
    budget: { models: number; shortlisted: number; skills: number; evaluatedSkills: number }
  }
  questions: Record<string, { type: string; criteria: Record<string, string> }>
}
const requests: Body[] = []
const choose = (workload: string, select: (body: Body) => string) =>
  Object.assign(
    async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.ok(Buffer.byteLength(String(init?.body)) <= 48_000)
      const body: Body = JSON.parse(String(init?.body))
      requests.push(body)
      return Response.json({
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([id, question]) => [
            id,
            question.type === "score"
              ? { type: "score", score: 2, confidence: 0.99 }
              : {
                  type: "choice",
                  choice:
                    id === "kind"
                      ? "review"
                      : id === "relation"
                        ? "standalone"
                        : id === "workload"
                          ? workload
                          : select(body),
                  confidence: 0.99,
                },
          ]),
        ),
      })
    },
    { preconnect: fetch.preconnect },
  )
const astra = {
  providerID: "openai",
  modelID: "gpt-6-astra",
  variant: "low",
  name: "Astra",
  description: "Coding model",
}
const sol = { ...astra, modelID: "gpt-6-sol", variant: "high", name: "Sol" }
for (const providerID of ["openai", "openrouter"]) {
  const models = [astra, sol].map((model) => ({
    ...model,
    providerID,
    modelID: providerID === "openai" ? model.modelID : `openai/${model.modelID}`,
  }))
  const result = await Jev.prepare(
    { ...input, models },
    { models, skills: [] },
    choose("escalate", () => "model1"),
  )
  assert.deepEqual(result.model, { providerID, modelID: models[1].modelID, variant: "high" })
  const rejected = await Jev.prepare(
    { ...input, models: [models[0]] },
    { models, skills: [] },
    choose("escalate", () => "model0"),
  )
  assert.equal(rejected.model, undefined)
  assert.equal(rejected.routing, "unavailable")
  assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.decision?.outcome === "no-eligible-model"))
  const manual = await Jev.prepare(
    { ...input, auto: false, models: [models[0]] },
    { models, skills: [] },
    choose("escalate", () => "model0"),
  )
  assert.equal(manual.routing, "manual")
  assert.equal(manual.model, undefined)
  assert.equal(requests.at(-1)?.questions.model, undefined)
}
for (const [variant, reasoningEffort, expected] of [
  [undefined, undefined, "gpt-6-sol"],
  [undefined, "low", "gpt-6-sol"],
  [undefined, "high", "gpt-6-astra"],
  ["custom", undefined, "gpt-6-sol"],
  ["xhigh", undefined, "gpt-6-astra"],
] as const) {
  const models = [{ ...astra, variant, reasoningEffort }, sol]
  const result = await Jev.prepare(
    { ...input, models },
    { models, skills: [] },
    choose("escalate", () => "model1"),
  )
  assert.equal(result.model?.modelID, expected)
}
const design = [astra, { ...sol, variant: "medium" }]
const fixed = [{ ...astra, providerID: "anthropic", modelID: "fixed-model", variant: undefined }]
assert.equal(
  (
    await Jev.prepare(
      { ...input, models: fixed },
      { models: fixed, skills: [] },
      choose("escalate", () => "model0"),
    )
  ).model?.modelID,
  "fixed-model",
)
const unknownDefault = [{ ...fixed[0], reasoningEffort: "unknown" }]
assert.equal(
  (
    await Jev.prepare(
      { ...input, models: unknownDefault },
      { models: unknownDefault, skills: [] },
      choose("escalate", () => "model0"),
    )
  ).model,
  undefined,
)
assert.equal(
  (
    await Jev.prepare(
      { ...input, models: design },
      { models: design, skills: [] },
      choose("design", () => "model1"),
    )
  ).model?.modelID,
  sol.modelID,
)
const bounded = [{ ...astra, modelID: "gpt-6-luna", variant: undefined }, { ...astra, modelID: "gpt-6-luna" }, sol]
assert.equal(
  (
    await Jev.prepare(
      { ...input, models: bounded },
      { models: bounded, skills: [] },
      choose("bounded", () => "model2"),
    )
  ).model?.variant,
  "low",
)

const description = JSON.stringify({
  family: "coding",
  context: 200000,
  cost: [
    { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
    { input: 2, output: 10, cache: { read: 0.2, write: 2.5 }, context: 128000 },
  ],
  inputs: ["text", "image"],
})
const catalog = Array.from({ length: 180 }, (_, index) => ({
  providerID: "openrouter",
  modelID: `vendor/code-model-${index}`,
  variant: "high",
  name: `Code model ${index}`,
  description,
}))
const before = requests.length
const large = await Jev.prepare(
  { ...input, models: catalog },
  { models: catalog, skills: [] },
  choose("escalate", (body) => Object.keys(body.questions.model.criteria).at(-1)!),
)
assert.equal(large.status, "ready")
assert.equal(requests.length, before + 1)
assert.equal(large.model?.modelID, "vendor/code-model-179")
assert.equal(requests.at(-1)?.state.descriptions.length, 1)
assert.ok(Object.keys(requests.at(-1)!.questions.model.criteria).length <= 64)

const full = [
  ...catalog,
  ...Array.from({ length: 74 }, (_, index) => ({ ...catalog[0], modelID: `other-${index}`, variant: "low" })),
  { ...astra, variant: "high" },
]
const skills = Array.from({ length: 100 }, (_, index) => ({
  name: `skill-${index}`,
  description: `Useful task instructions ${"解释🧪".repeat(1000)}`,
  content: `Instructions ${index}`,
  location: `/skills/${index}/SKILL.md`,
}))
const text = `Use $skill-99. ${'修复🧪"\\\n'.repeat(5000)} Preserve authentication.`
Jev.remember("utf8-routing", "先前🧪".repeat(2000))
const utf8 = await Jev.prepare(
  { ...input, sessionID: "utf8-routing", independent: false, text, models: full },
  { models: full, skills },
  choose("escalate", () => "model0"),
)
assert.equal(utf8.model?.modelID, astra.modelID)
assert.equal(utf8.model?.variant, "high")
assert.equal(utf8.skills[0].name, "skill-99")
assert.equal(utf8.skills[0].content.includes("Instructions 99"), true)
assert.equal(utf8.skills.length, 3)
assert.ok(requests.at(-1)?.state.task.endsWith("Preserve authentication."))
assert.ok(!requests.at(-1)?.state.task.includes("\ufffd"))
assert.ok(requests.at(-1)!.state.budget.evaluatedSkills < 80)
assert.ok(requests.at(-1)!.state.budget.evaluatedSkills > 0)
assert.ok(
  Object.values(requests.at(-1)!.questions.model.criteria).some((value) => value.includes("gpt-6-astra (high)")),
)
const receipt = (await Jev.usage("utf8-routing")).find((entry) => entry.decision?.selected)
assert.equal(receipt?.decision?.selected?.id, astra.modelID)
assert.equal(receipt?.decision?.selected?.variant, "high")
assert.ok((receipt?.decision?.outcome.length ?? 0) < 100)

const variants = [
  ...Array.from({ length: 254 }, (_, index) => ({ ...astra, variant: `custom-${index}` })),
  { ...astra, variant: "high" },
]
assert.equal(
  (
    await Jev.prepare(
      { ...input, models: variants },
      { models: variants, skills: [] },
      choose("escalate", () => "model0"),
    )
  ).model?.variant,
  "high",
)
const oversizedIdentity = [{ ...astra, modelID: "long-identity".repeat(10_000) }]
const beforeOversized = requests.length
assert.equal(
  (
    await Jev.prepare(
      { ...input, sessionID: "oversized-identity", models: oversizedIdentity },
      { models: oversizedIdentity, skills: [] },
      choose("escalate", () => "model0"),
    )
  ).status,
  "unavailable",
)
assert.equal(requests.length, beforeOversized)
assert.equal((await Jev.usage("oversized-identity"))[0].decision?.outcome, "no-model-fits-budget")

const manual = await Jev.prepare(
  { ...input, auto: false, text, models: [full[254]] },
  { models: full, skills },
  choose("escalate", () => "model0"),
)
assert.equal(manual.status, "ready")
assert.equal(manual.routing, "manual")
assert.equal(manual.model, undefined)
assert.equal(requests.at(-1)?.questions.model, undefined)
assert.deepEqual(requests.at(-1)?.state.descriptions, [])

await Jev.request(
  "test-only-not-a-real-key",
  { text: "🧪".repeat(20_000) },
  { reason: { type: "choice", instructions: "Choose", criteria: { yes: "Yes" } } },
  choose("bounded", () => "yes"),
  "oversized",
)
assert.equal((await Jev.usage("oversized"))[0].decision?.outcome, "request-too-large")
