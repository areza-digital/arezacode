export type ProjectDependency = {
  name: string
  current: string
  update: string
  latest: string
  workspace: string
  kind: "major" | "minor" | "patch" | "prerelease"
  ageLimited: boolean
}

export type ProjectDependencies =
  | { status: "checked"; packages: ProjectDependency[]; checkedAt: number }
  | { status: "noPackage" | "missingLock" | "bunUnavailable" | "failed" }
