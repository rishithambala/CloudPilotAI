import { getCloudProvider, type CloudProviderID } from "@cloudpilot-ai/core/cloud-provider/catalog"
import { getCloudConnection, recordCloudConnection } from "@cloudpilot-ai/core/cloud-provider/cache"
import {
  CLI_LOGIN_TIMEOUT_MS,
  CLI_STEP_TIMEOUT_MS,
  failureDetail,
  isCliMissing,
  type CliRunResult,
} from "@cloudpilot-ai/core/cloud-provider/cli"
import { cliAvailable, detectCloudProvider, invalidateCloudProvider } from "@cloudpilot-ai/core/cloud-provider/detect"
import { AZURE_LOGIN_ARGS, runAz } from "@cloudpilot-ai/core/cloud-provider/azure"
import { GCP_LOGIN_ARGS, runGcloud } from "@cloudpilot-ai/core/cloud-provider/gcp"
import { ociLoginArgs, ociRefreshArgs, runOci } from "@cloudpilot-ai/core/cloud-provider/oracle"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { createAwsConnect, loginFailure, type AwsPending } from "./aws-connect"
import { createProviderConnect, type CloudConnect } from "./provider-connect"

// Connect flows for the CLI-driven providers other than AWS. Each provider
// is a small adapter (questions to ask, sign-in command, optional
// post-sign-in step); the shared engine in provider-connect.ts runs the
// state machine, and detection reuses the same core decision tree the deploy
// agent's `connection_status` tool calls.

type Inputs = Record<string, string>

type CliAdapter = {
  id: Exclude<CloudProviderID, "aws">
  /** First-run questions. Resolve undefined when the user cancels. */
  collect: (dialog: DialogContext, previous: Inputs | undefined) => Promise<Inputs | undefined>
  /** Inputs to re-use when the row says "sign in expired". */
  reauthInputs: (profile: string) => Promise<Inputs>
  /** Browser sign-in (or token refresh, when `reauth`). */
  login: (inputs: Inputs, signal: AbortSignal, reauth: boolean) => Promise<CliRunResult>
  /** Written before verification so detection picks the right profile. */
  record: (inputs: Inputs) => { account?: string; region?: string; project?: string }
  /** Best-effort follow-up after a verified sign-in; returns a warning when it fails. */
  after?: (inputs: Inputs, signal: AbortSignal) => Promise<string | undefined>
}

const google: CliAdapter = {
  id: "google-cloud",
  async collect(dialog, previous) {
    const project = await DialogPrompt.show(dialog, "Google Cloud project ID (optional)", {
      placeholder: "my-project-123 — leave empty to choose later",
      value: previous?.project,
    })
    if (project === null) return undefined
    return { project: project.trim() }
  },
  async reauthInputs() {
    const cached = await getCloudConnection("google-cloud")
    return { project: cached?.project ?? "" }
  },
  login: (_inputs, signal) => runGcloud(GCP_LOGIN_ARGS, CLI_LOGIN_TIMEOUT_MS, signal),
  record: (inputs) => (inputs.project ? { project: inputs.project } : {}),
  async after(inputs, signal) {
    if (!inputs.project) return undefined
    const result = await runGcloud(["config", "set", "project", inputs.project], CLI_STEP_TIMEOUT_MS, signal)
    return result.ok
      ? undefined
      : `Signed in, but the project could not be set: ${failureDetail(result) ?? "unknown error"}`
  },
}

const azure: CliAdapter = {
  id: "azure",
  // az picks the default subscription itself; nothing to ask up front.
  collect: async () => ({}),
  reauthInputs: async () => ({}),
  login: (_inputs, signal) => runAz(AZURE_LOGIN_ARGS, CLI_LOGIN_TIMEOUT_MS, signal),
  record: () => ({}),
}

const oracle: CliAdapter = {
  id: "oracle",
  async collect(dialog, previous) {
    const profile = (
      await DialogPrompt.show(dialog, "Oracle Cloud profile", {
        placeholder: "DEFAULT",
        value: previous?.profile ?? "DEFAULT",
      })
    )?.trim()
    if (!profile) return undefined
    const region = (
      await DialogPrompt.show(dialog, "Oracle Cloud home region", {
        placeholder: "us-ashburn-1",
        value: previous?.region,
      })
    )?.trim()
    if (!region) return undefined
    return { profile, region }
  },
  async reauthInputs(profile) {
    const cached = await getCloudConnection("oracle")
    return { profile, region: cached?.region ?? "us-ashburn-1" }
  },
  async login(inputs, signal, reauth) {
    // An expired browser session can often be refreshed without a new
    // sign-in; fall back to the full browser flow when it cannot.
    if (reauth) {
      const refreshed = await runOci(ociRefreshArgs(inputs.profile), CLI_STEP_TIMEOUT_MS, signal)
      if (refreshed.ok || signal.aborted) return refreshed
    }
    return runOci(ociLoginArgs(inputs.profile, inputs.region), CLI_LOGIN_TIMEOUT_MS, signal)
  },
  record: (inputs) => ({ account: inputs.profile, region: inputs.region }),
}

