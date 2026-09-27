import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolDefinition,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../../process"
import { Shell } from "../../shell"
import { SessionInputTable } from "../sql"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Catalog } from "../../catalog"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionHealth } from "../health"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { AutomaticChecks } from "../../automatic-checks"
import { Jev } from "../../jev"
import { Document } from "../../document"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const permissions = yield* PermissionV2.Service
    const process = yield* AppProcess.Service
    const automations = new Map<string, Awaited<ReturnType<typeof AutomaticChecks.session>>>()
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, session: SessionSchema.Info) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load(),
        Effect.succeed(session.instructions ? SystemContext.make({
          key: SystemContext.Key.make("core/session-instructions"),
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.succeed(session.instructions),
          baseline: (text) => `Custom instructions for this session:\n${text}`,
          update: (_previous, text) => `These custom instructions replace the previous custom instructions for this session:\n${text}`,
          removed: () => "The previous custom instructions for this session no longer apply.",
        }) : SystemContext.empty),
      ], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const prepareCommand = Effect.fn("SessionRunner.prepareCommand")(function* (row: typeof SessionInputTable.$inferSelect) {
      const session = yield* getSession(row.session_id)
      const agent = yield* agents.select(session.agent)
      const matches = [...row.prompt.text.matchAll(/!`([^`]+)`/g)]
      const outputs: string[] = []
      for (const match of matches) {
        yield* permissions.assert({ sessionID: session.id, agent: agent.id, action: "bash", resources: [match[1]!], metadata: { command: row.preparation?.command } }).pipe(Effect.orDie)
        const shell = Shell.acceptable()
        const result = yield* process.run(ChildProcess.make(shell, Shell.args(shell, match[1]!, location.directory), { cwd: location.directory }), { maxOutputBytes: 1_048_576, maxErrorBytes: 65_536, timeout: "2 minutes" }).pipe(Effect.flatMap(AppProcess.requireSuccess), Effect.orDie)
        if (result.stdoutTruncated) return yield* Effect.die(new Error("Command output exceeds 1 MiB"))
        outputs.push(result.stdout.toString("utf8"))
      }
      let index = 0
      return row.prompt.text.replace(/!`([^`]+)`/g, () => outputs[index++]!)
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff, prepareCommand)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id, prepareCommand))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff, prepareCommand)
        }
        yield* SessionInput.deliverTasks(db, events, session.id)
        promoted += yield* SessionInput.promoteSteers(db, events, session.id, yield* EventV2.latestSequence(db, session.id), prepareCommand)
        if (promoted > 0) currentStep = 1
        if (promoted === 0 && step === 1 && (yield* SessionHealth.get(db, session.id)).locked)
          return { needsContinuation: false, step: currentStep }
      }
      const system = yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session), session.id, initialized)
      const model = yield* models.resolve(session)
      if (model.route.defaults.limits?.context) yield* SessionHealth.recordModel(db, session.id, { id: session.model?.id ?? model.id, providerID: session.model?.providerID ?? model.provider, context: model.route.defaults.limits.context })
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const original = entries.map((entry) => entry.message)
      const notice = yield* Effect.promise(() => automations.get(session.id)?.before(original) ?? Promise.resolve(""))
      const context = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const message = entry.message
          if (
            message.type !== "user" ||
            !message.files?.some((file) => Document.documentType(file.name ?? file.uri, file.mime))
          )
            return entry
          const documents = message.files.filter((file) => Document.documentType(file.name ?? file.uri, file.mime))
          const texts = yield* Effect.forEach(documents, (file) =>
            Effect.gen(function* () {
              if (file.uri.startsWith("file:")) {
                const absolute = yield* Effect.promise(() => realpath(fileURLToPath(file.uri)))
                const relative = path.relative(location.directory, absolute)
                if (relative.startsWith("..") || path.isAbsolute(relative))
                  yield* permissions.assert({
                    sessionID: session.id,
                    agent: agent.id,
                    action: "external_directory",
                    resources: [path.dirname(absolute)],
                    save: [],
                  }).pipe(Effect.orDie)
                yield* permissions.assert({
                  sessionID: session.id,
                  agent: agent.id,
                  action: "read",
                  resources: [absolute],
                  save: [],
                }).pipe(Effect.orDie)
              }
              return yield* Effect.tryPromise((signal) => Document.attachment(file, signal, session.id)).pipe(
                Effect.catch(() =>
                  Effect.succeed(`Document conversion failed: ${file.name ?? "attachment"}. No content was extracted.`),
                ),
              )
            }),
          )
          return {
            ...entry,
            message: {
              ...message,
              text: [message.text, ...texts].join("\n\n"),
              files: message.files.filter((file) => !documents.includes(file)),
            },
          }
        }),
      )
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = createHash("sha256").update(JSON.stringify([location.directory, location.workspaceID, model.provider, model.id, agent.info?.system, system.baseline])).digest("hex")
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": model.provider === "openrouter" ? promptCacheKey : session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey }, openrouter: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [
          ...toLLMMessages(context.map((entry) => entry.message), model),
          ...(notice ? [Message.user(notice)] : []),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions.map((tool) => Jev.quickEdit(session.id) && Jev.needsQuickEditReason(tool.name) ? new ToolDefinition({
          ...tool,
          inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties && typeof tool.inputSchema.properties === "object" ? tool.inputSchema.properties : {}), quickEditReason: Jev.quickEditReason } },
        }) : tool) ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      const prices = yield* Effect.serviceOption(Catalog.Service).pipe(
        Effect.flatMap((catalog) =>
          Option.isSome(catalog)
            ? catalog.value.model.available().pipe(
                Effect.map(
                  (items) =>
                    items.find((item) => String(item.providerID) === model.provider && String(item.api.id) === model.id)?.cost,
                ),
              )
            : Effect.succeed(undefined),
        ),
      )
      const compactionInput = {
        sessionID: session.id,
        entries: context,
        model,
        request,
        prices,
      }
      if (yield* compaction.compactIfNeeded(compactionInput)) return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      let timing: NonNullable<SessionMessage.Usage["timing"]> = { startedAt: Date.now(), retries: [] }
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
        timing: () => timing,
        prices,
        request: {
          systemCharacters: JSON.stringify(request.system).length,
          messageCharacters: JSON.stringify(request.messages).length,
          toolCharacters: JSON.stringify(request.tools).length,
          cacheKey: promptCacheKey,
        },
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (timing.firstEventAt === undefined) timing = { ...timing, firstEventAt: Date.now() }
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                Effect.promise(() => Jev.guardTool(session.id, event.name, event.input)).pipe(
                  Effect.flatMap((guard) => guard.error
                    ? Effect.succeed({ result: { type: "error" as const, value: guard.error }, output: undefined, outputPaths: [] })
                    : toolMaterialization.settle({
                      sessionID: session.id,
                      agent: agent.id,
                      assistantMessageID,
                      call: { ...event, input: guard.input },
                    })),
                ),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
        Effect.provideService(RequestExecutor.Observer, (event) => Effect.gen(function* () {
          if (event.type === "dispatch" && timing.dispatchedAt === undefined) timing = { ...timing, dispatchedAt: event.time }
          if (event.type === "response" && timing.firstResponseAt === undefined) timing = { ...timing, firstResponseAt: event.time }
          if (event.type !== "retry") return
          timing = { ...timing, retries: [...timing.retries, { time: event.time, attempt: event.attempt, reason: event.reason, delayMs: event.delayMs }] }
          yield* events.publish(SessionEvent.Retried, {
            sessionID: session.id,
            timestamp: DateTime.makeUnsafe(event.time),
            attempt: event.attempt,
            error: { message: event.reason, isRetryable: true, metadata: { delayMs: String(event.delayMs) } },
          })
        })),
        Effect.annotateLogs({ sessionID: session.id, provider: model.provider, model: model.id }),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow(compactionInput)))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: stepSettlement.usage.cost ?? 0,
                usage: stepSettlement.usage,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          if (!publisher.hasProviderError()) {
            const context = yield* getContext(session.id)
            yield* restore(Effect.promise((signal) => automations.get(session.id)?.after(context, signal) ?? Promise.resolve()))
            if (!needsContinuation) {
              const verification = yield* restore(Effect.promise(() => automations.get(session.id)?.complete(!isLastStep) ?? Promise.resolve(undefined)))
              if (verification?.status === "retry") needsContinuation = true
              if (verification?.status === "blocked") yield* withPublication(publisher.failAssistant(verification.notice))
            }
          }
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const locked = (yield* SessionHealth.get(db, input.sessionID)).locked
      if (locked && !(yield* SessionInput.canStartIndependent(db, input.sessionID))) return
      const hasSteer = !locked && (yield* SessionInput.hasPending(db, input.sessionID, "steer"))
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      automations.set(input.sessionID, yield* Effect.promise(() => AutomaticChecks.session(location.directory, input.sessionID)))
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        const automation = automations.get(input.sessionID)
        automations.delete(input.sessionID)
        if (!automation) return
        const context = yield* getContext(input.sessionID).pipe(Effect.orDie)
        yield* Effect.promise(() => automation.finish(context))
      }))
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation && !(yield* SessionHealth.get(db, input.sessionID)).locked) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = (yield* SessionInput.hasPending(db, input.sessionID, "queue")) && (!(yield* SessionHealth.get(db, input.sessionID)).locked || (yield* SessionInput.canStartIndependent(db, input.sessionID)))
        promotion = shouldRun ? "queue" : undefined
      }
    }, Effect.scoped)

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    PermissionV2.node,
    AppProcess.node,
    Database.node,
  ],
})
