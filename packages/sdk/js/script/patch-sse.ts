const original =
  /          signal\.removeEventListener\(["']abort["'], abortHandler\);?\r?\n          reader\.releaseLock\(\);?/
const requestStart = /      try \{\r?\n        const (requestInit|response)/
const replacement = `          signal.removeEventListener("abort", abortHandler)
          controller.abort()
          try {
            await reader.cancel()
          } catch {} finally {
            reader.releaseLock()
          }`

export async function patchSse(file: string | URL) {
  const source = await Bun.file(file).text()
  if (source.includes("controller.abort()")) return
  if (!original.test(source) || !requestStart.test(source)) {
    throw new Error(`SSE cleanup patch did not apply: ${file}`)
  }
  await Bun.write(
    file,
    source.replace(original, replacement).replace(
      requestStart,
      `      try {
        const controller = new AbortController()
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
        const $1`,
    ),
  )
}

if (import.meta.main) {
  await Promise.all(
    ["../src/gen/core/serverSentEvents.gen.ts", "../src/v2/gen/core/serverSentEvents.gen.ts"].map((file) =>
      patchSse(new URL(file, import.meta.url)),
    ),
  )
}
