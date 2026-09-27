import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const web = createRequire(new URL("../package.json", import.meta.url))
const astro = web.resolve("astro/package.json")

test("Cloudflare error pages use the ASSETS binding even for an untrusted request host", async () => {
  mock.module("cloudflare:workers", () => ({ env: {} }))
  const { handle } = await import(join(dirname(web.resolve("@astrojs/cloudflare")), "utils/handler.js"))
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches")
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {} })
  let requests = 0
  const trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++
      return new Response("private network data")
    },
  })
  const assets: string[] = []
  try {
    const response = await handle(
      { assets: new Set() },
      {
        match: () => undefined,
        render: (_request: Request, options: { prerenderedErrorPageFetch: (url: string) => Promise<Response> }) =>
          options.prerenderedErrorPageFetch(new URL("/404.html", trap.url).href),
      },
      new Request(new URL("/missing", trap.url)),
      {
        ASSETS: {
          fetch: async (url: string) => {
            assets.push(url)
            return new Response("safe asset", { status: 404 })
          },
        },
      },
      { waitUntil: () => {} },
    )
    expect(await response.text()).toBe("safe asset")
    expect(assets).toEqual([new URL("/missing", trap.url).href, new URL("/404", trap.url).href])
    expect(requests).toBe(0)
  } finally {
    trap.stop(true)
    if (previous) Object.defineProperty(globalThis, "caches", previous)
    if (!previous) Reflect.deleteProperty(globalThis, "caches")
  }
})

test("Astro escapes hostile named slots and preserves the default slot", async () => {
  const { renderComponent } = await import(join(dirname(astro), "dist/runtime/server/render/component.js"))
  const instance = await renderComponent(
    {
      renderers: [
        {
          name: "@astrojs/solid-js",
          clientEntrypoint: "/renderer.js",
          ssr: {
            check: () => true,
            renderToStaticMarkup: () => ({ html: "<div>safe</div>" }),
          },
        },
      ],
      clientDirectives: new Map([["load", ""]]),
      resolve: async (value: string) => value,
    },
    "Fixture",
    () => {},
    {
      "client:load": true,
      "client:component-path": "/fixture.js",
      "client:component-export": "default",
    },
    {
      'x"><img src=x onerror=alert(1)>': () => "slot content",
      default: () => "default content",
    },
  )
  const chunks: unknown[] = []
  instance.render({ write: (chunk: unknown) => chunks.push(chunk) })
  const html = chunks.filter((value) => typeof value === "string" || value instanceof String).join("")
  expect(html).not.toContain("<img")
  expect(html).toContain('data-astro-template="x&quot;&gt;&lt;img')
  expect(html).toContain("slot content")
  expect(html).toContain("<template data-astro-template>default content</template>")
})

test("Astro uses the retained Sharp mitigation for AVIF conversion", async () => {
  const sharp = (await import(createRequire(astro).resolve("sharp"))).default
  const service = (await import(web.resolve("astro/assets/services/sharp"))).default
  expect(sharp.versions.sharp).toBe("0.35.4")
  expect(sharp.versions.heif).toBe("1.23.2")
  const source = await sharp({ create: { width: 8, height: 6, channels: 4, background: "red" } })
    .avif()
    .toBuffer()
  for (const format of ["png", "webp", "avif"]) {
    const output = await service.transform(
      source,
      { src: "fixture.avif", width: 4, format },
      { service: { config: {} } },
    )
    const metadata = await sharp(output.data).metadata()
    expect(metadata.width).toBe(4)
    expect(metadata.height).toBe(3)
    expect(output.format).toBe(format === "avif" ? "heif" : format)
  }
})
