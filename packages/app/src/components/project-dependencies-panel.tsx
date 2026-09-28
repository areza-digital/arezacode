import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
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

export function ProjectDependenciesPanel() {
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
  createEffect(() => {
    sdk().directory
    server.key
    revision++
    setState({ data: undefined, loading: false, query: "" })
  })
  onCleanup(() => revision++)
  const check = async () => {
    if (!available() || state.loading) return
    const current = ++revision
    setState({ loading: true, data: undefined })
    const data = await platform.checkDependencies!(sdk().directory).catch(() => ({ status: "failed" as const }))
    if (revision === current) setState({ data, loading: false })
  }
  const result = () => (state.data?.status === "checked" ? state.data : undefined)
  const packages = createMemo(
    () =>
      result()?.packages.filter((item) =>
        `${item.name} ${item.workspace}`.toLowerCase().includes(state.query.trim().toLowerCase()),
      ) ?? [],
  )
  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col" data-component="project-dependencies">
      <div class="flex shrink-0 items-center justify-between gap-2 p-4">
        <span class="text-14-medium text-text-strong">{language.t("session.panel.dependencies")}</span>
        <Button variant="ghost" size="small" disabled={!available() || state.loading} onClick={() => void check()}>
          {language.t(state.loading ? "dependencies.checking" : "dependencies.check")}
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
          <p class="text-12-regular text-text-weak">{language.t("dependencies.scope")}</p>
          <Show when={state.loading}>
            <p role="status" class="text-13-regular text-text-weak">
              {language.t("dependencies.checking")}
            </p>
          </Show>
          <Show when={state.data && state.data.status !== "checked" ? state.data.status : undefined}>
            {(status) => (
              <p role="alert" class="text-13-regular text-text-weak">
                {language.t(`dependencies.${status()}`)}
              </p>
            )}
          </Show>
          <Show when={result()}>
            {(data) => (
              <>
                <div role="status" class="text-13-medium text-text-strong">
                  {language.t("dependencies.count", { count: data().packages.length })}
                </div>
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
