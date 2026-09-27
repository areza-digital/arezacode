import type { JWTPayload } from "jose"

export function installationTokenOptions(installationId: number, repositoryId: number) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error("Invalid repository ID")
  return {
    type: "installation" as const,
    installationId,
    repositoryIds: [repositoryId],
    permissions: {
      contents: "write" as const,
      issues: "write" as const,
      pull_requests: "write" as const,
      metadata: "read" as const,
    },
  }
}

export function parseRepositoryClaim(payload: JWTPayload) {
  const claim = payload.repository
  if (typeof claim !== "string") throw new Error("Repository claim is missing")

  const parts = claim.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Repository claim is invalid")
  const id = Number(payload.repository_id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Repository ID claim is invalid")

  return {
    owner: parts[0],
    repo: parts[1],
    id,
  }
}
