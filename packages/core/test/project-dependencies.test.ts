import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkProjectDependencies, parseOutdated } from "../src/project-dependencies"

describe("project dependency checks", () => {
  test("reads Bun workspace rows, upgrade kinds, and release-age limits", () => {
    expect(
      parseOutdated(`bun outdated v1.3.14
| Package | Current | Update | Latest | Workspace |
| ------- | ------- | ------ | ------ | --------- |
| solid-js | 1.9.9 | 1.9.10 | 1.9.10 | app, desktop |
| vite (dev) | 7.3.0 | 7.4.0 | 8.0.0 * | catalog (app) |
| effect | 4.0.0-beta.10 | 4.0.0-beta.11 | 4.0.0-beta.11 | core |
Note: The * indicates that version isn't true latest due to minimum release age
`),
    ).toEqual([
      {
        name: "solid-js",
        current: "1.9.9",
        update: "1.9.10",
        latest: "1.9.10",
        workspace: "app, desktop",
        kind: "patch",
        ageLimited: false,
      },
      {
        name: "vite (dev)",
        current: "7.3.0",
        update: "7.4.0",
        latest: "8.0.0",
        workspace: "catalog (app)",
        kind: "major",
        ageLimited: true,
      },
      {
        name: "effect",
        current: "4.0.0-beta.10",
        update: "4.0.0-beta.11",
        latest: "4.0.0-beta.11",
        workspace: "core",
        kind: "prerelease",
        ageLimited: false,
      },
    ])
    expect(parseOutdated("│ Package │ Current │ Update │ Latest │\n│ lib │ 1.0.0 │ 1.2.0 │ 1.2.0 │")[0].kind).toBe(
      "minor",
    )
    expect(parseOutdated("bun outdated v1.3.14\n")).toEqual([])
    expect(() => parseOutdated("| lib | unknown | 1.0.0 | 1.0.0 |")).toThrow()
    expect(() => parseOutdated("Registry request failed")).toThrow()
  })

  test("rejects invalid paths and identifies projects without a manifest or lock", async () => {
    await expect(checkProjectDependencies("relative/path")).rejects.toThrow("Invalid project directory")
    await expect(checkProjectDependencies(null)).rejects.toThrow("Invalid project directory")
    const directory = await mkdtemp(join(tmpdir(), "areza-dependencies-"))
    try {
      expect(await checkProjectDependencies(directory)).toEqual({ status: "noPackage" })
      await Bun.write(join(directory, "package.json"), JSON.stringify({ name: "dependency-test", private: true }))
      expect(await checkProjectDependencies(directory)).toEqual({ status: "missingLock" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
