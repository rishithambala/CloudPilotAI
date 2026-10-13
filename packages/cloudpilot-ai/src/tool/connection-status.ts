import { Effect, Schema } from "effect"
import { CLOUD_PROVIDER_IDS, type CloudProviderID } from "@cloudpilot-ai/core/cloud-provider/catalog"
import { runCli, CLI_STEP_TIMEOUT_MS } from "@cloudpilot-ai/core/cloud-provider/cli"
import { detectCloudProvider, type CloudConnectionStatus } from "@cloudpilot-ai/core/cloud-provider/detect"
import {
  GITHUB_MCP_NAME,
  describeGithub,
  githubStateFromMcp,
  parseGithubRemote,
  type GithubConnectionState,
  type McpStatusLike,
} from "@cloudpilot-ai/core/connection/github"
import * as Tool from "./tool"
import DESCRIPTION from "./connection-status.txt"
import { MCP } from "@/mcp"
import { InstanceState } from "@/effect/instance-state"

// Agent-facing view of exactly what the TUI Settings rows compute for
// humans: GitHub (via the GitHub MCP server status) and every cloud provider
// (via the shared core detection). The deploy agents call this instead of
// guessing with raw CLI commands.

export const TARGETS = ["all", "github", ...CLOUD_PROVIDER_IDS] as const
export type Target = (typeof TARGETS)[number]

export const Parameters = Schema.Struct({
  target: Schema.optional(Schema.Literals(TARGETS)).annotate({
    description: 'What to check: "all" (default), "github", or one cloud provider id.',
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Skip the one-minute cache and check again (use after the user reconnects).",
  }),
})

export type GithubStatus = {
  target: "github"
  name: "GitHub"
  state: GithubConnectionState
  /** owner/repo of the current project's GitHub remote, when there is one. */
  repository?: string
  summary: string
  nextStep?: string
}

export type ConnectionReport = {
  github?: GithubStatus
  cloud: CloudConnectionStatus[]
  /** One-line plain-language overview the orchestrator can relay directly. */
  overview: string
}

export function buildGithubStatus(status: McpStatusLike | undefined, repository: string | undefined): GithubStatus {
  const result = githubStateFromMcp(status)
  const text = describeGithub(result.state, result.error)
  return {
    target: "github",
    name: "GitHub",
    state: result.state,
    ...(repository ? { repository } : {}),
    summary:
      repository && result.state === "connected" ? `${text.summary} This project is ${repository}.` : text.summary,
    ...(text.nextStep ? { nextStep: text.nextStep } : {}),
  }
}

export function buildReport(input: { github?: GithubStatus; cloud: CloudConnectionStatus[] }): ConnectionReport {
  const ready = input.cloud.filter((item) => item.state === "connected").map((item) => item.name)
  const parts: string[] = []
  if (input.github) parts.push(input.github.state === "connected" ? "GitHub is connected" : "GitHub is not ready")
  if (input.cloud.length > 0)
    parts.push(
      ready.length > 0 ? `connected cloud providers: ${ready.join(", ")}` : "no cloud provider is connected yet",
    )
  return { ...input, overview: parts.length ? `${parts.join("; ")}.` : "Nothing was checked." }
}

export function cloudTargets(target: Target): CloudProviderID[] {
  if (target === "all") return [...CLOUD_PROVIDER_IDS]
  if (target === "github") return []
  return [target]
}

async function githubRemote(directory: string): Promise<string | undefined> {
  const result = await runCli("git", ["-C", directory, "remote", "get-url", "origin"], {
    timeoutMs: CLI_STEP_TIMEOUT_MS,
  })
  return result.ok ? parseGithubRemote(result.stdout) : undefined
}

type Metadata = { report: ConnectionReport }

export const ConnectionStatusTool = Tool.define<typeof Parameters, Metadata, MCP.Service>(
  "connection_status",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "connection_status",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const target: Target = params.target ?? "all"
          const maxAgeMs = params.refresh ? 0 : 60_000

          let github: GithubStatus | undefined
          if (target === "all" || target === "github") {
            const ins = yield* InstanceState.context
            const statuses = yield* mcp.status()
            const repository = yield* Effect.promise(() => githubRemote(ins.directory))
            github = buildGithubStatus(statuses[GITHUB_MCP_NAME] as McpStatusLike | undefined, repository)
          }
          const cloud = yield* Effect.promise(() =>
            Promise.all(cloudTargets(target).map((id) => detectCloudProvider(id, { maxAgeMs, signal: ctx.abort }))),
          )
          const report = buildReport({ github, cloud })
          return {
            title: report.overview,
            output: JSON.stringify(report, null, 2),
            metadata: { report },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
