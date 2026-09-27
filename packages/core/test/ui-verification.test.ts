import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { UiVerification } from "../src/ui-verification"
import { AutomaticChecks } from "../src/automatic-checks"
import { nativeCommand } from "../src/util/native-command"

test("completion requires fresh visual evidence and semantic review, and bounds correction attempts", async () => {
  const initial = { files: new Map<string, string>() }
  const edited = { files: new Map([["src/card.tsx", "new"]]) }
  const screenshot = {
    id: "screen-1",
    tool: "browser",
    input: '{"action":"screenshot"}',
    output: "http://localhost:3000/cards",
    visual: true,
    ok: true,
  }
  const context = { promptID: "user-1", requests: ["Fix card alignment"], tools: [screenshot], response: "Done" }
  let reviews = 0
  const guard = UiVerification.create("test", initial, async () => {
    reviews++
    return []
  })
  guard.observe(initial, context)
  guard.observe(edited, context)
  expect((await guard.check()).status).toBe("retry")
  expect(reviews).toBe(0)
  guard.observe(edited, { ...context, tools: [...context.tools, { ...screenshot, id: "failed", ok: false }] })
  expect((await guard.check()).status).toBe("retry")
  guard.observe(edited, { ...context, tools: [...context.tools, { ...screenshot, id: "screen-2" }] })
  expect((await guard.check()).status).toBe("pass")
  expect(reviews).toBe(1)
  guard.observe({ files: new Map([["src/card.tsx", "newer"]]) }, context)
  expect((await guard.check()).status).toBe("blocked")
  expect(reviews).toBe(1)
  guard.observe(initial, context)
  expect((await guard.check()).status).toBe("pass")
  expect(guard.guidance()).toBe("")

  const missing = UiVerification.create("test", initial, async () => ["Installed app was not verified"])
  missing.observe(initial, { ...context, tools: [] })
  missing.observe(edited, { ...context, tools: [] })
  missing.observe(edited, context)
  expect(await missing.check(false)).toMatchObject({
    status: "blocked",
    notice: expect.stringContaining("Installed app"),
  })
  expect(await missing.check(false, "Unresolved UI scope violation")).toMatchObject({
    status: "blocked",
    notice: expect.stringContaining("scope violation"),
  })
})

test("read-only work and existing dirty UI do not require verification", async () => {
  const snapshot = { files: new Map([["src/styles.css", "existing dirty work"]]) }
  const guard = UiVerification.create("test", snapshot, async () => {
    throw new Error("Unexpected review")
  })
  guard.observe(
    { files: new Map([...snapshot.files, ["src/server.ts", "backend edit"]]) },
    { promptID: "user", requests: ["Fix backend"], tools: [], response: "Done" },
  )
  expect((await guard.check()).status).toBe("pass")
})

test("checkout tracking catches deletion and edits committed during a tool call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "areza-ui-completion-"))
  try {
    await nativeCommand("git", ["init", "-q", directory])
    await Bun.write(path.join(directory, "page.tsx"), "export default () => <main />")
    await nativeCommand("git", ["add", "."], { cwd: directory })
    await nativeCommand(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline"],
      { cwd: directory },
    )
    const baseline = await AutomaticChecks.files(directory)
    await rm(path.join(directory, "page.tsx"))
    expect((await AutomaticChecks.files(directory, baseline.revision)).files.get("page.tsx")).toBe("deleted")
    await Bun.write(path.join(directory, "style.css"), "body { color: red }")
    await nativeCommand("git", ["add", "."], { cwd: directory })
    await nativeCommand(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "changed"],
      { cwd: directory },
    )
    const current = await AutomaticChecks.files(directory, baseline.revision)
    expect([...current.files.keys()].sort()).toEqual(["page.tsx", "style.css"])
    const guard = UiVerification.create("test", baseline)
    guard.observe(current, { promptID: "user", requests: ["Fix UI"], tools: [], response: "Done" })
    expect((await guard.check(false)).status).toBe("blocked")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
