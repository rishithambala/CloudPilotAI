import { readAwsCredentials, detectAwsState, runAws } from "./aws"
import { azureAccountShow, detectAzureState, readAzureProfile } from "./azure"
import { getCloudConnection, recordCloudConnection, type CloudConnectionRecord } from "./cache"
import { CLOUD_PROVIDERS, getCloudProvider, type CloudProviderID } from "./catalog"
import { CLI_STEP_TIMEOUT_MS } from "./cli"
import { which } from "../util/which"
import { detectGcpState, gcpActiveAccount, gcpProject, gcpTokenValid } from "./gcp"
import { detectOracleState, ociVerify, readOciConfig } from "./oracle"

// Provider-agnostic connection detection: the one function both the TUI
// (Settings rows, sidebar, connect popup) and the agent-facing
// `connection_status` tool call, so humans and agents always see the same
// answer. Cheapest checks first: CLI present → persisted setup record →
// local CLI config → one live read-only call.

export type CloudConnectionState =
  /** Signed in and a live read-only call succeeded. */
  | "connected"
  /** Set up before, but the sign-in expired or was revoked. */
  | "reauth"
  /** Never set up on this machine. */
  | "not_connected"
  /** The provider's command-line tool is not installed. */
  | "cli_missing"
  /** Detection itself failed for an unexpected reason. */
  | "error"

export type CloudConnectionStatus = {
  provider: CloudProviderID
  name: string
  state: CloudConnectionState
  /** Profile or signed-in account, when known. */
  account?: string
  region?: string
  project?: string
  /** One plain-language sentence a non-technical user can understand. */
  summary: string
  /** What the user (not the agent) needs to do next, if anything. */
  nextStep?: string
  checkedAt: number
}

export type DetectOptions = {
  /** Re-use a result younger than this instead of re-running CLI checks. */
  maxAgeMs?: number
  /** Persist a successful detection so the next check takes the fast path. */
  persist?: boolean
  signal?: AbortSignal
}

const memo = new Map<CloudProviderID, { value: CloudConnectionStatus; at: number }>()
const inflight = new Map<CloudProviderID, Promise<CloudConnectionStatus>>()

export function cliAvailable(id: CloudProviderID): boolean {
  const provider = getCloudProvider(id)
  return provider ? which(provider.cli) !== null : false
}

type Presence =
  | { kind: "connected"; account: string; region?: string; project?: string }
  | { kind: "reauth"; account: string; region?: string }
  | { kind: "first-time" }

async function presenceOf(id: CloudProviderID, cached: CloudConnectionRecord | undefined): Promise<Presence> {
  const done = cached?.done === true
  if (id === "aws") {
    const presence = await detectAwsState({
      kvDone: done,
      kvProfile: cached?.account,
      readCredentials: () => readAwsCredentials(),
      sts: (profile) =>
        runAws(["sts", "get-caller-identity", "--profile", profile], CLI_STEP_TIMEOUT_MS).then((r) => r.ok),
    })
    if (presence.kind === "first-time") return presence
    return { kind: presence.kind, account: presence.profile, region: cached?.region }
  }
  if (id === "google-cloud") {
    const presence = await detectGcpState({
      cachedAccount: done ? cached?.account : undefined,
      activeAccount: gcpActiveAccount,
      tokenValid: (account) => gcpTokenValid(account),
    })
    if (presence.kind === "connected")
      return { kind: "connected", account: presence.account, project: cached?.project ?? (await gcpProject()) }
    return presence
  }
  if (id === "azure") {
    const presence = await detectAzureState({
      cachedAccount: done ? cached?.account : undefined,
      readProfile: () => readAzureProfile(),
      accountShow: () => azureAccountShow(),
    })
    if (presence.kind === "connected")
      return { kind: "connected", account: presence.account, project: presence.subscription }
    return presence
  }
  const presence = await detectOracleState({
    cachedProfile: cached?.account,
    readConfig: () => readOciConfig(),
    verify: (profile) => ociVerify(profile),
  })
  if (presence.kind === "first-time") return presence
  return { kind: presence.kind, account: presence.profile, region: presence.region ?? cached?.region }
}

