import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { schemaErrorReason } from "@opencode-ai/server/schema-error"

// Default Respondable returns an empty 400 body. Match the NamedError shape
// used by other 4xx/5xx so the SDK's `wrapClientError` extracts `.data.message`.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@opencode/HttpApiSchemaError",
  {
    error: InvalidRequestError,
  },
) {}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error, context) => {
  const reason = schemaErrorReason(error.cause)
  const response = context.endpoint.path.startsWith("/api/")
    ? Effect.fail(
        new InvalidRequestError({
          message: reason,
          kind: error.kind,
        }),
      )
    : Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { name: "BadRequest", data: { message: reason, kind: error.kind } },
          { status: 400 },
        ),
      )
  return Effect.logWarning("schema rejection", { kind: error.kind, reason }).pipe(Effect.andThen(response))
})
