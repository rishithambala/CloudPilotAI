import { createSignal } from "solid-js"
import type { McpStatus } from "@cloudpilot-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useToast } from "../ui/toast"
import { GITHUB_MCP_NAME, GITHUB_MCP_URL } from "../util/github-mcp"
import { githubStateFromMcp } from "@cloudpilot-ai/core/connection/github"

// Settings GitHub setup engine. GitHub's MCP server does not support MCP
// dynamic client registration, so auth is a personal access token sent as a
// Bearer header (oauth disabled) instead of the browser OAuth handshake.
// Clicking Connect asks for the token through a popup, then the connection
// starts in the same row — no chat session is ever opened.
export type GithubPhase =
  | { state: "checking" }
  | { state: "idle" }
  | { state: "working"; step: string }
  | { state: "needs_auth" }
  | { state: "connected" }
  | { state: "failed"; message: string }

function statusOf(status: Record<string, McpStatus> | undefined): McpStatus | undefined {
  if (!status) return undefined
  return status[GITHUB_MCP_NAME]
}

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return JSON.stringify(error)
}

export function createGithubConnect(opts: { onConnected?: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  const [phase, setPhaseInternal] = createSignal<GithubPhase>({ state: "checking" })
  let alive = true
  let running = false

  const setPhase = (next: GithubPhase) => {
    if (alive) setPhaseInternal(next)
  }

  async function refresh(): Promise<Record<string, McpStatus> | undefined> {
    const result = await sdk.client.mcp.status()
    if (result.data) sync.set("mcp", result.data)
    return result.data
  }

  // Same mapping the deploy agent's connection_status tool uses, so the
  // Settings row and the agent never disagree about GitHub.
  function apply(status: McpStatus | undefined): boolean {
    const result = githubStateFromMcp(status)
    if (result.state === "connected") {
      setPhase({ state: "connected" })
      return true
    }
    if (result.state === "needs_auth") setPhase({ state: "needs_auth" })
    else if (result.state === "failed") setPhase({ state: "failed", message: result.error ?? "Connection failed" })
    else setPhase({ state: "idle" })
    return false
  }

  async function detect() {
    setPhase({ state: "checking" })
    // Always re-fetch: the sync store can hold a stale snapshot while the
    // server dropped or recovered the connection underneath.
    const status = await refresh()
    apply(statusOf(status))
  }

  async function connectWithToken(token: string): Promise<boolean> {
    if (running) return false
    running = true
    const entry = {
      type: "remote" as const,
      url: GITHUB_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
      oauth: false as const,
    }
    setPhase({ state: "working", step: "Connecting GitHub…" })
    const added = await sdk.client.mcp.add({ name: GITHUB_MCP_NAME, config: entry })
    if (added.error) {
      running = false
      setPhase({ state: "failed", message: errorMessage(added.error) })
      return false
    }
    await sdk.client.mcp.connect({ name: GITHUB_MCP_NAME })
    const status = await refresh()
    running = false
    const connected = apply(statusOf(status))
    if (!connected) return false
    const saved = await persist(entry)
    // Saving the global config disposes server instances, so drop the stale
    // instance and reload all state — otherwise MCP and Integrations keep
    // showing the pre-save snapshot.
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    await detect()
    if (saved) toast.show({ message: "GitHub connected.", variant: "success" })
    else toast.show({ message: "GitHub connected for this session only — could not save.", variant: "warning" })
    opts.onConnected?.()
    return true
  }

  // Saved to the global config so the connection survives app restarts.
  // Runtime state alone is memory-only and would be lost on close.
  async function persist(entry: {
    type: "remote"
    url: string
    headers: { Authorization: string }
    oauth: false
  }): Promise<boolean> {
    const result = await sdk.client.global.config.update({
      config: { mcp: { [GITHUB_MCP_NAME]: entry } },
    })
    return !result.error
  }

  // Token prompt goes through a popup. The host passes a reopen that
  // restores it when the user cancels or the token is rejected.
  async function collectTokenInput(reopen: () => void) {
    const token = await DialogPrompt.show(dialog, "GitHub personal access token", {
      placeholder: "ghp_… / github_pat_…",
      description: () => (
        <box gap={1}>
          <text>Get one at github.com/settings/personal-access-tokens with repo access.</text>
          <Link href="https://github.com/settings/personal-access-tokens/new" />
        </box>
      ),
    })
    if (!token || token.trim().length === 0) {
      reopen()
      return
    }
    const connected = await connectWithToken(token.trim())
    if (!connected) reopen()
  }

  return {
    phase,
    detect,
    collectTokenInput,
    connectWithToken,
    dispose: () => {
      alive = false
    },
  }
}
