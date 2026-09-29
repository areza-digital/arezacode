export * as AutomaticChecks from "./automatic-checks"

import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, writeFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"
import { Jev } from "./jev"
import { UiPolicy } from "./ui-policy"
import { UiVerification } from "./ui-verification"
import { Entire } from "./entire"
import type { SessionMessage } from "./session/message"
import { engineCommand, engineEnabled, engineEnvironment, engineResult, engineVersions, nativeBinary, nativeCommand } from "./util/native-command"

const scans = new Map<string, Promise<string>>()
const results = new Map<string, string[]>()
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const reuseChecks = new Map<string, { before: string; at: number; candidates: Array<{ path: string; hash: string }>; blocks: Map<string, string> }>()
const sourceFile = (target: string) => /\.(?:[cm]?[jt]sx?|vue|svelte|py|php|rs|go|swift)$/.test(target) && !/(?:^|[/.])(?:test|spec|generated|vendor)(?:[/.]|$)/.test(target)
const codeBlocks = (text: string) => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 3 && !/^(?:import |\/\/|#)/.test(line))
  return lines.flatMap((_, index) => {
    const block = lines.slice(index, index + 12).join("\n")
    return index + 12 <= lines.length && block.length >= 240 ? [hash(block)] : []
  })
}

export async function rememberReuse(sessionID: string, target: string, before: string, candidates: Array<{ path: string; content: string }>) {
  const blocks = new Map<string, string>()
  candidates.forEach((candidate) => {
    if (candidate.content.trim().length >= 80) blocks.set(hash(candidate.content.trim()), candidate.path)
    codeBlocks(candidate.content).forEach((block) => blocks.set(block, candidate.path))
  })
  const key = `${sessionID}:${target}`
  reuseChecks.delete(key)
  reuseChecks.set(key, { before: hash(before), at: Date.now(), candidates: candidates.map((candidate) => ({ path: candidate.path, hash: hash(candidate.content) })), blocks })
  while (reuseChecks.size > 32) reuseChecks.delete(reuseChecks.keys().next().value!)
}

export async function guardReuse(sessionID: string, target: string, before: string, after: string) {
  await Jev.guardChange(sessionID, target, before, after)
  if (!sourceFile(target) || before === after || !(await engineEnabled("ponytail"))) return
  const existing = new Set(before.split("\n").map((line) => line.trim()))
  const added = after.split("\n").filter((line) => line.trim() && !existing.has(line.trim()))
  const declaration = added.some((line) => /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\s|^export\s+const\s|^const\s+[A-Z]\w*\s*=/.test(line))
  if (before && added.length < 40 && !declaration) return
  const check = reuseChecks.get(`${sessionID}:${target}`)
  if (!check || check.before !== hash(before) || Date.now() - check.at > 600_000)
    throw new Error(`Ponytail reuse check required before creating or substantially expanding ${target}. Call reuse_check for this target and search for the existing feature, shared UI components, and native library support. Then reuse the existing owner or make a justified targeted change.`)
  for (const candidate of check.candidates) {
    const content = await readFile(candidate.path, "utf8").catch(() => undefined)
    if (content === undefined || hash(content) !== candidate.hash)
      throw new Error("Reuse evidence changed. Run reuse_check again before writing.")
  }
  const old = new Set(codeBlocks(before))
  const duplicate = [hash(after.trim()), ...codeBlocks(after).filter((block) => !old.has(block))].map((block) => check.blocks.get(block)).find(Boolean)
  if (duplicate) throw new Error(`Duplicate implementation detected in ${duplicate}. Reuse or extend that implementation instead of copying it into ${target}.`)
}

