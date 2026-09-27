import { expect, test } from "bun:test"
import { UiPolicy } from "../src/ui-policy"

test("UI copy checks literal, encoded and interpolated separators without flagging ordinary punctuation", () => {
  for (const value of [
    "Paid · Today",
    "Paid — Today",
    "Paid &middot; Today",
    "Paid \\u2014 Today",
    "{paid} · {date}",
  ]) {
    expect(UiPolicy.inspect("src/components/card.tsx", "", `<p>${value}</p>`)?.copy.length).toBeGreaterThan(0)
  }
  expect(UiPolicy.inspect("src/locales/en.json", "{}", '{"label":"Paid • Today"}')?.copy).toContain("Paid • Today")
  expect(
    UiPolicy.inspect("src/components/card.tsx", "", '<p title="Paid: today">Total: 1.5, ready.</p>')?.copy,
  ).toEqual([])
  expect(UiPolicy.inspect("src/components/card.tsx", "", "// Preserve — source\n<p>Ready</p>")?.copy).toEqual([])
  expect(UiPolicy.inspect("test/card.test.tsx", "", "<p>Paid · Today</p>")).toBeUndefined()
})

test("UI inspection catches new components and preserves unrelated pre-existing copy", () => {
  const before = "export const Card = () => <p>Paid · Today</p>\n"
  expect(UiPolicy.inspect("src/card.tsx", before, before.replace("<p>", '<p className="small">'))?.copy).toEqual([])
  expect(UiPolicy.inspect("src/card.tsx", before, before.replace("<p>", '<p className="small">'))?.structural).toBe(
    false,
  )
  expect(UiPolicy.inspect("src/card.tsx", before, before + "export const NewPage = () => <main />")?.structural).toBe(
    true,
  )
  expect(UiPolicy.inspect("src/pages/new.tsx", "", "export default () => <main />")?.structural).toBe(true)
  expect(UiPolicy.inspect("src/card.tsx", before, before + "<p>Paid · Today</p>")?.copy.length).toBeGreaterThan(0)
})
