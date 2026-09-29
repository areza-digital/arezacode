import { createEffect, createMemo, For, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Spinner } from "@opencode-ai/ui/spinner"
import { finishStartup } from "@opencode-ai/ui/logo"
import { useSessionTabAvatarState } from "./layout/project-avatar-state"
import { OverflowText } from "@opencode-ai/ui/overflow-text"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { useNotification } from "@/context/notification"
import { useTabs, tabKey } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { sessionTitle } from "@/utils/session-title"
import { shouldOpenSessionInBackground } from "./home-session-open"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeProjects } from "./home/home-projects"
import type { HomeProjectsViewProps } from "./home/home-projects-view"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { DialogCreateProjectV2 } from "@/components/dialog-edit-project-v2"
import { showToast } from "@/utils/toast"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionsController, registerHomeCommandPalette } from "./home/home-sessions-controller"

export function HomeSidebar(props: { onCollapse: () => void; debugTools?: { visible: boolean; toggle: () => void } }) {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  registerHomeCommandPalette(home)
  const layout = useLayout()
  const settings = useSettings()
  const notification = useNotification()
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()
  const act = (action: () => Promise<unknown>) =>
    void action().catch((error) => showToast({ title: language.t("common.requestFailed"), description: String(error) }))
  const [state, setState] = createStore({ search: "" })
  const selectedDraft = () => {
    const route = layout.route()
    return route.type === "draft" ? route.draftID : undefined
  }
  const selected = (id: string, server: ServerConnection.Key) => {
    const route = layout.route()
    return route.type === "session" && route.sessionId === id && route.server === server
  }
  createEffect(() => {
    const route = layout.route()
    const tab = tabs.store.find((tab) =>
      route.type === "draft"
        ? tab.type === "draft" && tab.draftID === route.draftID
        : route.type === "session" &&
          tab.type === "session" &&
          tab.sessionId === route.sessionId &&
          tab.server === route.server,
    )
    const directory = tab?.type === "draft" ? tab.directory : tab ? tabs.info[tabKey(tab)]?.directory : undefined
    if (!tab || !directory) return
    untrack(() => {
      const conn = home.server.list().find((conn) => ServerConnection.key(conn) === tab.server)
      if (!conn) return
      const project = home.project.forServer(conn).find((project) => {
        const assigned =
          tab.type === "session" ? home.server.context(conn).projects.assignment(tab.sessionId) : undefined
        return assigned
          ? assigned.project === project.worktree
          : project.worktree === directory ||
              project.folders?.includes(directory) ||
              project.sandboxes?.includes(directory)
      })
      home.selection.set({ server: tab.server, directory: project?.worktree ?? directory })
      if (project) home.server.context(conn).projects.expand(project.worktree)
    })
  })
  const renderSessions: NonNullable<HomeProjectsViewProps["renderSessions"]> = (expanded, conn, project) => {
    const sessions = createHomeSessionsController(home, Infinity, { server: conn, project, expanded })
    const records = createMemo<ReturnType<typeof sessions.data.searchRecords>>(
      (previous) =>
        expanded()
          ? sessions.data
              .searchRecords()
              .filter((record) => record.session.title.toLowerCase().includes(state.search.toLowerCase()))
          : previous,
      [],
    )
    const recordsByID = createMemo(() => new Map(records().map((record) => [record.session.id, record])))
    const chats = () => project().worktree === home.project.chatDirectory(conn)
    return (
      <Show when={!chats() || records().length}>
        <div class="mt-1 mb-3 flex flex-col gap-0.5">
          <Show when={chats()}>
            <div class="px-2 py-2 text-v2-text-text-muted">{language.t("sidebar.chats")}</div>
          </Show>
          <Show
            when={!sessions.data.loading()}
            fallback={
              <span class="px-2 py-2 text-v2-text-text-muted">{projects.copy.language.t("common.loading")}</span>
            }
          >
            <For
              each={[...recordsByID().keys()]}
              fallback={
                <span class="px-10 py-2 text-v2-text-text-faint">
                  {projects.copy.language.t("home.sessions.empty")}
                </span>
              }
            >
              {(id) => {
                const record = createMemo<ReturnType<typeof records>[number]>(
                  (previous) => recordsByID().get(id) ?? previous,
                  recordsByID().get(id)!,
                )
                return (
                  <div
                    class="group/chat relative flex min-w-0 items-center rounded-md hover:bg-v2-overlay-simple-overlay-hover"
                    classList={{
                      "bg-v2-background-bg-layer-03": selected(record().session.id, sessions.session.server()),
                    }}
                  >
                    <button
                      type="button"
                      data-component="home-session-row"
                      class="flex h-8 min-w-0 flex-1 items-center gap-3 rounded-md pr-9 text-left text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-muted"
                      classList={{
                        "text-v2-text-text-base": selected(record().session.id, sessions.session.server()),
                      }}
                      aria-current={selected(record().session.id, sessions.session.server()) ? "page" : undefined}
                      onClick={(event) => {
                        notification
                          .ensureServerState(sessions.session.server())
                          .session.markViewed(record().session.id)
                        if (layout.session.width() === 0) layout.session.resize(600)
                        sessions.session.open(record().session, {
                          background: shouldOpenSessionInBackground({
                            button: event.button,
                            mac: /Mac|iPod|iPhone|iPad/.test(navigator.platform),
                            meta: event.metaKey,
                            ctrl: event.ctrlKey,
                            shift: event.shiftKey,
                            alt: event.altKey,
                          }),
                        })
                      }}
                    >
                      <span class="flex w-7 shrink-0 items-center justify-center">
                        <SidebarSessionStatus
                          server={sessions.session.server()}
                          directory={record().session.directory}
                          sessionID={record().session.id}
                        />
                      </span>
                      <OverflowText fade>{sessionTitle(record().session.title) || record().session.id}</OverflowText>
                    </button>
                    <MenuV2 placement="bottom-end">
                      <MenuV2.Trigger
                        class="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-v2-text-text-muted opacity-0 hover:text-v2-text-text-base focus-visible:opacity-100 group-hover/chat:opacity-100 data-[expanded]:opacity-100"
                        aria-label={language.t("common.moreOptions")}
                      >
                        <Icon name="outline-dots" />
                      </MenuV2.Trigger>
                      <MenuV2.Portal>
                        <MenuV2.Content>
                          <MenuV2.Item
                            onSelect={() =>
                              dialog.show(() => (
                                <SidebarChatDialog
                                  title={language.t("common.rename")}
                                  value={record().session.title}
                                  onSubmit={(value) => sessions.session.rename(record().session, value)}
                                />
                              ))
                            }
                          >
                            {language.t("common.rename")}
                          </MenuV2.Item>
                          <MenuV2.Item onSelect={() => act(() => sessions.session.share(record().session))}>
                            {language.t("session.share.action.share")}...
                          </MenuV2.Item>
                          <MenuV2.Item onSelect={() => act(() => sessions.session.export(record().session))}>
                            {language.t("common.export")}...
                          </MenuV2.Item>
                          <MenuV2.Item
                            onSelect={() =>
                              dialog.show(() => (
                                <SidebarProjectDialog
                                  home={home}
                                  server={conn}
                                  onSelect={(project) => sessions.session.assign(record().session, project)}
                                />
                              ))
                            }
                          >
                            {language.t("session.project.assign")}
                          </MenuV2.Item>
                          <MenuV2.Item onSelect={() => act(() => sessions.session.archive(record().session))}>
                            {language.t("common.archive")}
                          </MenuV2.Item>
                          <MenuV2.Separator />
                          <MenuV2.Item
                            onSelect={() =>
                              dialog.show(() => (
                                <SidebarChatDialog
                                  title={language.t("session.delete.title")}
                                  description={language.t("session.delete.confirm", { name: record().session.title })}
                                  onSubmit={() => sessions.session.delete(record().session)}
                                />
                              ))
                            }
                          >
                            {language.t("common.delete")}...
                          </MenuV2.Item>
                        </MenuV2.Content>
                      </MenuV2.Portal>
                    </MenuV2>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>
    )
  }

  return (
    <div
      id="project-sidebar"
      data-component="project-sidebar"
      class="relative z-40 flex h-full min-h-0 max-w-[80vw] shrink-0 flex-col pl-3 max-md:absolute max-md:inset-y-2 max-md:left-0 max-md:h-auto max-md:bg-v2-background-bg-deep"
      style={{ width: `${Math.min(480, Math.max(220, layout.sidebar.width()))}px` }}
    >
      <ButtonV2
        variant="ghost-muted"
        icon="edit"
        class="mx-1 mr-4 mt-3 !justify-start"
        onClick={() => home.project.openChat()}
      >
        {language.t("sidebar.newChat")}
      </ButtonV2>
      <input
        type="search"
        class="mx-1 mr-4 mt-2 h-8 shrink-0 rounded-md bg-v2-background-bg-layer-02 px-3 text-v2-text-text-base outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-muted"
        value={state.search}
        onInput={(event) => setState("search", event.currentTarget.value)}
        placeholder={projects.copy.language.t("home.sessions.search.placeholder")}
        aria-label={projects.copy.language.t("home.sessions.search.placeholder")}
      />
      <HomeProjects
        projects={projects}
        chats={
          <For each={home.server.list()}>
            {(conn) =>
              renderSessions(
                () => true,
                conn,
                () => ({ worktree: home.project.chatDirectory(conn), expanded: true }),
              )
            }
          </For>
        }
        projectActive={(server, directory) => {
          const tab = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === selectedDraft())
          return tab?.type === "draft" && tab.server === server && tab.directory === directory
        }}
        renderSessions={renderSessions}
      />
      <ResizeHandle
        direction="horizontal"
        edge={settings.general.sidebarPosition() === "right" ? "start" : "end"}
        class="max-md:hidden"
        size={Math.min(480, Math.max(220, layout.sidebar.width()))}
        min={220}
        max={480}
        onResize={layout.sidebar.resize}
        onCollapse={props.onCollapse}
        onCollapseChange={layout.projectSidebar.previewCollapse}
        collapseThreshold={160}
        aria-label={projects.copy.language.t("sidebar.nav.projectsAndSessions")}
      />
    </div>
  )
}

function SidebarChatDialog(props: {
  title: string
  value?: string
  description?: string
  onSubmit: (value: string) => Promise<unknown>
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ value: props.value ?? "", busy: false, error: "" })
  return (
    <Dialog fit>
      <form
        class="contents"
        onSubmit={async (event) => {
          event.preventDefault()
          if (state.busy) return
          setState({ busy: true, error: "" })
          await props
            .onSubmit(state.value)
            .then(dialog.close)
            .catch((error) => setState("error", String(error)))
            .finally(() => setState("busy", false))
        }}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div class="flex min-w-[min(360px,80vw)] flex-col gap-3 p-4">
          <Show when={props.description}>
            <p>{props.description}</p>
          </Show>
          <Show when={props.value !== undefined}>
            <TextInputV2
              autofocus
              aria-label={language.t("common.rename")}
              value={state.value}
              onInput={(event) => setState("value", event.currentTarget.value)}
            />
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </div>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" onClick={dialog.close}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            type="submit"
            variant="contrast"
            disabled={state.busy || (props.value !== undefined && !state.value.trim())}
          >
            {props.title}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function SidebarProjectDialog(props: {
  home: ReturnType<typeof createHomeController>
  server: ServerConnection.Any
  onSelect: (directory: string) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const select = (directory: string) => {
    props.onSelect(directory)
    dialog.close()
  }
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("session.project.assign")}</DialogTitle>
      </DialogHeader>
      <div class="flex min-w-[min(360px,80vw)] flex-col gap-1 p-4">
        <ButtonV2 variant="ghost-muted" onClick={() => select("")}>
          {language.t("session.project.none")}
        </ButtonV2>
        <For each={props.home.project.forServer(props.server)}>
          {(project) => (
            <ButtonV2 variant="ghost-muted" onClick={() => select(project.worktree)}>
              {project.name || project.worktree.split(/[\\/]/).pop()}
            </ButtonV2>
          )}
        </For>
        <ButtonV2
          variant="neutral"
          onClick={() => dialog.show(() => <DialogCreateProjectV2 server={props.server} onSelect={props.onSelect} />)}
        >
          {language.t("project.create.title")}
        </ButtonV2>
      </div>
    </Dialog>
  )
}

function SidebarSessionStatus(props: { server: ServerConnection.Key; directory: string; sessionID: string }) {
  const language = useLanguage()
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionID,
  )
  const label = () =>
    language.t(
      state.status() === "waiting"
        ? "notification.permission.title"
        : state.status() === "error"
          ? "notification.session.error.title"
          : state.status() === "complete"
            ? "notification.session.responseReady.title"
            : "common.loading",
    )
  return (
    <Show when={state.status()}>
      <span
        data-component="sidebar-session-status"
        data-status={state.status()}
        class="flex size-4 shrink-0 items-center justify-center"
        role="img"
        aria-label={label()}
        title={label()}
      >
        <Show
          when={state.status() === "working"}
          fallback={
            <span
              class="size-2 rounded-full"
              style={{
                "background-color":
                  state.status() === "waiting" ? "#fbbf24" : state.status() === "error" ? "#ef4444" : "#34d399",
              }}
            />
          }
        >
          <Spinner class="size-4" />
        </Show>
      </span>
    </Show>
  )
}

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const language = useLanguage()
  const layout = useLayout()
  const settings = useSettings()
  let opening = false
  createEffect(() => {
    if (layout.ready() && settings.ready() && home.server.focusedSync().ready && !home.project.newSession())
      finishStartup()
  })
  createEffect(() => {
    if (opening || !home.server.focused() || !home.server.focusedSync().data.path.state) return
    opening = true
    untrack(home.project.openChat)
  })
  return (
    <div class="flex flex-1 self-stretch items-center justify-center">
      <ButtonV2
        icon="edit"
        variant="ghost-muted"
        onClick={() => {
          const conn = home.server.focused()
          if (conn) projects.project.choose(conn)
        }}
      >
        {language.t("sidebar.newChat")}
      </ButtonV2>
    </div>
  )
}
