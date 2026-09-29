import { describe, expect, test } from "bun:test"
import { invalidateFromWatcher } from "./watcher"
import { createFileTreeStore } from "./tree-store"

describe("file watcher invalidation", () => {
  test("ignores in-flight listing failures after the watched folder is removed", async () => {
    const listing = Promise.withResolvers<never[]>()
    const errors: string[] = []
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (path) => path,
      list: async (path) => {
        if (path) return listing.promise
        return [{ path: "src", name: "src", absolute: "/repo/src", type: "directory", ignored: false }]
      },
      onError: (message) => errors.push(message),
    })
    await tree.listDir("")
    const pending = tree.listDir("src")
    invalidateFromWatcher(
      { type: "file.watcher.updated", properties: { file: "src", event: "unlink" } },
      {
        normalize: (path) => path,
        hasFile: () => false,
        loadFile: () => {},
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        removeDir: tree.removeDir,
        refreshDir: () => {},
      },
    )
    listing.reject(new Error("Directory no longer exists"))
    await pending
    expect(errors).toEqual([])
    expect(tree.dirState("src")).toBeUndefined()
  })

  test("rechecks changes arriving while a directory listing is in flight", async () => {
    const first = Promise.withResolvers<never[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (path) => path,
      list: async () => {
        calls++
        if (calls === 1) return first.promise
        return [{ path: "new.ts", name: "new.ts", absolute: "/repo/new.ts", type: "file", ignored: false }]
      },
      onError: (message) => {
        throw new Error(message)
      },
    })
    const pending = tree.listDir("")
    const refresh = tree.listDir("", { force: true })
    first.resolve([])
    await Promise.all([pending, refresh])
    expect(calls).toBe(2)
    expect(tree.children("").map((node) => node.path)).toEqual(["new.ts"])
  })

  test("removing and recreating a folder clears its cached listing", async () => {
    let present = true
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (path) => path,
      list: async (path) => {
        if (path)
          return [{ path: "src/new.ts", name: "new.ts", absolute: "/repo/src/new.ts", type: "file", ignored: false }]
        if (!present) return []
        return [{ path: "src", name: "src", absolute: "/repo/src", type: "directory", ignored: false }]
      },
      onError: (message) => {
        throw new Error(message)
      },
    })
    await tree.listDir("")
    await tree.listDir("src")
    present = false
    await tree.listDir("", { force: true })
    expect(tree.isLoaded("src")).toBe(false)
    present = true
    await tree.listDir("", { force: true })
    await tree.listDir("src")
    expect(tree.children("src").map((node) => node.path)).toEqual(["src/new.ts"])
  })

  test("reloads open files and refreshes loaded parent on add", () => {
    const loads: string[] = []
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(loads).toEqual(["src/new.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })
})
