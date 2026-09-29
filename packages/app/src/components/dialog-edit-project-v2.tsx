import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProjectAvatar, PROJECT_AVATAR_VARIANTS } from "@opencode-ai/ui/v2/project-avatar-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useDirectoryPicker } from "./directory-picker"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { getProjectAvatarSource } from "@/pages/layout/helpers"
import { createEditProjectModel } from "./edit-project"

export function DialogEditProjectV2(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const model = createEditProjectModel(props)

  return (
    <Dialog fit containerClass="max-w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)]">
      <form onSubmit={model.submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("dialog.project.edit.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <ScrollView
          data-slot="dialog-body"
          class="max-h-[min(560px,calc(100vh-160px))] w-full"
          viewportClass="flex flex-col gap-6 px-4 pt-4 pb-1"
        >
          <Field>
            <Field.Label>{language.t("dialog.project.edit.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={model.store.name}
              placeholder={model.folderName()}
              onInput={(event) => model.setStore("name", event.currentTarget.value)}
            />
          </Field>

          <ProjectFoldersField
            server={props.server}
            folders={model.store.folders}
            onChange={(folders) => model.setStore("folders", folders)}
          />

          <div class="flex w-full flex-col gap-2">
            <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
              {language.t("dialog.project.edit.icon")}
            </div>
            <div class="flex items-center gap-3">
              <button
                type="button"
                aria-label={language.t("dialog.project.edit.icon.alt")}
                class="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-[6px] outline outline-1 outline-transparent transition-[background-color,outline-color] focus-visible:outline-v2-border-border-focus"
                classList={{
                  "bg-v2-overlay-simple-overlay-hover outline-v2-border-border-focus": model.store.dragOver,
                }}
                onMouseEnter={() => model.setStore("iconHover", true)}
                onMouseLeave={() => model.setStore("iconHover", false)}
                onDrop={model.drop}
                onDragOver={model.dragOver}
                onDragLeave={model.dragLeave}
                onClick={model.iconClick}
              >
                <ProjectAvatar
                  fallback={model.store.name || model.defaultName()}
                  src={getProjectAvatarSource(props.project.id, {
                    color: model.store.color,
                    url: props.project.icon?.url,
                    override: model.store.iconOverride,
                  })}
                  variant={getProjectAvatarVariant(model.store.color)}
                  class="!size-16 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[32px]"
                />
                <span
                  class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[6px] bg-v2-background-bg-contrast/80 text-v2-icon-icon-contrast backdrop-blur-[2px] transition-opacity"
                  classList={{
                    "opacity-100": model.store.iconHover,
                    "opacity-0": !model.store.iconHover,
                  }}
                >
                  <Icon name={model.store.iconOverride ? "close" : "outline-share"} />
                </span>
              </button>
              <input
                ref={(element) => {
                  model.setIconInput(element)
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={model.inputChange}
              />
              <div class="flex select-none flex-col gap-[6px] text-[11px] font-[440] leading-none tracking-[0.05px] text-v2-text-text-muted">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
              </div>
            </div>
          </div>

          <Show when={!model.store.iconOverride}>
            <div class="flex w-full flex-col gap-2">
              <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
                {language.t("dialog.project.edit.color")}
              </div>
              <div class="-ml-1 flex gap-1.5">
                <For each={PROJECT_AVATAR_VARIANTS}>
                  {(color) => (
                    <button
                      type="button"
                      aria-label={language.t("dialog.project.edit.color.select", { color })}
                      aria-pressed={getProjectAvatarVariant(model.store.color) === color}
                      class="flex size-8 items-center justify-center rounded-[10px] p-1 outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus"
                      classList={{
                        "bg-v2-overlay-simple-overlay-hover [box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]":
                          getProjectAvatarVariant(model.store.color) === color,
                      }}
                      onClick={() => {
                        if (getProjectAvatarVariant(model.store.color) === color && !props.project.icon?.url) return
                        model.setStore(
                          "color",
                          getProjectAvatarVariant(model.store.color) === color ? undefined : color,
                        )
                      }}
                    >
                      <ProjectAvatar
                        fallback={model.store.name || model.defaultName()}
                        variant={getProjectAvatarVariant(color)}
                        class="!size-6 [&_[data-slot=project-avatar-surface]]:!rounded-[6px]"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Field>
            <Field.Label>{language.t("dialog.project.edit.worktree.startup")}</Field.Label>
            <Field.Prefix>{language.t("dialog.project.edit.worktree.startup.description")}</Field.Prefix>
            <TextareaV2
              class="!w-full [&_[data-slot=textarea-v2-textarea]]:font-mono"
              rows={3}
              value={model.store.startup}
              placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
              spellcheck={false}
              onInput={(event) => model.setStore("startup", event.currentTarget.value)}
            />
          </Field>
        </ScrollView>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={model.save.isPending} onClick={model.close}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function DialogCreateProjectV2(props: { server: ServerConnection.Any; onSelect: (directory: string) => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const [state, setState] = createStore({ name: "", folders: [] as string[] })
  return (
    <Dialog fit containerClass="max-w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)]">
      <form
        class="contents"
        onSubmit={(event) => {
          event.preventDefault()
          if (!state.name.trim() || !state.folders.length) return
          const directory = state.folders[0]
          global.ensureServerCtx(props.server).projects.save({
            worktree: directory,
            name: state.name.trim(),
            folders: [...state.folders],
            expanded: true,
          })
          dialog.close()
          props.onSelect(directory)
        }}
      >
        <DialogHeader>
          <DialogTitle>{language.t("project.create.title")}</DialogTitle>
        </DialogHeader>
        <div class="flex w-full min-w-0 flex-col gap-6 p-4">
          <Field>
            <Field.Label>{language.t("dialog.project.edit.name")}</Field.Label>
            <TextInputV2
              autofocus
              value={state.name}
              class="!w-full"
              placeholder={language.t("project.create.name")}
              onInput={(event) => setState("name", event.currentTarget.value)}
            />
          </Field>
          <ProjectFoldersField
            server={props.server}
            folders={state.folders}
            onChange={(folders) => setState("folders", folders)}
          />
        </div>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" onClick={dialog.close}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!state.name.trim() || !state.folders.length}>
            {language.t("project.create.title")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function ProjectFoldersField(props: {
  server: ServerConnection.Any
  folders: string[]
  onChange: (folders: string[]) => void
}) {
  const language = useLanguage()
  const pick = useDirectoryPicker()
  return (
    <Field>
      <Field.Label>{language.t("project.folders")}</Field.Label>
      <div class="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-v2-border-border-base p-3">
        <For each={props.folders}>
          {(folder) => (
            <div class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 truncate" title={folder}>
                {folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || folder}
              </span>
              <ButtonV2
                type="button"
                variant="ghost-muted"
                aria-label={language.t("project.folder.remove", { folder })}
                onClick={() => props.onChange(props.folders.filter((item) => item !== folder))}
              >
                <Icon name="close" />
              </ButtonV2>
            </div>
          )}
        </For>
        <ButtonV2
          type="button"
          variant="neutral"
          onClick={() =>
            pick({
              server: props.server,
              title: language.t("project.folder.add"),
              multiple: true,
              nested: true,
              onSelect: (value) =>
                props.onChange([
                  ...new Set([...props.folders, ...(Array.isArray(value) ? value : value ? [value] : [])]),
                ]),
            })
          }
        >
          {language.t("project.folder.add")}
        </ButtonV2>
      </div>
    </Field>
  )
}
