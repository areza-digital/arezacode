import assert from "node:assert/strict"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Jev } from "../../src/jev"
import { Auth } from "../../src/legacy-auth"
import { LayerNode } from "../../src/effect/layer-node"
import { Deferred, Effect, Fiber } from "effect"
import { FileMutation } from "../../src/file-mutation"

const auth = LayerNode.compile(Auth.node)

const input = {
  sessionID: "test",
  text: "Fix a typo",
  agent: "build",
  auto: true,
  models: [{ providerID: "allowed", modelID: "fast" }],
}
const candidates = {
  models: [
    { providerID: "allowed", modelID: "fast", name: "Fast", description: "Simple work" },
    { providerID: "blocked", modelID: "other", name: "Other", description: "Not enabled" },
  ],
  skills: [
    { name: "editing", description: "Fix typos", content: "Check spelling", location: "/skills/editing/SKILL.md" },
  ],
}
let calls = 0
const transport: typeof fetch = Object.assign(
  async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++
    const body = JSON.parse(String(init?.body))
    if (body.questions.model) assert.deepEqual(Object.keys(body.questions.model.criteria), ["model0"])
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [
          id,
          (question as { type: string }).type === "choice"
            ? { type: "choice", choice: id === "kind" ? "fix" : id === "relation" ? "standalone" : id === "workload" ? "bounded" : "model0", confidence: 0.95 }
            : { type: "score", score: 2, confidence: 0.95 },
        ]),
      ),
    })
  },
  { preconnect: fetch.preconnect },
)

