import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions).toEqual(expect.arrayContaining(SessionEvent.Definitions))
    expect(EventManifest.Definitions).toEqual(expect.arrayContaining(EventManifest.ServerDefinitions))
    expect(new Set(EventManifest.Definitions.map((definition) => definition.type)).size).toBe(
      EventManifest.Definitions.length,
    )
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect([...EventManifest.Latest.values()]).toEqual([...EventManifest.Definitions])
    expect(new Set(EventManifest.Durable.values())).toEqual(
      new Set([
        ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
        ...SessionEvent.DurableDefinitions,
      ]),
    )
    SessionV1.Event.Definitions.forEach((definition) => {
      expect(EventManifest.Definitions).toContain(definition)
      expect(EventManifest.ServerDefinitions.includes(definition)).toBe(definition.durable !== undefined)
    })
    EventManifest.Durable.forEach((definition, key) => {
      expect(key).toBe(`${definition.type}.${definition.durable?.version}`)
    })
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("session.next.compaction.accounted")).toBe(SessionEvent.Compaction.Accounted)
    expect(EventManifest.Durable.get("session.next.compaction.accounted.1")).toBe(SessionEvent.Compaction.Accounted)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Latest.get("message.part.delta")).toBe(SessionV1.Event.PartDelta)
    expect(EventManifest.Latest.get("session.diff")).toBe(SessionV1.Event.Diff)
    expect(EventManifest.Latest.get("session.error")).toBe(SessionV1.Event.Error)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
