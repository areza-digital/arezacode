// @ts-nocheck
import * as mod from "./message-part"
import { create } from "@opencode-ai/ui/storybook/scaffold"
import { DataProvider } from "../context/data"

const story = create({ title: "UI/MessagePart", mod })
export default { title: "UI/MessagePart", id: "components-message-part", component: story.meta.component }
export const Basic = story.Basic

export const ToolSpacing = {
  render: () => {
    const Tool = mod.PART_MAPPING.tool
    const message = { id: "spacing-message", sessionID: "spacing-session", role: "assistant" }
    const parts = [
      { tool: "task", input: { subagent_type: "explore", description: "Check chat spacing" }, status: "completed" },
      { tool: "bash", input: { command: "bun run typecheck", description: "Check types" }, status: "completed" },
      { tool: "task", input: { subagent_type: "explore", description: "Review tool icons" }, status: "running" },
      { tool: "read", input: { filePath: "/project/src/chat.tsx" }, status: "completed" },
    ].map((item, index) => ({
      id: `spacing-${index}`,
      messageID: message.id,
      sessionID: message.sessionID,
      type: "tool",
      tool: item.tool,
      callID: `spacing-call-${index}`,
      state: {
        status: item.status,
        input: item.input,
        output: "Completed successfully",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }))
    return (
      <DataProvider
        directory="/project"
        data={{
          session: [],
          session_status: {},
          session_diff: {},
          message: {},
          part: {},
          agent: [{ name: "explore" }],
        }}
      >
        <div style={{ "max-width": "720px", margin: "32px auto" }}>
          {parts.map((part) => (
            <Tool part={part} message={message} defaultOpen={false} />
          ))}
          <mod.ContextToolGroup parts={[parts[3]]} />
        </div>
      </DataProvider>
    )
  },
}
