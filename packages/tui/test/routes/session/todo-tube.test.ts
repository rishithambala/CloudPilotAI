import { describe, expect, test } from "bun:test"
import { glideDuration, glideStep, patrolPhase, patrolRange, planRail } from "../../../src/routes/session/todo-toggle"

describe("planRail", () => {
  test("returns empty for no tasks", () => {
    expect(planRail([], 24)).toEqual({ rows: [], nodeRow: [], slack: 0, plane: null })
  })

  test("spreads links to strictly fill the height, bottom task first", () => {
    const { rows, nodeRow, slack, plane } = planRail(["pending", "pending", "pending", "pending"], 24)
    expect(slack).toBe(0)
    // 1 counter + 4 nodes + 19 link rows = 24.
    expect(rows.length).toBe(23)
    expect(nodeRow).toEqual([22, 15, 8, 0])
    expect(rows[0]).toEqual({ kind: "node", task: 3 })
    expect(rows[22]).toEqual({ kind: "node", task: 0 })
    expect(rows[1]).toEqual({ kind: "link", below: 2 })
    expect(plane).toBe(0)
  })

  test("rests the plane on the active task", () => {
    const { plane, nodeRow } = planRail(["completed", "completed", "in_progress", "pending"], 24)
    expect(plane).toBe(2)
    expect(nodeRow[2]).toBe(8)
  })

  test("hides the plane when everything is done", () => {
    const { plane } = planRail(["completed", "completed"], 24)
    expect(plane).toBeNull()
  })

  test("compresses links when tasks outgrow the height", () => {
    const { rows, slack } = planRail(["completed", "pending", "pending", "pending"], 6)
    expect(slack).toBe(0)
    // 1 counter + 4 nodes + 1 link row = 6.
    expect(rows.length).toBe(5)
    expect(rows.filter((row) => row.kind === "link")).toHaveLength(1)
  })
})

describe("glide", () => {
  test("duration grows with distance", () => {
    expect(glideDuration(0)).toBe(150)
    expect(glideDuration(3)).toBe(900)
  })

  test("mid-flight position is strictly between endpoints", () => {
    const step = glideStep(0, 3, 450, 900)
    expect(step.done).toBe(false)
    expect(step.pos).toBeGreaterThan(0)
    expect(step.pos).toBeLessThan(3)
  })

  test("snaps exactly to target at the end", () => {
    expect(glideStep(0, 3, 900, 900)).toEqual({ pos: 3, done: true })
    expect(glideStep(0, 3, 9999, 900)).toEqual({ pos: 3, done: true })
  })

  test("a multi-node jump takes many frames, never one", () => {
    const duration = glideDuration(3)
    const positions = [0]
    let elapsed = 0
    while (true) {
      elapsed += 30
      const step = glideStep(0, 3, elapsed, duration)
      positions.push(step.pos)
      if (step.done) break
    }
    expect(positions.length).toBeGreaterThan(5)
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1])
    expect(positions.at(-1)).toBe(3)
  })
})

describe("patrol", () => {
  test("spans the active node and its upper neighbor", () => {
    expect(patrolRange(0, 4)).toEqual([0, 1])
    expect(patrolRange(2, 4)).toEqual([2, 3])
  })

  test("drops below the topmost task when nothing is above it", () => {
    expect(patrolRange(3, 4)).toEqual([2, 3])
  })

  test("stays put with no active task or a lone task", () => {
    expect(patrolRange(-1, 4)).toBeNull()
    expect(patrolRange(0, 1)).toBeNull()
  })

  test("phase ping-pongs 0 → 1 → 0 over one period", () => {
    expect(patrolPhase(0, 3600)).toBe(0)
    expect(patrolPhase(1800, 3600)).toBe(1)
    expect(patrolPhase(900, 3600)).toBe(0.5)
    expect(patrolPhase(2700, 3600)).toBe(0.5)
    expect(patrolPhase(3600, 3600)).toBe(0)
  })
})
