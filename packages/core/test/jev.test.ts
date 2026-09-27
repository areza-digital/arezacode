import { expect, test } from "bun:test"
import { Jev } from "../src/jev"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const questions = {
  model: {
    type: "choice" as const,
    instructions: "Choose the suitable model",
    criteria: { fast: "Fast", strong: "Strong" },
  },
  skill: { type: "score" as const, instructions: "Skill relevance", criteria: ["No", "Maybe", "Yes"] },
}

test.each(["jev-flow", "jev-routing"])(
  "%s preserves manual choices and confines Auto",
  async (fixture) => {
    const directory = await mkdtemp(path.join(tmpdir(), "areza-jev-test-"))
    try {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, `fixtures/${fixture}.ts`)], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory,
          XDG_DATA_HOME: directory,
          XDG_CACHE_HOME: directory,
          XDG_STATE_HOME: directory,
          OPENROUTER_API_KEY: "",
          OPENCODE_AUTH_CONTENT: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

test("Jev sends one bounded typed request and rejects invalid, failed, or incomplete answers", async () => {
  const requests: Array<{ state: unknown; model: string; questions: unknown }> = []
  let response: unknown = {
    answers: {
      model: { type: "choice", choice: "fast", confidence: 0.9 },
      skill: { type: "score", score: 2, confidence: 0.95 },
    },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as { state: unknown; model: string; questions: unknown })
      expect(request.headers.get("authorization")).toBe("Bearer test-only-not-a-real-key")
      return Response.json(response)
    },
  })
  const transport: typeof fetch = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/systemone")
      expect(init?.redirect).toBe("error")
      return fetch(server.url, init)
    },
    { preconnect: fetch.preconnect },
  )
  try {
    const sessionID = `ses_usage_${crypto.randomUUID()}`
    response = { ...response as object, id: "gen-decision", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { input_tokens: 30, output_tokens: 5, cost: 0 } }
    const result = await Jev.request("test-only-not-a-real-key", { task: "Fix the typo" }, questions, transport, sessionID)
    expect(result?.model).toEqual({ type: "choice", choice: "fast", confidence: 0.9 })
    expect(requests).toHaveLength(1)
    expect(await Jev.usage(sessionID)).toMatchObject([{ kind: "jev", usage: { input: 30, output: 5, total: 35, cost: 0, costSource: "reported", responseID: "gen-decision", responseModel: "typesafe/jev-1.13-20260917", responseProvider: "TypeSafe" } }])
    expect(requests[0].model).toBe("~typesafe/jev-latest")
    expect(Object.keys(requests[0].questions as object)).toEqual(["model", "skill"])
    response = {
      answers: {
        model: { type: "choice", choice: "unknown", confidence: 0.99 },
        skill: { type: "score", score: 2, confidence: 1 },
      },
    }
    expect(await Jev.request("test-only-not-a-real-key", {}, questions, transport)).toBeUndefined()
    const invalidSession = `ses_invalid_${crypto.randomUUID()}`
    expect(await Jev.request("test-only-not-a-real-key", {}, questions, transport, invalidSession)).toBeUndefined()
    expect(await Jev.usage(invalidSession)).toMatchObject([{ finish: "error", decision: { outcome: "unavailable" } }])
    response = { answers: { model: { type: "choice", choice: "fast", confidence: 1 } } }
    expect(await Jev.request("test-only-not-a-real-key", {}, questions, transport)).toBeUndefined()
    expect(await Jev.request("", {}, questions, transport)).toBeUndefined()
    expect(await Jev.request("test-only-not-a-real-key", "x".repeat(50_000), questions, transport)).toBeUndefined()
    expect(requests).toHaveLength(4)
    expect(await Jev.request("test-only-not-a-real-key", {}, { bad: { type: "score", instructions: "Invalid scale", criteria: ["Only one"] } }, transport)).toBeUndefined()
    expect(requests).toHaveLength(4)
    response = { answers: { model: { type: "choice", choice: "fast" }, skill: { type: "score", score: 2 } } }
    expect((await Jev.request("test-only-not-a-real-key", {}, questions, transport))?.model.confidence).toBe(0)
  } finally {
    server.stop(true)
  }
})

test("Jev deterministically orders complete Semgrep severity batches without a model call", async () => {
  let modelCalls = 0
  const fetcher: typeof fetch = Object.assign(async () => {
    modelCalls++
    return Response.json({ answers: {} })
  }, { preconnect: fetch.preconnect })
  const findings = [
    "src/info.ts:1 [INFO] info: informational finding",
    "src/warning.ts:2 [WARNING] warning: review this finding",
    "src/error.ts:3 [ERROR] error: critical finding",
  ]
  const ranked = await Jev.prioritizeSemgrep(findings, undefined, fetcher)
  expect(ranked).toEqual([findings[2], findings[1], findings[0]])
  expect(modelCalls).toBe(0)
})
