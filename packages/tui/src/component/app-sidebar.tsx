import { createMemo, createSignal, For, Show } from "solid-js"
import { InputRenderable, RGBA, TextAttributes } from "@opentui/core"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTuiConfig } from "../config"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogHelp } from "../ui/dialog-help"
import { DialogSettings } from "./dialog-settings"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSessionList } from "./dialog-session-list"
import { DialogSessionRename } from "./dialog-session-rename"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useClipboard } from "../context/clipboard"
import { getScrollAcceleration } from "../util/scroll"
import { Locale } from "../util/locale"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"
import { useLocation } from "../context/location"
import { useTuiPaths } from "../context/runtime"
import type { JSX } from "@opentui/solid"
import type { AssistantMessage, McpStatus, Session } from "@cloudpilot-ai/sdk/v2"

const SIDEBAR_WIDTH_DEFAULT = 30
const SIDEBAR_WIDTH_MIN = 20
const SIDEBAR_WIDTH_MAX = 50
const RAIL_WIDTH = 3

const DAY_MS = 86_400_000

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function AppSidebar() {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const local = useLocal()
  const dialog = useDialog()
  const [newChatHovered, setNewChatHovered] = createSignal(false)
  const [collapseHovered, setCollapseHovered] = createSignal(false)
  const [railHovered, setRailHovered] = createSignal<string>()
  const [hoveredSection, setHoveredSection] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  let searchInput: InputRenderable | undefined

  // Open/closed and width are persisted, like Claude.ai's collapsible,
  // resizable chat-list sidebar (toggle: ctrl+., resize: ctrl+[ / ctrl+]).
  const [open, setOpen] = kv.signal("app_sidebar_open", true)
  const [width] = kv.signal("app_sidebar_width", SIDEBAR_WIDTH_DEFAULT)
  // Collapsed chat groups persist too, like Claude.ai's collapsible Starred /
  // recency sections.
  const [collapsed, setCollapsed] = kv.signal<string[]>("app_sidebar_collapsed", [])
  const clampedWidth = createMemo(() => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width())))

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const location = useLocation()
  const paths = useTuiPaths()
  const footerDirectory = createMemo(() => location()?.directory ?? paths.cwd)

  const sessions = createMemo(() =>
    sync.data.session
      .filter((session) => session.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )

  const pinnedIDs = createMemo(() => local.session.pinned())

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return sessions()
    return sessions().filter((session) => (session.title || "Untitled").toLowerCase().includes(needle))
  })

  // Claude.ai groups the chat list into Starred plus recency buckets instead
  // of one flat list, so recent work stays scannable as history grows. While
  // searching, groups collapse into a single flat result list.
  const groups = createMemo(() => groupSessions(filtered(), pinnedIDs(), query().trim().length > 0, Date.now()))

  function isWorking(id: string) {
    const status = sync.data.session_status?.[id]
    return status?.type === "busy" || status?.type === "retry"
  }

  function toggleSection(label: string) {
    const prev = collapsed() as string[]
    setCollapsed(() => (prev.includes(label) ? prev.filter((entry) => entry !== label) : [...prev, label]))
  }

  function clearSearch() {
    if (searchInput && !searchInput.isDestroyed) searchInput.value = ""
    setQuery("")
  }

  function blurSearch() {
    if (searchInput && !searchInput.isDestroyed && searchInput.focused) searchInput.blur()
  }

  function selectSession(id: string) {
    clearSearch()
    blurSearch()
    route.navigate({ type: "session", sessionID: id })
  }

  function openMenu(session: Session) {
    blurSearch()
    dialog.replace(() => (
      <ChatActions
        sessionID={session.id}
        title={session.title || "Untitled"}
        pinned={local.session.isPinned(session.id)}
        isCurrent={session.id === currentSessionID()}
      />
    ))
  }

  // Collapsed state: a slim icon rail like Claude.ai's — new chat, search,
  // and expand affordances — so the main chat reclaims the space.
  return (
    <Show
      when={open()}
      fallback={
        <box
          backgroundColor={theme.backgroundPanel}
          width={RAIL_WIDTH}
          height="100%"
          flexShrink={0}
          flexDirection="column"
          alignItems="center"
          paddingTop={1}
          gap={1}
        >
          <RailIcon
            label="new"
            glyph="✎"
            hovered={railHovered() === "new"}
            onHover={() => setRailHovered("new")}
            onLeave={() => setRailHovered((current) => (current === "new" ? undefined : current))}
            onSelect={() => route.navigate({ type: "home" })}
          />
          <RailIcon
            label="search"
            glyph="⌕"
            hovered={railHovered() === "search"}
            onHover={() => setRailHovered("search")}
            onLeave={() => setRailHovered((current) => (current === "search" ? undefined : current))}
            onSelect={() => dialog.replace(() => <DialogSessionList />)}
          />
          <RailIcon
            label="help"
            glyph="?"
            hovered={railHovered() === "help"}
            onHover={() => setRailHovered("help")}
            onLeave={() => setRailHovered((current) => (current === "help" ? undefined : current))}
            onSelect={() => dialog.replace(() => <DialogHelp />)}
          />
          <RailIcon
            label="settings"
            glyph="☰"
            hovered={railHovered() === "settings"}
            onHover={() => setRailHovered("settings")}
            onLeave={() => setRailHovered((current) => (current === "settings" ? undefined : current))}
            onSelect={() => dialog.replace(() => <DialogSettings />)}
          />
          <box
            onMouseOver={() => setCollapseHovered(true)}
            onMouseOut={() => setCollapseHovered(false)}
            onMouseUp={() => setOpen(() => true)}
          >
            <text fg={collapseHovered() ? theme.text : theme.textMuted} attributes={collapseHovered() ? TextAttributes.BOLD : undefined}>
              ›
            </text>
          </box>
        </box>
      }
    >
      <box
        backgroundColor={theme.backgroundPanel}
        width={clampedWidth()}
        height="100%"
        flexShrink={0}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexShrink={0} flexDirection="row" alignItems="center" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={2}>
          <text fg={theme.primary} selectable={false}>
            ☁
          </text>
          <box flexGrow={1}>
            <text fg={theme.textMuted} selectable={false}>
              cloudpilot
            </text>
          </box>
          <box
            onMouseOver={() => setCollapseHovered(true)}
            onMouseOut={() => setCollapseHovered(false)}
            onMouseUp={() => setOpen(() => false)}
          >
            <text fg={collapseHovered() ? theme.text : theme.textMuted} attributes={collapseHovered() ? TextAttributes.BOLD : undefined}>
              ‹
            </text>
          </box>
        </box>

        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <InfoSection id="info" label="Info" collapsed={collapsed()} onToggle={toggleSection}>
            <InfoPanel sessionID={currentSessionID()} collapsed={collapsed()} onToggle={toggleSection} />
          </InfoSection>
        </box>

        <box height={1} flexShrink={0} />

        <box flexShrink={0} flexDirection="row" alignItems="center" paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <box
            flexGrow={1}
            flexDirection="row"
            alignItems="center"
            gap={1}
            onMouseOver={() => setNewChatHovered(true)}
            onMouseOut={() => setNewChatHovered(false)}
            onMouseUp={() => route.navigate({ type: "home" })}
          >
            <text fg={theme.primary}>✎</text>
            <text fg={newChatHovered() ? theme.text : theme.textMuted} attributes={newChatHovered() ? TextAttributes.BOLD : undefined}>
              <b>New chat</b>
            </text>
          </box>
        </box>

        <box
          flexShrink={0}
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
        >
          <text fg={theme.textMuted} selectable={false}>
            ⌕
          </text>
          <box flexGrow={1}>
            <input
              placeholder="Search chats"
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              focusedBackgroundColor={RGBA.fromInts(0, 0, 0, 0)}
              cursorColor={theme.primary}
              cursorStyle={tuiConfig.cursor}
              onInput={(value) => setQuery(value)}
              onSubmit={() => dialog.replace(() => <DialogSessionList />)}
              onMouseDown={() => searchInput?.focus()}
              ref={(r: InputRenderable) => {
                searchInput = r
              }}
            />
          </box>
          <Show when={query()}>
            <box onMouseUp={clearSearch}>
              <text fg={theme.textMuted}>×</text>
            </box>
          </Show>
        </box>

        <scrollbox
          flexGrow={1}
          paddingLeft={2}
          paddingRight={2}
          scrollAcceleration={scrollAcceleration()}
          onMouseDown={blurSearch}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <Show when={groups().length > 0} fallback={<text fg={theme.textMuted}>No chats yet</text>}>
            <box flexDirection="column" gap={0}>
              <For each={groups()}>
                {(group) => (
                  <>
                    <box
                      flexShrink={0}
                      flexDirection="row"
                      alignItems="center"
                      gap={1}
                      paddingLeft={1}
                      paddingTop={1}
                      paddingBottom={1}
                      onMouseOver={() => setHoveredSection(group.label)}
                      onMouseOut={() =>
                        setHoveredSection((current) => (current === group.label ? undefined : current))
                      }
                      onMouseUp={() => toggleSection(group.label)}
                    >
                      <text fg={hoveredSection() === group.label ? theme.text : theme.textMuted}>
                        {collapsed().includes(group.label) ? "▸" : "▾"}
                      </text>
                      <text
                        fg={hoveredSection() === group.label ? theme.text : theme.textMuted}
                        attributes={hoveredSection() === group.label ? TextAttributes.BOLD : undefined}
                      >
                        {group.label}
                      </text>
                    </box>
                    <Show when={!collapsed().includes(group.label)}>
                      <For each={group.sessions}>
                        {(session) => (
                          <SidebarRow
                            session={session}
                            active={session.id === currentSessionID()}
                            pinned={local.session.isPinned(session.id)}
                            working={isWorking(session.id)}
                            width={clampedWidth()}
                            onSelect={() => selectSession(session.id)}
                            onTogglePin={() => local.session.togglePin(session.id)}
                            onMenu={() => openMenu(session)}
                          />
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </For>
              <Show when={query().trim()}>
                <box
                  flexShrink={0}
                  paddingLeft={1}
                  paddingTop={1}
                  onMouseUp={() => dialog.replace(() => <DialogSessionList />)}
                >
                  <text fg={theme.textMuted}>Search all chats and content…</text>
                </box>
              </Show>
            </box>
          </Show>
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="char">
            {footerDirectory()}
          </text>
        </box>
      </box>
    </Show>
  )
}

function RailIcon(props: {
  label: string
  glyph: string
  hovered: boolean
  onHover: () => void
  onLeave: () => void
  onSelect: () => void
}) {
  const { theme } = useTheme()
  return (
    <box onMouseOver={props.onHover} onMouseOut={props.onLeave} onMouseUp={props.onSelect}>
      <text fg={props.hovered ? theme.text : theme.textMuted} attributes={props.hovered ? TextAttributes.BOLD : undefined}>
        {props.glyph}
      </text>
    </box>
  )
}

function SidebarRow(props: {
  session: Session
  active: boolean
  pinned: boolean
  working: boolean
  width: number
  onSelect: () => void
  onTogglePin: () => void
  onMenu: () => void
}) {
  const { theme } = useTheme()
  // Hover lives on the row itself (not the parent list) and the action slots
  // re-assert it, so moving the cursor onto the star or "⋯" never unmounts
  // the button mid-click. Slots always occupy space to avoid layout shift.
  const [hover, setHover] = createSignal(false)
  // The active chat gets a soft fill like Claude.ai's selected row; hovered
  // rows underline instead of shifting layout with a fill.
  const emphasized = () => props.active || hover()
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      marginBottom={1}
      gap={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onSelect}
    >
      <box flexGrow={1} minWidth={0} flexDirection="column">
        <box flexDirection="row" gap={1} alignItems="center">
          <Show when={props.working}>
            <Spinner />
          </Show>
          <text fg={props.active ? theme.primary : hover() ? theme.text : theme.textMuted} attributes={emphasized() ? TextAttributes.BOLD : undefined}>
            {Locale.truncate(props.session.title || "Untitled", props.width - 12)}
          </text>
        </box>
        <text fg={theme.textMuted}>{Locale.todayTimeOrDateTime(props.session.time.updated)}</text>
      </box>
      <Show when={props.pinned || hover()} fallback={<text selectable={false}> </text>}>
        <box
          flexShrink={0}
          onMouseOver={() => setHover(true)}
          onMouseUp={(evt: { stopPropagation(): void }) => {
            evt.stopPropagation()
            props.onTogglePin()
          }}
        >
          <text fg={props.pinned ? theme.primary : theme.textMuted}>{props.pinned ? "★" : "☆"}</text>
        </box>
      </Show>
      <Show when={hover()} fallback={<text selectable={false}> </text>}>
        <box
          flexShrink={0}
          onMouseOver={() => setHover(true)}
          onMouseUp={(evt: { stopPropagation(): void }) => {
            evt.stopPropagation()
            props.onMenu()
          }}
        >
          <text fg={theme.text}>⋯</text>
        </box>
      </Show>
    </box>
  )
}

// Per-chat actions behind the hover "⋯" menu, mirroring Claude.ai's chat
// item menu: star, rename, share, and delete.
function ChatActions(props: { sessionID: string; title: string; pinned: boolean; isCurrent: boolean }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const route = useRoute()
  const toast = useToast()
  const clipboard = useClipboard()
  const kv = useKV()

  async function share() {
    if (sync.data.config.share === "disabled") {
      toast.show({ message: "Sharing is disabled", variant: "error" })
      return
    }
    const copy = (url: string) =>
      clipboard
        .write?.(url)
        .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
        .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
    const existing = sync.data.session.find((session) => session.id === props.sessionID)?.share?.url
    if (existing) {
      await copy(existing)
      return
    }
    if (!kv.get("share_consent", false)) {
      const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
      if (ok !== true) return
      kv.set("share_consent", true)
    }
    await sdk.client.session
      .share({ sessionID: props.sessionID })
      .then((res) => copy(res.data!.share!.url))
      .catch((error) => {
        toast.show({
          message: error instanceof Error ? error.message : "Failed to share session",
          variant: "error",
        })
      })
  }

  async function remove() {
    try {
      const result = await sdk.client.session.delete({ sessionID: props.sessionID })
      if (result.error) {
        toast.show({
          variant: "error",
          title: "Failed to delete session",
          message: errorMessage(result.error),
        })
        return
      }
    } catch (err) {
      toast.show({
        variant: "error",
        title: "Failed to delete session",
        message: errorMessage(err),
      })
      return
    }
    toast.show({ message: "Session deleted", variant: "success" })
    if (props.isCurrent) route.navigate({ type: "home" })
  }

  return (
    <DialogSelect
      title={Locale.truncate(props.title, 40)}
      options={[
        {
          title: props.pinned ? "Unstar" : "Star",
          value: "star",
          description: props.pinned ? "remove from starred chats" : "pin to starred chats",
          onSelect: (dialog) => {
            local.session.togglePin(props.sessionID)
            dialog.clear()
          },
        },
        {
          title: "Rename",
          value: "rename",
          description: "rename this chat",
          onSelect: (dialog) => {
            dialog.replace(() => <DialogSessionRename session={props.sessionID} />)
          },
        },
        {
          title: "Share",
          value: "share",
          description: "copy a shareable link",
          onSelect: async (dialog) => {
            await share()
            dialog.clear()
          },
        },
        {
          title: "Delete",
          value: "delete",
          description: "delete this chat",
          onSelect: async (dialog) => {
            await remove()
            dialog.clear()
          },
        },
      ]}
    />
  )
}

type SessionGroup = {
  label: string
  sessions: Session[]
}

// A persisted collapsible section header: the outer Info toggle and each of
// Context / LSP / MCP / Cloud inside it.
function InfoSection(props: {
  id: string
  label: string
  collapsed: string[]
  onToggle: (label: string) => void
  children: JSX.Element
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const shut = () => props.collapsed.includes(props.id)
  return (
    <>
      <box
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        gap={1}
        paddingTop={1}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => props.onToggle(props.id)}
      >
        <text fg={hover() ? theme.text : theme.textMuted}>{shut() ? "▸" : "▾"}</text>
        <text
          fg={hover() ? theme.text : theme.textMuted}
          attributes={hover() ? TextAttributes.BOLD : undefined}
        >
          {props.label}
        </text>
      </box>
      <Show when={!shut()}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {props.children}
        </box>
      </Show>
    </>
  )
}

// Session info previously behind the top-bar info panel, now living in the
// left sidebar: token context for the active session plus LSP, MCP, and
// cloud provider status.
function InfoPanel(props: { sessionID: string | undefined; collapsed: string[]; onToggle: (label: string) => void }) {
  const sync = useSync()
  const { theme } = useTheme()

  const contextInfo = createMemo(() => {
    const id = props.sessionID
    if (!id) return undefined
    const messages = sync.data.message[id] ?? []
    const last = messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    const cost = sync.session.get(id)?.cost ?? 0
    if (!last) return { tokens: 0, percent: null as number | null, cost }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      cost,
    }
  })

  const lsp = createMemo(() => sync.data.lsp)
  const mcp = createMemo(() => Object.entries(sync.data.mcp).filter(([, item]) => item.status === "connected"))

  return (
    <>
      <InfoSection id="info:context" label="Context" collapsed={props.collapsed} onToggle={props.onToggle}>
        <Show
          when={contextInfo()}
          fallback={<text fg={theme.textMuted}>No active session</text>}
        >
          {(info) => (
            <>
              <text fg={theme.textMuted}>{info().tokens.toLocaleString()} tokens</text>
              <text fg={theme.textMuted}>{info().percent ?? 0}% used</text>
              <text fg={theme.textMuted}>{money.format(info().cost)} spent</text>
            </>
          )}
        </Show>
      </InfoSection>
      <InfoSection id="info:lsp" label="LSP" collapsed={props.collapsed} onToggle={props.onToggle}>
        <Show when={lsp().length > 0} fallback={<text fg={theme.textMuted}>No language servers active</text>}>
          <For each={lsp()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={item.status === "connected" ? theme.success : theme.error}>
                  •
                </text>
                <text fg={theme.textMuted}>
                  {item.id} {item.root}
                </text>
              </box>
            )}
          </For>
        </Show>
      </InfoSection>
      <InfoSection id="info:mcp" label="MCP" collapsed={props.collapsed} onToggle={props.onToggle}>
        <Show when={mcp().length > 0} fallback={<text fg={theme.textMuted}>None connected</text>}>
          <For each={mcp()}>
            {([name, item]) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={mcpDot(theme, item.status)}>
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  {name} <span style={{ fg: theme.textMuted }}>{mcpStatusLabel(item)}</span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </InfoSection>
    </>
  )
}

function mcpDot(theme: { success: RGBA; error: RGBA; warning: RGBA; textMuted: RGBA }, status: string): RGBA {
  if (status === "connected") return theme.success
  if (status === "failed") return theme.error
  if (status === "needs_auth") return theme.warning
  if (status === "needs_client_registration") return theme.error
  return theme.textMuted
}

function mcpStatusLabel(item: McpStatus): string {
  if (item.status === "connected") return "Connected"
  if (item.status === "failed") return item.error
  if (item.status === "disabled") return "Disabled"
  if (item.status === "needs_auth") return "Needs auth"
  return item.error
}

function groupSessions(sessions: Session[], pinnedIDs: string[], searching: boolean, now: number): SessionGroup[] {
  if (searching) return [{ label: "Results", sessions }]
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const pinned = pinnedIDs.flatMap((id) => {
    const session = byID.get(id)
    return session ? [session] : []
  })
  const pinnedSet = new Set(pinned.map((session) => session.id))
  const buckets = new Map<string, Session[]>()
  for (const session of sessions) {
    if (pinnedSet.has(session.id)) continue
    const label = bucketLabel(session.time.updated, now)
    const bucket = buckets.get(label)
    if (bucket) bucket.push(session)
    else buckets.set(label, [session])
  }
  const groups: SessionGroup[] = []
  if (pinned.length > 0) groups.push({ label: "Starred", sessions: pinned })
  for (const label of ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]) {
    const bucket = buckets.get(label)
    if (bucket && bucket.length > 0) groups.push({ label, sessions: bucket })
  }
  return groups
}

function bucketLabel(updated: number, now: number): string {
  const diff = startOfDay(now) - startOfDay(updated)
  if (diff <= 0) return "Today"
  if (diff <= DAY_MS) return "Yesterday"
  if (diff <= 7 * DAY_MS) return "Previous 7 days"
  if (diff <= 30 * DAY_MS) return "Previous 30 days"
  return "Older"
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