export async function session(directory: string, sessionID: string) {
  let baseline = await files(directory).catch(() => undefined)
  const revision = baseline?.revision
  const verification = UiVerification.create(sessionID, baseline)
  const originals = new Map(baseline ? await Promise.all([...baseline.files].filter(([name, value]) => UiPolicy.applies(name) && !value.startsWith("oversized:")).map(async ([name]) => [name, await readFile(path.join(baseline!.root, name), "utf8").catch(() => "")] as const)) : [])
  const pendingUI = new Map<string, string>()
  let uiNotice = ""
  let notice = ""
  let userID = ""
  let modified = false
  await Entire.ensure(directory).catch(() => { notice = "Entire is unavailable. Session checkpoints will not be recorded." })
  const record = async (event: Parameters<typeof Entire.recordV2>[2], context: readonly SessionMessage.Message[]) => {
    await Entire.recordV2(directory, sessionID, event, context).catch(() => { notice += "\nEntire checkpoint recording failed. No checkpoint is claimed for this turn." })
  }
  return {
    before: async (context: readonly SessionMessage.Message[]) => {
      verification.observe(baseline, verificationContext(context))
      const user = context.findLast((message) => message.type === "user")
      if (user && user.id !== userID) {
        if (userID) await record("turn-end", context.slice(0, context.indexOf(user)))
        if (!userID) await record("session-start", context)
        await record("turn-start", context)
        userID = user.id
        Jev.remember(sessionID, user.text, context.filter((message) => message.type === "user").map((message) => message.text))
        if (await engineEnabled("ponytail")) await engineResult("ponytail", "Build hook active: reuse preflight and mechanical tool checks enabled. Guidance supplied; compliance is verified separately.")
      }
      return [notice, uiNotice, verification.guidance(), user ? await Jev.guidance(sessionID, user.id, context.slice(context.indexOf(user) + 1).filter((message) => message.type === "assistant").length) : ""].filter(Boolean).join("\n")
    },
    after: async (_context: readonly SessionMessage.Message[], signal?: AbortSignal) => {
      const security = process.env.AREZACODE_SEMGREP !== "0" && await engineEnabled("semgrep")
      const ponytail = await engineEnabled("ponytail")
      if (baseline) {
        try {
          const current = await files(directory, revision)
          verification.observe(current, verificationContext(_context))
          const changed = new Map([...current.files].filter(([name, value]) => baseline!.files.get(name) !== value))
          const violations: string[] = []
          for (const name of new Set([...changed.keys(), ...pendingUI.keys()])) {
            if (!UiPolicy.applies(name)) continue
            if (current.files.get(name)?.startsWith("oversized:")) {
              violations.push(`${name}: UI inspection skipped a file larger than 1 MiB; split the change before claiming verification.`)
              continue
            }
            const content = await readFile(path.join(current.root, name), "utf8").catch(() => undefined)
            if (content === undefined) { pendingUI.delete(name); continue }
            const before = pendingUI.get(name) ?? originals.get(name) ?? (baseline.revision ? await nativeCommand("git", ["show", `${baseline.revision}:${name}`], { cwd: current.root }).catch(() => "") : "")
            try {
              await Jev.verifyChange(sessionID, path.join(current.root, name), before, content)
              pendingUI.delete(name)
            } catch (error) {
              pendingUI.set(name, before)
              violations.push(`${name}: ${error instanceof Error ? error.message : "UI policy check unavailable"}`)
            }
            originals.set(name, content)
          }
          uiNotice = violations.length ? `UI policy corrections required before claiming completion. These files were changed outside a successful pre-write check; revise only the offending changes and preserve user edits.\n${violations.join("\n")}` : ""
          if (changed.size || baseline.files.size !== current.files.size) {
            modified = true
            notice = security ? await scan(current.root, changed, sessionID, signal) : ""
            if (ponytail) {
              notice += "\nPonytail review hook: inspect the current diff and untracked files, reuse shared owners/components, check dependency additions against native support, and run the relevant configured project_check. Incremental scans cover only the latest changed files."
              await engineResult("ponytail", "Review hook supplied after edits. Reuse evidence and configured checks still require verification.")
            }
          }
          baseline = current
        } catch {
          verification.observe(undefined, verificationContext(_context))
          notice = "Automatic checks failed or are unavailable. Changed files have not passed verification."
        }
      }
    },
    complete: (canRetry: boolean) => verification.check(canRetry, uiNotice),
    finish: async (context: readonly SessionMessage.Message[]) => {
      if (modified && baseline && process.env.AREZACODE_SEMGREP !== "0" && await engineEnabled("semgrep")) await scan(baseline.root, baseline.files, sessionID).catch(() => engineResult("semgrep", "Final changed-file scan failed; coverage is incomplete."))
      if (userID) await record("turn-end", context)
      await record("session-end", context)
    },
  }
}

