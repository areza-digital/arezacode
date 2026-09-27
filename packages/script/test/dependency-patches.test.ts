import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const root = createRequire(new URL("../../../package.json", import.meta.url))
const consoleApp = createRequire(new URL("../../console/app/package.json", import.meta.url))
const core = createRequire(new URL("../../core/package.json", import.meta.url))
const slack = createRequire(new URL("../../slack/package.json", import.meta.url))

test("SolidStart's dev-server plugin runs with the patched Vite version", async () => {
  const start = consoleApp.resolve("@solidjs/start/package.json")
  const owner = createRequire(start)
  const vite = await import(owner.resolve("vite"))
  const file = join(dirname(start), "dist/config/dev-server.js")
  expect(owner("vite/package.json").version).toBe("7.3.6")
  const { devServer } = await import(file)
  const server = await vite.createServer({
    configFile: false,
    root: dirname(start),
    plugins: [devServer()],
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
    environments: { server: { consumer: "server" } },
  })
  try {
    expect(vite.isRunnableDevEnvironment(server.environments.server)).toBe(true)
  } finally {
    await server.close()
  }
})

const sdk = createRequire(core.resolve("@modelcontextprotocol/sdk/package.json"))
const bolt = createRequire(slack.resolve("@slack/bolt/package.json"))

for (const [name, parent, alias, version] of [
  ["MCP Express 5", sdk, "body-parser2", "2.3.0"],
  ["Slack Express 4", bolt, "body-parser1", "1.20.6"],
] as const) {
  test(`${name} rejects invalid parser limits and enforces valid limits`, async () => {
    const express = parent("express")
    const parser = root(alias)
    expect(root(`${alias}/package.json`).version).toBe(version)
    for (const type of ["json", "raw", "text", "urlencoded"]) {
      expect(express[type]).toBe(parser[type])
      for (const limit of ["invalid", NaN]) {
        expect(() => express[type]({ limit, extended: false })).toThrow(/limit/)
      }
      expect(() => express[type]({ limit: null, extended: false })).not.toThrow()
    }
    const app = express()
    app.use(express.json({ limit: "32b" }))
    app.post("/", (request: { body: unknown }, response: { json(value: unknown): void }) => response.json(request.body))
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => server.on("listening", resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    try {
      const accepted = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ ok: true })
      const rejected = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oversized: "x".repeat(64) }),
      })
      expect(rejected.status).toBe(413)
      await rejected.text()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