const ADAPTERS: Record<CliAdapter["id"], CliAdapter> = {
  "google-cloud": google,
  azure,
  oracle,
}

export function createCliCloudConnect(
  adapter: CliAdapter,
  opts: { onConnected?: (account: string) => void },
): CloudConnect<Inputs> {
  const dialog = useDialog()
  const toast = useToast()
  const provider = getCloudProvider(adapter.id)!
  const engine = createProviderConnect<{ inputs: Inputs | undefined }>(adapter.id)
  const { phase, setPhase, cancellable, interruptAndRetry } = engine

  const missing = () =>
    setPhase({
      state: "failed",
      inputs: undefined,
      message: `${provider.name} CLI (${provider.cli}) not found. Install it from ${provider.installUrl}, then try again.`,
    })

  async function detect() {
    setPhase({ state: "checking" })
    invalidateCloudProvider(adapter.id)
    const status = await detectCloudProvider(adapter.id)
    if (status.state === "connected") return setPhase({ state: "connected", profile: status.account ?? provider.name })
    if (status.state === "reauth") return setPhase({ state: "reauth", profile: status.account ?? provider.name })
    if (status.state === "not_connected") return setPhase({ state: "idle" })
    if (status.state === "cli_missing") return missing()
    setPhase({ state: "failed", inputs: undefined, message: status.summary })
  }

  async function flow(inputs: Inputs, reauth: boolean, signal: AbortSignal) {
    if (!cliAvailable(adapter.id)) return missing()
    setPhase({ state: "working", step: "Waiting for browser sign-in…", canInterrupt: true })
    const login = await adapter.login(inputs, signal, reauth)
    if (signal.aborted) return
    if (!login.ok) {
      const failure = isCliMissing(login)
        ? { message: `${provider.name} CLI (${provider.cli}) not found. Install it, then try again.`, cancelled: false }
        : loginFailure(login)
      setPhase({ state: "failed", inputs, message: failure.message })
      toast.show({
        message: failure.cancelled
          ? "Browser sign-in was cancelled."
          : `${provider.name} sign-in failed. You can try again.`,
        variant: failure.cancelled ? "info" : "error",
      })
      return
    }
    setPhase({ state: "working", step: "Verifying access…", canInterrupt: false })
    await recordCloudConnection(adapter.id, { done: false, ...adapter.record(inputs) })
    invalidateCloudProvider(adapter.id)
    const status = await detectCloudProvider(adapter.id)
    if (signal.aborted) return
    if (status.state !== "connected") {
      setPhase({ state: "failed", inputs, message: `Not connected: ${status.summary}` })
      return
    }
    if (adapter.after) {
      setPhase({ state: "working", step: "Finishing setup…", canInterrupt: false })
      const warning = await adapter.after(inputs, signal)
      if (signal.aborted) return
      if (warning) toast.show({ message: warning, variant: "info" })
    }
    const account = status.account ?? provider.name
    await recordCloudConnection(adapter.id, { done: true, account, ...adapter.record(inputs) })
    setPhase({ state: "connected", profile: account })
    toast.show({ message: `${provider.name} connected (${account}).`, variant: "success" })
    opts.onConnected?.(account)
  }

  function run(inputs: Inputs, reauth: boolean): Promise<void> {
    return cancellable(
      () => run(inputs, reauth),
      (signal) => flow(inputs, reauth, signal),
    )
  }

  async function collectFirstRunInputs(reopen: (pending?: Inputs) => void) {
    const inputs = await adapter.collect(dialog, undefined)
    reopen(inputs)
  }

  async function activate() {
    const current = phase()
    if (current.state === "working" && current.canInterrupt) return interruptAndRetry()
    if (current.state === "reauth") return run(await adapter.reauthInputs(current.profile), true)
    if (current.state === "failed") {
      if (current.inputs) return run(current.inputs, false)
      return detect()
    }
  }

  return {
    providerId: adapter.id,
    phase,
    detect,
    collectFirstRunInputs,
    start: (inputs) => run(inputs, false),
    activate,
    dispose: engine.dispose,
  }
}

export type CloudPending =
  | { providerId: "aws"; data: AwsPending }
  | { providerId: Exclude<CloudProviderID, "aws">; data: Inputs }

// Provider-agnostic entry point used by Settings and the connect popup.
export function createCloudConnect(
  id: CloudProviderID,
  opts: { onConnected?: (account: string) => void } = {},
): CloudConnect<any> {
  if (id === "aws") return createAwsConnect(opts)
  return createCliCloudConnect(ADAPTERS[id], opts)
}
