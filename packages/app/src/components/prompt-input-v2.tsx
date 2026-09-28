import { createStore } from "solid-js/store"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { Permission } from "@opencode-ai/schema/permission"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import type { ReferenceInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createResource, on, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { Token } from "@opencode-ai/core/util/token"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { DialogSelectModelUnpaidV2 } from "@/components/dialog-select-model-unpaid-v2"
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { normalizePromptHistoryEntry, promptLength, type PromptHistoryComment } from "@/components/prompt-input/history"
import { createPersistedPromptInputHistory } from "@/components/prompt-input/history-store"
import { promptDesignPlaceholder, promptPlaceholder } from "@/components/prompt-input/placeholder"
import { createPromptSubmit } from "@/components/prompt-input/submit"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { type ImageAttachmentPart, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createSessionTabs } from "@/pages/session/helpers"
import { showToast } from "@/utils/toast"
import { PromptInputV2, type PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import {
  createPromptInputV2Controller,
  createPromptInputV2State,
  type PromptInputV2Interaction,
} from "@opencode-ai/session-ui/v2/prompt-input/interaction"

export type PromptInputV2ComposerProps = {
  class?: string
  controller: PromptInputV2ComposerController
  borderUnderlay?: boolean
}

export type PromptInputV2ControllerProps = Omit<PromptInputProps, "class" | "submission">
export type PromptInputV2ComposerController = PromptInputV2Interaction & {
  readonly model: PromptInputProps["controls"]["model"]
  readonly approval: {
    current: () => Permission.ApprovalMode
    saving: () => boolean
    select: (mode: Permission.ApprovalMode) => Promise<void>
  }
}

export function PromptInputV2Composer(props: PromptInputV2ComposerProps) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const jev = () => serverSDK().jev
  const settings = useSettings()
  createEffect(
    on(
      () => serverSync().data.provider.connected.includes("openrouter"),
      () => void jev().refresh(),
    ),
  )
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-3">
      <PromptInputV2
        controller={props.controller}
        borderUnderlay={props.borderUnderlay}
        class={props.class}
        variantControlVisible={
          !props.controller.model.loading && !(jev().available() && props.controller.model.selection.auto())
        }
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        approvalControl={
          <SelectV2
            appearance="inline"
            data-action="prompt-approval"
            classList={{ "prompt-approval-full": props.controller.approval.current() === "full" }}
            icon={
              <Show when={props.controller.approval.current() === "full"}>
                <Icon name="shield" />
              </Show>
            }
            aria-label={language.t("approval.title")}
            options={["default", "ask", "auto", "full"] as Permission.ApprovalMode[]}
            current={props.controller.approval.current()}
            disabled={props.controller.approval.saving()}
            placement="top-start"
            label={(mode) => language.t(`approval.${mode}`)}
            onSelect={(mode) => mode && void props.controller.approval.select(mode)}
          >
            {(mode) => (
              <span data-slot="approval-mode-option" class="flex flex-col gap-1 leading-4">
                <span
                  class="flex items-center gap-2"
                  classList={{ "text-[var(--v2-state-fg-warning)]": mode === "full" }}
                >
                  <Show when={mode === "full"}>
                    <Icon name="shield" />
                  </Show>
                  {language.t(`approval.${mode}`)}
                </span>
                <span class="text-12 text-text-weak whitespace-normal max-w-72">
                  {language.t(`approval.${mode}.description`)}
                </span>
              </span>
            )}
          </SelectV2>
        }
        modelControl={
          <PromptInputV2ModelControl
            loading={props.controller.model.loading}
            paid={props.controller.model.paid || props.controller.model.selection.list().length > 0}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.controller.model.selection}
            providerID={props.controller.model.selection.current()?.provider?.id}
            modelName={
              jev().available() && props.controller.model.selection.auto()
                ? language.t("jev.auto")
                : (props.controller.model.selection.current()?.name ?? language.t("dialog.model.select.title"))
            }
            onClose={props.controller.restoreFocus}
            onUnpaidClick={() =>
              dialog.show(() => <DialogSelectModelUnpaidV2 model={props.controller.model.selection} />)
            }
          />
        }
        toolsControl={
          <div
            class="@container/prompt-tools min-w-6 flex-1"
            classList={{ "max-w-[80px]": jev().available(), "max-w-[52px]": !jev().available() }}
          >
            <div
              classList={{
                "@min-[80px]/prompt-tools:hidden": jev().available(),
                "@min-[52px]/prompt-tools:hidden": !jev().available(),
              }}
            >
              <MenuV2 gutter={6} modal={false} placement="top-end">
                <MenuV2.Trigger
                  as={IconButtonV2}
                  type="button"
                  variant="ghost-muted"
                  size="normal"
                  data-action="prompt-tools-menu"
                  icon={<Icon name="outline-dots" />}
                  aria-label={language.t("common.moreOptions")}
                />
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <Show when={jev().available()}>
                      <MenuV2.CheckboxItem
                        checked={jev().state.enabled}
                        disabled={!jev().state.loaded || jev().state.saving || jev().state.error}
                        onChange={(enabled) => void jev().update({ enabled })}
                        closeOnSelect={false}
                      >
                        <Icon name="settings-gear" />
                        {language.t("jev.name")}
                      </MenuV2.CheckboxItem>
                    </Show>
                    <MenuV2.CheckboxItem
                      checked={settings.general.browserVerification()}
                      disabled={!settings.ready()}
                      onChange={settings.general.setBrowserVerification}
                      closeOnSelect={false}
                    >
                      <Icon name="monitor" />
                      {language.t("prompt.browser.label")}
                    </MenuV2.CheckboxItem>
                    <MenuV2.CheckboxItem
                      checked={settings.general.independentTasks()}
                      disabled={!settings.ready()}
                      onChange={settings.general.setIndependentTasks}
                      closeOnSelect={false}
                    >
                      <Icon name="workspace-isolated" />
                      {language.t("prompt.independent.label")}
                    </MenuV2.CheckboxItem>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </div>
            <div
              class="hidden items-center gap-1"
              classList={{
                "@min-[80px]/prompt-tools:flex": jev().available(),
                "@min-[52px]/prompt-tools:flex": !jev().available(),
              }}
            >
              <Show when={jev().available()}>
                <TooltipV2 value={language.t(jev().state.enabled ? "jev.disable" : "jev.enable")}>
                  <IconButtonV2
                    type="button"
                    variant={jev().state.enabled ? "neutral" : "ghost-muted"}
                    size="normal"
                    data-action="prompt-jev"
                    icon={<Icon name="settings-gear" />}
                    aria-label={language.t("jev.name")}
                    aria-pressed={jev().state.enabled}
                    disabled={!jev().state.loaded || jev().state.saving || jev().state.error}
                    onClick={() => void jev().update({ enabled: !jev().state.enabled })}
                  />
                </TooltipV2>
              </Show>
              <TooltipV2
                value={language.t(
                  settings.general.browserVerification() ? "prompt.browser.automatic" : "prompt.browser.manual",
                )}
              >
                <IconButtonV2
                  type="button"
                  variant={settings.general.browserVerification() ? "neutral" : "ghost-muted"}
                  size="normal"
                  data-action="prompt-browser"
                  icon={<Icon name="monitor" />}
                  aria-label={language.t("session.panel.browser")}
                  aria-pressed={settings.general.browserVerification()}
                  disabled={!settings.ready()}
                  onClick={() => settings.general.setBrowserVerification(!settings.general.browserVerification())}
                />
              </TooltipV2>
              <TooltipV2
                value={language.t(
                  settings.general.independentTasks() ? "prompt.independent.on" : "prompt.independent.off",
                )}
              >
                <IconButtonV2
                  type="button"
                  variant={settings.general.independentTasks() ? "neutral" : "ghost-muted"}
                  size="normal"
                  data-action="prompt-independent"
                  icon={<Icon name="workspace-isolated" />}
                  aria-label={language.t("prompt.independent.label")}
                  aria-pressed={settings.general.independentTasks()}
                  disabled={!settings.ready()}
                  onClick={() => settings.general.setIndependentTasks(!settings.general.independentTasks())}
                />
              </TooltipV2>
            </div>
          </div>
        }
      />
    </div>
  )
}

