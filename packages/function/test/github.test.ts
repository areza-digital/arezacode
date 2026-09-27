import { describe, expect, test } from "bun:test"
import { installationTokenOptions, parseRepositoryClaim } from "../src/github"

describe("parseRepositoryClaim", () => {
  test("reads repository identity with a legacy subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        repository_id: "456789",
        sub: "repo:octocat/my-repo:ref:refs/heads/main",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo", id: 456789 })
  })

  test("reads repository identity with an immutable subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        repository_id: "456789",
        sub: "repo:octocat@123456/my-repo@456789:ref:refs/heads/main",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo", id: 456789 })
  })

  test("does not depend on a repository path in a customized subject", () => {
    expect(
      parseRepositoryClaim({
        repository: "octocat/my-repo",
        repository_id: "456789",
        sub: "repository_owner:octocat:repository_visibility:private",
      }),
    ).toEqual({ owner: "octocat", repo: "my-repo", id: 456789 })
  })

  test("rejects a missing repository claim", () => {
    expect(() => parseRepositoryClaim({})).toThrow("Repository claim is missing")
  })

  test("rejects an invalid repository claim", () => {
    expect(() => parseRepositoryClaim({ repository: "octocat" })).toThrow("Repository claim is invalid")
  })

  test("rejects missing or invalid immutable repository identity", () => {
    for (const repository_id of [undefined, "", "not-an-id", "0", "1.5"]) {
      expect(() => parseRepositoryClaim({ repository: "octocat/my-repo", repository_id })).toThrow(
        "Repository ID claim is invalid",
      )
    }
  })

  test("restricts installation tokens to the verified repository and required permissions", () => {
    expect(installationTokenOptions(42, 123)).toEqual({
      type: "installation",
      installationId: 42,
      repositoryIds: [123],
      permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
    })
    expect(() => installationTokenOptions(42, NaN)).toThrow("Invalid repository ID")
  })
})
