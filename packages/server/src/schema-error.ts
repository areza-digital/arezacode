import type { Schema, SchemaIssue } from "effect"

export function schemaErrorReason(error: Schema.SchemaError) {
  return issueReasons(error.issue).slice(0, 8).join("; ").slice(0, 1024)
}

function issueReasons(issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey> = []): string[] {
  switch (issue._tag) {
    case "Pointer":
      return issueReasons(issue.issue, [...path, ...issue.path])
    case "Encoding":
    case "Filter":
      return issueReasons(issue.issue, path)
    case "Composite":
    case "AnyOf":
      if (issue.issues.length) return issue.issues.slice(0, 8).flatMap((child) => issueReasons(child, path))
  }
  const message = issue._tag === "MissingKey" ? "Missing required field" : "Invalid value"
  return [path.length ? `${message} at ${path.map(String).join(".")}` : message]
}
