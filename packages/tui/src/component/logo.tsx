import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { mascotCellWidths, mascotCells } from "../mascot/cells"
import type { MascotCell } from "../mascot/raster"
import { CellImage } from "./image"

// Rows (prompt, taglines, gaps, margins) the mascot must leave room for so
// it never pushes the prompt outside small terminals.
const RESERVED_ROWS = 14
const SOURCE_RATIO = 1024 / 1536

// Largest pre-rasterized width that fits both dimensions. Falls back to the
// smallest art on extremely narrow or short terminals instead of breaking
// the layout.
export function pickMascotWidth(termWidth: number, termHeight: number): number {
  const byWidth = termWidth >= 64 ? 44 : termWidth >= 52 ? 36 : termWidth >= 40 ? 28 : termWidth >= 28 ? 20 : 12
  const maxRows = Math.max(4, termHeight - RESERVED_ROWS)
  let picked: number = mascotCellWidths[0] ?? 12
  for (const width of mascotCellWidths) {
    if (width > byWidth) break
    if (Math.ceil((width * SOURCE_RATIO) / 2) > maxRows) break
    picked = width
  }
  return picked
}

// The source PNG is a plain cloud, so the face is knocked out of the
// silhouette as negative space: two eye holes plus a mouth hole. Holes
// show the terminal background, which reads on any theme without adding
// colors. Targets snap to the nearest covered cell so the face never
// floats on transparency.
function knockFace(cells: MascotCell[][]): MascotCell[][] {
  const rows = cells.length
  const cols = cells[0]?.length ?? 0
  if (rows < 5 || cols < 7) return cells
  const nearest = (y: number, x: number): [number, number] | undefined => {
    for (let radius = 0; radius <= 3; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dy), Math.abs(dx)) !== radius) continue
          const cell = cells[y + dy]?.[x + dx]
          if (cell && (cell.fg || cell.bg)) return [y + dy, x + dx]
        }
      }
    }
    return undefined
  }
  const copy = cells.map((row) => row.map((cell) => ({ ...cell })))
  const eyeRow = Math.floor(rows * 0.42)
  const mouthRow = Math.min(rows - 1, eyeRow + 2)
  const targets: Array<[number, number]> = [
    [eyeRow, Math.floor(cols * 0.38)],
    [eyeRow, Math.floor(cols * 0.6)],
    [mouthRow, Math.floor(cols * 0.49)],
  ]
  for (const [y, x] of targets) {
    const found = nearest(y, x)
    if (found) copy[found[0]][found[1]] = { char: " " }
  }
  return copy
}

export function Logo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const cells = () => knockFace(mascotCells[pickMascotWidth(dimensions().width, dimensions().height)] ?? [])

  return (
    <box flexDirection="column" gap={1} alignItems="center">
      <CellImage cells={cells()} monochrome={theme.textMuted} />
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        cloudpilot-ai
      </text>
      <text fg={theme.textMuted} selectable={false}>
        AN AUTONOMOUS MULTI-AGENT CLOUD OPERATIONS PLATFORM
      </text>
    </box>
  )
}
