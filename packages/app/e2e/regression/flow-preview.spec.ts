import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("opens a completed flow write with overview, technical details, and wireframe", async ({ page }, testInfo) => {
  await page.addInitScript(
    (server) => localStorage.setItem("opencode.settings.dat:defaultServerUrl", server),
    `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
  )
  const input = { path: "flows/login.flow.md", content: "" }
  const timeline = await setupTimeline(page, {
    settings: { newLayoutDesigns: true },
    messages: [userMessage(), assistantMessage([toolPart("prt_flow", "write", "running", input)])],
  })
  await page.route("**/file/content*", (route) =>
    route.fulfill({
      json: {
        type: "text",
        content:
          "## For everyone\nPress Sign in to continue.\n\n## Technical details\nThe login handler sends the request.\n\n## Wireframe\n> Sign in -> Loading -> Account",
      },
    }),
  )
  await timeline.send(partUpdated(toolPart("prt_flow", "write", "completed", input, { output: "Written" })))
  const panel = page.locator("#review-panel")
  await expect(panel.getByRole("tab", { name: "login.flow.md" })).toHaveAttribute("data-selected", "")
  await expect(panel.getByText("Press Sign in to continue.", { exact: true })).toBeVisible()
  await panel.getByRole("tab", { name: "Technical details", exact: true }).click()
  await expect(panel.getByText("The login handler sends the request.", { exact: true })).toBeVisible()
  await panel.getByRole("tab", { name: "Wireframe", exact: true }).click()
  await expect(panel.getByRole("tabpanel", { name: "Wireframe", exact: true })).toContainText(
    "Sign in -> Loading -> Account",
  )
  await page.screenshot({ path: testInfo.outputPath("flow-wireframe.png") })
})
