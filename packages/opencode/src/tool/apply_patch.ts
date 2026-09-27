import * as path from "path"
import { Effect, Schema } from "effect"
import { Jev } from "@opencode-ai/core/jev"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const mutation = yield* FileMutation.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
      }> = []

      let totalDiff = ""
      const mutations: FileMutation.ConditionalMutationInput[] = []

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)
        const target = { canonical: yield* afs.resolve(filePath), resource: path.relative(instance.worktree, filePath) }

        switch (hunk.type) {
          case "add": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
            )
            const oldContent = source?.text ?? ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            mutations.push({ target, expected: source?.content, content: Bom.join(next.text, next.bom) })
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)
            const destination =
              movePath && movePath !== filePath
                ? yield* Bom.readFile(afs, movePath).pipe(
                    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
                  )
                : undefined
            const diffPath = destination && movePath ? movePath : filePath
            const diff = trimDiff(createTwoFilesPatch(diffPath, diffPath, destination?.text ?? oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(destination?.text ?? oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            if (movePath && movePath !== filePath) {
              mutations.push(
                {
                  target: {
                    canonical: yield* afs.resolve(movePath),
                    resource: path.relative(instance.worktree, movePath),
                  },
                  expected: destination?.content,
                  content: Bom.join(newContent, bom),
                },
                { target, expected: source.content },
              )
              if (destination) {
                const removed = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, ""))
                fileChanges.push({
                  filePath,
                  oldContent,
                  newContent: "",
                  type: "delete",
                  diff: removed,
                  additions: 0,
                  deletions: diffLines(oldContent, "").reduce((count, change) => count + (change.count ?? 0), 0),
                  bom: source.bom,
                })
                totalDiff += removed + "\n"
              }
            } else {
              mutations.push({ target, expected: source.content, content: Bom.join(newContent, bom) })
            }

            fileChanges.push({
              filePath: diffPath,
              oldContent: destination?.text ?? oldContent,
              newContent,
              type: destination ? "update" : hunk.move_path ? "move" : "update",
              movePath: destination ? undefined : movePath,
              diff,
              additions,
              deletions,
              bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            mutations.push({ target, expected: source.content })
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      const targets = mutations.map((change) => change.target.canonical)
      if (new Set(targets).size !== targets.length) {
        return yield* Effect.fail(new Error("apply_patch verification failed: multiple changes target the same file"))
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.movePath ? { movePath: change.movePath } : {}),
      }))

      // Check permissions if needed
      const relativePaths = [
        ...new Set(
          fileChanges.flatMap((change) =>
            [change.filePath, ...(change.movePath ? [change.movePath] : [])].map((file) =>
              path.relative(instance.worktree, file).replaceAll("\\", "/"),
            ),
          ),
        ),
      ]
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        yield* Effect.promise(() =>
          Jev.guardChange(
            ctx.sessionID,
            change.movePath ?? change.filePath,
            change.type === "move" ? "" : change.oldContent,
            change.newContent,
          ),
        )
      }
      yield* mutation.applyIfUnchanged(mutations)
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          if (yield* format.file(edited)) {
            yield* Bom.syncFile(afs, edited, change.bom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
