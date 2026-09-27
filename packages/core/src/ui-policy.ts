export * as UiPolicy from "./ui-policy"

import { diffLines } from "diff"

export const guidance =
  "UI changes must reuse the existing page, component, motion and design tokens. Do not create pages, components, routes, wrappers or abstractions unless needed by the user's request. Preserve sibling states: open/close, back, hover, focus, loading, empty, scroll and narrow layouts. Check changed UI visually before claiming success. Use colons or commas between related items, never decorative em/en dashes, middle dots or bullets. Preserve exact quoted source text and meaningful symbols; do not rewrite user data. A blocked write is a correction request: revise the patch, never bypass it through shell, code execution or another tool."

export function applies(target: string) {
  return (
    !/(?:^|[/.])(?:tests?|spec|fixtures?|generated|vendor|node_modules)(?:[/.]|$)/i.test(target) &&
    (/\.(?:[jt]sx|vue|svelte|html|css|scss|sass|less|blade\.php)$/i.test(target) ||
      (/(?:^|[/\\])(?:components|pages|views|routes|i18n|locales|translations)(?:[/\\])/i.test(target) &&
        /\.(?:[cm]?[jt]s|json|php|css)$/i.test(target)))
  )
}

export function inspect(target: string, before: string, after: string) {
  if (before === after || !applies(target)) return
  const markup = /\.(?:[jt]sx|vue|svelte|html|blade\.php)$/i.test(target)
  const changes = diffLines(before, after, { timeout: 100 })
  if (!changes)
    return {
      copy: [],
      structural: true,
      patch: "Diff exceeded the inspection limit; split the change into smaller patches.",
    }
  const added = changes
    .filter((change) => change.added)
    .map((change) => change.value)
    .join("\n")
  const oldCopy = copies(before, markup)
  const copy = copies(after, markup).filter((value) => {
    const index = oldCopy.indexOf(value)
    if (index < 0) return true
    oldCopy.splice(index, 1)
    return false
  })
  const declaration = (text: string) =>
    [...text.matchAll(/(?:function\s+|(?:const|class)\s+)([A-Z]\w*)\s*(?:[=(<{])/g)].map((match) => match[1])
  const existing = new Set(declaration(before))
  return {
    copy,
    structural:
      !before.trim() || declaration(added).some((name) => !existing.has(name)) || added.split("\n").length > 40,
    patch: changes
      .filter((change) => change.added || change.removed)
      .map((change) => `${change.added ? "+" : "-"}${change.value}`)
      .join("\n"),
  }
}

function copies(text: string, markup: boolean) {
  const source = text.replace(/\/\*[\s\S]*?\*\/|<!--[^]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
  const literals = [...source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)].map((match) => match[2])
  const content = markup ? [...source.matchAll(/>([^<>]+)</g)].map((match) => match[1].replace(/\{[^{}]*\}/g, "")) : []
  return [...literals, ...content]
    .map((value) =>
      value
        .replace(
          /&(?:mdash|ndash|middot|bull);|&#(?:8212|8211|183|8226);|&#x(?:2014|2013|b7|2022);|\\u(?:2014|2013|00b7|2022)/gi,
          "·",
        )
        .trim(),
    )
    .filter((value) => /[—–·•]/.test(value))
}
