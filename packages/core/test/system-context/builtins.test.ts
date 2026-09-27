import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const instructionFile = FSUtil.resolve("/repo/AGENTS.md")
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const builtInsNode = LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node])
const it = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)
const instructionFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        up: () => Effect.succeed([instructionFile]),
        readFileStringSafe: (path) => Effect.succeed(path === instructionFile ? "Be precise." : undefined),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const itWithInstructions = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [FSUtil.node, instructionFS],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)

describe("SystemContextBuiltIns", () => {
  test("disabled optional integrations support initialization, replacement, and transitions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "optional-context-"))
    try {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixtures/optional-context.ts")], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory,
          XDG_DATA_HOME: directory,
          XDG_CACHE_HOME: directory,
          XDG_STATE_HOME: directory,
          OPENCODE_TEST_HOME: directory,
          OPENCODE_CONFIG_CONTENT: "{}",
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, output + error).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toContain(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
        ].join("\n"),
      )
      expect(initialized.baseline).toContain(`Today's date: ${localDate(timestamp)}`)
      expect(initialized.baseline).toContain("Choose the smallest relevant project_check operation")
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service

      const baseline = (yield* SystemContext.initialize(yield* context.load())).baseline
      expect(baseline).toContain(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
        ].join("\n"),
      )
      expect(baseline).toContain(`Today's date: ${localDate(timestamp)}`)
      expect(baseline).toEndWith(`Instructions from: ${instructionFile}\nBe precise.`)
    }),
  )
})
