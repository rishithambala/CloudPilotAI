import { recordCloudConnection } from "@cloudpilot-ai/core/cloud-provider/cache"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useKV } from "../context/kv"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import {
  AWS_LOGIN_TIMEOUT_MS,
  AWS_PROFILE_KEY,
  AWS_REGION_KEY,
  AWS_SETUP_DONE_KEY,
  AWS_STEP_TIMEOUT_MS,
  clearLoginSession,
  detectAwsState,
  isCliMissing,
  readAwsCredentials,
  runAws,
  stsValid,
} from "../util/aws-setup"
import { createProviderConnect, type CloudConnect, type ProviderPhase } from "./provider-connect"

// Background AWS setup engine shared by the Settings cloud list and the
// connect popup. No chat session is ever opened: steps run as detached child
// processes while the row shows Connect, a working spinner, re-authenticate,
// or a connected tick. Hosts collect first-run inputs inline and report back
// through onConnected.

type AwsFailed = {
  profile: string | undefined
  region: string | undefined
  resume: "login" | "toolkit"
}

export type AwsPhase = ProviderPhase<AwsFailed>

export type AwsPending = { profile: string; region: string; isNewExperience: boolean }

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? "unknown error"
}

// Browser-flow failures surface on either stream (or neither), so combine
// both and classify cancel/timeout separately from real errors.
export function loginFailure(login: { stdout: string; stderr: string; timedOut: boolean; aborted?: boolean }): {
  message: string
  cancelled: boolean
} {
  if (login.aborted) return { message: "Sign-in was interrupted.", cancelled: true }
  const output = [login.stderr, login.stdout].map(lastLine).find((line) => line !== "unknown error") ?? "unknown error"
  if (login.timedOut || /expir|timed out/i.test(output)) {
    return { message: "Sign-in timed out before completing in the browser. Try again.", cancelled: false }
  }
  if (/cancell?ed|cancel\b|abort|interrupted|browser (was )?closed/i.test(output)) {
    return { message: "Browser sign-in was cancelled. Try again when ready.", cancelled: true }
  }
  return { message: `Sign-in failed: ${output}`, cancelled: false }
}

