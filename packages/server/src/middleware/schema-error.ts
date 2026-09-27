import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { schemaErrorReason } from "../schema-error"
export { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => {
  const reason = schemaErrorReason(error.cause)
  return Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
})
