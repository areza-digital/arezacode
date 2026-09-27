/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The failure path is `sync.tsx#sync.session.sync` reading
 * `messages.data!` while the SDK leaves `data` undefined on error.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("failed history preserves cached messages and retries on the next entry", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      title: "broken",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    let requests = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`) {
        requests++
        return requests === 1 ? json({}, { status: 500 }) : json([])
      }
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      if (url.pathname === "/session") return json([sessionPayload])
      return undefined
    }, tmp.path)

    try {
      sync.set("message", sessionID, [
        {
          id: "msg_cached",
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        },
      ])
      await expect(sync.session.sync(sessionID)).rejects.toBeDefined()
      expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_cached"])
      await sync.session.sync(sessionID)
      expect(requests).toBe(2)
      expect(sync.data.message[sessionID]).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})
