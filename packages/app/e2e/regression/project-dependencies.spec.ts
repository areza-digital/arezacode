import { expect, test, type Page } from "@playwright/test"
import type { ProjectDependencies } from "../../src/project-dependencies"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/Users/example/Documents/Projects/project-with-a-very-long-name/another-long-folder/workspace"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const sessionID = "ses_dependencies"

test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })

test("automatically checks dependencies on opening, preserves filters, and handles retries", async ({ page }) => {
  let result: ProjectDependencies = {
    status: "checked",
    checkedAt: 1,
    packages: [
      {
        name: "vite (dev)",
        current: "6.4.0",
        update: "6.4.1",
        latest: "7.3.0",
        workspace: "app",
        kind: "major",
        ageLimited: false,
      },
      {
        name: "solid-js",
        current: "1.9.9",
        update: "1.9.10",
        latest: "1.9.10",
        workspace: "catalog (app, desktop)",
        kind: "patch",
        ageLimited: true,
      },
    ],
  }
  const pending = Promise.withResolvers<void>()
  const checks: string[] = []
  await page.exposeFunction("checkTestDependencies", async (requested: string) => {
    checks.push(requested)
    expect(requested).toBe(directory)
    await pending.promise
    return result
  })
  await setup(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Dependency project", exact: true }).click()
  const panel = page.locator("#review-panel")
  expect(checks).toHaveLength(0)
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  await panel.getByRole("button", { name: "Dependencies", exact: true }).click()
  const dependencies = panel.locator('[data-component="project-dependencies"]')
  await expect(dependencies.getByRole("button", { name: "Checking versions…" })).toBeDisabled()
  expect(checks).toHaveLength(1)
  pending.resolve()
  await expect(dependencies.getByRole("article")).toHaveCount(2)
  await expect(dependencies.getByText("Review breaking changes before upgrading.")).toBeVisible()
  await expect(dependencies.getByText("1.9.10", { exact: true })).toHaveCount(2)
  await page.screenshot({ path: "/tmp/areza-dependencies-panel.png" })
  await dependencies.getByRole("searchbox").fill("solid")
  await expect(dependencies.getByRole("article")).toHaveCount(1)
  await panel.getByRole("button", { name: "New tab", exact: true }).click()
  await panel.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(dependencies).toBeHidden()
  expect(checks).toHaveLength(1)
  await panel.getByRole("tab", { name: "Dependencies", exact: true }).click()
  await expect(dependencies.getByRole("searchbox")).toHaveValue("solid")
  expect(checks).toHaveLength(2)
  result = { status: "failed" }
  await dependencies.getByRole("button", { name: "Refresh" }).click()
  await expect(dependencies.getByRole("alert")).toContainText("Could not check versions")
  await expect(dependencies.getByRole("article")).toHaveCount(0)
  result = { status: "missingLock" }
  await dependencies.getByRole("button", { name: "Refresh" }).click()
  await expect(dependencies.getByRole("alert")).toContainText("No Bun lockfile found")
  result = { status: "checked", packages: [], checkedAt: 2 }
  await dependencies.getByRole("button", { name: "Refresh" }).click()
  await expect(dependencies.getByText("No newer versions found", { exact: true })).toBeVisible()
  const empty = dependencies.locator('[data-component="empty-state"]')
  await expect(empty).toBeVisible()
  await expect(dependencies.getByRole("status")).toHaveCount(0)
  await expect(dependencies.getByRole("searchbox")).toHaveCount(0)
  const bounds = await empty.boundingBox()
  expect(bounds?.height).toBeGreaterThan(400)
  await page.screenshot({ path: "/tmp/areza-dependencies-empty.png" })
})

test("keeps long source folder paths inside the create project dialog", async ({ page }) => {
  await setup(page)
  await page.goto("/")
  const row = page.locator('[data-component="home-session-row"]').filter({ hasText: "Dependency project" })
  await row.locator("..").getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Move to project..." }).click()
  await page.getByRole("button", { name: "Create project", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Create project" })
  await dialog.getByRole("button", { name: "Add a folder" }).click()
  await expect(dialog.getByText(directory, { exact: true })).toBeVisible()
  await dialog.getByPlaceholder("Project name").fill("Long path project")
  await expect(dialog.getByRole("button", { name: "Create project", exact: true })).toBeEnabled()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1)
    await expect(dialog.getByRole("button", { name: `Remove ${directory}` })).toBeVisible()
    await page.screenshot({ path: `/tmp/areza-create-project-${width}.png` })
  }
  await dialog.getByRole("button", { name: `Remove ${directory}` }).click()
  await expect(dialog.getByRole("button", { name: "Create project", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_dependencies",
      worktree: directory,
      vcs: "git",
      name: "Dependencies",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "proj_dependencies",
        directory,
        title: "Dependency project",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
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
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { panelOpened: true } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
    },
    { directory, server, sessionID },
  )
  await page.route("**/src/entry.tsx*", async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    expect(source).toContain('platform: "web",')
    await route.fulfill({
      response,
      body: source.replace(
        'platform: "web",',
        `platform: "desktop", os: "macos", windowID: "browser", checkDependencies: (directory) => window.checkTestDependencies(directory), openDirectoryPickerDialog: async () => [${JSON.stringify(directory)}],`,
      ),
    })
  })
}
