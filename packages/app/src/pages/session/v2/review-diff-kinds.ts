import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Kind } from "@/components/file-tree-v2"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { pathKey } from "@/utils/path-key"

export type RenderDiff = FileDiffInfo | (SnapshotFileDiff & { file: string }) | VcsFileDiff

export function reviewDirectories(
  projects: { worktree: string; folders?: string[]; sandboxes?: string[] }[],
  directory: string,
  assignment?: string,
) {
  const project = projects.find((item) =>
    assignment
      ? pathKey(item.worktree) === pathKey(assignment)
      : [item.worktree, ...(item.folders ?? []), ...(item.sandboxes ?? [])].some(
          (folder) => pathKey(folder) === pathKey(directory),
        ),
  )
  const folders = project?.folders?.length ? project.folders : [project?.worktree ?? directory]
  const worktree = project?.sandboxes?.some((folder) => pathKey(folder) === pathKey(directory)) ? [directory] : []
  return [...new Map([...worktree, ...folders].map((folder) => [pathKey(folder), folder])).values()]
}

export function normalizePath(p: string) {
  return normalizeFileTreeV2Path(p)
}

export function reviewFilePath(root: string, file: string, directory: string) {
  const source = pathKey(directory).split("/").filter(Boolean)
  const target = pathKey(root).split("/").filter(Boolean)
  if (/^[A-Za-z]:$/.test(source[0] ?? "") && source[0] !== target[0]) return `${pathKey(root)}/${file}`
  const common = source.findIndex((part, index) => part !== target[index])
  const prefix = common < 0 ? source.length : common
  return [...source.slice(prefix).map(() => ".."), ...target.slice(prefix), file].join("/")
}

export function filterRenderableDiff(value: FileDiffInfo | SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function reviewDiffNeedsLoad(diff: RenderDiff) {
  if (diff.additions === 0 && diff.deletions === 0) return false
  return !diff.patch || !/^@@ /m.test(diff.patch)
}

export function reviewRootDirectory(root: string) {
  return root === "/" || /^[A-Za-z]:[/\\]?$/.test(root) ? root : root.replace(/[/\\]+$/, "")
}

export function reviewDiffDirectory(root: string, file: string) {
  const path = normalizePath(file)
  const index = path.lastIndexOf("/")
  const separator = root.includes("\\") ? "\\" : "/"
  const base = reviewRootDirectory(root)
  if (index < 0) return base
  return `${base.endsWith(separator) ? base : base + separator}${path.slice(0, index).replaceAll("/", separator)}`
}

export function reviewDiffKinds(diffs: RenderDiff[]) {
  const merge = (a: Kind | undefined, b: Kind) => {
    if (!a) return b
    if (a === b) return a
    return "mix" as const
  }

  const out = new Map<string, Kind>()
  for (const diff of diffs) {
    const file = normalizePath(diff.file)
    const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

    out.set(file, kind)

    const parts = file.split("/")
    parts.slice(0, -1).forEach((_, idx) => {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) return
      out.set(dir, merge(out.get(dir), kind))
    })
  }
  return out
}

export function filterReviewFiles(files: string[], query: string) {
  const value = query.trim().toLowerCase()
  if (!value) return files
  return files.filter((file) => file.toLowerCase().includes(value))
}
