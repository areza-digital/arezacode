import { describe, expect, test } from "bun:test"
import {
  filterReviewFiles,
  reviewDirectories,
  reviewDiffDirectory,
  reviewDiffKinds,
  reviewDiffNeedsLoad,
  reviewFilePath,
} from "./review-diff-kinds"

test("review file actions resolve against the selected repository", () => {
  expect(reviewFilePath("/projects/web", "src/app.ts", "/projects/api")).toBe("../web/src/app.ts")
  expect(reviewFilePath("/projects/web", "src/app.ts", "/projects/web")).toBe("src/app.ts")
  expect(reviewFilePath("/repo", "src/app.ts", "/repo/packages/app")).toBe("../../src/app.ts")
  expect(reviewFilePath("C:\\projects\\web", "src/app.ts", "C:\\projects\\api")).toBe("../web/src/app.ts")
})

test("review follows project assignments and current source folders while preserving worktree roots", () => {
  const projects = [
    { worktree: "/old", folders: ["/old"] },
    { worktree: "/web", folders: ["/web", "/api/", "/api"], sandboxes: ["/web-feature"] },
  ]
  expect(reviewDirectories(projects, "/old", "/web")).toEqual(["/web", "/api"])
  expect(reviewDirectories(projects, "/api")).toEqual(["/web", "/api"])
  expect(reviewDirectories(projects, "/web-feature")).toEqual(["/web-feature", "/web", "/api"])
  projects[1]!.folders = ["/api"]
  expect(reviewDirectories(projects, "/web")).toEqual(["/api"])
  expect(reviewDirectories([], "/unassigned")).toEqual(["/unassigned"])
})

describe("reviewDiffKinds", () => {
  test("maps file and directory kinds", () => {
    const kinds = reviewDiffKinds([
      { file: "src/a.ts", additions: 1, deletions: 0, status: "added" },
      { file: "src/b.ts", additions: 0, deletions: 2, status: "deleted" },
    ])

    expect(kinds.get("src/a.ts")).toBe("add")
    expect(kinds.get("src/b.ts")).toBe("del")
    expect(kinds.get("src")).toBe("mix")
  })

  test("normalizes file and directory paths", () => {
    const kinds = reviewDiffKinds([{ file: "\\src//lib/a.ts/", additions: 1, deletions: 1, status: "modified" }])

    expect(kinds.get("src/lib/a.ts")).toBe("mix")
    expect(kinds.get("src/lib")).toBe("mix")
  })
})

describe("filterReviewFiles", () => {
  test("filters by path substring", () => {
    const files = ["src/a.ts", "src/b.ts", "lib/c.ts"]
    expect(filterReviewFiles(files, "b.ts")).toEqual(["src/b.ts"])
    expect(filterReviewFiles(files, "")).toEqual(files)
  })
})

describe("reviewDiffNeedsLoad", () => {
  test("loads changed files whose aggregate patch has no hunks", () => {
    expect(
      reviewDiffNeedsLoad({
        file: "src/a.ts",
        additions: 1,
        deletions: 0,
        patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts",
      }),
    ).toBe(true)
  })

  test("keeps complete patches and empty changes", () => {
    expect(
      reviewDiffNeedsLoad({
        file: "src/a.ts",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+value",
      }),
    ).toBe(false)
    expect(reviewDiffNeedsLoad({ file: "empty.txt", additions: 0, deletions: 0 })).toBe(false)
  })
})

describe("reviewDiffDirectory", () => {
  test("scopes nested files to their parent directory", () => {
    expect(reviewDiffDirectory("/repo", "src/lib/a.ts")).toBe("/repo/src/lib")
    expect(reviewDiffDirectory("C:\\repo", "src/lib/a.ts")).toBe("C:\\repo\\src\\lib")
  })

  test("does not rescope root files", () => {
    expect(reviewDiffDirectory("/repo/", "README.md")).toBe("/repo")
    expect(reviewDiffDirectory("/", "README.md")).toBe("/")
    expect(reviewDiffDirectory("C:\\", "README.md")).toBe("C:\\")
    expect(reviewDiffDirectory("/", "src/a.ts")).toBe("/src")
    expect(reviewDiffDirectory("C:\\", "src/a.ts")).toBe("C:\\src")
  })
})