function verificationContext(context: readonly SessionMessage.Message[]): UiVerification.Context {
  return {
    promptID: context.findLast((message) => message.type === "user")?.id ?? "",
    requests: context.flatMap((message) => message.type === "user" ? [message.text] : []),
    response: context.findLast((message) => message.type === "assistant")?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "",
    tools: context.flatMap((message) => message.type === "assistant" ? message.content.flatMap((part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error") ? [{
      id: part.id, tool: part.name, input: JSON.stringify(part.state.input),
      output: part.state.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n"),
      visual: part.state.content.some((content) => content.type === "file" && content.mime.startsWith("image/")),
      ok: part.state.status === "completed",
    }] : []) : []),
  }
}

export async function files(directory: string, base?: string) {
  const root = (await nativeCommand("git", ["rev-parse", "--show-toplevel"], { cwd: directory })).trim()
  const [tracked, staged, untracked, revision] = await Promise.all([
    nativeCommand("git", ["diff", "--name-only", "-z", ...(base ? [base] : [])], { cwd: root }),
    nativeCommand("git", ["diff", "--cached", "--name-only", "-z"], { cwd: root }),
    nativeCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }),
    nativeCommand("git", ["rev-parse", "HEAD"], { cwd: root }).catch(() => undefined),
  ])
  const entries = await Promise.all(
    [...new Set((tracked + staged + untracked).split("\0").filter(Boolean))].map(async (name) => {
      const file = path.resolve(root, name)
      const relative = path.relative(root, file)
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return
      const info = await lstat(file).catch(() => undefined)
      if (!info) return [name, "deleted"] as const
      if (!info?.isFile()) return
      const canonical = path.relative(root, await realpath(file))
      if (canonical === ".." || canonical.startsWith(".." + path.sep) || path.isAbsolute(canonical)) return
      if (info.size > 1024 * 1024) return [name, `oversized:${info.size}:${info.mtimeMs}`] as const
      return [name, hash(await readFile(file))] as const
    }),
  )
  return { root, revision: revision?.trim(), files: new Map(entries.filter((entry) => entry !== undefined)) }
}