export function createAwsConnect(opts: {
  onConnected?: (profile: string) => void
}): CloudConnect<AwsPending> & {
  firstRun: (profile: string, region: string, isNewExperience: boolean) => Promise<void>
} {
  const dialog = useDialog()
  const toast = useToast()
  const kv = useKV()

  const engine = createProviderConnect<AwsFailed>("aws")
  const { phase, setPhase, cancellable, interruptAndRetry } = engine
  // Rules context for this run. Retry stays in the same run, so a plain
  // mutable is enough and phases stay serializable.
  let rulesContext: { isNewExperience: boolean; directory: string } | undefined

  const notify = (message: string, variant: "success" | "error" | "info") => {
    if (variant === "success") return toast.show({ message, variant })
    if (variant === "error") return toast.show({ message, variant: "error" })
    return toast.show({ message, variant: "info" })
  }

  const kvProfile = () => kv.get(AWS_PROFILE_KEY) as string | undefined
  const kvRegion = () => kv.get(AWS_REGION_KEY) as string | undefined

  async function storedRegion(profile: string): Promise<string> {
    const kept = kvRegion()
    if (kept) return kept
    const configured = await runAws(["configure", "get", "region", "--profile", profile], AWS_STEP_TIMEOUT_MS)
    const region = configured.stdout.trim()
    if (configured.ok && region) return region
    return "us-east-1"
  }

  async function detect() {
    setPhase({ state: "checking" })
    const cli = await runAws(["--version"], AWS_STEP_TIMEOUT_MS)
    if (!cli.ok) {
      setPhase({
        state: "failed",
        profile: undefined,
        region: undefined,
        resume: "login",
        message: isCliMissing(cli)
          ? "AWS CLI not found. Install AWS CLI v2, then try again."
          : `AWS CLI check failed: ${lastLine(cli.stderr)}`,
      })
      return
    }
    const presence = await detectAwsState({
      kvDone: kv.get(AWS_SETUP_DONE_KEY, false) === true,
      kvProfile: kvProfile(),
      readCredentials: () => readAwsCredentials(),
      sts: stsValid,
    })
    if (presence.kind === "connected") {
      kv.set(AWS_SETUP_DONE_KEY, true)
      kv.set(AWS_PROFILE_KEY, presence.profile)
      finishConnected(presence.profile, false)
      return
    }
    if (presence.kind === "reauth") {
      setPhase({ state: "reauth", profile: presence.profile })
      return
    }
    setPhase({ state: "idle" })
  }

  function finishConnected(profile: string, withToolkit: boolean) {
    // Shared with the deploy agent's connection_status tool and other
    // processes, so they recognise a returning user without the slow path.
    void recordCloudConnection("aws", { done: true, account: profile, region: kvRegion() })
    setPhase({ state: "connected", profile })
    if (withToolkit) notify(`AWS connected and Agent Toolkit ready (${profile}).`, "success")
    opts.onConnected?.(profile)
  }

  // Step 7 of the runbook: fetch the experience rules and append them to
  // the project AGENTS.md under stable markers (idempotent). Best effort:
  // a rules failure warns but never blocks the connected tick.
  async function appendProjectRules(isNewExperience: boolean, directory: string): Promise<boolean> {
    const url = isNewExperience
      ? "https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/rules/aws-starter-rules.md"
      : "https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/rules/aws-agent-rules.md"
    const response = await fetch(url).catch(() => undefined)
    if (!response || !response.ok) return false
    const rules = (await response.text().catch(() => "")).trim()
    if (!rules) return false
    const begin = "<!-- BEGIN AWS Agent Toolkit rules -->"
    const end = "<!-- END AWS Agent Toolkit rules -->"
    const block = `${begin}\n${rules}\n${end}`
    const file = Bun.file(pathJoin(directory, "AGENTS.md"))
    const existing = (await file.exists()) ? await file.text().catch(() => "") : ""
    if (existing.includes(begin) && existing.includes(end)) {
      const start = existing.indexOf(begin)
      const finish = existing.indexOf(end) + end.length
      await Bun.write(file, existing.slice(0, start) + block + existing.slice(finish)).catch(() => false)
      return true
    }
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
    const next = existing.length > 0 ? `${existing}${separator}\n${block}\n` : `${block}\n`
    return Bun.write(file, next)
      .then(() => true)
      .catch(() => false)
  }

  async function verifyAndFinish(
    profile: string,
    region: string,
    runToolkit: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const cancelled = () => signal?.aborted === true
    setPhase({ state: "working", step: "Verifying access…", canInterrupt: false })
    const identity = await runAws(["sts", "get-caller-identity", "--profile", profile], AWS_STEP_TIMEOUT_MS, signal)
    if (cancelled()) return false
    if (!identity.ok) {
      const detail = [identity.stderr, identity.stdout].map(lastLine).find((line) => line !== "unknown error")
      setPhase({
        state: "failed",
        profile,
        region,
        resume: "login",
        message: detail ? `Not connected: ${detail}` : "Verification failed. Try again.",
      })
      return false
    }
    // Best effort from here: browser auth already succeeded, so toolkit or
    // rules hiccups warn instead of failing back to Try again.
    let toolkitReady = false
    if (runToolkit) {
      setPhase({ state: "working", step: "Setting up Agent Toolkit…", canInterrupt: false })
      const toolkit = await runAws(
        ["configure", "agent-toolkit", "--yes", "--region", "us-east-1", "--profile", profile],
        AWS_LOGIN_TIMEOUT_MS,
        signal,
      )
      if (cancelled()) return false
      if (!toolkit.ok) {
        notify(
          toolkit.timedOut
            ? "Agent Toolkit setup timed out, continuing without it."
            : "Agent Toolkit setup failed, continuing without it.",
          "info",
        )
      } else {
        setPhase({ state: "working", step: "Verifying Agent Toolkit…", canInterrupt: false })
        const skills = await runAws(
          ["agent-toolkit", "list-available-skills", "--region", "us-east-1", "--profile", profile],
          AWS_STEP_TIMEOUT_MS,
          signal,
        )
        if (cancelled()) return false
        if (!skills.ok) notify("Agent Toolkit verification failed, continuing without it.", "info")
        else toolkitReady = true
      }
      const context = rulesContext
      if (context) {
        setPhase({ state: "working", step: "Adding AWS rules…", canInterrupt: false })
        const rulesOk = await appendProjectRules(context.isNewExperience, context.directory)
        if (cancelled()) return false
        if (!rulesOk) notify("AWS rules could not be added to AGENTS.md.", "info")
      }
    }
    kv.set(AWS_SETUP_DONE_KEY, true)
    kv.set(AWS_PROFILE_KEY, profile)
    kv.set(AWS_REGION_KEY, region)
    finishConnected(profile, toolkitReady)
    return true
  }

  async function loginFlow(profile: string, region: string, runToolkit: boolean, signal: AbortSignal) {
    // A stale login_session makes the CLI stop for y/n overwrite
    // confirmation, which has no stdin here and dies with EOF.
    await clearLoginSession(profile)
    if (signal.aborted) return
    setPhase({ state: "working", step: "Waiting for browser sign-in…", canInterrupt: true })
    const login = await runAws(["login", "--region", region, "--profile", profile], AWS_LOGIN_TIMEOUT_MS, signal)
    if (signal.aborted) return
    if (!login.ok) {
      const failure = loginFailure(login)
      setPhase({
        state: "failed",
        profile,
        region,
        resume: "login",
        message: failure.message,
      })
      notify(
        failure.cancelled ? "Browser sign-in was cancelled." : "AWS sign-in failed. You can try again.",
        failure.cancelled ? "info" : "error",
      )
      return
    }
    await verifyAndFinish(profile, region, runToolkit, signal)
  }

  function startLogin(profile: string, region: string, runToolkit: boolean): Promise<void> {
    return cancellable(
      () => startLogin(profile, region, runToolkit),
      (signal) => loginFlow(profile, region, runToolkit, signal),
    )
  }

  // First run: region is configured, then the browser login, then the
  // Agent Toolkit steps plus project rules. Failures land on the retry
  // state with inputs kept.
  async function firstRun(profile: string, region: string, isNewExperience: boolean) {
    rulesContext = { isNewExperience, directory: process.cwd() }
    await cancellable(
      () => firstRun(profile, region, isNewExperience),
      async (signal) => {
        setPhase({ state: "working", step: "Checking AWS CLI…", canInterrupt: true })
        const cli = await runAws(["--version"], AWS_STEP_TIMEOUT_MS, signal)
        if (signal.aborted) return
        if (!cli.ok) {
          setPhase({
            state: "failed",
            profile,
            region,
            resume: "login",
            message: isCliMissing(cli)
              ? "AWS CLI not found. Install AWS CLI v2, then try again."
              : `AWS CLI check failed: ${lastLine(cli.stderr)}`,
          })
          return
        }
        setPhase({ state: "working", step: "Setting region…", canInterrupt: true })
        const setRegion = await runAws(
          ["configure", "set", "region", region, "--profile", profile],
          AWS_STEP_TIMEOUT_MS,
          signal,
        )
        if (signal.aborted) return
        if (!setRegion.ok) {
          setPhase({
            state: "failed",
            profile,
            region,
            resume: "login",
            message: `Could not set region: ${lastLine(setRegion.stderr)}`,
          })
          return
        }
        await loginFlow(profile, region, true, signal)
      },
    )
  }

  // First-run questions go through popups. They replace the host dialog,
  // so the host passes a reopen that restores it with a pending run (or
  // plain, when the user cancels).
  async function collectFirstRunInputs(reopen: (pending?: AwsPending) => void) {
    const profile = (
      await DialogPrompt.show(dialog, "AWS profile", {
        placeholder: "Profile name",
      })
    )?.trim()
    if (!profile) {
      reopen(undefined)
      return
    }
    const experience = await DialogConfirm.show(
      dialog,
      "AWS experience",
      "Did you sign up recently for AWS using a social provider like Google or GitHub, and did you create a project?",
    )
    if (experience === undefined) {
      reopen(undefined)
      return
    }
    const region = (
      await DialogPrompt.show(dialog, "AWS region", {
        placeholder: "us-east-1",
      })
    )?.trim()
    if (!region) {
      reopen(undefined)
      return
    }
    reopen({ profile, region, isNewExperience: experience })
  }

  async function retryFailed(failed: Extract<AwsPhase, { state: "failed" }>) {
    if (!failed.profile || !failed.region) {
      await detect()
      return
    }
    if (failed.resume === "toolkit") {
      const profile = failed.profile
      const region = failed.region
      await cancellable(
        () => retryFailed(failed),
        async (signal) => {
          setPhase({ state: "working", step: "Setting up Agent Toolkit…", canInterrupt: true })
          await verifyAndFinish(profile, region, true, signal)
        },
      )
      return
    }
    await startLogin(failed.profile, failed.region, true)
  }

  async function activate() {
    const current = phase()
    if (current.state === "working" && current.canInterrupt) {
      await interruptAndRetry()
      return
    }
    if (current.state === "reauth") {
      await startLogin(current.profile, await storedRegion(current.profile), false)
      return
    }
    if (current.state === "failed") {
      await retryFailed(current)
      return
    }
  }

  return {
    providerId: "aws",
    phase,
    detect,
    firstRun,
    start: (pending) => firstRun(pending.profile, pending.region, pending.isNewExperience),
    collectFirstRunInputs,
    activate,
    dispose: engine.dispose,
  }
}

function pathJoin(directory: string, file: string): string {
  return directory.endsWith("/") || directory.endsWith("\\") ? `${directory}${file}` : `${directory}/${file}`
}
