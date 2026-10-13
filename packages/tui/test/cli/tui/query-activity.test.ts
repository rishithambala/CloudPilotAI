import { describe, expect, test } from "bun:test"
import type { ReasoningPart, ToolPart } from "@cloudpilot-ai/sdk/v2"
import { describeActivity, toolActivitySummary } from "../../../src/routes/session"

function base(tool: string, id: string): Omit<ToolPart, "state"> {
  return { id, sessionID: "session", messageID: "message", type: "tool", callID: id, tool }
}

function pending(tool: string, id: string): ToolPart {
  return { ...base(tool, id), state: { status: "pending", input: {}, raw: "" } }
}

function running(tool: string, id: string): ToolPart {
  return { ...base(tool, id), state: { status: "running", input: {}, time: { start: 1000 } } }
}

function completed(tool: string, id: string, start: number, end: number): ToolPart {
  return { ...base(tool, id), state: { status: "completed", input: {}, output: "", title: tool, metadata: {}, time: { start, end } } }
}

function failed(tool: string, id: string, start: number, end: number): ToolPart {
  return { ...base(tool, id), state: { status: "error", input: {}, error: "nope", time: { start, end } } }
}

function thinking(id: string, text: string, start: number, end?: number): ReasoningPart {
  return { id, sessionID: "session", messageID: "message", type: "reasoning", text, time: { start, end } }
}

describe("toolActivitySummary", () => {
  test("uses plain words for running, finished, and failed work", () => {
    expect(toolActivitySummary("read", "running")).toBe("Reading files…")
    expect(toolActivitySummary("read", "pending")).toBe("Reading files…")
    expect(toolActivitySummary("read", "completed")).toBe("Read files")
    expect(toolActivitySummary("read", "error")).toBe("Couldn't read files")
  })

  test("covers search and file changes without technical detail", () => {
    expect(toolActivitySummary("websearch", "running")).toBe("Searching the web…")
    expect(toolActivitySummary("websearch", "completed")).toBe("Searched the web")
    expect(toolActivitySummary("edit", "completed")).toBe("Edited files")
  })

  test("falls back to generic wording for unknown tools", () => {
    expect(toolActivitySummary("mystery", "running")).toBe("Working…")
    expect(toolActivitySummary("mystery", "completed")).toBe("Finished a step")
    expect(toolActivitySummary("mystery", "error")).toBe("A step had an issue")
  })
})

describe("describeActivity", () => {
  test("stays empty when nothing happened and nothing runs", () => {
    expect(describeActivity([], { running: false, writing: false })).toEqual({ mode: "empty", headline: "", count: 0 })
  })

  test("shows a working line at the very start of a turn", () => {
    expect(describeActivity([], { running: true, writing: false }).headline).toBe("Working…")
  })

  test("headlines the latest running tool while work continues", () => {
    const summary = describeActivity([completed("read", "a", 1000, 1500), running("websearch", "b")], { running: true, writing: false })
    expect(summary.mode).toBe("active")
    expect(summary.headline).toBe("Searching the web…")
    expect(summary.count).toBe(2)
  })

  test("headlines live thinking when no tool runs", () => {
    const summary = describeActivity([thinking("a", "pondering", 1000)], { running: true, writing: false })
    expect(summary.mode).toBe("active")
    expect(summary.headline).toBe("Thinking…")
  })

  test("headlines a live thinking title when present", () => {
    const summary = describeActivity([thinking("a", "**Planning the fix**\n\nDetails", 1000)], { running: true, writing: false })
    expect(summary.headline).toBe("Thinking: Planning the fix")
  })

  test("headlines answer writing once tools and thinking settle", () => {
    const summary = describeActivity([completed("read", "a", 1000, 1500)], { running: true, writing: true })
    expect(summary.mode).toBe("active")
    expect(summary.headline).toBe("Writing answer…")
  })

  test("titles finished work by achievement, not process", () => {
    const summary = describeActivity(
      [thinking("t", "done", 1000, 10000), completed("read", "a", 1000, 1500), completed("grep", "b", 1200, 2000)],
      { running: false, writing: false },
    )
    expect(summary.mode).toBe("done")
    expect(summary.headline).toBe("Reviewed 1 file · Searched 1 file")
  })

  test("prioritizes file changes in the achievement title", () => {
    const summary = describeActivity(
      [thinking("t", "done", 1000, 2000), completed("websearch", "a", 1000, 1500), completed("write", "b", 1500, 1800)],
      { running: false, writing: false },
    )
    expect(summary.headline).toBe("Updated 1 file · Searched the web")
  })

  test("falls back to thought time when nothing else was achieved", () => {
    expect(describeActivity([thinking("t", "done", 1000, 10000)], { running: false, writing: false }).headline).toBe(
      "Thought for 9.0s",
    )
  })

  test("names searched sources from result counts", () => {
    const search: ToolPart = {
      ...base("websearch", "a"),
      state: { status: "completed", input: { query: "x" }, output: "", title: "websearch", metadata: { numResults: 5, provider: "exa" }, time: { start: 1000, end: 1500 } },
    }
    expect(describeActivity([search], { running: false, writing: false }).headline).toBe("Searched 5 sources")
  })

  test("folds failed steps in silently", () => {
    const summary = describeActivity([completed("read", "a", 1000, 1500), failed("write", "b", 1500, 1800)], { running: false, writing: false })
    expect(summary.mode).toBe("done")
    expect(summary.headline).toBe("Updated 1 file · Reviewed 1 file")
  })

  test("falls back to a plain finish when nothing is describable", () => {
    expect(describeActivity([completed("bash", "a", 1000, 1500)], { running: false, writing: false }).headline).toBe("Finished")
  })

  test("treats a lone pending tool as active work", () => {
    const summary = describeActivity([pending("write", "a")], { running: true, writing: false })
    expect(summary.mode).toBe("active")
    expect(summary.headline).toBe("Writing files…")
  })
})
