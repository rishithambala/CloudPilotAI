import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { useKV } from "../../context/kv"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

const LINK_BOLD = "┃"
const LINK_MUTED = "│"
const NODE_DONE = "●"
const NODE_ACTIVE = "◉"
const NODE_QUEUED = "○"
const PLANE_UP = "▲"
const PLANE_DOWN = "▼"
const TICK = "✓"

export type RailRow = { kind: "node"; task: number } | { kind: "link"; below: number }

// Lays out one vertical rail, bottom task first. Nodes are one row each,
// links between them share the remaining height so the rail strictly fits
// its budget: more tasks means shorter links. Plane is the rest target in
// node units: the active task, the first pending task when nothing is
// active, or null when everything is done.
export function planRail(
  statuses: readonly string[],
  height: number,
): { rows: RailRow[]; nodeRow: number[]; slack: number; plane: number | null } {
  const total = statuses.length
  if (total === 0 || height <= 0) return { rows: [], nodeRow: [], slack: 0, plane: null }
  const links = total - 1
  // One row for the counter, one per node; links split what is left.
  const spare = height - 1 - total
  const base = links > 0 ? Math.max(0, Math.floor(spare / links)) : 0
  const rem = links > 0 ? Math.max(0, spare - base * links) : 0
  const rows: RailRow[] = []
  const nodeRow: number[] = []
  // Top task first (column order), bottom task fills upward.
  for (let task = total - 1; task >= 0; task--) {
    nodeRow[task] = rows.length
    rows.push({ kind: "node", task })
    if (task > 0) {
      const link = links - task
      const count = base + (link < rem ? 1 : 0)
      for (let i = 0; i < count; i++) rows.push({ kind: "link", below: task - 1 })
    }
  }
  const active = statuses.indexOf("in_progress")
  const anchor = active === -1 ? statuses.findIndex((status) => status !== "completed") : active
  return {
    rows,
    nodeRow,
    // Negative only when tasks outnumber rows, which needs a terminal
    // shorter than the todo list itself; overflow then clips same as elsewhere.
    slack: Math.max(0, height - 1 - rows.length),
    plane: anchor === -1 ? null : anchor,
  }
}

// Travel time scales with distance so the plane moves at constant speed no
// matter how many nodes a single update jumps over.
export function glideDuration(distance: number): number {
  return 150 + 250 * Math.abs(distance)
}

export function glideStep(
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
): { pos: number; done: boolean } {
  if (durationMs <= 0 || from === to) return { pos: to, done: true }
  const t = Math.max(0, Math.min(1, elapsedMs / durationMs))
  return { pos: from + (to - from) * t, done: t >= 1 }
}

// Patrol range for the slow drift while a task is processing: the active node
// and its upper neighbor, or the node below when the topmost task is active.
// Null when there is nothing to drift across (no active task or a lone task).
export function patrolRange(active: number, total: number): [number, number] | null {
  if (active < 0 || total <= 1) return null
  return active < total - 1 ? [active, active + 1] : [active - 1, active]
}

// Ping-pong phase 0 → 1 → 0 over one period.
export function patrolPhase(elapsedMs: number, periodMs: number): number {
  if (periodMs <= 0) return 0
  const x = (elapsedMs % periodMs) / periodMs
  return 1 - Math.abs(1 - x * 2)
}