assert.equal((await Jev.prepare(input, candidates, transport)).status, "disabled")
await mkdir(path.join(process.env.XDG_CONFIG_HOME!, "opencode"), { recursive: true })
await writeFile(path.join(process.env.XDG_CONFIG_HOME!, "opencode/jev.json"), JSON.stringify({ ...Jev.defaults, apiKey: "old-typesafe-test-key", openRouterKey: "obsolete-test-only-key" }), { mode: 0o600 })
assert.equal((await Jev.status()).configured, false)
await Jev.update({ ...Jev.defaults, enabled: true })
assert.equal((await Jev.prepare(input, candidates, transport)).status, "missing-key")
assert.equal(calls, 0)
await Effect.runPromise(Auth.Service.use((service) => service.set("openrouter", { type: "api", key: "test-only-not-a-real-key" })).pipe(Effect.provide(auth)))
assert.equal((await Jev.status()).configured, true)
assert.equal((await readFile(path.join(process.env.XDG_CONFIG_HOME!, "opencode/jev.json"), "utf8")).includes("Key"), false)
assert.equal((await stat(path.join(process.env.XDG_CONFIG_HOME!, "opencode/jev.json"))).mode & 0o777, 0o600)
assert.equal("apiKey" in (await Jev.status()), false)
assert.equal("openRouterKey" in (await Jev.status()), false)
const auto = await Jev.prepare(input, candidates, transport)
assert.deepEqual(auto.model, { providerID: "allowed", modelID: "fast" })
assert.equal(auto.skills[0].name, "editing")
assert.equal((await Jev.prepare({ ...input, auto: false }, candidates, transport)).model, undefined)
await Jev.update({ ...Jev.defaults, enabled: false })
assert.equal((await Jev.prepare(input, candidates, transport)).status, "disabled")
assert.equal(calls, 2)
await Jev.update({ ...Jev.defaults, enabled: true })
const variants = ["low", "high"].map((variant) => ({ ...candidates.models[0], variant }))
const routing: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(Object.keys(body.questions.model.criteria), ["model0", "model1"])
  assert.match(body.questions.model.criteria.model1, /high/)
  return Response.json({ answers: { workload: { type: "choice", choice: "bounded", confidence: 0.95 }, model: { type: "choice", choice: "model1", confidence: 0.94 }, kind: { type: "choice", choice: "review", confidence: 0.95 }, relation: { type: "choice", choice: "standalone", confidence: 0.95 } } })
}, { preconnect: fetch.preconnect })
const routed = await Jev.prepare({ ...input, promptID: "msg_routing_test", models: variants }, { models: [...variants, candidates.models[1]], skills: [] }, routing)
assert.deepEqual(routed.model, { providerID: "allowed", modelID: "fast", variant: "low" })
assert.equal(routed.routing, "selected")
const child = await Jev.delegate(input.sessionID, "child", "Review authentication", "review", routing)
assert.deepEqual(child?.model, routed.model)
const history = await Jev.usage(input.sessionID)
assert.ok(history.some((entry) => entry.promptID === "msg_routing_test" && entry.decision?.selected?.variant === "low"))
const uncertain: typeof fetch = Object.assign(async () => Response.json({ answers: { workload: { type: "choice", choice: "bounded", confidence: 0.4 }, model: { type: "choice", choice: "model0", confidence: 0.4 }, kind: { type: "choice", choice: "cosmetic", confidence: 0.4 }, relation: { type: "choice", choice: "followup", confidence: 0.4 } } }), { preconnect: fetch.preconnect })
const uncertainRoute = await Jev.prepare({ ...input, promptID: "msg_uncertain_routing", models: variants }, { models: variants, skills: [] }, uncertain)
assert.equal(uncertainRoute.routing, "selected")
assert.deepEqual(uncertainRoute.model, { providerID: "allowed", modelID: "fast", variant: "high" })
assert.equal(uncertainRoute.task, undefined)
assert.ok(
  (await Jev.usage(input.sessionID)).some(
    (entry) =>
      entry.promptID === "msg_uncertain_routing" &&
      entry.decision?.confidence === 0.4 &&
      entry.decision.selected?.variant === "high",
  ),
)
await Jev.recordCompression(input.sessionID, 12000, 3000, true, { created: Date.now() - 20, completed: Date.now() })
assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.automation?.cached && entry.automation.outputCharacters === 3000))
const explicit = await Jev.prepare({ ...input, auto: false, text: "Use $requested" }, {
  models: [],
  skills: [...Array.from({ length: 80 }, (_, index) => ({ ...candidates.skills[0], name: `other-${index}` })),
    { ...candidates.skills[0], name: "requested" }],
}, transport)
assert.equal(explicit.skills[0].name, "requested")
assert.equal(explicit.skills.length, 3)
assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.decision?.skills?.includes("requested") && entry.decision.skills.length === 3))
const cosmetic: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  assert.equal(body.state.previousTask, "Use $requested")
  assert.equal(body.state.task, "Use $editing to make the sidebar heading 13px")
  assert.match(body.questions.model.instructions, /low effort/)
  const response = await transport(_, init)
  const result = await response.json() as { answers: Record<string, { choice: string }> }
  result.answers.kind.choice = "cosmetic"
  result.answers.relation.choice = "followup"
  return Response.json(result)
}, { preconnect: fetch.preconnect })
const beforeCosmetic = calls
const small = await Jev.prepare({ ...input, promptID: "msg_cosmetic", text: "Use $editing to make the sidebar heading 13px" }, { ...candidates, skills: [...candidates.skills, { ...candidates.skills[0], name: "audit" }] }, cosmetic)
assert.equal(calls, beforeCosmetic + 1)
assert.deepEqual(small.task, { kind: "cosmetic", relation: "followup" })
assert.deepEqual(small.skills.map((skill) => skill.name), ["editing"])
assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.promptID === "msg_cosmetic" && entry.decision?.task?.kind === "cosmetic" && entry.decision.skills?.join() === "editing"))
assert.match(await Jev.guidance(input.sessionID, "msg_cosmetic", 0), /No delegation/)
assert.doesNotMatch(await Jev.guidance(input.sessionID, "msg_cosmetic", 0), /Effort checkpoint/)
assert.match(await Jev.guidance(input.sessionID, "msg_cosmetic", 4), /Effort checkpoint/)
assert.deepEqual(await Jev.prepare({ ...input, promptID: "msg_cosmetic", text: "Use $editing to make the sidebar heading 13px" }, { ...candidates, skills: [...candidates.skills, { ...candidates.skills[0], name: "audit" }] }, cosmetic), small)
assert.equal(calls, beforeCosmetic + 1)
assert.equal(Jev.quickEdit(input.sessionID), true)
assert.deepEqual(await Jev.guardTool(input.sessionID, "read", { path: "sidebar.tsx", limit: 2000, offset: 300 }), { input: { path: "sidebar.tsx", limit: 250, offset: 300 } })
assert.equal((await Jev.guardTool(input.sessionID, "edit", { filePath: "sidebar.tsx" })).error, undefined)
assert.equal((await Jev.guardTool(input.sessionID, "bash", { command: "git diff -- sidebar.tsx" })).error, undefined)
for (const [name, args] of [["task", { prompt: "Audit everything" }], ["bash", { command: "bun run build" }], ["project_check", { operation: "verify" }], ["bash", { command: "git diff; bun run build" }], ["code_mode", { code: "runEverything()" }], ["apply_patch", { patchText: "*** Begin Patch\n*** Add File: new-component.tsx\n+new component\n*** End Patch" }]] as const) {
  assert.match((await Jev.guardTool(input.sessionID, name, args)).error!, /Quick Edit blocked/)
}
assert.equal((await Jev.guardTool(input.sessionID, "project_check", { operation: "test", files: ["sidebar.test.ts"] })).error, undefined)
assert.equal(await Jev.context("large output".repeat(500), input.sessionID, cosmetic), undefined)
assert.deepEqual(await Jev.prioritize(["one", "two"], input.sessionID, cosmetic), ["one", "two"])
assert.equal(calls, beforeCosmetic + 1)
let duplicateRankingCalls = 0
const duplicateRanking: typeof fetch = Object.assign(async () => {
  duplicateRankingCalls++
  return Response.json({ answers: {} })
}, { preconnect: fetch.preconnect })
assert.deepEqual(await Jev.prioritize(["same", "same"], undefined, duplicateRanking), ["same"])
assert.equal(duplicateRankingCalls, 0)
assert.deepEqual(await Jev.prioritize(["  FAIL same   test  ", "FAIL same test", "FAIL other test"], undefined, duplicateRanking), ["  FAIL same   test  ", "FAIL other test"])
assert.equal(duplicateRankingCalls, 1)
assert.equal(await Jev.testFindings("FAIL duplicate\n  \u001b[31mFAIL   duplicate\u001b[0m", undefined, duplicateRanking), undefined)
assert.equal(duplicateRankingCalls, 1)
let expansions = 0
const expand: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  expansions++
  const body = JSON.parse(String(init?.body))
  assert.equal(body.state.tool, "project_check")
  assert.equal("quickEditReason" in body.state.input, false)
  return Response.json({ answers: { scope: { type: "choice", choice: "expand", confidence: expansions === 1 ? 0.4 : 0.95 } } })
}, { preconnect: fetch.preconnect })
const required = { operation: "verify", quickEditReason: "AGENTS.md requires full verification before changes to the shared theme." }
assert.match((await Jev.guardTool(input.sessionID, "project_check", required, expand)).error!, /not expanded/)
assert.equal(Jev.quickEdit(input.sessionID), true)
assert.match((await Jev.guardTool(input.sessionID, "project_check", required, expand)).error!, /not expanded/)
assert.equal(expansions, 1)
assert.equal((await Jev.guardTool(input.sessionID, "project_check", { ...required, quickEditReason: "AGENTS.md: changes to the shared theme must pass the configured verify script before completion." }, expand)).error, undefined)
assert.equal(Jev.quickEdit(input.sessionID), false)
assert.equal((await Jev.guardTool(input.sessionID, "project_check", required, expand)).error, undefined)
assert.equal(expansions, 2)
assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.promptID === "msg_cosmetic" && entry.decision?.outcome === "expanded" && entry.decision.task?.kind === "fix"))
assert.equal(await Jev.guidance(input.sessionID, "msg_other", 8), "")
assert.equal(Jev.quickEdit(input.sessionID), false)
const overthinking: typeof fetch = Object.assign(async () => Response.json({ answers: { workload: { type: "choice", choice: "bounded", confidence: 0.95 }, model: { type: "choice", choice: "model1", confidence: 0.96 }, kind: { type: "choice", choice: "cosmetic", confidence: 0.99 }, relation: { type: "choice", choice: "standalone", confidence: 0.99 } } }), { preconnect: fetch.preconnect })
const efficient = await Jev.prepare({ ...input, promptID: "msg_low_effort", models: variants }, { models: variants, skills: [] }, overthinking)
assert.equal(efficient.model?.variant, "low")
assert.ok((await Jev.usage(input.sessionID)).some((entry) => entry.promptID === "msg_low_effort" && entry.decision?.selected?.variant === "low"))
const highOnly = await Jev.prepare({ ...input, promptID: "msg_high_only", models: [variants[1]] }, { models: variants, skills: [] }, Object.assign(async () => Response.json({ answers: { workload: { type: "choice", choice: "bounded", confidence: 0.95 }, model: { type: "choice", choice: "model0", confidence: 0.96 }, kind: { type: "choice", choice: "cosmetic", confidence: 0.99 }, relation: { type: "choice", choice: "standalone", confidence: 0.99 } } }), { preconnect: fetch.preconnect }))
assert.equal(highOnly.model?.variant, "high")
const unsure = await Jev.prepare({ ...input, promptID: "msg_uncertain", models: variants }, { models: variants, skills: [] }, uncertain)
assert.equal(unsure.task, undefined)
assert.equal(await Jev.guidance(input.sessionID, "msg_uncertain", 8), "")
const ranking: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  const values: string[] = body.state.chunks ?? body.state.findings ?? []
  return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id, index) => [id,
    id === "kind" || id === "relation" ? { type: "choice", choice: id === "kind" ? "fix" : "standalone", confidence: 0.95 } : {
      type: "score", score: values[index]?.includes("important") ? 2 : 0, confidence: 0.95,
    },
  ])) })
}, { preconnect: fetch.preconnect })
const forced = await Jev.prepare({ ...input, auto: false, text: "$editing" }, candidates, ranking)
assert.equal(forced.skills[0].name, "editing")
const excerpts = await Jev.context("unrelated".padEnd(2000, ".") + "important".padEnd(2000, "."), input.sessionID, ranking)
assert.ok(excerpts?.startsWith("[Excerpt 2 of 2]"))
assert.ok(!excerpts?.includes("unrelated"))
assert.deepEqual(await Jev.prioritize(["minor", "important"], input.sessionID, ranking), ["important", "minor"])
const many = [...Array.from({ length: 35 }, (_, index) => `minor-${index}`), "important"]
const ordered = await Jev.prioritize(many, input.sessionID, ranking)
assert.equal(ordered[0], "important")
assert.deepEqual(new Set(ordered), new Set(many))
const failures = "FAIL minor\n  minor stack\nFAIL important\n  important stack\n2 failed"
const prioritized = await Jev.testFindings(failures, input.sessionID, ranking)
assert.ok(prioritized?.startsWith("Jev prioritized test failures:\nFAIL important\nFAIL minor"))
assert.ok(prioritized?.endsWith(failures))
const disabling: typeof fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    await Jev.update({ ...Jev.defaults, enabled: false })
    return transport(...args)
  },
  { preconnect: fetch.preconnect },
)
const disabled = await Jev.prepare(input, candidates, disabling)
assert.equal(disabled.status, "disabled")
assert.equal(disabled.model, undefined)
assert.deepEqual(disabled.skills, [])
await Effect.runPromise(Auth.Service.use((service) => service.set("openrouter", { type: "api", key: "updated-test-only-key" })).pipe(Effect.provide(auth)))
await Jev.update({ ...Jev.defaults, enabled: true })
const updated: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer updated-test-only-key")
  return Response.json({ answers: { skill: { type: "score", score: 2, confidence: 1 } } })
}, { preconnect: fetch.preconnect })
assert.ok(await Jev.evaluate("skills", {}, { skill: { type: "score", instructions: "test", criteria: ["No", "Maybe", "Yes"] } }, updated))
const free = { providerID: "opencode", modelID: "mimo-v2.6-flash-free", name: "MiMo Flash Free", description: "Free coding model" }
const astra = [undefined, "low", "medium", "high", "xhigh"].map((variant) => ({ providerID: "openai", modelID: "gpt-6-astra", variant, name: "GPT-6 Astra", description: "Coding model" }))
assert.equal((await Jev.prepare({ ...input, models: [free] }, { models: [free], skills: [] }, uncertain)).model, undefined)
const economical = [astra[1], { providerID: "openai", modelID: "gpt-6-luna", variant: "low", name: "Luna", description: "Available text/image model" }, { providerID: "openai", modelID: "gpt-6-sol", variant: "medium", name: "Sol", description: "Available coding model" }]
const benchmarkRouting: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(Object.keys(body.questions.model.criteria), ["model0", "model1", "model2"])
  assert.equal(body.state.benchmarks.find((item: { modelID: string }) => item.modelID === "gpt-6-luna").costPerTaskUSD, 0.07)
  assert.equal(body.state.benchmarks[0].effort, "max")
  assert.match(body.questions.model.instructions, /lowest total-cost suitable/)
  return Response.json({ answers: {
    workload: { type: "choice", choice: "bounded", confidence: 0.95 },
    model: { type: "choice", choice: body.state.role === "subagent" ? "model1" : "model0", confidence: 0.95 },
    kind: { type: "choice", choice: "review", confidence: 0.95 },
    relation: { type: "choice", choice: "standalone", confidence: 0.95 },
  } })
}, { preconnect: fetch.preconnect })
await Jev.prepare({ ...input, models: economical }, { models: economical, skills: [] }, benchmarkRouting)
assert.equal((await Jev.delegate(input.sessionID, "economical-child", "Find the two route definitions and return file/line references", "explore", benchmarkRouting))?.model?.modelID, "gpt-6-luna")
assert.deepEqual(
  (
    await Jev.delegate(
      input.sessionID,
      "uncertain-child",
      "Review ambiguous authentication behavior",
      "general",
      uncertain,
    )
  )?.model,
  { providerID: "openai", modelID: "gpt-6-sol", variant: "medium" },
)
const restricted: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(Object.keys(body.questions.model.criteria), ["model0"])
  assert.match(body.questions.model.criteria.model0, /gpt-6-sol/)
  assert.equal(body.state.previousTask, undefined)
  return Response.json({ answers: { workload: { type: "choice", choice: "bounded", confidence: 0.95 }, model: { type: "choice", choice: "model0", confidence: 0.95 }, kind: { type: "choice", choice: "fix", confidence: 0.95 }, relation: { type: "choice", choice: "standalone", confidence: 0.95 } } })
}, { preconnect: fetch.preconnect })
assert.equal((await Jev.prepare({ ...input, independent: true, models: [economical[2]] }, { models: economical, skills: [] }, restricted)).model?.modelID, "gpt-6-sol")
const policyModels = [...economical, astra[2], astra[3], free]
for (const providerID of ["openai", "openrouter"]) {
  const models = policyModels.map((model) => providerID === "openrouter" && model.providerID === "openai" ? { ...model, providerID, modelID: `openai/${model.modelID}` } : model)
  for (const [confidence, kindConfidence, relationConfidence] of [[0.64, 0.95, 0.95], [0.37, 0.95, 0.95], [0.39, 0.95, 0.95], [0.94, 0.4, 0.95], [0.94, 0.95, 0.4]]) {
    const choose: typeof fetch = Object.assign(async () => Response.json({ answers: {
      workload: { type: "choice", choice: "bounded", confidence },
      model: { type: "choice", choice: "model1", confidence: 0.95 },
      kind: { type: "choice", choice: "fix", confidence: kindConfidence },
      relation: { type: "choice", choice: "standalone", confidence: relationConfidence },
    } }), { preconnect: fetch.preconnect })
    const parentID = `delegate-${providerID}-${confidence}-${kindConfidence}-${relationConfidence}`
    await Jev.prepare({ ...input, sessionID: parentID, models }, { models, skills: [] }, choose)
    const childID = `${parentID}-child`
    const child = await Jev.delegate(parentID, childID, "Diagnose the requested issue", "general", choose)
    assert.deepEqual(child?.model, {
      providerID,
      modelID: providerID === "openai" ? "gpt-6-sol" : "openai/gpt-6-sol",
      variant: "medium",
    })
    assert.equal(child?.routing, "selected")
    assert.ok(
      (await Jev.usage(childID)).some(
        (entry) => entry.decision?.selected?.id.endsWith("gpt-6-sol") && entry.decision.selected.variant === "medium",
      ),
    )
    const restricted = models.filter((model) => !("variant" in model) || model.variant === "low")
    await Jev.prepare({ ...input, sessionID: `${parentID}-restricted`, models: restricted }, { models: restricted, skills: [] }, choose)
    assert.equal((await Jev.delegate(`${parentID}-restricted`, `${childID}-restricted`, "Diagnose the requested issue", "general", choose))?.routing, "uncertain")
  }
}
for (const [text, workload, confidence, expected] of [
  ["Make this interface look better", "design", 0.95, astra[2]],
  ["Change padding to exactly 16px", "bounded", 0.95, economical[1]],
  ["Implement pagination", "implementation", 0.95, economical[2]],
  ["The Luna attempt still fails; diagnose the cross-file bug", "escalate", 0.95, astra[3]],
  ["Investigate unclear behavior", "bounded", 0.4, economical[2]],
  ["Make this interface look better", "design", 0.3, astra[2]],
  ["Implement pagination", "implementation", 0.74, economical[2]],
  ["Diagnose an authentication bypass", "escalate", 0.4, astra[3]],
] as const) {
  const choose: typeof fetch = Object.assign(async () => Response.json({ answers: {
    workload: { type: "choice", choice: workload, confidence },
    model: { type: "choice", choice: workload === "bounded" ? "model5" : "model1", confidence: 0.95 },
    kind: { type: "choice", choice: "cosmetic", confidence: 0.95 },
    relation: { type: "choice", choice: "standalone", confidence: 0.95 },
  } }), { preconnect: fetch.preconnect })
  const sessionID = `policy-${workload}-${confidence}`
  const result = await Jev.prepare({ ...input, sessionID, text, models: policyModels }, { models: policyModels, skills: [] }, choose)
  assert.deepEqual(result.model, { providerID: expected.providerID, modelID: expected.modelID, variant: expected.variant })
  assert.equal(result.task?.kind, workload === "bounded" && confidence >= 0.8 ? "cosmetic" : "feature")
  assert.ok((await Jev.usage(sessionID)).some((entry) => entry.decision?.selected?.id === expected.modelID && entry.decision.selected.variant === expected.variant))
  const openrouter = policyModels.map((model) => model.providerID === "openai" ? { ...model, providerID: "openrouter", modelID: `openai/${model.modelID}` } : model)
  assert.deepEqual((await Jev.prepare({ ...input, sessionID: `${sessionID}-openrouter`, text, models: openrouter }, { models: openrouter, skills: [] }, choose)).model, { providerID: "openrouter", modelID: `openai/${expected.modelID}`, variant: expected.variant })
}
Jev.remember("scope", "Fix spacing in the existing member card")
let scopeCalls = 0
const rejectChange: typeof fetch = Object.assign(async () => {
  scopeCalls++
  return Response.json({ answers: { change: { type: "choice", choice: "revise", confidence: 0.99 } } })
}, { preconnect: fetch.preconnect })
await assert.rejects(Jev.guardChange("scope", "/src/pages/unrequested.tsx", "", "export const Dashboard = () => <main />", rejectChange), /UI scope guard/)
await assert.rejects(Jev.guardChange("scope", "/src/pages/unrequested.tsx", "", "export const Dashboard = () => <main />", rejectChange), /UI scope guard/)
assert.equal(scopeCalls, 1)
await Jev.guardChange("scope", "/src/components/card.tsx", '<p className="p-2">Ready</p>', '<p className="p-4">Ready</p>', rejectChange)
assert.equal(scopeCalls, 1)
await assert.rejects(Jev.guardChange("scope", "/src/components/card.tsx", "<p>Ready</p>", "<p>Ready · Today</p>", rejectChange), /UI copy policy/)
Jev.remember("scope", "Add the requested dashboard page")
const allowChange: typeof fetch = Object.assign(async () => Response.json({ answers: { change: { type: "choice", choice: "allow", confidence: 0.99 } } }), { preconnect: fetch.preconnect })
await Jev.guardChange("scope", "/src/pages/requested.tsx", "", "export const Dashboard = () => <main />", allowChange)
const staleChange: typeof fetch = Object.assign(
  async () => {
    Jev.remember("scope", "Stop adding pages; fix the existing card")
    return allowChange("https://example.invalid")
  },
  { preconnect: fetch.preconnect },
)
await assert.rejects(
  Jev.guardChange("scope", "/src/pages/stale.tsx", "", "export const Dashboard = () => <main />", staleChange),
  /active request changed/,
)
const approvedTarget = "/src/pages/approved.tsx"
const approvedContent = "export const Approved = () => <main />"
Jev.remember("approval", "Add this page")
let approvals = 0
await Jev.guardChange("approval", approvedTarget, "", approvedContent, rejectChange, async (review) => {
  approvals++
  assert.equal(review.uiScopeGuard, true)
  assert.equal(review.filepath, approvedTarget)
  assert.match(review.diff, /\+export const Approved/)
})
await Jev.guardChange("approval", approvedTarget, "", approvedContent, rejectChange, async () => {
  approvals++
})
assert.equal(approvals, 1)
await Jev.verifyChange("approval", approvedTarget, "", approvedContent)
await assert.rejects(
  Jev.guardChange("approval", approvedTarget, "", approvedContent + "\n", rejectChange),
  /UI scope guard/,
)
await assert.rejects(
  Jev.guardChange("approval", "/src/pages/denied.tsx", "", approvedContent, rejectChange, async () => {
    throw new Error("User rejected")
  }),
  /User rejected/,
)
await assert.rejects(
  Jev.guardChange("approval", "/src/pages/denied.tsx", "", approvedContent, rejectChange),
  /UI scope guard/,
)
await assert.rejects(
  Jev.guardChange("approval", "/src/pages/stale.tsx", "", approvedContent, rejectChange, async () => {
    Jev.remember("approval", "Stop adding pages")
  }),
  /active request changed/,
)
await assert.rejects(Jev.guardChange("approval", approvedTarget, "", approvedContent, rejectChange), /UI scope guard/)
Jev.remember("move", "Move the existing page")
await Jev.guardChange("move", "/src/pages/moved.tsx", approvedContent, approvedContent, rejectChange)
await Jev.verifyChange("move", "/src/pages/moved.tsx", "", approvedContent)
const unavailableChange: typeof fetch = Object.assign(async () => Response.json({}, { status: 503 }), {
  preconnect: fetch.preconnect,
})
await Jev.guardChange("move", "/src/pages/offline.tsx", "", approvedContent, unavailableChange, async () => {
  approvals++
})
assert.equal(approvals, 2)
const mutations = LayerNode.compile(FileMutation.node)
for (const method of ["write", "writeTextPreservingBom", "create", "writeIfUnchanged"] as const) {
  const target = { canonical: path.join(process.env.XDG_CONFIG_HOME!, method + ".tsx"), resource: method + ".tsx" }
  const original = method === "create" ? "" : "export const Original = () => <p>Original</p>"
  if (original) await writeFile(target.canonical, original)
  await assert.rejects(
    Jev.guardChange("move", target.canonical, original, approvedContent, rejectChange),
    /UI scope guard/,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* FileMutation.Service
      const waiting = yield* Deferred.make<void>()
      const pending = yield* files[method]({
        target,
        content: approvedContent,
        expected: new TextEncoder().encode(original),
        sessionID: "move",
        approveUI: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(waiting)
      yield* Fiber.interrupt(pending)
      assert.equal(yield* Effect.promise(() => readFile(target.canonical, "utf8").catch(() => "")), original)
    }).pipe(Effect.scoped, Effect.provide(mutations)),
  )
  await assert.rejects(
    Jev.guardChange("move", target.canonical, original, approvedContent, rejectChange),
    /UI scope guard/,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* FileMutation.Service
      const result = yield* Effect.exit<FileMutation.WriteResult, unknown, never>(
        files[method]({
          target,
          content: approvedContent,
          expected: new TextEncoder().encode(original),
          sessionID: "move",
          approveUI: () => Effect.promise(() => writeFile(target.canonical, "User edited while waiting")),
        }),
      )
      assert.equal(result._tag, "Failure")
      assert.equal(yield* Effect.promise(() => readFile(target.canonical, "utf8")), "User edited while waiting")
    }).pipe(Effect.provide(mutations)),
  )
}
const verificationEvidence = { requests: ["Fix the card and install the rebuilt app"], files: ["src/card.tsx"], tools: [{ id: "screen", tool: "browser", input: "screenshot", output: "installed app", visual: true, ok: true }], response: "Checked card layout" }
const verificationReview: typeof fetch = Object.assign(async (_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(Object.keys(body.questions), ["visual", "workflow", "consistency", "scope", "delivery"])
  assert.equal(body.state.tools[0].id, "screen")
  return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "choice", choice: id === "delivery" ? "missing" : "verified", confidence: 0.99 }])) })
}, { preconnect: fetch.preconnect })
assert.match((await Jev.reviewUI("scope", verificationEvidence, verificationReview)).join("\n"), /delivery:/)
const verifiedReview: typeof fetch = Object.assign(async () => Response.json({ answers: Object.fromEntries(["visual", "workflow", "consistency", "scope", "delivery"].map((id) => [id, { type: "choice", choice: "verified", confidence: 0.99 }])) }), { preconnect: fetch.preconnect })
assert.deepEqual(await Jev.reviewUI("scope", verificationEvidence, verifiedReview), [])
await Jev.update({ ...Jev.defaults, enabled: false })
assert.match((await Jev.reviewUI("scope", verificationEvidence, verifiedReview)).join("\n"), /disabled/)
await Jev.guardChange("scope", "/src/pages/disabled.tsx", "", "export const Dashboard = () => <main />", rejectChange)
await assert.rejects(Jev.guardChange("scope", "/src/components/card.tsx", "<p>Ready</p>", "<p>Ready · Today</p>", allowChange), /UI copy policy/)
await Jev.update({ ...Jev.defaults, enabled: true })
await Effect.runPromise(Auth.Service.use((service) => service.remove("openrouter")).pipe(Effect.provide(auth)))
assert.equal((await Jev.prepare(input, candidates, transport)).status, "missing-key")
assert.equal((await Jev.status()).configured, false)
