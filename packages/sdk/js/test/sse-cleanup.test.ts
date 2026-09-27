import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createOpencodeClient } from "../src/v2/client"

for (const exit of ["return", "break", "cancel-error"] as const) {
  test(`v2 SSE cancels its response body on ${exit}`, async () => {
    const cancelled = Promise.withResolvers<void>()
    const controller = new AbortController()
    const sdk = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
            },
            cancel() {
              cancelled.resolve()
              if (exit === "cancel-error") throw new Error("Cancellation failed")
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const events = await sdk.event.subscribe(undefined, { signal: controller.signal })
    if (exit === "break") {
      for await (const event of events.stream) {
        expect(event).toEqual({ type: "server.connected" })
        break
      }
    }
    if (exit !== "break") {
      expect((await events.stream.next()).value).toEqual({ type: "server.connected" })
      await events.stream.return(undefined)
    }
    await cancelled.promise
    expect(controller.signal.aborted).toBe(false)
  })
}

for (const version of ["v1", "v2"] as const) {
  for (const exit of ["return", "break"] as const) {
    test(`${version} SSE cancels its HTTP response on ${exit}`, async () => {
      const client = version === "v1" ? await import("../src/client") : await import("../src/v2/client")
      const cancelled = Promise.withResolvers<void>()
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write('data: {"type":"server.connected"}\n\n')
        _request.socket.once("close", () => cancelled.resolve())
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("Expected TCP address")
        const sdk = client.createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
        const events = await sdk.event.subscribe()
        if (exit === "break") {
          for await (const event of events.stream) {
            expect(event).toEqual({ type: "server.connected" })
            break
          }
        }
        if (exit === "return") {
          expect((await events.stream.next()).value).toEqual({ type: "server.connected" })
          await events.stream.return(undefined)
        }
        await cancelled.promise
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  }
}

test("SSE cleanup preserves retries and the caller's abort signal", async () => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  const sdk = createOpencodeClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      if (!(input instanceof Request)) throw new Error("Expected Request")
      signals.push(input.signal)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            if (signals.length === 1) {
              stream.error(new Error("Disconnected"))
              return
            }
            stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const events = await sdk.event.subscribe(undefined, {
    signal: controller.signal,
    sseMaxRetryAttempts: 2,
    sseSleepFn: async () => {},
  })
  expect((await events.stream.next()).value).toEqual({ type: "server.connected" })
  expect(signals).toHaveLength(2)
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  await events.stream.return(undefined)
  expect(signals[1].aborted).toBe(true)
  expect(controller.signal.aborted).toBe(false)
})