export function scan(root: string, changed: Map<string, string>, sessionID?: string, signal?: AbortSignal) {
  if (!changed.size) return Promise.resolve("")
  const oversized = [...changed].filter(([, hash]) => hash.startsWith("oversized:"))
  const targets = [...changed].filter(([, hash]) => hash !== "deleted" && !hash.startsWith("oversized:")).map(([name]) => name)
  const incomplete = oversized.length
    ? `Semgrep skipped ${oversized.length} changed files larger than 1 MiB; coverage is incomplete.`
    : ""
  if (!targets.length) return Promise.resolve(incomplete)
  const format = async (findings: string[], errors: number) => [
    findings.length ? `Automatic Semgrep findings (${findings.length}):\n${(await Jev.prioritizeSemgrep(findings, sessionID)).join("\n")}` : "",
    errors ? `Semgrep reported ${errors} scan errors; coverage is incomplete.` : "",
    incomplete,
  ].filter(Boolean).join("\n")
  const previous = scans.get(root) ?? Promise.resolve("")
  const task = previous
    .catch(() => "")
    .then(async () => {
      signal?.throwIfAborted()
      if (!(await engineEnabled("semgrep"))) return ""
      const unchanged = async () => (await Promise.all(targets.map(async (name) => {
        const content = await readFile(path.join(root, name)).catch(() => undefined)
        return content !== undefined && hash(content) === changed.get(name)
      }))).every(Boolean)
      if (!(await unchanged())) throw new Error("Files changed before scanning; refresh the scan inputs")
      const directory = path.join(Global.Path.cache, "automatic-semgrep")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const rules = path.join(directory, "default.yaml")
      const cached = await readFile(rules, "utf8").catch(() => undefined)
      if (!cached) {
        const response = await fetch("https://semgrep.dev/c/p/default", { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) })
        if (!response.ok) throw new Error("Semgrep rules could not be downloaded; scan did not run")
        const text = await response.text()
        if (text.length > 8 * 1024 * 1024 || !/(?:"rules"|rules)\s*:/.test(text))
          throw new Error("Invalid Semgrep rules response")
        const temporary = rules + `.${randomUUID()}.tmp`
        await writeFile(temporary, text, { mode: 0o600 })
        await rename(temporary, rules)
      }
      const binary = await nativeBinary("semgrep")
      const dependencies = await Promise.all(["package.json", "bun.lock", "bun.lockb", "pyproject.toml", "uv.lock", "Cargo.lock", ".semgrepignore"].map((file) => readFile(path.join(root, file)).then(hash).catch(() => "")))
      const key = hash(JSON.stringify([root, engineVersions.semgrep, binary, await lstat(binary).then((info) => [info.size, info.mtimeMs]), hash(await readFile(rules)), dependencies, [...changed].sort()]))
      const hit = results.get(key)
      if (hit !== undefined) return format(hit, 0)
      const persisted = await readCache("semgrep", key)
      if (persisted) {
        const parsed: unknown = await Promise.resolve(persisted).then(JSON.parse).catch(() => undefined)
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          await engineResult("semgrep", "Reused a complete scan with identical files, rules, dependencies, and tool version.")
          return format(parsed, 0)
        }
      }
      const output = await engineCommand(
        "semgrep",
        [
          "scan",
          "--config",
          rules,
          "--json",
          "--metrics",
          "off",
          "--disable-version-check",
          "--no-git-ignore",
          "--timeout",
          "10",
          "--",
          ...targets.map((file) => path.join(root, file)),
        ],
        { cwd: root, timeout: 120_000, signal },
      )
      const parsed: unknown = JSON.parse(output)
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("results" in parsed) ||
        !Array.isArray(parsed.results) ||
        !("errors" in parsed) ||
        !Array.isArray(parsed.errors)
      )
        throw new Error("Invalid Semgrep response; scan status is unknown")
      const findings = parsed.results.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") throw new Error("Invalid Semgrep finding")
        const result = item as {
          path?: string
          start?: { line?: number }
          check_id?: string
          extra?: { message?: string; severity?: string }
        }
        if (typeof result.path !== "string" || typeof result.extra?.message !== "string")
          throw new Error("Invalid Semgrep finding")
        return [
          `${path.relative(root, result.path)}:${result.start?.line ?? 1} [${result.extra.severity ?? "WARNING"}] ${result.check_id}: ${result.extra.message}`,
        ]
      })
      if (!(await unchanged())) throw new Error("Files changed during scanning; results were not cached")
      if (!parsed.errors.length) {
        results.set(key, findings)
        if (results.size > 100) results.delete(results.keys().next().value!)
        await writeCache("semgrep", key, JSON.stringify(findings))
      }
      await engineResult("semgrep", `${findings.length} findings; ${parsed.errors.length} scan errors`)
      return format(findings, parsed.errors.length)
    })
  scans.set(root, task)
  return task.finally(() => {
    if (scans.get(root) === task) scans.delete(root)
  })
}

