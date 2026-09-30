import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { Schema } from "effect"
import { glob } from "glob"
import { satisfies, valid, validRange } from "semver"

export const Environment = Schema.Struct({
  root: Schema.String,
  runtimes: Schema.Array(Schema.Struct({ name: Schema.Literals(["node", "bun"]), version: Schema.String })),
  workspaces: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      dependencies: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          declared: Schema.String,
          installed: Schema.String,
          status: Schema.Literals(["installed", "missing", "optional", "mismatch", "unverified"]),
        }),
      ),
      requirements: Schema.Array(
        Schema.Struct({
          name: Schema.Literals(["node", "bun"]),
          source: Schema.String,
          required: Schema.String,
          status: Schema.Literals(["matched", "mismatch", "unverified"]),
        }),
      ),
      warnings: Schema.Array(Schema.Literals(["nodeUnpinned", "bunUnpinned", "nodeTypesMismatch"])),
    }),
  ),
})

const Manifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  workspaces: Schema.optional(
    Schema.Union([Schema.Array(Schema.String), Schema.Struct({ packages: Schema.Array(Schema.String) })]),
  ),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  engines: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  volta: Schema.optional(Schema.Struct({ node: Schema.optional(Schema.String) })),
  packageManager: Schema.optional(Schema.String),
})

const execute = promisify(execFile)
const read = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
const manifest = async (directory: string) => {
  const text = await read(join(directory, "package.json"))
  return text === undefined
    ? undefined
    : Schema.decodeUnknownSync(Manifest)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text))
}

async function workspacePaths(root: string, value: NonNullable<Awaited<ReturnType<typeof manifest>>>) {
  const patterns = value.workspaces
    ? "packages" in value.workspaces
      ? value.workspaces.packages
      : value.workspaces
    : []
  if (patterns.some((pattern) => isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")))
    throw new Error("Invalid workspace path")
  return glob(
    patterns
      .filter((pattern) => !pattern.startsWith("!"))
      .map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`),
    {
      cwd: root,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        ...patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => `${pattern.slice(1)}/**`),
      ],
    },
  ).then((paths) => paths.sort().map((path) => dirname(join(root, path))))
}

export async function projectRoot(directory: string): Promise<string> {
  const value = await manifest(directory)
  if (!value) return directory
  for (let parent = dirname(directory); parent !== dirname(parent); parent = dirname(parent)) {
    const candidate = await manifest(parent)
    if (candidate?.workspaces && (await workspacePaths(parent, candidate)).includes(directory)) return parent
  }
  return directory
}

export async function checkProjectEnvironment(root: string, signal?: AbortSignal): Promise<typeof Environment.Type> {
  const value = await manifest(root)
  if (!value) throw new Error("Missing project manifest")
  const runtimes = await Promise.all(
    (["node", "bun"] as const).map(async (name) => ({
      name,
      version: await execute(name, ["--version"], {
        cwd: root,
        signal,
        timeout: 10_000,
        maxBuffer: 4096,
        encoding: "utf8",
      }).then(
        ({ stdout }) => valid(stdout.trim()) ?? "",
        () => "",
      ),
    })),
  )
  const paths = [root, ...(await workspacePaths(root, value))]
  const workspaces = await Promise.all(
    paths.map(async (directory) => {
      signal?.throwIfAborted()
      const resolved = await realpath(directory)
      if (relative(root, resolved).startsWith("..") || isAbsolute(relative(root, resolved)))
        throw new Error("Workspace outside project")
      const data = await manifest(directory)
      if (!data) throw new Error("Missing workspace manifest")
      const dependencies = await Promise.all(
        Object.entries({
          ...data.peerDependencies,
          ...data.devDependencies,
          ...data.dependencies,
          ...data.optionalDependencies,
        }).map(async ([name, declared]) => {
          if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(name) || name.includes("..")) throw new Error("Invalid dependency name")
          const installed = await installedVersion(directory, root, name)
          const optional =
            name in (data.optionalDependencies ?? {}) ||
            (name in (data.peerDependencies ?? {}) &&
              !(name in (data.dependencies ?? {})) &&
              !(name in (data.devDependencies ?? {})))
          const status = !installed
            ? optional
              ? "optional"
              : "missing"
            : validRange(declared)
              ? satisfies(installed, declared)
                ? "installed"
                : "mismatch"
              : "unverified"
          return { name, declared, installed, status } as const
        }),
      )
      const requirements = (
        await Promise.all(
          runtimes.map(async (runtime) => {
            const pins = await runtimePins(directory, root, runtime.name)
            const engines = [
              value.engines?.[runtime.name],
              ...(directory === root ? [] : [data.engines?.[runtime.name]]),
            ].filter((item) => item !== undefined)
            return [...pins, ...engines.map((required) => ({ source: "engines", required }))].map(
              (pin) =>
                ({
                  name: runtime.name,
                  ...pin,
                  status:
                    !runtime.version || !validRange(pin.required)
                      ? "unverified"
                      : satisfies(runtime.version, pin.required)
                        ? "matched"
                        : "mismatch",
                }) as const,
            )
          }),
        )
      ).flat()
      const node = runtimes.find((runtime) => runtime.name === "node")?.version
      const types = dependencies.find((dependency) => dependency.name === "@types/node")?.installed
      return {
        name: data.name ?? (relative(root, directory) || "."),
        path: relative(root, directory) || ".",
        dependencies,
        requirements,
        warnings: [
          ...(!requirements.some((item) => item.name === "node" && valid(item.required))
            ? ["nodeUnpinned" as const]
            : []),
          ...(!requirements.some((item) => item.name === "bun" && valid(item.required))
            ? ["bunUnpinned" as const]
            : []),
          ...(node && types && node.split(".")[0] !== types.split(".")[0] ? ["nodeTypesMismatch" as const] : []),
        ],
      }
    }),
  )
  signal?.throwIfAborted()
  return { root, runtimes, workspaces }
}

async function installedVersion(directory: string, root: string, name: string): Promise<string> {
  const text = await read(join(directory, "node_modules", name, "package.json"))
  if (text !== undefined)
    return (
      Schema.decodeUnknownSync(Manifest)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text)).version ?? ""
    )
  if (directory === root) return ""
  return installedVersion(dirname(directory), root, name)
}

async function runtimePins(
  directory: string,
  root: string,
  name: "node" | "bun",
): Promise<{ source: string; required: string }[]> {
  const data = await manifest(directory)
  const files = await Promise.all(
    (name === "node" ? [".nvmrc", ".node-version"] : [".bun-version"]).map(async (file) => ({
      source: file,
      required: (await read(join(directory, file)))?.trim() ?? "",
    })),
  )
  const tools = await read(join(directory, ".tool-versions"))
  const tool = tools
    ?.split("\n")
    .find((line) => line.trim().startsWith(`${name === "node" ? "nodejs" : "bun"} `))
    ?.trim()
    .split(/\s+/)[1]
  const pins = [
    ...files,
    ...(tool ? [{ source: ".tool-versions", required: tool }] : []),
    ...(name === "node" && data?.volta?.node ? [{ source: "volta.node", required: data.volta.node }] : []),
    ...(name === "bun" && data?.packageManager?.startsWith("bun@")
      ? [{ source: "packageManager", required: data.packageManager.slice(4).split("+")[0] }]
      : []),
  ].filter((pin) => pin.required)
  if (directory === root) return pins
  const inherited = await runtimePins(dirname(directory), root, name)
  return [...pins, ...inherited.filter((pin) => !pins.some((local) => local.source === pin.source))]
}
