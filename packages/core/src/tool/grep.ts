export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { AutomaticChecks } from "../automatic-checks"
import { LocationMutation } from "../location-mutation"
import { Jev } from "../jev"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description:
      "Maximum matches to return. Defaults to 100 and is capped at 1000. Narrow the pattern or path for more results.",
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput, limit?: number) => {
  const lines = output.length === 0 ? ["No files found"] : [`Found ${output.length} matches`]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (limit !== undefined && output.length >= limit)
    lines.push(`Result limit reached (${limit}). More matches may exist; narrow the pattern or path.`)
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        reuse_check: Tool.withPermission(Tool.make({
          description: "Before creating a source file or adding a substantial feature, search for existing owners, shared UI components, helpers, and installed native capabilities. Supply the target and a feature-oriented search pattern. Returns bounded evidence, never proof that no duplicates exist. Valid evidence permits source writes for ten minutes until the target or candidates change. Inspect the candidates and use Context7 for installed-library APIs before implementing.",
          input: Schema.Struct({ target: Schema.String, query: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(200)) }),
          output: Schema.String,
          toModelOutput: ({ output }) => [{ type: "text", text: output }],
          execute: (input, context) => Effect.gen(function* () {
            const source = { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID }
            const target = yield* mutation.resolve({ path: input.target, kind: "file" })
            if (target.externalDirectory) return yield* new ToolFailure({ message: "Run reuse_check from the project that owns this file." })
            yield* permission.assert({ action: "grep", resources: [input.query], save: ["*"], sessionID: context.sessionID, agent: context.agent, source })
            const matches = yield* ripgrep.grep({ cwd: location.directory, pattern: input.query, include: "*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,php,rs,go,swift}", limit: 80 })
            const paths = [...new Set(matches.map((match) => match.entry.path))].filter((file) => path.resolve(location.directory, file) !== target.canonical).slice(0,12)
            const candidates: Array<{ path: string; content: string }> = []
            for (const file of [input.target, ...paths]) {
              const item = yield* mutation.resolve({ path: file, kind: "file" })
              if (item.externalDirectory) continue
              yield* permission.assert({ action: "read", resources: [item.resource], save: ["*"], sessionID: context.sessionID, agent: context.agent, source })
              const info = yield* fs.stat(item.canonical).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
              if (info?.type === "File" && (item.canonical === target.canonical || info.size <= 64 * 1024)) candidates.push({ path: item.canonical, content: yield* fs.readFileString(item.canonical) })
            }
            const before = candidates.find((candidate) => candidate.path === target.canonical)?.content ?? ""
            yield* Effect.promise(() => AutomaticChecks.rememberReuse(context.sessionID, target.canonical, before, candidates.filter((candidate) => candidate.path !== target.canonical)))
            const evidence = matches.map((match) => `${match.entry.path}:${match.line}: ${match.text}`)
            const ranked = yield* Effect.promise(() => Jev.prioritize(evidence, context.sessionID))
            return `Ponytail build preflight recorded for ${input.target}. Bounded search: ${matches.length} matches, ${paths.length} candidate files. Reuse existing owners where suitable; identical implementation blocks will be rejected. This is evidence, not a claim of semantic uniqueness.\n${ranked.join("\n")}`
          }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: "Reuse search failed; source creation remains blocked. Check the target, pattern, and read permissions." }))),
        }), "grep"),
        [name]: Tool.make({
          description:
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })),
                Math.min(input.limit ?? 100, 1000),
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const resolved = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (resolved.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(resolved.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const target = resolved.canonical
              const info = yield* fs.stat(target)
              return yield* ripgrep
                .grep({
                  cwd: info?.type === "Directory" ? target : path.dirname(target),
                  pattern: input.pattern,
                  file: info?.type === "File" ? path.basename(target) : undefined,
                  include: input.include,
                  limit: Math.min(input.limit ?? 100, 1000),
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(
                              location.directory,
                              path.resolve(
                                info?.type === "Directory" ? target : path.dirname(target),
                                match.entry.path,
                              ),
                            ),
                          ),
                        }),
                      }),
                    ),
                  ),
                )
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to grep for ${input.pattern}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node, LocationMutation.node],
})
