/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test.each(["message", "part"] as const)(
  "uncached %s deletion survives hydration and keeps events flowing",
  async (kind) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const response = Promise.withResolvers<Response>()
    const errors = spyOn(console, "error").mockImplementation(() => {})
    let requested = false
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        requested = true
        return response.promise
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)
    try {
      const hydrate = sync.session.sync(sessionID)
      await wait(() => requested)
      expect(() =>
        emit(
          global(
            kind === "message"
              ? { id: "evt_delete", type: "message.removed", properties: { sessionID, messageID } }
              : { id: "evt_delete", type: "message.part.removed", properties: { sessionID, messageID, partID } },
          ),
        ),
      ).not.toThrow()
      emit(global({ id: "evt_status", type: "session.status", properties: { sessionID, status: { type: "busy" } } }))
      await wait(() => sync.data.session_status[sessionID]?.type === "busy")
      response.resolve(
        json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
      )
      await hydrate
      expect(sync.data.message[sessionID]).toHaveLength(kind === "message" ? 0 : 1)
      expect(sync.data.part[messageID] ?? []).toEqual([])
      expect(errors).not.toHaveBeenCalled()
    } finally {
      app.renderer.destroy()
      errors.mockRestore()
    }
  },
)

test("reconnect repairs missed completion and clears stale busy status", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requests++
      return json([
        {
          info: requests === 1 ? { ...assistant, time: { created: 1 } } : assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: requests === 1 ? "partial" : "completed" }],
        },
      ])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  try {
    await sync.session.sync(sessionID)
    sync.set("session_status", sessionID, { type: "busy" })
    emit(global({ id: "evt_connect1", type: "server.connected", properties: {} }))
    emit(global({ id: "evt_connect2", type: "server.connected", properties: {} }))
    await wait(() => sync.data.session_status[sessionID]?.type === "idle")
    expect(requests).toBe(2)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "completed" })
    expect(sync.data.message[sessionID][0].time).toMatchObject({ completed: 2 })
  } finally {
    app.renderer.destroy()
  }
})

test("reconnect snapshots preserve newer message, status, metadata and todo events", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const response = Promise.withResolvers<Response>()
  const page = [{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return ++requests === 1 ? json(page) : response.promise
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  try {
    await sync.session.sync(sessionID)
    sync.set("session_status", sessionID, { type: "busy" })
    const pending = sync.reconnect()
    await wait(() => requests === 2)
    emit(
      global({
        id: "evt_live_info",
        type: "session.updated",
        properties: { sessionID, info: { ...sync.session.get(sessionID)!, title: "new title" } },
      }),
    )
    emit(global({ id: "evt_live_status", type: "session.status", properties: { sessionID, status: { type: "busy" } } }))
    emit(
      global({
        id: "evt_live_message",
        type: "message.updated",
        properties: { sessionID, info: { ...assistant, time: { created: 1, completed: 3 } } },
      }),
    )
    emit(
      global({
        id: "evt_live_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 3,
          part: { id: partID, sessionID, messageID, type: "text", text: "new live text" },
        },
      }),
    )
    emit(
      global({
        id: "evt_live_todo",
        type: "todo.updated",
        properties: { sessionID, todos: [{ content: "new todo", status: "pending", priority: "high" }] },
      }),
    )
    await wait(() => sync.data.todo[sessionID]?.length === 1)
    response.resolve(json(page))
    await pending
    expect(sync.data.session_status[sessionID].type).toBe("busy")
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "new live text" })
    expect(sync.data.message[sessionID][0].time).toMatchObject({ completed: 3 })
    expect(sync.session.get(sessionID)?.title).toBe("new title")
    expect(sync.data.todo[sessionID][0].content).toBe("new todo")
  } finally {
    app.renderer.destroy()
  }
})

test("reconnect waits for pre-disconnect hydration and repeats after another connection", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const response = Promise.withResolvers<Response>()
  const { app, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requests++
      if (requests === 1) return response.promise
      return json([
        { info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: `fresh ${requests}` }] },
      ])
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  try {
    const initial = sync.session.sync(sessionID)
    await wait(() => requests === 1)
    const first = sync.reconnect()
    const second = sync.reconnect()
    response.resolve(json([]))
    await Promise.all([initial, first, second])
    expect(requests).toBe(3)
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "fresh 3" })
  } finally {
    app.renderer.destroy()
  }
})

test.each(["status", "history"] as const)(
  "failed reconnect %s remains retryable without clearing working state",
  async (failure) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let failing = false
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/session/status" && failing && failure === "status") return json({}, { status: 500 })
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        if (failing && failure === "history") return json({}, { status: 500 })
        return json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "saved" }] }])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)
    try {
      await sync.session.sync(sessionID)
      sync.set("session_status", sessionID, { type: "busy" })
      failing = true
      await expect(sync.reconnect()).rejects.toBeDefined()
      expect(sync.data.part[messageID][0]).toMatchObject({ text: "saved" })
      expect(sync.data.session_status[sessionID].type).toBe("busy")
      failing = false
      await sync.reconnect()
      expect(sync.data.session_status[sessionID].type).toBe("idle")
    } finally {
      app.renderer.destroy()
    }
  },
)

test("a newer reconnect retries after an older connection snapshot fails", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<Response>()
  let recovering = false
  let statuses = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/session/status" && recovering) return ++statuses === 1 ? response.promise : json({})
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (
      url.pathname === `/session/${sessionID}/message` ||
      url.pathname === `/session/${sessionID}/todo` ||
      url.pathname === `/session/${sessionID}/diff`
    )
      return json([])
    return undefined
  }, tmp.path)
  try {
    await sync.session.sync(sessionID)
    sync.set("session_status", sessionID, { type: "busy" })
    recovering = true
    const first = sync.reconnect()
    await wait(() => statuses === 1)
    const second = sync.reconnect()
    response.resolve(json({}, { status: 500 }))
    await Promise.all([first, second])
    expect(statuses).toBe(2)
    expect(sync.data.session_status[sessionID].type).toBe("idle")
  } finally {
    app.renderer.destroy()
  }
})

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
      }),
    )
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "hydrated" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test("live messages merged during hydration retain the 100 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
