import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"
import { createPromptSession } from "@/context/prompt-state"
import type { createJevClient } from "@/utils/jev"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()
const independentSubmissions = new Set<string>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  browserVerification?: boolean
  independent?: boolean
  project?: { name: string; folders: string[] } | null
  jev?: { auto: boolean; models: { providerID: string; modelID: string; variant?: string }[] }
}

type FollowupSendInput = {
  scope?: DirectorySDK["scope"]
  jev?: ReturnType<typeof createJevClient>
  routingError?: string
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  onCancel?: () => void
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export function sendFollowupDraft(input: FollowupSendInput) {
  const key = input.draft.independent && input.scope ? ScopedKey.from(input.scope, input.draft.sessionID) : undefined
  if (key) independentSubmissions.add(key)
  return sendDraft(input).finally(() => {
    if (key) independentSubmissions.delete(key)
  })
}

async function sendDraft(input: FollowupSendInput) {
  const browserVerification = input.draft.browserVerification
    ? "Browser verification preference selected by the user: AUTOMATIC. Browser checks are already approved for this request; perform relevant checks without asking the user to choose manual or automatic. Keep checks focused. Apply this preference to subagents. Other tool permissions still apply."
    : "Browser verification preference selected by the user: MANUAL. Do not run browser checks, shell-driven browser automation, or delegated browser checks. Do not ask the user to choose manual or automatic. Provide a brief manual test checklist with expected results, marked unverified. Apply this preference to subagents."
  const projectContext =
    input.draft.project === undefined
      ? undefined
      : input.draft.project
        ? `The user selected project ${JSON.stringify(input.draft.project.name)}. Its source folders are ${JSON.stringify(input.draft.project.folders)}. Use these folders as project context, use explicit paths when working across them, and pass this context to subagents. Existing tool permissions still apply.`
        : "No project is selected for this chat. Do not assume that a project selected in an earlier turn is still attached. Existing tool permissions still apply."
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const decision: { result?: Awaited<ReturnType<ReturnType<typeof createJevClient>["prepare"]>> } = {}
  const wait = async (cleanup: VoidFunction = setIdle, promptID?: string) => {
    const ok = await input.before?.()
    if (ok === false) return false
    const abort = new AbortController()
    const key = input.scope ? ScopedKey.from(input.scope, input.draft.sessionID) : undefined
    const entry = {
      abort,
      cleanup: () => {
        cleanup()
        input.onCancel?.()
      },
    }
    if (key) pending.set(key, entry)
    const cancelled = Promise.withResolvers<undefined>()
    const cancel = () => cancelled.resolve(undefined)
    abort.signal.addEventListener("abort", cancel, { once: true })
    try {
      decision.result = await Promise.race([
        input.jev?.prepare(
          {
            sessionID: input.draft.sessionID,
            promptID,
            text,
            agent: input.draft.agent,
            auto: input.draft.jev?.auto ?? false,
            independent: input.draft.independent,
            images: images.length > 0,
            models: input.draft.jev?.models ?? [],
          },
          input.draft.sessionDirectory,
          abort.signal,
        ),
        cancelled.promise,
      ])
      if (!input.jev?.state.enabled) decision.result = undefined
      if (
        !abort.signal.aborted &&
        input.draft.jev?.auto &&
        input.jev?.state.enabled &&
        input.jev.state.routing &&
        !decision.result?.model
      )
        throw new Error(input.routingError ?? "jev.routingUnavailable")
      return !abort.signal.aborted
    } finally {
      abort.signal.removeEventListener("abort", cancel)
      if (key && pending.get(key) === entry) pending.delete(key)
    }
  }

  const command = Array.from(text.matchAll(/(?:^|\s)\/(\S+)/g)).find((match) =>
    input.sync.data.command.some((item) => item.name === match[1]),
  )
  if (command) {
    setBusy()
    try {
      const messageID = Identifier.ascending("message")
      if (!(await wait(setIdle, messageID))) {
        setIdle()
        return false
      }

      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: command[1]!,
        ...(input.draft.independent ? { independent: true } : {}),
        arguments: [text.slice(0, command.index).trim(), text.slice(command.index + command[0].length).trim()]
          .filter(Boolean)
          .join(" "),
        agent: input.draft.agent,
        model: {
          id: decision.result?.model?.modelID ?? input.draft.model.modelID,
          providerID: decision.result?.model?.providerID ?? input.draft.model.providerID,
          variant: decision.result?.model ? decision.result.model.variant : input.draft.variant,
        },
        files: [
          {
            uri: `data:text/plain;charset=utf-8,${encodeURIComponent(browserVerification)}`,
            name: "browser-verification.txt",
          },
          ...(projectContext
            ? [
                {
                  uri: `data:text/plain;charset=utf-8,${encodeURIComponent(projectContext)}`,
                  name: "project-context.txt",
                },
              ]
            : []),
          ...(await Promise.all(
            images.map(async (attachment) => ({
              uri: await blobDataUrl(attachment.blob, attachment.mime),
              name: attachment.filename,
            })),
          )),
          ...(decision.result?.skills ?? []).map((skill) => ({
            uri: `data:text/plain;charset=utf-8,${encodeURIComponent(skill.content)}`,
            name: `${skill.name}.txt`,
          })),
        ],
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: {
      ...input.draft.model,
      modelID:
        input.draft.jev?.auto && input.jev?.state.enabled && input.jev.state.routing ? "" : input.draft.model.modelID,
      variant: input.draft.variant,
    },
  }

  const add = (model = message.model) =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message: { ...message, model },
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (
      !(await wait(() => {
        setIdle()
        remove()
      }, messageID))
    ) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    const prepared = decision.result
    const selected = prepared?.model ?? input.draft.model
    if (prepared?.model || !message.model.modelID) {
      add({ ...selected, variant: prepared?.model ? prepared.model.variant : input.draft.variant })
    }
    if (input.jev?.state.enabled) {
      for (const skill of prepared?.skills ?? [])
        requestParts.push({
          id: Identifier.ascending("part"),
          type: "text",
          synthetic: true,
          text: skill.content,
          metadata: { jevSkill: skill.name },
        })
    }
    requestParts.push({
      id: Identifier.ascending("part"),
      type: "text",
      synthetic: true,
      text: browserVerification,
      metadata: { browserVerification: input.draft.browserVerification ? "automatic" : "manual" },
    })
    if (projectContext)
      requestParts.push({
        id: Identifier.ascending("part"),
        type: "text",
        synthetic: true,
        text: projectContext,
        metadata: { projectContext: true },
      })
    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      ...(input.draft.independent ? { independent: true } : {}),
      agent: input.draft.agent,
      model: input.jev?.state.enabled ? selected : input.draft.model,
      variant: prepared?.model ? prepared.model.variant : input.draft.variant,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  approvalMode?: Accessor<"default" | "ask" | "auto" | "full">
  browserVerification?: Accessor<boolean>
  independentTasks?: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const serverSDK = useServerSDK()
  const prompt = input.prompt
  const layout = useLayout()
  const server = useServer()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .api.session.interrupt({ sessionID })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (owner: ServerSync, dir: string, info: Session) => {
    owner.session.remember(info)
    owner.homeSessions.apply({ type: "session.created", properties: { sessionID: info.id, info } })
    const [, setStore] = owner.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const submitting = new WeakSet<ReturnType<typeof prompt.capture>>()
  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    const target = prompt.capture()
    if (submitting.has(target)) return
    submitting.add(target)
    return submit(event, sdk(), sync(), serverSDK(), serverSync()).finally(() => submitting.delete(target))
  }
  const currentSDK = sdk

  const submit = async (
    event: Event,
    origin: DirectorySDK,
    originSync: DirectorySync,
    originServer: ReturnType<ReturnType<typeof useServerSDK>>,
    originServerSync: ServerSync,
  ) => {
    event.preventDefault()

    const sdk = () => origin
    const sync = () => originSync
    const serverSDK = () => originServer
    const serverSync = () => originServerSync
    const pendingKey = (sessionID: string) => ScopedKey.from(origin.scope, sessionID)
    const draftID = search.draftId
    const draftServer = draftID ? tabs.draft(draftID).server : ServerConnection.key(originServer.server)
    const target = prompt.capture()
    const active = () => currentSDK() === origin && prompt.capture() === target && search.draftId === draftID
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const independent = mode === "normal" && (input.independentTasks?.() ?? false)

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    if (params.id) {
      const sessionID = params.id
      const origin = sdk()
      const health = await origin.api.session.health({ sessionID }).catch((error) => {
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorMessage(error) })
      })
      if (!health) return
      if (health.locked && !independent) {
        showToast({ title: language.t("context.health.lockedMessage") })
        return
      }
      if (
        params.id !== sessionID ||
        currentSDK() !== origin ||
        !submission.current(prompt.capture()) ||
        !submission.unchanged()
      )
        return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const approvalApi = serverSDK().approval
    const approvalMode = input.approvalMode?.()
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && (!approvalMode || approvalMode === "default") && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    const browserVerification = input.browserVerification?.() ?? false
    const auto = modelSelection.auto?.() ?? false

    let sessionDirectory = projectDirectory
    let client = sdk().client
    let session = input.info()

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      if (active()) input.onNewSessionWorktreeReset?.()
    }

    if (!session && isNewSession) {
      const created = await sdk()
        .api.session.create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        })
        .then(async (session) => {
          if (approvalMode && approvalMode !== "default") await approvalApi.set(session.id, approvalMode)
          return normalizeSessionInfo(session)
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(originServerSync, sessionDirectory, created)
        session = created
        await startTransition(() => {
          if (!session) return
          if (shouldAutoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
          if (!submission.unchanged()) return
          if (active())
            local.session.promote(sessionDirectory, session.id, {
              agent: currentAgent.name,
              model: {
                providerID: currentModel.provider.id,
                modelID: currentModel.id,
                auto,
              },
              variant: variant ?? null,
            })
          if (active()) layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          if (draftID) {
            const next = { type: "session" as const, server: draftServer, sessionId: session.id }
            submission.retarget(
              tabs.state(next, "prompt", () =>
                createPromptSession(origin.scope, { dir: base64Encode(sessionDirectory), id: next.sessionId }),
              ),
            )
            tabs.promoteDraft(draftID, { server: draftServer, sessionId: session.id })
            return
          }
          if (!active()) return
          submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
          navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        })
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const projects = server.projects.forServer(ServerConnection.key(serverSDK().server))
    const assignment = projects.assignment(session.id)
    const project = projects.list().find((item) => item.worktree === (assignment?.project ?? sessionDirectory))
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      browserVerification,
      independent,
      project: project
        ? { name: project.name || project.worktree, folders: [...(project.folders ?? [project.worktree])] }
        : null,
      jev: {
        auto,
        models: sdk().jev?.state.enabled
          ? modelSelection
              .list()
              .filter((item) => modelSelection.visible({ providerID: item.provider.id, modelID: item.id }))
              .flatMap((item) =>
                [undefined, ...Object.keys(item.variants ?? {})].map((variant) => ({
                  providerID: item.provider.id,
                  modelID: item.id,
                  variant,
                })),
              )
              .slice(0, 255)
          : [],
      },
    }

    const clearInput = () => {
      const cleared = submission.clear()
      if (cleared && submission.current(prompt.capture())) {
        input.setMode("normal")
        input.setPopover(null)
      }
      return cleared
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (
      !isNewSession &&
      mode === "normal" &&
      (input.shouldQueue?.() || independentSubmissions.has(pendingKey(session.id)))
    ) {
      if (!input.onQueue) return
      input.onQueue?.(draft)
      if (clearInput()) clearContext(submission.target())
      return
    }

    const notify = submission.current(prompt.capture()) && submission.unchanged()

    if (mode === "shell") {
      clearInput()
      if (notify) input.onSubmit?.()
      const eventID = Event.ID.create()
      sdk()
        .api.session.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    if (clearInput()) for (const item of commentItems) submission.target().context.remove(item.key)
    if (notify) input.onSubmit?.()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      scope: sdk().scope,
      jev: sdk().jev,
      routingError: language.t("jev.routingUnavailable"),
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      onCancel: () => {
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      },
    })
      .then((sent) => {
        if (!sent && restoreInput()) restoreCommentItems(submission.target(), commentItems)
      })
      .catch((err) => {
        pending.delete(pendingKey(session.id))
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      })
  }

  return {
    abort,
    handleSubmit,
  }
}