export function usePromptInputV2Controller(props: PromptInputV2ControllerProps): PromptInputV2ComposerController {
  const settings = useSettings()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sync = useSync()
  const files = useFile()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = props.state ?? usePrompt()
  let editor: HTMLDivElement | undefined

  const interaction = createPromptInputV2State()
  const mode = () => interaction[0].mode
  const history = props.history ?? createPersistedPromptInputHistory()
  const tabs = () => props.controls.session.tabs
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab
  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((tab) => tab !== active)] : all
    return order.reduce<string[]>((result, tab) => {
      const path = files.pathFromTab(tab)
      if (!path || result.includes(path)) return result
      return [...result, path]
    }, [])
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const [approval, setApproval] = createStore<{ mode: Permission.ApprovalMode; saving: boolean }>({
    mode: "default",
    saving: false,
  })
  const [savedApproval] = createResource(
    () => (props.controls.session.id ? { id: props.controls.session.id, server: serverSDK() } : undefined),
    (source) => source.server.approval.get(source.id).catch(() => undefined),
  )
  createEffect(
    on(
      () => [props.controls.session.id, savedApproval()] as const,
      ([, mode]) => {
        setApproval("mode", mode ?? "default")
      },
    ),
  )
  const selectApproval = async (mode: Permission.ApprovalMode) => {
    const id = props.controls.session.id
    if (!id) {
      setApproval("mode", mode)
      return
    }
    const context = sdk()
    const permissions = permission.currentServerState()
    setApproval("saving", true)
    await serverSDK()
      .approval.set(id, mode)
      .then(() => {
        permissions.disableAutoAccept(id, context.directory)
        if (props.controls.session.id === id && sdk().scope === context.scope) setApproval("mode", mode)
      })
      .catch((error) => showToast({ title: language.t("common.requestFailed"), description: String(error) }))
      .finally(() => setApproval("saving", false))
  }
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const attachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const commentCount = createMemo(() => {
    if (mode() === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && attachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: mode(),
      commentCount: commentCount(),
      example: mode() === "shell" ? "git status" : "",
      suggest: false,
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )
  const designPlaceholder = () =>
    promptDesignPlaceholder(mode(), placeholder(), (key, params) =>
      language.t(key as Parameters<typeof language.t>[0], params as never),
    )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      const comment = item.comment?.trim()
      if (!comment) return []
      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({ start: item.selection.startLine, end: item.selection.endLine } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []
      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }
  const restoreHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file",
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })
  const submission = createPromptSubmit({
    prompt,
    info,
    imageAttachments: attachments,
    commentCount,
    autoAccept: accepting,
    approvalMode: () => approval.mode,
    browserVerification: settings.general.browserVerification,
    independentTasks: settings.general.independentTasks,
    mode,
    working,
    editor: () => editor,
    queueScroll: () => requestAnimationFrame(() => editor?.scrollIntoView({ block: "nearest" })),
    promptLength,
    addToHistory: (value, mode) => controller.addHistory(value, mode),
    resetHistoryNavigation: () => controller.resetHistory(),
    setMode: (next) => controller.dispatch({ type: next === "shell" ? "mode.shell" : "mode.normal" }),
    setPopover: (popover) => {
      if (!popover) controller.dispatch({ type: "popover.close" })
    },
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
    model: props.controls.model.selection,
  })

  const referenceDescription = (reference: ReferenceInfo) =>
    reference.source.type === "git" ? reference.source.repository : reference.source.path
  const references = createMemo(() =>
    sync()
      .data.reference.filter((reference) => !reference.hidden)
      .map((reference) => ({
        id: `reference:${reference.name}`,
        kind: "reference" as const,
        label: `@${reference.name}`,
        path: reference.path,
        description: reference.description ?? referenceDescription(reference),
        mention: {
          type: "file" as const,
          path: reference.path,
          content: `@${reference.name}`,
          start: 0,
          end: 0,
          mime: "application/x-directory",
          filename: reference.name,
        },
      })),
  )
  const resources = createMemo(() =>
    Object.values(sync().data.mcp_resource).map((resource) => ({
      id: `resource:${resource.server}:${resource.uri}`,
      kind: "resource" as const,
      label: `@${resource.name}`,
      path: resource.uri,
      description: resource.description,
      mention: {
        type: "file" as const,
        path: resource.uri,
        content: `@${resource.name}`,
        start: 0,
        end: 0,
        mime: resource.mimeType ?? "text/plain",
        filename: resource.name,
        url: resource.uri,
        source: {
          type: "resource" as const,
          text: { value: `@${resource.name}`, start: 0, end: resource.name.length + 1 },
          clientName: resource.server,
          uri: resource.uri,
        },
      },
      resource,
    })),
  )
  const context = createMemo<PromptInputV2Suggestion[]>(() => [
    ...references(),
    ...props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        label: `@${agent.name}`,
        mention: { type: "agent" as const, name: agent.name, content: `@${agent.name}`, start: 0, end: 0 },
      })),
    ...resources(),
    ...recent().map((path) => ({
      id: `file:${path}`,
      kind: "file" as const,
      label: path,
      path,
      recent: true,
      mention: { type: "file" as const, path, content: `@${path}`, start: 0, end: 0 },
    })),
  ])
  const [skills] = createResource(
    sdk,
    async (context) => {
      const result = await (async () => {
        if ((await context.protocol) === "v1") return (await context.client.app.skills()).data ?? []
        return (await context.api.skill.list({ location: { directory: context.directory } })).data
      })().catch(() => [])
      return Array.isArray(result) ? result : []
    },
    { initialValue: [] },
  )
  const slashCommands = createMemo(() => [
    ...sync().data.command.map((item) => ({
      id: `custom.${item.name}`,
      trigger: item.name,
      title: item.name,
      description: item.description,
      type: "custom" as const,
      source: item.source ?? "command",
      template: item.template,
    })),
    ...command.options
      .filter(
        (item) => (!item.disabled || item.id === "session.compact") && !item.id.startsWith("suggested.") && item.slash,
      )
      .map((item) => ({
        id: item.id,
        trigger: item.slash!,
        title: item.title,
        description: item.description,
        type: "builtin" as const,
        disabled: item.disabled,
        source: "builtin" as const,
        template: "",
      })),
  ])
  const commands = createMemo<PromptInputV2Suggestion[]>(() =>
    slashCommands().map((item) => {
      const skill =
        item.source === "skill" && !skills.loading
          ? skills.latest.find((skill) => skill.name === item.trigger)
          : undefined
      const location = skill?.location.replaceAll("\\", "/")
      const directory = sdk().directory.replaceAll("\\", "/").replace(/\/$/, "")
      const home = sync().data.path.home.replaceAll("\\", "/").replace(/\/$/, "")
      const origin = !location
        ? undefined
        : location === "<built-in>" || location.startsWith("/builtin/") || location.includes("/.system/")
          ? "system"
          : location.startsWith(`${directory}/`)
            ? "project"
            : home && location.startsWith(`${home}/`)
              ? "personal"
              : "system"
      return {
        id: item.id,
        kind: "command",
        label: `/${item.trigger}`,
        trigger: item.trigger,
        title: item.title,
        description: item.description,
        keybind: command.keybindParts(item.id),
        commandType: item.source,
        disabled: item.type === "builtin" && item.disabled,
        group: language.t(`prompt.slash.group.${item.source}`),
        badge: origin ? language.t(`prompt.slash.origin.${origin}`) : undefined,
        tooltip:
          item.source === "skill"
            ? language.t("prompt.slash.skillTokens", { count: Token.estimate(item.template) })
            : item.type === "builtin" && item.id === "session.compact" && item.disabled
              ? language.t("prompt.slash.compactUnavailable")
              : undefined,
      }
    }),
  )
  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  const controller = createPromptInputV2Controller({
    store: () => prompt.capture().store,
    state: interaction,
    identity: () => prompt.capture(),
    history: {
      entries: (mode) =>
        history.entries(mode).map((value) => {
          const entry = normalizePromptHistoryEntry(value)
          return { prompt: entry.prompt, metadata: entry.comments }
        }),
      add: (value, mode) => history.add(value, mode, mode === "shell" ? [] : historyComments()),
      capture: historyComments,
      restore: (metadata) => restoreHistoryComments(metadata as PromptHistoryComment[]),
    },
    commands,
    context,
    searchContextFiles: async (query) =>
      (await files.searchFilesAndDirectories(query)).map((path) => ({
        id: `file:${path}`,
        kind: "file",
        label: path,
        path,
        mention: { type: "file", path, content: `@${path}`, start: 0, end: 0 },
      })),
    onContextRemove(item) {
      if (item?.commentID) comments.remove(item.path, item.commentID)
    },
    openAttachment: (attachment) =>
      dialog.show(() => <ImagePreview src={attachment.blob.url} alt={attachment.filename} />),
    openContext(key) {
      const item = controller.contextItem(key)
      if (item) openComment(item, props, sync, layout, files, comments)
    },
    onEditor(element) {
      editor = element as HTMLDivElement
      props.ref?.(editor)
    },
    onSuggestionSelect(item) {
      if (item.kind !== "command") return
      const selected = slashCommands().find((entry) => entry.id === item.id)
      if (!selected || selected.type === "custom") return
      return () => command.trigger(selected.id, "slash")
    },
    attachments: {
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      isDialogActive: () => !!dialog.active,
      warn: () =>
        showToast({
          title: language.t("prompt.toast.pasteUnsupported.title"),
          description: language.t("prompt.toast.pasteUnsupported.description"),
        }),
      duplicate: () => showToast({ title: language.t("prompt.toast.attachmentDuplicate.title") }),
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      readClipboardImage: platform.readClipboardImage,
      getPathForFile: platform.getPathForFile,
      store: platform.draftStore?.putBlob,
    },
    view: {
      placeholder: designPlaceholder,
      get agent() {
        return props.controls.agents.visible && props.controls.agents.options.length > 0
          ? {
              options: () => props.controls.agents.options.map((name) => ({ id: name, label: name })),
              current: () => props.controls.agents.current,
              onSelect: (value: string) => props.controls.agents.select(value),
              keybind: () => command.keybindParts("agent.cycle"),
            }
          : undefined
      },
      variant: {
        options: () => variants().map((value) => ({ id: value, label: value })),
        current: () => props.controls.model.selection.variant.current() ?? "default",
        onSelect: (value) => props.controls.model.selection.variant.set(value === "default" ? undefined : value),
        keybind: () => command.keybindParts("model.variant.cycle"),
      },
      submit: {
        stopping,
        working,
        onSubmit: () => void submission.handleSubmit(new Event("submit")),
        onStop: () => void submission.abort(),
      },
    },
  })
  Object.defineProperty(controller, "approval", {
    value: {
      current: () => approval.mode,
      saving: () =>
        approval.saving || (!!props.controls.session.id && (savedApproval.loading || savedApproval() === undefined)),
      select: selectApproval,
    },
  })
  Object.defineProperty(controller, "model", { get: () => props.controls.model })

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: controller.state.mode !== "normal",
      onSelect: () => controller.attach(),
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+x",
      disabled: controller.state.mode === "shell",
      onSelect: () => controller.dispatch({ type: "mode.shell" }),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+e",
      disabled: controller.state.mode === "normal",
      onSelect: () => controller.dispatch({ type: "mode.normal" }),
    },
  ])

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return
        prompt.context.items().forEach((item) => prompt.context.remove(item.key))
        edit.context.forEach((item) =>
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          }),
        )
        controller.dispatch({ type: "mode.normal" })
        controller.resetHistory()
        prompt.set(edit.prompt, promptLength(edit.prompt))
        controller.restoreFocus()
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  return controller as PromptInputV2ComposerController
}

