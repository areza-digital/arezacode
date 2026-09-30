import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify, stripVTControlCharacters } from "node:util"
import { Schema } from "effect"
import { checkProjectEnvironment, Environment, projectRoot } from "./project-environment"

export const workflow =
  "When asked to check or update project dependencies, first use dependency_check for the active project. Review current, within-range, and latest versions, workspace coverage, declared versus installed dependencies, available Node/Bun versions, runtime requirements and pin warnings. Available runtimes are resolved from the checker environment, not inspected running servers. The check is read-only, covers direct dependencies across Bun workspaces, and is not a security audit. Respect project permissions and instructions for updates, then check again. Missing package.json, missing Bun lockfile, unavailable Bun, failed or unverified checks are not up-to-date results."

export const Input = Schema.Struct({})
export const Output = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("checked"),
    packages: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        current: Schema.String,
        update: Schema.String,
        latest: Schema.String,
        workspace: Schema.String,
        kind: Schema.Literals(["major", "minor", "patch", "prerelease"]),
        ageLimited: Schema.Boolean,
      }),
    ),
    checkedAt: Schema.Number,
    environment: Schema.optional(Environment),
    environmentFailed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    status: Schema.Literals(["noPackage", "missingLock", "bunUnavailable", "failed"]),
    environment: Schema.optional(Environment),
    environmentFailed: Schema.optional(Schema.Boolean),
  }),
])
export type ProjectDependencies = typeof Output.Type
export type ProjectDependency = Extract<ProjectDependencies, { status: "checked" }>["packages"][number]

const execute = promisify(execFile)
const pending = new Map<string, Promise<ProjectDependencies>>()

export async function checkProjectDependencies(directory: unknown, signal?: AbortSignal): Promise<ProjectDependencies> {
  signal?.throwIfAborted()
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0"))
    throw new Error("Invalid project directory")
  const resolved = await realpath(directory)
  if (!(await stat(resolved)).isDirectory()) throw new Error("Invalid project directory")
  const root = await projectRoot(resolved).catch(() => undefined)
  if (!root) return { status: "failed", environmentFailed: true }
  if (signal) return scan(root, signal)
  const existing = pending.get(root)
  if (existing) return existing
  const check = scan(root).finally(() => pending.delete(root))
  pending.set(root, check)
  return check
}

async function scan(root: string, signal?: AbortSignal): Promise<ProjectDependencies> {
  if (!(await stat(join(root, "package.json")).catch(() => undefined))?.isFile()) return { status: "noPackage" }
  const [versions, environment] = await Promise.all([
    checkVersions(root, signal).catch(() => ({ status: "failed" as const })),
    checkProjectEnvironment(root, signal).catch(() => undefined),
  ])
  signal?.throwIfAborted()
  return { ...versions, ...(environment ? { environment } : { environmentFailed: true }) }
}

async function checkVersions(root: string, signal?: AbortSignal): Promise<ProjectDependencies> {
  return execute("bun", ["outdated", "--recursive", "--no-progress"], {
    cwd: root,
    signal,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).then(
    ({ stdout, stderr }) => {
      if (/\berror:/i.test(stderr)) return { status: "failed" }
      const packages = parseOutdated(stdout)
      return { status: "checked", packages, checkedAt: Date.now() }
    },
    (error: { code?: string; stderr?: string }) => ({
      status:
        error.code === "ENOENT"
          ? "bunUnavailable"
          : error.stderr?.includes("missing lockfile")
            ? "missingLock"
            : "failed",
    }),
  )
}

export function parseOutdated(output: string): ProjectDependency[] {
  return stripVTControlCharacters(output)
    .split("\n")
    .flatMap((line) => {
      if (!/^\s*[|│]/u.test(line)) {
        if (!line.trim() || /^bun outdated v|^Note: The \* indicates|^[┌├└─┬┼┴┐┤┘]+$/u.test(line.trim())) return []
        throw new Error("Unexpected dependency report")
      }
      const cells = line
        .split(/[|│]/u)
        .slice(1, -1)
        .map((cell) => cell.trim())
      if (!cells.length || cells[0] === "Package" || /^[\s─-]*$/u.test(cells[0])) return []
      if (cells.length !== 4 && cells.length !== 5) throw new Error("Unexpected dependency report")
      const versions = cells.slice(1, 4).map((cell) => cell.replace(/\s+\*$/, ""))
      const current = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(versions[0])
      const latest = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(versions[2])
      if (!current || !latest) throw new Error("Unexpected dependency version")
      const kind =
        current[1] !== latest[1]
          ? "major"
          : current[2] !== latest[2]
            ? "minor"
            : current[3] !== latest[3]
              ? "patch"
              : "prerelease"
      return [
        {
          name: cells[0],
          current: versions[0],
          update: versions[1],
          latest: versions[2],
          workspace: cells[4] ?? "",
          kind,
          ageLimited: cells.slice(1, 4).some((cell) => cell.endsWith(" *")),
        } satisfies ProjectDependency,
      ]
    })
}
