import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { wait } from "../cmd/tui/sync-fixture"

test("SSE reconnects after closure and isolates a failing event subscriber", async () => {
  let requests = 0
  const seen: string[] = []
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests++
      const id = `evt_connect_${requests}`
      const request = new Request(input, init)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  directory: "global",
                  payload: { id, type: "server.connected", properties: {} },
                })}\n\n`,
              ),
            )
            if (requests === 1) return controller.close()
            request.signal.addEventListener("abort", () => controller.close(), { once: true })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    { preconnect: fetch.preconnect },
  )
  function Probe() {
    const sdk = useSDK()
    sdk.event.on("event", (event) => {
      if (event.payload.id === "evt_connect_1") throw new Error("subscriber failure")
    })
    sdk.event.on("event", (event) => seen.push(event.payload.id))
    return <box />
  }
  const app = await testRender(() => (
    <SDKProvider url="http://test" fetch={transport}>
      <Probe />
    </SDKProvider>
  ))
  try {
    await wait(() => seen.length === 2, 4000)
    expect(requests).toBe(2)
    expect(seen).toEqual(["evt_connect_1", "evt_connect_2"])
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    app.renderer.destroy()
    errors.mockRestore()
  }
})
