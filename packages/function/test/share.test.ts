import { beforeEach, expect, mock, test } from "bun:test"

const requests: Record<string, unknown>[] = []
mock.module("sst", () => ({
  Resource: { GITHUB_APP_ID: { value: "test" }, GITHUB_APP_PRIVATE_KEY: { value: "test" } },
}))
mock.module("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => ({ payload: { repository: "org/repo", repository_id: "123" } }),
}))
mock.module("@octokit/auth-app", () => ({
  createAppAuth: () => async (input: Record<string, unknown>) => {
    requests.push(input)
    return { token: "test" }
  },
}))
mock.module("@octokit/rest", () => ({
  Octokit: class {
    apps = { getRepoInstallation: async () => ({ data: { id: 42 } }) }
    repos = { get: async () => ({ data: { id: 123, permissions: { push: true } } }) }
  },
}))

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

const { default: api, SyncServer } = await import("../src/api")
beforeEach(() => {
  requests.splice(0)
})

function fixture() {
  const data = new Map<string, unknown>()
  let tail = Promise.resolve()
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (entries: Record<string, unknown>) => {
      Object.entries(entries).forEach(([key, value]) => data.set(key, value))
    },
    transaction: async <T>(callback: (tx: typeof storage) => Promise<T>) => {
      const previous = tail
      const release = Promise.withResolvers<void>()
      tail = release.promise
      await previous
      try {
        return await callback(storage)
      } finally {
        release.resolve()
      }
    },
  }
  const server = new SyncServer(
    { storage } as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof SyncServer>[1],
  )
  const env = { SYNC_SERVER: { idFromName: (id: string) => id, get: () => server }, WEB_DOMAIN: "share.test" }
  return { server, env }
}

test("public share creation never reveals an existing secret", async () => {
  const { server, env } = fixture()
  const original = await server.share("session_12345678")
  expect(original).toBeString()
  for (const sessionID of ["12345678", "session_12345678", "different_12345678"]) {
    const response = await api.request(
      "/share_create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID }),
      },
      env,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Share already exists" })
  }
  await expect(server.assertSecret(original!)).resolves.toBeUndefined()
})

test("overlapping creations return ownership to exactly one caller", async () => {
  const { server } = fixture()
  const results = await Promise.all([server.share("session_12345678"), server.share("other_12345678")])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(results.filter((value) => value === undefined)).toHaveLength(1)
})

test("missing secrets never authorize an uncreated share", async () => {
  const { server } = fixture()
  await expect(server.assertSecret(undefined as unknown as string)).rejects.toThrow("Invalid secret")
  await expect(server.assertSecret("")).rejects.toThrow("Invalid secret")
})

for (const endpoint of ["exchange_github_app_token", "exchange_github_app_token_with_pat"]) {
  test(`${endpoint} requests only the verified repository and minimal permissions`, async () => {
    const response = await api.request(`/${endpoint}`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ owner: "org", repo: "repo" }),
    })
    expect(response.status).toBe(200)
    expect(requests.find((request) => request.type === "installation")).toEqual({
      type: "installation",
      installationId: 42,
      repositoryIds: [123],
      permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
    })
  })
}
