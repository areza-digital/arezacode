import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkProjectEnvironment, projectRoot } from "../src/project-environment"
import { checkProjectDependencies } from "../src/project-dependencies"

describe("project environment checks", () => {
  test("inspects every workspace, hoisted and local installations, pins and runtime mismatches", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areza-environment-")))
    try {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: ["apps/*", "packages/*", "!apps/excluded"],
          packageManager: `bun@${Bun.version}`,
          devDependencies: { typescript: "^5.7.2" },
        }),
      )
      await Bun.write(
        join(root, "apps/admin/package.json"),
        JSON.stringify({
          name: "admin",
          engines: { node: ">=999" },
          dependencies: { typescript: "^5.7.2", missing: "^1.0.0", incompatible: "^2.0.0", "@types/node": "^1.0.0" },
          optionalDependencies: { optional: "^1.0.0" },
        }),
      )
      await Bun.write(
        join(root, "apps/bot/package.json"),
        JSON.stringify({ name: "bot", dependencies: { typescript: "^5.7.2" } }),
      )
      await Bun.write(join(root, "packages/db/package.json"), JSON.stringify({ name: "db" }))
      await Bun.write(join(root, "apps/excluded/package.json"), JSON.stringify({ name: "excluded" }))
      await Bun.write(
        join(root, "node_modules/typescript/package.json"),
        JSON.stringify({ name: "typescript", version: "5.9.3" }),
      )
      await Bun.write(
        join(root, "apps/bot/node_modules/typescript/package.json"),
        JSON.stringify({ name: "typescript", version: "5.8.0" }),
      )
      await Bun.write(
        join(root, "node_modules/incompatible/package.json"),
        JSON.stringify({ name: "incompatible", version: "1.0.0" }),
      )
      await Bun.write(
        join(root, "node_modules/@types/node/package.json"),
        JSON.stringify({ name: "@types/node", version: "1.0.0" }),
      )
      expect(await projectRoot(join(root, "apps/admin"))).toBe(root)
      const result = await checkProjectEnvironment(root)
      expect(result.workspaces.map((workspace) => workspace.name)).toEqual(["root", "admin", "bot", "db"])
      expect(result.runtimes.find((runtime) => runtime.name === "bun")?.version).toBe(Bun.version)
      const admin = result.workspaces.find((workspace) => workspace.name === "admin")!
      expect(admin.dependencies).toContainEqual({
        name: "typescript",
        declared: "^5.7.2",
        installed: "5.9.3",
        status: "installed",
      })
      expect(admin.dependencies).toContainEqual({
        name: "missing",
        declared: "^1.0.0",
        installed: "",
        status: "missing",
      })
      expect(admin.dependencies.find((dependency) => dependency.name === "incompatible")?.status).toBe("mismatch")
      expect(admin.dependencies.find((dependency) => dependency.name === "optional")?.status).toBe("optional")
      expect(admin.warnings).toContain("nodeUnpinned")
      expect(admin.warnings).toContain("nodeTypesMismatch")
      expect(admin.warnings).not.toContain("bunUnpinned")
      expect(admin.requirements).toContainEqual({
        name: "bun",
        source: "packageManager",
        required: Bun.version,
        status: "matched",
      })
      expect(admin.requirements).toContainEqual({
        name: "node",
        source: "engines",
        required: ">=999",
        status: "mismatch",
      })
      expect(result.workspaces.find((workspace) => workspace.name === "bot")?.dependencies[0].installed).toBe("5.8.0")
      await Bun.write(join(root, ".nvmrc"), result.runtimes.find((runtime) => runtime.name === "node")!.version)
      const pinned = await checkProjectEnvironment(root)
      expect(pinned.workspaces.every((workspace) => !workspace.warnings.includes("nodeUnpinned"))).toBe(true)
      expect(
        pinned.workspaces[1].requirements.some((item) => item.source === ".nvmrc" && item.status === "matched"),
      ).toBe(true)
      const partial = await checkProjectDependencies(join(root, "apps/admin"))
      expect(partial.status).toBe("missingLock")
      expect(partial.environment?.workspaces).toHaveLength(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports incomplete inspections and rejects workspace paths outside the project", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areza-environment-")))
    const outside = await realpath(await mkdtemp(join(tmpdir(), "areza-outside-")))
    try {
      await Bun.write(join(root, "package.json"), "{invalid")
      expect(await checkProjectDependencies(root)).toMatchObject({ status: "failed", environmentFailed: true })
      await Bun.write(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["apps/*"] }))
      await Bun.write(join(root, "apps/admin/package.json"), JSON.stringify({ name: "admin" }))
      await Bun.write(join(outside, "package.json"), JSON.stringify({ name: "outside" }))
      await symlink(outside, join(root, "apps/external"))
      await expect(checkProjectEnvironment(root)).rejects.toThrow("Workspace outside project")
      await Bun.write(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["../*"] }))
      await expect(checkProjectEnvironment(root)).rejects.toThrow("Invalid workspace path")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
