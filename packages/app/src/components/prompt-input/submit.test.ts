import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import { createPromptState } from "@/context/prompt-state"
import { ServerConnection } from "@/context/server"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const approvalChanges: Array<{ server: string; sessionID: string; mode: string }> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let contextLocked = false
let healthGate: Promise<void> | undefined
let switchedServer = false
const sessionDrafts = new Map<string, ReturnType<typeof createPromptState>>()

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => undefined,
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        health: async (input: { sessionID: string }) => {
          await healthGate
          return { sessionID: input.sessionID, limit: 250_000, locked: contextLocked }
        },
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")
  const otherClient = clientFor("/repo/other")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@/utils/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => {
      const server = permissionServer
      return {
        approval: {
          set: async (sessionID: string, mode: string) => {
            approvalChanges.push({ server, sessionID, mode })
          },
        },
      }
    },
  }))

  mock.module("@/context/server", () => ({
    ServerConnection: { ...ServerConnection, key: () => "server-key" },
    useServer: () => ({
      key: "server-key",
      projects: { forServer: () => ({ assignment: () => undefined, list: () => [] }) },
    }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      state: (tab: { sessionId: string }) => {
        const state = sessionDrafts.get(tab.sessionId) ?? createPromptState()
        sessionDrafts.set(tab.sessionId, state)
        return state
      },
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      const other = { ...sdk, scope: "other", directory: "/repo/other", api: otherClient.api }
      return () => (switchedServer ? other : sdk)
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      homeSessions: { apply: () => undefined },
      session: {
        remember: () => undefined,
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  approvalChanges.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  contextLocked = false
  healthGate = undefined
  switchedServer = false
  sessionDrafts.clear()
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test.each(["edit", "switch", "repeat"] as const)(
    "new-session creation preserves the origin during %s",
    async (change) => {
      const gate = Promise.withResolvers<void>()
      createSessionGate = gate.promise
      search.draftId = "draft-a"
      const original = createPromptState({ prompt: "original request" })
      const sibling = createPromptState({ prompt: "sibling request" })
      let current = original
      const changedModes: string[] = []
      const submit = createPromptSubmit({
        prompt: { ...original, capture: () => current },
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => "normal",
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: () => 16,
        addToHistory: () => undefined,
        resetHistoryNavigation: () => undefined,
        setMode: (mode) => changedModes.push(mode),
        setPopover: () => undefined,
      })
      const pending = submit.handleSubmit({ preventDefault() {} } as Event)
      if (change === "repeat") await submit.handleSubmit({ preventDefault() {} } as Event)
      if (change === "edit") original.set([{ type: "text", content: "newer request", start: 0, end: 13 }])
      if (change === "switch") {
        current = sibling
        search.draftId = "draft-b"
        switchedServer = true
      }
      gate.resolve()
      await pending
      await Bun.sleep(0)
      expect(sentPrompts).toEqual(["/repo/main"])
      expect(createdSessions).toHaveLength(1)
      expect(promptInputs[0]).toMatchObject({ text: expect.stringContaining("original request") })
      expect(sibling.current()[0]).toMatchObject({ content: "sibling request" })
      expect(changedModes).toEqual([])
      if (change === "edit") {
        expect(original.current()[0]).toMatchObject({ content: "newer request" })
        expect(promotedDrafts).toEqual([])
      }
      if (change === "switch") {
        expect(promotedDrafts).toEqual([{ draftID: "draft-a", server: "project-server", sessionId: "session-1" }])
        expect(promoted).toEqual([])
      }
    },
  )

  test("switching isolation off cannot overtake an independent submission still being prepared", async () => {
    const { sendFollowupDraft } = await import("./submit")
    params = { id: "session-1" }
    const gate = Promise.withResolvers<boolean>()
    const first = sendFollowupDraft({
      scope: "local",
      before: () => gate.promise,
      api: { prompt: async () => undefined },
      serverSync: { session: { set: () => undefined } },
      sync: { data: { command: [] }, session: { optimistic: { add: () => undefined, remove: () => undefined } } },
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [],
        context: [],
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        independent: true,
      },
    } as unknown as Parameters<typeof sendFollowupDraft>[0])
    const queued: Array<{ independent?: boolean }> = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      independentTasks: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => false,
      onQueue: (draft) => queued.push(draft),
    })
    await submit.handleSubmit({ preventDefault() {} } as Event)
    expect(queued).toMatchObject([{ independent: false }])
    expect(sentPrompts).toEqual([])
    gate.resolve(false)
    expect(await first).toBe(false)
  })
  test("captures independent mode before awaiting health and preserves it on a queued draft", async () => {
    params = { id: "session-1" }
    contextLocked = true
    const gate = Promise.withResolvers<void>()
    healthGate = gate.promise
    let independent = true
    const queued: Array<{ independent?: boolean }> = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      independentTasks: () => independent,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
    })
    const pending = submit.handleSubmit({ preventDefault() {} } as Event)
    independent = false
    gate.resolve()
    await pending
    expect(queued).toMatchObject([{ independent: true }])
    expect(sentPrompts).toEqual([])
  })
  for (const mode of ["normal", "shell"] as const) {
    test(`preserves the draft and queue when context is locked in ${mode} mode`, async () => {
      params = { id: "session-1" }
      contextLocked = true
      const original = promptValue
      let queued = false
      let history = false
      const submit = createPromptSubmit({
        prompt,
        info: () => ({ id: "session-1" }),
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => mode,
        working: () => true,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: () => 2,
        addToHistory: () => {
          history = true
        },
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
        shouldQueue: () => true,
        onQueue: () => {
          queued = true
        },
      })
      await submit.handleSubmit({ preventDefault() {} } as Event)
      expect(promptValue).toBe(original)
      expect(queued).toBe(false)
      expect(history).toBe(false)
      expect(sentPrompts).toEqual([])
      expect(sentShell).toEqual([])
      expect(optimistic).toEqual([])
    })
  }

  test("does not submit into another chat after a delayed health check", async () => {
    params = { id: "session-1" }
    const gate = Promise.withResolvers<void>()
    healthGate = gate.promise
    const submit = createPromptSubmit({
      prompt,
      info: () => (params.id ? { id: params.id } : undefined),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    params.id = "session-2"
    gate.resolve()
    await sending
    expect(sentPrompts).toEqual([])
    expect(optimistic).toEqual([])
  })

  test("sends the captured browser preference for each draft", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const requests: Array<{
      text: string
      independent?: boolean
      legacyParts: Array<{ metadata?: { browserVerification?: string } }>
    }> = []
    for (const automatic of [false, true, false]) {
      await sendFollowupDraft({
        api: {
          prompt: async (input: (typeof requests)[number]) => {
            requests.push(input)
          },
        },
        serverSync: { session: { set: () => undefined } },
        sync: { data: { command: [] }, session: { optimistic: { add: () => undefined, remove: () => undefined } } },
        draft: {
          sessionID: "session-browser",
          sessionDirectory: "/repo",
          prompt: [{ type: "text", content: "Check layout", start: 0, end: 12 }],
          context: [],
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
          browserVerification: automatic,
          independent: automatic,
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0])
    }
    expect(requests.map((request) => request.legacyParts.at(-1)?.metadata?.browserVerification)).toEqual([
      "manual",
      "automatic",
      "manual",
    ])
    expect(requests.map((request) => request.independent)).toEqual([undefined, true, undefined])
    expect(requests[0].text).toContain("Do not run browser checks")
    expect(requests[1].text).toContain("Browser checks are already approved")
    expect(requests[2].text).toContain("marked unverified")
  })

  test("sends every selected source folder and explicitly clears detached project context", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const requests: Array<{ text: string }> = []
    for (const project of [{ name: "Named project", folders: ["/source/api", "/source/site"] }, null]) {
      await sendFollowupDraft({
        api: {
          prompt: async (input: (typeof requests)[number]) => {
            requests.push(input)
          },
        },
        serverSync: { session: { set: () => undefined } },
        sync: { data: { command: [] }, session: { optimistic: { add: () => undefined, remove: () => undefined } } },
        draft: {
          sessionID: "project-chat",
          sessionDirectory: "/state/chats",
          prompt: [{ type: "text", content: "Review", start: 0, end: 6 }],
          context: [],
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
          project,
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0])
    }
    expect(requests[0].text).toContain("/source/api")
    expect(requests[0].text).toContain("/source/site")
    expect(requests[0].text).toContain("pass this context to subagents")
    expect(requests[1].text).toContain("No project is selected")
    expect(requests[1].text).not.toContain("/source/api")
  })

  test("waits for Jev and executes its model and effort; uncertain Auto never sends", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const gate = Promise.withResolvers<{
      status: "ready"
      routing: "selected"
      model: { providerID: string; modelID: string; variant: string }
      skills: []
    }>()
    const requests: unknown[] = []
    const messages: Array<{ model: { modelID: string; variant?: string } }> = []
    const base = {
      api: {
        prompt: async (input: unknown) => {
          requests.push(input)
        },
      },
      serverSync: { session: { set: () => undefined } },
      sync: {
        data: { command: [] },
        session: {
          optimistic: {
            add: (input: { message: (typeof messages)[number] }) => messages.push(input.message),
            remove: () => undefined,
          },
        },
      },
      draft: {
        sessionID: "session-route",
        sessionDirectory: "/repo",
        prompt: [{ type: "text", content: "Review authentication", start: 0, end: 21 }],
        context: [],
        agent: "build",
        model: { providerID: "original", modelID: "original" },
        variant: "low",
        jev: { auto: true, models: [{ providerID: "chosen", modelID: "astra", variant: "high" }] },
      },
      jev: { state: { enabled: true, routing: true }, prepare: () => gate.promise },
      routingError: "Choose a model or retry",
    }
    const pending = sendFollowupDraft(base as unknown as Parameters<typeof sendFollowupDraft>[0])
    await Bun.sleep(0)
    expect(requests).toHaveLength(0)
    gate.resolve({
      status: "ready",
      routing: "selected",
      model: { providerID: "chosen", modelID: "astra", variant: "high" },
      skills: [],
    })
    expect(await pending).toBe(true)
    expect(requests).toMatchObject([{ model: { providerID: "chosen", modelID: "astra" }, variant: "high" }])
    expect(messages[0].model.modelID).toBe("")
    expect(messages[1].model).toMatchObject({ modelID: "astra", variant: "high" })
    expect(messages[1]).not.toBe(messages[0])
    const uncertain = {
      ...base,
      jev: { state: base.jev.state, prepare: async () => ({ status: "ready", routing: "uncertain", skills: [] }) },
    }
    await expect(sendFollowupDraft(uncertain as unknown as Parameters<typeof sendFollowupDraft>[0])).rejects.toThrow(
      "Choose a model or retry",
    )
    expect(requests).toHaveLength(1)
  })

  test("Stop cancels pending Jev preparation immediately without sending a late decision", async () => {
    const { sendFollowupDraft } = await import("./submit")
    params = { id: "session-cancel" }
    const started = Promise.withResolvers<AbortSignal>()
    const decision = Promise.withResolvers<undefined>()
    let restored = false
    let sent = false
    const sending = sendFollowupDraft({
      scope: "local",
      api: {
        prompt: async () => {
          sent = true
        },
      },
      serverSync: { session: { set() {} } },
      sync: { data: { command: [] }, session: { optimistic: { add() {}, remove() {} } } },
      draft: {
        sessionID: params.id,
        sessionDirectory: "/repo/main",
        prompt: promptValue,
        context: [],
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      jev: {
        state: { enabled: true },
        prepare: (_: unknown, __: string, signal: AbortSignal) => {
          started.resolve(signal)
          return decision.promise
        },
      },
      onCancel: () => {
        restored = true
      },
    } as unknown as Parameters<typeof sendFollowupDraft>[0])
    const signal = await started.promise
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-cancel" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll() {},
      promptLength: () => 2,
      addToHistory() {},
      resetHistoryNavigation() {},
      setMode() {},
      setPopover() {},
    })
    await submit.abort()
    expect(signal.aborted).toBe(true)
    expect(restored).toBe(true)
    expect(await sending).toBe(false)
    decision.resolve(undefined)
    await Promise.resolve()
    expect(sent).toBe(false)
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("binds the approval mode and server when sending a new chat", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let selectedApproval: "ask" | "full" = "ask"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      approvalMode: () => selectedApproval,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    selectedApproval = "full"
    release()
    await result

    expect(enabledAutoAccept).toEqual([])
    expect(approvalChanges).toEqual([{ server: "server-a", sessionID: "session-1", mode: "ask" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: expect.stringContaining("Browser verification preference selected by the user: MANUAL."),
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect(
      (
        promptInputs[0] as {
          legacyParts?: {
            id: string
            type: string
            text?: string
            synthetic?: boolean
            metadata?: Record<string, unknown>
          }[]
        }
      ).legacyParts,
    ).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
      {
        id: expect.stringMatching(/^prt_/),
        type: "text",
        synthetic: true,
        text: expect.stringContaining("Do not ask the user to choose manual or automatic."),
        metadata: { browserVerification: "manual" },
      },
      {
        id: expect.stringMatching(/^prt_/),
        type: "text",
        synthetic: true,
        text: expect.stringContaining("No project is selected for this chat."),
        metadata: { projectContext: true },
      },
    ])
  })

  test.each([
    ["/review staged changes", "staged changes"],
    ["please /review staged changes", "please staged changes"],
    ["staged changes /review", "staged changes"],
    ["please\n/review\nstaged changes", "please staged changes"],
    ["check src/review /review staged changes", "check src/review staged changes"],
  ])("submits slash commands anywhere through the current session API: %s", async (content, argumentsText) => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content, start: 0, end: content.length }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      browserVerification: () => true,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    await Bun.sleep(0)
    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: argumentsText,
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [
          {
            name: "browser-verification.txt",
            uri: expect.stringContaining(
              encodeURIComponent("Browser verification preference selected by the user: AUTOMATIC."),
            ),
          },
          {
            name: "project-context.txt",
            uri: expect.stringContaining(encodeURIComponent("No project is selected for this chat.")),
          },
        ],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})
