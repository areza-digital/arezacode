import { For, Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import type { ProjectDependencies } from "@/project-dependencies"

export function ProjectDependenciesPanel(props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const server = useServer()
  const available = () => !!platform.checkDependencies && server.isLocal()
  const [state, setState] = createStore({
    data: undefined as ProjectDependencies | undefined,
    loading: false,
    query: "",
  })
  let revision = 0
  let queued = false
  createEffect(() => {
    sdk().directory
    server.key
    revision++
    queued = false
    setState({ data: undefined, loading: false, query: "" })
  })
  onCleanup(() => revision++)
  const check = async () => {
    if (!available()) return
    if (state.loading) {
      queued = true
      return
    }
    queued = false
    const current = ++revision
    setState({ loading: true })
    const data = await platform.checkDependencies!(sdk().directory).catch(() => ({ status: "failed" as const }))
    if (revision !== current) return
    setState({ data, loading: false })
    if (queued && props.active) void check()
  }
  createEffect(
    on([() => props.active, () => sdk().directory, () => server.key, available], () => {
      if (!props.active || !available()) return
      void check()
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = () => {
        clearTimeout(timer)
        timer = setTimeout(() => void check(), 300)
      }
      const stop = sdk().event.listen((event) => {
        if (event.details.type !== "file.watcher.updated") return
        if (
          !/(^|[/\\])(package\.json|bun\.lockb?|bunfig\.toml|\.nvmrc|\.node-version|\.bun-version|\.tool-versions)$/.test(
            event.details.properties.file,
          )
        )
          return
        refresh()
      })
      window.addEventListener("focus", refresh)
      const interval = setInterval(refresh, 300_000)
      onCleanup(() => {
        stop()
        clearTimeout(timer)
        clearInterval(interval)
        queued = false
        window.removeEventListener("focus", refresh)
      })
    }),
  )
  const result = () => (state.data?.status === "checked" ? state.data : undefined)
  const packages = createMemo(
    () =>
      result()?.packages.filter((item) =>
        `${item.name} ${item.workspace}`.toLowerCase().includes(state.query.trim().toLowerCase()),
      ) ?? [],
  )
  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col" data-component="project-dependencies">
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 p-4">
        <span class="text-14-medium text-text-strong">{language.t("session.panel.dependencies")}</span>
        <Button variant="ghost" size="small" disabled={!available() || state.loading} onClick={() => void check()}>
          {language.t(state.loading ? "dependencies.checking" : "session.panel.refresh")}
        </Button>
      </div>
      <ScrollView class="min-h-0 flex-1" viewportClass="flex min-w-0 flex-col gap-4 px-4 pb-4">
        <Show
          when={available()}
          fallback={
            <EmptyState
              icon={<Icon name="checklist" />}
              title={language.t("session.panel.dependencies")}
              description={language.t("dependencies.desktop")}
            />
          }
        >
          <Show when={state.loading && !state.data}>
            <div role="status" class="flex flex-1 flex-col">
              <EmptyState
                icon={<Icon name="checklist" />}
                title={language.t("dependencies.checking")}
                description={language.t("dependencies.scope")}
              />
            </div>
          </Show>
          <Show when={state.data?.environmentFailed}>
            <p role="alert" class="text-13-regular text-text-strong">
              {language.t("dependencies.environmentFailed")}
            </p>
          </Show>
          <Show when={state.data?.environment}>
            {(environment) => (
              <section class="flex min-w-0 flex-col gap-3" aria-label={language.t("dependencies.environment")}>
                <h3 class="text-13-medium text-text-strong">{language.t("dependencies.environment")}</h3>
                <p class="text-12-regular text-text-weak">{language.t("dependencies.runtimeScope")}</p>
                <dl class="flex flex-wrap gap-2 text-12-regular">
                  <For each={environment().runtimes}>
                    {(runtime) => (
                      <div class="min-w-0 basis-24 flex-1 break-all">
                        <dt class="text-text-weak">{language.t(`dependencies.runtime.${runtime.name}`)}</dt>
                        <dd class="text-text-strong">{runtime.version || language.t("dependencies.unavailable")}</dd>
                      </div>
                    )}
                  </For>
                </dl>
                <p class="text-12-regular text-text-weak">
                  {language.t("dependencies.coverage", { count: environment().workspaces.length })}
                </p>
                <For each={environment().workspaces}>
                  {(workspace) => (
                    <details class="min-w-0 rounded-lg border border-border-weaker-base p-3">
                      <summary class="cursor-pointer break-words text-13-medium text-text-strong">
                        {workspace.name}
                        <span class="block text-12-regular text-text-weak">
                          {language.t("dependencies.inventoryCount", { count: workspace.dependencies.length })}
                        </span>
                        <Show
                          when={
                            workspace.warnings.length ||
                            workspace.requirements.some((item) => item.status !== "matched") ||
                            workspace.dependencies.some(
                              (item) =>
                                item.status === "missing" || item.status === "mismatch" || item.status === "unverified",
                            )
                          }
                        >
                          <span class="block text-12-regular text-text-strong">
                            {language.t("dependencies.attention")}
                          </span>
                        </Show>
                      </summary>
                      <div class="mt-3 flex min-w-0 flex-col gap-3">
                        <p class="break-all text-12-regular text-text-weak">{workspace.path}</p>
                        <For each={workspace.warnings}>
                          {(warning) => (
                            <p class="text-12-regular text-text-strong">{language.t(`dependencies.${warning}`)}</p>
                          )}
                        </For>
                        <For each={workspace.requirements}>
                          {(item) => (
                            <p class="break-words text-12-regular text-text-weak">
                              {language.t("dependencies.requirement", {
                                name: item.name,
                                source: item.source,
                                required: item.required,
                                status: language.t(`dependencies.requirement.${item.status}`),
                              })}
                            </p>
                          )}
                        </For>
                        <For each={workspace.dependencies}>
                          {(item) => (
                            <div class="min-w-0 text-12-regular">
                              <p class="break-all text-text-strong">{item.name}</p>
                              <p class="break-all text-text-weak">
                                {language.t("dependencies.declaredVersion", { version: item.declared })}
                              </p>
                              <p class="break-all text-text-weak">
                                {language.t("dependencies.installedVersion", {
                                  version: item.installed || language.t("dependencies.unavailable"),
                                })}
                              </p>
                              <Show when={item.status !== "installed"}>
                                <p class="text-text-strong">{language.t(`dependencies.install.${item.status}`)}</p>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  )}
                </For>
              </section>
            )}
          </Show>
          <Show when={state.data && state.data.status !== "checked" ? state.data.status : undefined}>
            {(status) => (
              <div role="alert" class="flex flex-1 flex-col">
                <EmptyState
                  icon={<Icon name="checklist" />}
                  title={language.t("session.panel.dependencies")}
                  description={language.t(`dependencies.${status()}`)}
                />
              </div>
            )}
          </Show>
          <Show when={result()}>
            {(data) => (
              <>
                <Show
                  when={data().packages.length}
                  fallback={
                    <EmptyState
                      icon={<Icon name="checklist" />}
                      title={language.t("dependencies.upToDate")}
                      description={language.t("dependencies.upToDate.detail")}
                    />
                  }
                >
                  <p class="text-12-regular text-text-weak">{language.t("dependencies.scope")}</p>
                  <div role="status" class="text-13-medium text-text-strong">
                    {language.t("dependencies.count", { count: data().packages.length })}
                  </div>
                  <input
                    type="search"
                    class="w-full min-w-0 rounded-md border border-border-base bg-transparent px-3 py-2 text-13-regular text-text-strong focus-visible:outline-2 focus-visible:outline-border-active"
                    aria-label={language.t("dependencies.search")}
                    placeholder={language.t("dependencies.search")}
                    value={state.query}
                    onInput={(event) => setState("query", event.currentTarget.value)}
                  />
                  <p class="text-12-regular text-text-weak">{language.t("dependencies.guidance")}</p>
                  <Show when={data().packages.some((item) => item.ageLimited)}>
                    <p class="text-12-regular text-text-weak">{language.t("dependencies.ageLimited")}</p>
                  </Show>
                  <For
                    each={packages()}
                    fallback={<p class="text-13-regular text-text-weak">{language.t("dependencies.noMatches")}</p>}
                  >
                    {(item) => (
                      <article class="flex min-w-0 flex-col gap-2 rounded-lg border border-border-weaker-base p-3">
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <span class="min-w-0 break-all text-13-medium text-text-strong">{item.name}</span>
                          <span class="shrink-0 rounded bg-surface-base px-2 py-1 text-12-medium text-text-weak">
                            {language.t(`dependencies.${item.kind}`)}
                          </span>
                        </div>
                        <Show when={item.workspace}>
                          <p class="break-words text-12-regular text-text-weak">{item.workspace}</p>
                        </Show>
                        <dl class="grid min-w-0 grid-cols-3 gap-2 text-12-regular">
                          <div class="min-w-0">
                            <dt class="text-text-weak">{language.t("dependencies.current")}</dt>
                            <dd class="break-all text-text-strong">{item.current}</dd>
                          </div>
                          <div class="min-w-0">
                            <dt class="text-text-weak">{language.t("dependencies.update")}</dt>
                            <dd class="break-all text-text-strong">{item.update}</dd>
                          </div>
                          <div class="min-w-0">
                            <dt class="text-text-weak">{language.t("dependencies.latest")}</dt>
                            <dd class="break-all text-text-strong">{item.latest}</dd>
                          </div>
                        </dl>
                        <p class="text-12-regular text-text-weak">
                          {language.t(
                            item.kind === "major"
                              ? "dependencies.reviewMajor"
                              : item.update !== item.current
                                ? "dependencies.updateRange"
                                : "dependencies.reviewRange",
                          )}
                        </p>
                      </article>
                    )}
                  </For>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </ScrollView>
    </div>
  )
}