export function TodoRail(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const list = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const completed = createMemo(() => list().filter((item) => item.status === "completed").length)
  const counter = createMemo(() => `${TICK} ${completed()}/${list().length}`)

  // The rail bows out shortly after the whole list is done: enough time to
  // register the completed state, then it disappears until new todos arrive.
  const allDone = createMemo(() => list().length > 0 && list().every((item) => item.status === "completed"))
  const [lingerDone, setLingerDone] = createSignal(false)
  let lingerTimer: ReturnType<typeof setTimeout> | undefined
  const clearLinger = () => {
    if (lingerTimer === undefined) return
    clearTimeout(lingerTimer)
    lingerTimer = undefined
  }
  onCleanup(clearLinger)

  createEffect(() => {
    if (!allDone()) {
      clearLinger()
      setLingerDone(false)
      return
    }
    clearLinger()
    setLingerDone(false)
    lingerTimer = setTimeout(() => setLingerDone(true), 2500)
  })

  const visible = createMemo(() => {
    if (list().length === 0 || lingerDone()) return false
    // Completion flash still shows during the linger window.
    if (allDone()) return true
    // Interrupted sessions go idle with unfinished todos left behind: hide.
    return (sync.data.session_status[props.sessionID]?.type ?? "idle") !== "idle"
  })
  const railWidth = createMemo(() => Math.max(3, counter().length))

  // Rough reserve for prompt/footer chrome until the first real measurement lands.
  const estimate = createMemo(() => Math.max(10, dimensions().height - 12))
  const [measured, setMeasured] = createSignal(0)
  const railHeight = createMemo(() => measured() || estimate())

  let rail: BoxRenderable | undefined
  const measure = () => {
    const height = rail?.height
    if (typeof height === "number" && height > 0 && height !== measured()) setMeasured(height)
  }

  createEffect(() => {
    if (!visible()) return
    measure()
    const id = setInterval(measure, 500)
    onCleanup(() => clearInterval(id))
  })
  createEffect(() => {
    dimensions()
    if (visible()) measure()
  })

  const layout = createMemo(() => planRail(list().map((item) => item.status), railHeight()))

  // The plane glides upward at constant speed instead of jumping between
  // nodes, then keeps drifting slowly while its task is processing. One
  // persistent timer serves both motions, so retargets mid-flight never
  // restart or cancel anything.
  const TICK_MS = 30
  const PATROL_PERIOD_MS = 3600
  const [planePos, setPlanePos] = createSignal<number | null>(null)
  const [planeDir, setPlaneDir] = createSignal<1 | -1>(1)
  let flight: { from: number; to: number; start: number; duration: number } | null = null
  let patrolT = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const clearTimer = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  onCleanup(clearTimer)

  // Points the plane along its motion: ▲ while rising, ▼ while descending.
  const movePlane = (pos: number) => {
    const prev = untrack(() => planePos())
    if (prev !== null) {
      if (pos > prev) setPlaneDir(1)
      else if (pos < prev) setPlaneDir(-1)
    }
    setPlanePos(pos)
  }

  const tick = () => {
    const flying = flight
    if (flying) {
      const step = glideStep(flying.from, flying.to, Date.now() - flying.start, flying.duration)
      if (!step.done) {
        movePlane(step.pos)
        return
      }
      flight = null
    }
    const info = untrack(() => {
      const items = list()
      return {
        rest: layout().plane,
        range: patrolRange(
          items.findIndex((item) => item.status === "in_progress"),
          items.length,
        ),
      }
    })
    if (info.rest === null || !info.range) {
      if (flying) movePlane(flying.to)
      return
    }
    const [lo, hi] = info.range
    if (flying) {
      // Sync the patrol phase so the handoff from travel is seamless.
      const frac = hi === lo ? 0 : Math.max(0, Math.min(1, (flying.to - lo) / (hi - lo)))
      patrolT = frac * (PATROL_PERIOD_MS / 2)
      movePlane(flying.to)
      return
    }
    patrolT += TICK_MS
    movePlane(lo + (hi - lo) * patrolPhase(patrolT, PATROL_PERIOD_MS))
  }

  const ensureTimer = () => {
    if (timer !== undefined) return
    timer = setInterval(tick, TICK_MS)
  }

  createEffect(
    on(() => props.sessionID, () => {
      flight = null
      patrolT = 0
      setPlanePos(null)
      setPlaneDir(1)
      setHover(null)
    }),
  )

  createEffect(() => {
    const target = layout().plane
    if (target === null) {
      flight = null
      setPlanePos(null)
      clearTimer()
      return
    }
    const current = untrack(() => planePos())
    if (current === target && flight === null) return
    if (!kv.get("animations_enabled", true)) {
      flight = null
      setPlanePos(target)
      return
    }
    flight = { from: current ?? 0, to: target, start: Date.now(), duration: glideDuration(target - (current ?? 0)) }
    ensureTimer()
  })

  const [hover, setHover] = createSignal<number | null>(null)
  const hovered = createMemo(() => {
    const index = hover()
    return index !== null && index < list().length ? index : null
  })

  const nodeFg = (task: number): RGBA => {
    const status = list()[task]?.status
    if (status === "completed") return theme.success
    if (status === "in_progress") return theme.warning
    return theme.textMuted
  }

  const nodeGlyph = (task: number) => {
    const status = list()[task]?.status
    if (status === "completed") return NODE_DONE
    if (status === "in_progress") return NODE_ACTIVE
    return NODE_QUEUED
  }

  const planeRow = createMemo(() => {
    const pos = planePos()
    const map = layout().nodeRow
    if (pos === null || map.length === 0) return null
    const lo = Math.max(0, Math.min(map.length - 1, Math.floor(pos)))
    const hi = Math.max(0, Math.min(map.length - 1, Math.ceil(pos)))
    if (lo === hi) return map[lo]
    const span = map[lo] - map[hi]
    return map[lo] - Math.round((pos - lo) * span)
  })

  const planeGlyph = createMemo(() => (planeDir() === 1 ? PLANE_UP : PLANE_DOWN))

  const tipTop = createMemo(() => {
    const index = hovered()
    if (index === null) return 0
    // Slack rows, then the counter row, then the task rows.
    return Math.min(layout().slack + 1 + layout().nodeRow[index], Math.max(0, railHeight() - 1))
  })

  const tip = createMemo(() => {
    const index = hovered()
    if (index === null) return null
    const item = list()[index]
    if (!item) return null
    const done = item.status === "completed"
    const active = item.status === "in_progress"
    // Full name; clamped only when it would overflow the screen width.
    const maxName = Math.max(8, dimensions().width - railWidth() - 8)
    const name = Locale.truncate(item.content, maxName)
    return {
      name,
      // Space + mark + padding, so the box never squeezes the text.
      width: name.length + 4,
      mark: done ? TICK : active ? NODE_ACTIVE : NODE_QUEUED,
      fg: done ? theme.success : active ? theme.warning : theme.textMuted,
    }
  })

  return (
    <Show when={visible()}>
      <box ref={(r: BoxRenderable) => (rail = r)} width={railWidth()} height="100%" flexDirection="column" flexShrink={0}>
        <For each={Array.from({ length: layout().slack })}>
          {() => <box height={1} />}
        </For>
        <box flexDirection="row" height={1} justifyContent="flex-end">
          <text fg={theme.success} selectable={false}>
            {counter()}
          </text>
        </box>
        <For each={layout().rows}>
          {(row, index) => {
            const isPlane = () => planeRow() === index()
            const glyph = () => {
              if (isPlane()) return planeGlyph()
              if (row.kind === "link") {
                const pos = planePos()
                const bold = layout().plane === null ? true : pos !== null && pos >= row.below + 0.5
                return bold ? LINK_BOLD : LINK_MUTED
              }
              return nodeGlyph(row.task)
            }
            const fg = () => {
              if (isPlane()) return theme.warning
              if (row.kind === "link") {
                const pos = planePos()
                const bold = layout().plane === null ? true : pos !== null && pos >= row.below + 0.5
                return bold ? theme.text : theme.textMuted
              }
              return nodeFg(row.task)
            }
            return (
              <box
                flexDirection="row"
                height={1}
                justifyContent="flex-end"
                onMouseOver={() => row.kind === "node" && setHover(row.task)}
                onMouseOut={() => setHover(null)}
              >
                <text fg={fg()} selectable={false}>
                  {glyph()}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={tip()}>
          {(item) => (
            <box
              position="absolute"
              top={tipTop()}
              right={railWidth()}
              width={item().width}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
            >
              <text attributes={TextAttributes.ITALIC} wrapMode="none" selectable={false}>
                <span style={{ fg: theme.text }}>{item().name} </span>
                <span style={{ fg: item().fg }}>{item().mark}</span>
              </text>
            </box>
          )}
        </Show>
      </box>
    </Show>
  )
}