export async function compress(text: string, signal?: AbortSignal, sessionID?: string) {
  const created = Date.now()
  signal?.throwIfAborted()
  if (text.length < 8000 || text.length > 4 * 1024 * 1024 || process.env.AREZACODE_HEADROOM === "0") return
  if (!(await engineEnabled("headroom"))) return
  const executable = await realpath(await nativeBinary("headroom"))
  const key = hash(JSON.stringify([engineVersions.headroom, executable, await lstat(executable).then((info) => [info.size, info.mtimeMs]), "v3:gpt-4o:reversible-folds:protect_recent=0:kompress=disabled:positive-token-savings", text]))
  const cached = await readCache("headroom", key)
  signal?.throwIfAborted()
  if (cached === "") {
    const completed = Date.now()
    await engineResult("headroom", "Reused unchanged output with identical input, settings, and tool version; no useful compression.")
    if (sessionID) await Jev.recordCompression(sessionID, text.length, text.length, true, { created, completed })
    signal?.throwIfAborted()
    return
  }
  if (cached && cached.length < text.length * 0.9 && !/<<ccr:|\[.*headroom_retrieve/.test(cached)) {
    const completed = Date.now()
    await engineResult("headroom", "Reused compressed output with identical input, settings, and tool version.")
    if (sessionID) await Jev.recordCompression(sessionID, text.length, cached.length, true, { created, completed })
    signal?.throwIfAborted()
    return cached
  }
  const first = (await readFile(executable, "utf8")).split("\n")[0]
  const python = first.startsWith("#!/") ? first.slice(2).trim() : undefined
  if (!python || !path.isAbsolute(python) || !path.basename(python).startsWith("python"))
    throw new Error("Headroom Python environment is unavailable")
  const output = await engineCommand(
    "headroom",
    [
      "-c",
      [
        "import json,sys",
        "from headroom import compress",
        "from headroom.tokenizers import get_tokenizer",
        "from headroom.transforms.lossless_compaction import compact_lossless",
        "text=sys.stdin.read()",
        "folded=min([text]+[compact_lossless(text,kind) for kind in ('text','search','paths','config')],key=len)",
        "result=folded if len(folded)<len(text) else compress([{'role':'tool','tool_call_id':'output','content':text}],model='gpt-4o',protect_recent=0,kompress_model='disabled').messages[0]['content']",
        "tokenizer=get_tokenizer('gpt-4o')",
        "print(json.dumps(result if isinstance(result,str) and tokenizer.count_text(result)<tokenizer.count_text(text) else text))",
      ].join("\n"),
    ],
    { interpreter: python, input: text, timeout: 15_000, signal, env: engineEnvironment({ HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" }) },
  )
  signal?.throwIfAborted()
  const result: unknown = JSON.parse(output)
  const valid = typeof result === "string" && result.trim() && !/<<ccr:|\[.*headroom_retrieve/.test(result)
  const useful = valid && result.length < text.length * 0.9
  await engineResult("headroom", useful
    ? `Compressed ${text.length} to ${result.length} characters; full originals remain available through tool-output storage.`
    : valid && result.length < text.length
      ? "Reduction below the 10% acceptance threshold; original output preserved."
      : "No supported reduction; original output preserved. ML text compression is disabled.")
  if (sessionID) await Jev.recordCompression(sessionID, text.length, useful ? result.length : text.length, false, { created, completed: Date.now() })
  signal?.throwIfAborted()
  if (!valid) return
  await writeCache("headroom", key, useful ? result : "", signal)
  if (!useful) return
  return result
}

async function readCache(engine: "headroom" | "semgrep", key: string) {
  const file = path.join(Global.Path.cache, "mechanical", engine, key)
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile() || info.size > 4 * 1024 * 1024 || Date.now() - info.mtimeMs > 7 * 86400_000) return
  return readFile(file, "utf8").catch(() => undefined)
}

async function writeCache(engine: "headroom" | "semgrep", key: string, text: string, signal?: AbortSignal) {
  const directory = path.join(Global.Path.cache, "mechanical", engine)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`)
  try {
    signal?.throwIfAborted()
    await writeFile(temporary, text, { mode: 0o600 })
    signal?.throwIfAborted()
    await rename(temporary, path.join(directory, key))
  } finally {
    await rm(temporary, { force: true })
  }
  const files = await readdir(directory)
  if (files.length <= 200) return
  const entries = await Promise.all(files.filter((name) => /^[a-f0-9]{64}$/.test(name)).map(async (name) => ({ name, time: await lstat(path.join(directory, name)).then((info) => info.mtimeMs).catch(() => 0) })))
  await Promise.all(entries.sort((a, b) => b.time - a.time).slice(200).map((entry) => rm(path.join(directory, entry.name), { force: true })))
}
