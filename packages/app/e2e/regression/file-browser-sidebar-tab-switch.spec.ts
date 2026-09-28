import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/FileBrowserSidebar"
const projectID = "proj_file_browser_sidebar"
const sessionID = "ses_file_browser_sidebar"
const title = "File browser sidebar"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const files = Array.from({ length: 80 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`)
// Marks the file-browser sidebar DOM node so a remount (fresh node) is detectable.
const PROBE = "original"

test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })

test("opens the panel picker, nested agents, and browser controls", async ({ page }) => {
  const events: unknown[] = []
  await setup(page, undefined, () => events)
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  const picker = panel.locator('[data-component="session-panel-picker"]')
  await expect(picker.getByRole("button")).toHaveText([
    "Review",
    "Terminal",
    "Browser",
    "Server",
    "Files",
    "Agents",
    "Dependencies",
  ])
  await page.screenshot({ path: "/tmp/areza-panels-picker.png" })
  await picker.getByRole("button", { name: "Agents", exact: true }).click()
  const agents = panel.locator('[data-component="session-agents"]')
  await expect(agents.getByRole("button", { name: /Review authentication.*Running/ })).toBeVisible()
  await expect(agents.getByRole("button", { name: /Inspect tests.*Idle/ })).toBeVisible()
  await expect(agents.getByText("Test · high", { exact: true })).toHaveCount(2)
  await page.screenshot({ path: "/tmp/areza-panels-agents.png" })
  events.push({
    directory,
    payload: { type: "session.status", properties: { sessionID: "ses_panel_child", status: { type: "idle" } } },
  })
  await expect(agents.getByRole("button", { name: /Review authentication.*Idle/ })).toBeVisible()
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  await picker.getByRole("button", { name: "Browser", exact: true }).click()
  const browser = panel.locator('[data-component="session-browser"]')
  await browser.getByRole("textbox", { name: "Enter a URL" }).fill("file:///etc/passwd")
  await browser.getByRole("textbox", { name: "Enter a URL" }).press("Enter")
  await expect(browser.getByRole("alert")).toHaveText("Enter an HTTP or HTTPS URL without credentials.")
  await page.screenshot({ path: "/tmp/areza-panels-browser.png" })
  await panel.getByRole("tab", { name: "Agents", exact: true }).click()
  await agents.getByRole("button", { name: /Inspect tests/ }).click()
  await expect(page).toHaveURL(new RegExp("/session/ses_panel_grandchild$"))
})

// The file-browser sidebar must stay mounted across preview/pinned file-tab
// switches. Remounting resets scroll and filter state.
test("keeps the file-browser sidebar mounted when switching file tabs", async ({ page }) => {
  await setup(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  await panel.getByRole("button", { name: "Files", exact: true }).click()
  await expect(panel.getByRole("tab", { name: "Open file" })).toHaveAttribute("data-selected", "")

  const sidebar = panel.locator('[data-component="session-review-v2-sidebar-root"]')
  await expect(sidebar).toBeVisible()
  await expect(panel.getByRole("button", { name: "file-00.ts" })).toBeVisible()

  await panel.getByRole("button", { name: "file-00.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-00.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-00.ts", { exact: true })).toBeVisible()

  const viewport = panel.locator('[data-slot="session-review-v2-sidebar-tree"] .scroll-view__viewport')
  await viewport.hover()
  await page.mouse.wheel(0, 100_000)
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  const scrolled = await viewport.evaluate((element) => element.scrollTop)
  expect(scrolled).toBeGreaterThan(0)
  await writeProbe(page)

  await panel.getByRole("button", { name: "file-79.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("contents:file-79.ts", { exact: true })).toBeVisible()
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrolled)

  await panel.getByRole("button", { name: "file-78.ts" }).dblclick()
  await expect(panel.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  await panel.getByRole("button", { name: "file-79.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-79.ts" })).toHaveAttribute("data-selected", "")
  await panel.getByRole("tab", { name: "file-78.ts" }).click()
  await expect(panel.getByRole("tab", { name: "file-78.ts" })).toHaveAttribute("data-selected", "")
  expect(await readProbe(page)).toBe(PROBE)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrolled)
})

test("keeps previous file search results visible while the next search loads", async ({ page }) => {
  const searchPending = Promise.withResolvers<void>()
  await setup(page, async ({ query }) => {
    if (query === "file-0") return ["file-00.ts"]
    if (query === "file-7") {
      await searchPending.promise
      return ["file-79.ts"]
    }
    return []
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const panel = page.locator("#review-panel")
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  await panel.getByRole("button", { name: "Files", exact: true }).click()
  const filter = panel.getByRole("combobox", { name: "Filter files" })
  await filter.fill("file-0")
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeVisible()

  const nextSearch = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === "/find/file" && url.searchParams.get("query") === "file-7"
  })
  await filter.fill("file-7")
  await nextSearch
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeVisible()

  searchPending.resolve()
  await expect(panel.getByRole("option", { name: "file-79.ts" })).toBeVisible()
  await expect(panel.getByRole("option", { name: "file-00.ts" })).toBeHidden()
})

type Probed = HTMLElement & { __e2eProbe?: string }

async function writeProbe(page: Page) {
  await page.locator('#review-panel [data-component="session-review-v2-sidebar-root"]').evaluate((el, probe) => {
    ;(el as Probed).__e2eProbe = probe
  }, PROBE)
}

async function readProbe(page: Page) {
  return page
    .locator('#review-panel [data-component="session-review-v2-sidebar-root"]')
    .evaluate((el) => (el as Probed).__e2eProbe)
}

async function setup(
  page: Page,
  findFiles?: (input: { query: string; dirs?: string; limit?: number }) => unknown | Promise<unknown>,
  events?: () => unknown[],
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "file-browser-sidebar",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
      ...(events
        ? [
            { id: "ses_panel_child", parentID: sessionID, title: "Review authentication" },
            { id: "ses_panel_grandchild", parentID: "ses_panel_child", title: "Inspect tests" },
          ].map((session) => ({
            ...session,
            slug: session.id,
            projectID,
            directory,
            version: "dev",
            time: { created: 1700000000000, updated: 1700000000000 },
          }))
        : []),
    ],
    vcsDiff: [],
    fileList: (path) => {
      if (path) return []
      return files.map((name) => ({
        name,
        path: name,
        absolute: `${directory}/${name}`,
        type: "file" as const,
        ignored: false,
      }))
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    findFiles,
    pageMessages: (id) => ({
      items:
        events && id !== sessionID
          ? [
              {
                info: {
                  id: `msg_${id}`,
                  sessionID: id,
                  role: "assistant",
                  agent: "build",
                  mode: "build",
                  modelID: "test",
                  providerID: "opencode",
                  variant: "high",
                  parentID: "msg_user",
                  time: { created: 1700000000000, completed: 1700000001000 },
                  path: { cwd: directory, root: directory },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [],
              },
            ]
          : [],
    }),
    sessionStatus: events ? { ses_panel_child: { type: "busy" }, ses_panel_grandchild: { type: "idle" } } : {},
    events,
    eventRetry: events ? 100 : undefined,
  })

  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID },
  )
}