export function describe(
  id: CloudProviderID,
  state: CloudConnectionState,
  extra: { account?: string; message?: string } = {},
): { summary: string; nextStep?: string } {
  const provider = getCloudProvider(id)!
  const who = extra.account ? ` as ${extra.account}` : ""
  if (state === "connected") return { summary: `${provider.name} is connected${who} and ready to use.` }
  if (state === "reauth")
    return {
      summary: `${provider.name} was set up before${who}, but the sign-in has expired.`,
      nextStep: `Open Settings → Cloud providers → Add and click ${provider.name} to sign in again in your browser.`,
    }
  if (state === "not_connected")
    return {
      summary: `${provider.name} is not connected on this computer yet.`,
      nextStep: `Open Settings → Cloud providers → Add and click ${provider.name} to connect it (it opens a browser sign-in).`,
    }
  if (state === "cli_missing")
    return {
      summary: `The ${provider.name} command-line tool ("${provider.cli}") is not installed, so CloudPilot cannot talk to ${provider.name} yet.`,
      nextStep: `Install it from ${provider.installUrl}, then connect ${provider.name} from Settings.`,
    }
  return {
    summary: `CloudPilot could not check ${provider.name}${extra.message ? `: ${extra.message}` : "."}`,
    nextStep: `Try again in a moment, or reconnect ${provider.name} from Settings.`,
  }
}

function build(
  id: CloudProviderID,
  state: CloudConnectionState,
  extra: { account?: string; region?: string; project?: string; message?: string } = {},
): CloudConnectionStatus {
  const provider = getCloudProvider(id)!
  const text = describe(id, state, extra)
  return {
    provider: id,
    name: provider.name,
    state,
    ...(extra.account ? { account: extra.account } : {}),
    ...(extra.region ? { region: extra.region } : {}),
    ...(extra.project ? { project: extra.project } : {}),
    summary: text.summary,
    ...(text.nextStep ? { nextStep: text.nextStep } : {}),
    checkedAt: Date.now(),
  }
}

async function run(id: CloudProviderID, options: DetectOptions): Promise<CloudConnectionStatus> {
  // PATH lookup only — no process spawn — so a missing CLI costs nothing.
  if (!cliAvailable(id)) return build(id, "cli_missing")
  if (options.signal?.aborted) return build(id, "error", { message: "the check was cancelled" })
  const cached = await getCloudConnection(id).catch(() => undefined)
  const presence = await presenceOf(id, cached)
  if (presence.kind === "first-time") return build(id, "not_connected")
  if (presence.kind === "reauth") return build(id, "reauth", { account: presence.account, region: presence.region })
  if (options.persist !== false) {
    await recordCloudConnection(id, {
      done: true,
      account: presence.account,
      region: presence.region ?? cached?.region,
      project: presence.project ?? cached?.project,
    })
  }
  return build(id, "connected", {
    account: presence.account,
    region: presence.region ?? cached?.region,
    project: presence.project ?? cached?.project,
  })
}

export async function detectCloudProvider(
  id: CloudProviderID,
  options: DetectOptions = {},
): Promise<CloudConnectionStatus> {
  const maxAge = options.maxAgeMs ?? 0
  const hit = memo.get(id)
  if (hit && maxAge > 0 && Date.now() - hit.at < maxAge) return hit.value
  const pending = inflight.get(id)
  if (pending) return pending
  const promise = run(id, options)
    .catch((error: unknown) => build(id, "error", { message: error instanceof Error ? error.message : String(error) }))
    .then((value) => {
      memo.set(id, { value, at: Date.now() })
      return value
    })
    .finally(() => inflight.delete(id))
  inflight.set(id, promise)
  return promise
}

export function detectAllCloudProviders(options: DetectOptions = {}): Promise<CloudConnectionStatus[]> {
  return Promise.all(CLOUD_PROVIDERS.map((item) => detectCloudProvider(item.id, options)))
}

// Connect flows call this after a successful sign-in (or sign-out) so the
// next status check sees the change instead of a stale memoised result.
export function invalidateCloudProvider(id?: CloudProviderID) {
  if (id) memo.delete(id)
  else memo.clear()
}
