import { createSignal } from "solid-js"
import type { CloudProviderID } from "@cloudpilot-ai/core/cloud-provider/catalog"
import type { CloudConnectionState } from "@cloudpilot-ai/core/cloud-provider/detect"
import { setCloudProviderState } from "../util/cloud-provider"

// Generic engine behind every cloud connect flow (AWS, Google Cloud, Azure,
// Oracle). It owns the row phase, the "Try again kills a stuck run and
// restarts it" pattern, and liveness after dispose. Provider flows supply
// only their CLI steps; see aws-connect.ts and cloud-connect.ts.

export type ProviderPhase<TFailed extends object = {}> =
  | { state: "checking" }
  | { state: "idle" }
  | { state: "working"; step: string; canInterrupt: boolean }
  /** `profile` is the provider identity: AWS/Oracle profile or signed-in account. */
  | { state: "reauth"; profile: string }
  | { state: "connected"; profile: string }
  | ({ state: "failed"; message: string } & TFailed)

function toConnectionState(phase: ProviderPhase<object>): CloudConnectionState | undefined {
  if (phase.state === "connected") return "connected"
  if (phase.state === "reauth") return "reauth"
  if (phase.state === "idle") return "not_connected"
  return undefined
}

export function createProviderConnect<TFailed extends object = {}>(providerId: CloudProviderID) {
  type Phase = ProviderPhase<TFailed>
  const [phase, setPhaseInternal] = createSignal<Phase>({ state: "checking" })
  let alive = true
  // In-flight run: aborting it resolves its CLI calls as aborted, and the
  // flow exits silently at the next checkpoint while the fresh retry takes
  // over the row.
  let currentAbort: AbortController | undefined
  let restartCurrent: (() => Promise<void>) | undefined

  const setPhase = (next: Phase) => {
    if (!alive) return
    setPhaseInternal(() => next)
    // Keep the shared connection store (sidebar, Settings, other rows) in
    // step with what this flow just learned.
    const state = toConnectionState(next)
    if (state) setCloudProviderState(providerId, state)
  }

  // Wraps a run so Try again can kill it mid-flight and restart it. The
  // aborted attempt exits silently at its next signal checkpoint while the
  // fresh attempt takes over the row.
  async function cancellable(restart: () => Promise<void>, body: (signal: AbortSignal) => Promise<void>) {
    const abort = new AbortController()
    currentAbort = abort
    restartCurrent = restart
    try {
      await body(abort.signal)
    } finally {
      if (currentAbort === abort) {
        currentAbort = undefined
        restartCurrent = undefined
      }
    }
  }

  // Try again while a run is still processing: kill the stuck attempt and
  // restart it. On success the button disappears into the tick.
  async function interruptAndRetry() {
    const restart = restartCurrent
    if (!restart) return
    currentAbort?.abort()
    await restart()
  }

  return {
    providerId,
    phase,
    setPhase,
    cancellable,
    interruptAndRetry,
    get alive() {
      return alive
    },
    // A run already in flight (e.g. a browser sign-in) is left to finish so
    // its result still persists; only row updates stop.
    dispose: () => {
      alive = false
    },
  }
}

export type ProviderConnectEngine<TFailed extends object = {}> = ReturnType<typeof createProviderConnect<TFailed>>

// Uniform surface every provider flow exposes to the Settings dialog and
// the connect popup, so the UI never special-cases a provider.
export type CloudConnect<TPending = unknown> = {
  providerId: CloudProviderID
  phase: () => ProviderPhase<object>
  detect: () => Promise<void>
  /** Ask first-run questions via popups, then reopen the host with the answers. */
  collectFirstRunInputs: (reopen: (pending?: TPending) => void) => Promise<void>
  /** Run the first-time connect with collected answers. */
  start: (pending: TPending) => Promise<void>
  /** Row click while reauth / failed / interruptible working. */
  activate: () => Promise<void>
  dispose: () => void
}
