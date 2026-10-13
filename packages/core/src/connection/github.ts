// GitHub integration facts shared by the TUI Settings row and the
// agent-facing `connection_status` tool, so both read GitHub state the same
// way. GitHub is connected through its remote MCP server with a personal
// access token (see the TUI's github-connect flow).

export const GITHUB_MCP_NAME = "github"
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"

export type GithubConnectionState = "connected" | "needs_auth" | "not_connected" | "failed"

/** Structural subset of the MCP status union, so core stays free of server types. */
export type McpStatusLike =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error?: string }
  | { status: string; error?: string }

export function githubStateFromMcp(status: McpStatusLike | undefined): {
  state: GithubConnectionState
  error?: string
} {
  if (!status) return { state: "not_connected" }
  if (status.status === "connected") return { state: "connected" }
  if (status.status === "needs_auth" || status.status === "needs_client_registration") return { state: "needs_auth" }
  if (status.status === "failed")
    return { state: "failed", error: "error" in status && typeof status.error === "string" ? status.error : undefined }
  return { state: "not_connected" }
}

export function describeGithub(state: GithubConnectionState, error?: string): { summary: string; nextStep?: string } {
  if (state === "connected")
    return { summary: "GitHub is connected, so CloudPilot can read and work with your repositories." }
  if (state === "needs_auth")
    return {
      summary: "GitHub was added but its access token is missing or no longer accepted.",
      nextStep: "Open Settings → Integrations → GitHub and paste a new personal access token.",
    }
  if (state === "failed")
    return {
      summary: `GitHub is set up but the connection failed${error ? `: ${error}` : "."}`,
      nextStep: "Open Settings → Integrations → GitHub and reconnect it.",
    }
  return {
    summary: "GitHub is not connected yet.",
    nextStep: "Open Settings → Integrations → GitHub and paste a personal access token to connect it.",
  }
}

// Accepts https, ssh and scp-style remotes: returns "owner/repo".
export function parseGithubRemote(url: string): string | undefined {
  const trimmed = url.trim()
  const match =
    trimmed.match(
      /^(?:https?:\/\/|ssh:\/\/|git:\/\/)(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    ) ?? trimmed.match(/^[^@\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (!match) return undefined
  return `${match[1]}/${match[2]}`
}
