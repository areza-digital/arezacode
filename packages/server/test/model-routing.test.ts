import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("V2 model list and Jev candidates exclude authenticated unsupported catalog APIs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "areza-model-routes-"))
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/model-routing.ts")], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: directory,
        XDG_DATA_HOME: directory,
        XDG_CACHE_HOME: directory,
        XDG_STATE_HOME: directory,
        OPENCODE_TEST_HOME: directory,
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_MODELS_PATH: path.resolve(import.meta.dir, "../../core/test/plugin/fixtures/models-dev.json"),
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
}, 30_000)
