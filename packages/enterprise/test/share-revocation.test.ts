import { beforeEach, expect, mock, test } from "bun:test"

const objects = new Map<string, string>()
let failCleanup = false
mock.module("aws4fetch", () => ({
  AwsClient: class {
    async fetch(input: string, init?: RequestInit) {
      const url = new URL(input)
      const key = url.pathname.split("/").slice(2).join("/")
      if (init?.method === "PUT") {
        objects.set(key, String(init.body))
        return new Response(null)
      }
      if (init?.method === "DELETE") {
        if (failCleanup) return new Response(null, { status: 500 })
        objects.delete(key)
        return new Response(null)
      }
      if (url.searchParams.has("list-type")) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(url.searchParams.get("prefix") ?? "")).sort()
        const offset = Number(url.searchParams.get("continuation-token") ?? 0)
        const page = keys.slice(offset, offset + 2)
        return new Response(
          `<ListBucketResult>${page.map((key) => `<Key>${key}</Key>`).join("")}${offset + 2 < keys.length ? `<NextContinuationToken>${offset + 2}</NextContinuationToken>` : ""}</ListBucketResult>`,
        )
      }
      return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 })
    }
  },
}))

process.env.OPENCODE_STORAGE_ADAPTER = "s3"
process.env.OPENCODE_STORAGE_BUCKET = "isolated-test"
process.env.OPENCODE_STORAGE_ACCESS_KEY_ID = "isolated-test"
process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY = "isolated-test"
const { Share } = await import("../src/core/share")
const { Storage } = await import("../src/core/storage")
const { GET } = await import("../src/routes/api/[...path]")

beforeEach(() => {
  objects.clear()
  failCleanup = false
})

test("deletion removes fixed snapshots and all legacy pages and denies direct reads", async () => {
  const share = await Share.create({ sessionID: "test_revocation" })
  await Share.sync({ share, data: [{ type: "session_diff", data: [] }] })
  await Storage.write(["share_compaction", share.id], { data: [] })
  for (const id of ["1", "2", "3", "4", "5"]) await Storage.write(["share_event", share.id, id], [])
  await Share.remove(share)
  expect(await Share.get(share.id)).toBeUndefined()
  expect(objects.has(`share_snapshot/${share.id}.json`)).toBe(false)
  expect(objects.has(`share_compaction/${share.id}.json`)).toBe(false)
  expect([...objects.keys()].some((key) => key.startsWith("share_event/"))).toBe(false)
  await expect(Share.data(share.id)).rejects.toThrow("Share not found")
  const response = await GET({ request: new Request(`https://share.test/api/share/${share.id}/data`) } as Parameters<
    typeof GET
  >[0])
  expect(response.status).toBe(404)
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("failed cleanup and late snapshot writes cannot resurrect a revoked URL", async () => {
  const share = await Share.create({ sessionID: "test_revocation" })
  failCleanup = true
  await expect(Share.remove(share)).rejects.toThrow("Failed to remove")
  await Storage.write(["share_snapshot", share.id], { data: [{ type: "session_diff", data: [] }] })
  await expect(Share.data(share.id)).rejects.toThrow("Share not found")
  await expect(Share.sync({ share, data: [] })).rejects.toThrow("Share not found")
  failCleanup = false
  await Share.remove(share)
  const replacement = await Share.create({ sessionID: share.sessionID })
  expect(replacement.id).not.toBe(share.id)
  await expect(Share.data(share.id)).rejects.toThrow("Share not found")
  expect(await Share.data(replacement.id)).toEqual([])
})

test("wrong secrets cannot revoke shares and live data is not cacheable", async () => {
  const share = await Share.create({ sessionID: "test_revocation" })
  await expect(Share.remove({ id: share.id, secret: "wrong" })).rejects.toThrow("Share secret invalid")
  const response = await GET({ request: new Request(`https://share.test/api/share/${share.id}/data`) } as Parameters<
    typeof GET
  >[0])
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
})