function PromptInputV2ModelControl(props: {
  loading: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: PromptInputV2ComposerController["model"]["selection"]
  providerID?: string
  modelName: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const content = () => (
    <>
      <Show when={props.providerID}>
        {(providerID) => (
          <ProviderIcon
            id={providerID()}
            class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            style={{ "will-change": "opacity", transform: "translateZ(0)" }}
          />
        )}
      </Show>
      <span class="truncate leading-4">{props.modelName}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )
  return (
    <Show when={!props.loading}>
      <TooltipV2
        placement="top"
        gutter={4}
        class="min-w-0"
        value={
          <>
            {props.title}
            <KeybindV2 keys={props.keybind} variant="neutral" />
          </>
        }
      >
        <Show
          when={props.paid}
          fallback={
            <ButtonV2
              data-action="prompt-model"
              data-control-type="dialog"
              variant="ghost-muted"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
              classList={{ "animate-in fade-in": shouldAnimate() }}
              style={{ height: "28px" }}
              onClick={props.onUnpaidClick}
            >
              {content()}
            </ButtonV2>
          }
        >
          <ModelSelectorPopoverV2
            model={props.model}
            trigger={(triggerProps) => (
              <ButtonV2
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="prompt-model"
                data-control-type="popover"
              >
                {content()}
              </ButtonV2>
            )}
            onClose={props.onClose}
          />
        </Show>
      </TooltipV2>
    </Show>
  )
}

function openComment(
  item: { path: string; commentID?: string; commentOrigin?: "review" | "file" },
  props: PromptInputV2ControllerProps,
  sync: ReturnType<typeof useSync>,
  layout: ReturnType<typeof useLayout>,
  files: ReturnType<typeof useFile>,
  comments: ReturnType<typeof useComments>,
) {
  if (!item.commentID) return
  const focus = { file: item.path, id: item.commentID }
  comments.setActive(focus)
  const queueFocus = (attempts = 6) => {
    requestAnimationFrame(() => {
      comments.setFocus({ ...focus })
      if (attempts <= 0) return
      requestAnimationFrame(() => {
        const current = comments.focus()
        if (current?.file === focus.file && current.id === focus.id) queueFocus(attempts - 1)
      })
    })
  }
  const diffs = props.controls.session.id ? sync().data.session_diff[props.controls.session.id] : undefined
  const review =
    item.commentOrigin === "review" || (item.commentOrigin !== "file" && diffs?.some((diff) => diff.file === item.path))
  if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
  if (review) {
    layout.fileTree.setTab("changes")
    props.controls.session.tabs.setActive("review")
    queueFocus()
    return
  }
  layout.fileTree.setTab("all")
  const tab = files.tab(item.path)
  void props.controls.session.tabs.open(tab)
  props.controls.session.tabs.setActive(tab)
  void Promise.resolve(files.load(item.path)).finally(() => queueFocus())
}
