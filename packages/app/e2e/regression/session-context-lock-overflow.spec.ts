import { expect, test } from "@playwright/test"
import { setupTimeline } from "../performance/timeline-stability/fixture"

for (const direction of ["ltr", "rtl"]) {
  test(`scrolls context-limit actions with edge fades in ${direction}`, async ({ page }, testInfo) => {
    await setupTimeline(page, { settings: { newLayoutDesigns: true, independentTasks: false } })
    await page.addInitScript(() => {
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", "dark")
    })
    await page.route("**/api/session/*/health", (route) =>
      route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { locked: true, inputTokens: 200000, limit: 200000 },
      }),
    )
    await page.reload()
    const banner = page.locator('[data-component="session-context-lock"]')
    await expect(banner.getByRole("status")).toHaveText("Context limit reached · Input locked")
    await banner.evaluate((element, direction) => {
      element.style.width = "280px"
      element.dir = direction
    }, direction)
    const scroll = banner.locator('.scroll-view[data-orientation="horizontal"]')
    const viewport = scroll.locator(".scroll-view__viewport")
    await expect(scroll).toHaveAttribute("data-scroll-after", "true")
    await expect(scroll).not.toHaveAttribute("data-scroll-before")
    expect(await banner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(viewport).toHaveCSS("mask-image", /linear-gradient/)
    await page.screenshot({ path: testInfo.outputPath(`context-lock-${direction}-start.png`) })
    const status = (await banner.getByRole("status").boundingBox())!
    const action = (await banner.getByRole("button", { name: "Copy handoff", exact: true }).boundingBox())!
    expect(Math.abs(status.y + status.height / 2 - action.y - action.height / 2)).toBeLessThan(2)
    await viewport.hover()
    await expect(scroll.locator(".scroll-view__thumb")).toBeHidden()
    await expect(viewport).toHaveCSS("scrollbar-width", "none")
    await page.mouse.wheel(direction === "rtl" ? -800 : 800, 0)
    await expect(scroll).toHaveAttribute("data-scroll-before", "true")
    await expect(scroll).not.toHaveAttribute("data-scroll-after")
    const next = banner.getByRole("button", { name: "Start new chat", exact: true })
    await expect(next).toBeInViewport()
    await expect(scroll.locator(".scroll-view__thumb")).toBeHidden()
    const box = (await next.boundingBox())!
    const bounds = (await viewport.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
    await page.screenshot({ path: testInfo.outputPath(`context-lock-${direction}-end.png`) })
    await page.mouse.wheel(direction === "rtl" ? 800 : -800, 0)
    await expect(scroll).not.toHaveAttribute("data-scroll-before")
    await expect(scroll).toHaveAttribute("data-scroll-after", "true")
    await banner.getByRole("button", { name: "Independent tasks", exact: true }).focus()
    await page.keyboard.press("Tab")
    await expect(banner.getByRole("button", { name: "Copy handoff", exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(next).toBeFocused()
    await expect(scroll).not.toHaveAttribute("data-scroll-after")
    await banner.evaluate((element) => {
      element.style.width = "100%"
    })
    await expect(scroll).not.toHaveAttribute("data-scroll-before")
    await expect(scroll).not.toHaveAttribute("data-scroll-after")
    await expect(scroll).toHaveCSS("--scroll-fade-start", "0px")
    await expect(scroll).toHaveCSS("--scroll-fade-end", "0px")
    await page.screenshot({ path: testInfo.outputPath(`context-lock-${direction}-fits.png`) })
    await banner.getByRole("button", { name: "Independent tasks", exact: true }).click()
    await expect(banner).toHaveCount(0)
  })
}
