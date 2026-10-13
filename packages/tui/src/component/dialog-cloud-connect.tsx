import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { CLOUD_PROVIDERS } from "../util/cloud-provider"
import { Spinner } from "./spinner"
import { type AwsPhase } from "./aws-connect"
import { createCloudConnect, type CloudPending } from "./cloud-connect"
import { type ProviderPhase } from "./provider-connect"
import { type GithubPhase } from "./github-connect"

// Popup behind Settings "+ New cloud provider": every available cloud
// provider with its own connect control. Clicking Connect asks that
// provider's first-run questions through popups, then the connection starts
// in the same row — no chat session is ever opened. On success the caller
// reopens Settings, where the provider now lists.
export function DialogCloudConnect(props: { pending?: CloudPending; onDone?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const connects = CLOUD_PROVIDERS.map((item) =>
    createCloudConnect(item.value, {
      onConnected: () => props.onDone?.(),
    }),
  )
  onCleanup(() => connects.forEach((connect) => connect.dispose()))
  onMount(() => {
    for (const connect of connects) {
      if (props.pending?.providerId === connect.providerId) void connect.start(props.pending.data)
      else void connect.detect()
    }
  })

  function reopen(providerId: CloudPending["providerId"], data?: CloudPending["data"]) {
    const pending = data === undefined ? undefined : ({ providerId, data } as CloudPending)
    dialog.replace(() => <DialogCloudConnect pending={pending} onDone={props.onDone} />)
  }

  return (
    <box gap={1} paddingBottom={1} flexGrow={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Connect cloud provider
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <box flexGrow={1} flexShrink={1} paddingLeft={4} paddingRight={4} flexDirection="column" gap={1}>
        <For each={connects}>
          {(connect, index) => (
            <CloudRow
              title={CLOUD_PROVIDERS[index()].title}
              phase={connect.phase()}
              onIdle={() => void connect.collectFirstRunInputs((data) => reopen(connect.providerId, data))}
              onActivate={() => void connect.activate()}
            />
          )}
        </For>
      </box>
    </box>
  )
}

export function SettingRow(props: { title: string; detail?: string; success?: boolean; onSelect?: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  return (
    <box
      flexDirection="row"
      gap={2}
      paddingLeft={2}
      onMouseOver={() => {
        if (props.onSelect) setHover(true)
      }}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onSelect?.()}
    >
      <text fg={hover() ? theme.text : theme.textMuted} attributes={hover() ? TextAttributes.BOLD : undefined}>
        {props.title}
      </text>
      <Show when={props.detail}>
        <text fg={props.success ? theme.success : theme.textMuted} wrapMode="none">
          {props.detail}
        </text>
      </Show>
    </box>
  )
}

export function CloudRow(props: {
  title: string
  phase: ProviderPhase<object>
  onIdle: () => void
  onActivate: () => void
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const phase = () => props.phase
  const clickable = () => {
    const current = phase()
    if (current.state === "working") return current.canInterrupt
    return current.state === "idle" || current.state === "reauth" || current.state === "failed"
  }

  const status = (): JSX.Element => {
    const current = phase()
    if (current.state === "checking") return <Spinner color={theme.textMuted}>Checking…</Spinner>
    if (current.state === "working")
      return (
        <box flexDirection="column">
          <Spinner color={theme.textMuted}>{current.step}</Spinner>
          <Show when={current.canInterrupt}>
            <text fg={theme.textMuted}>Try again</text>
          </Show>
        </box>
      )
    if (current.state === "connected")
      return (
        <text fg={theme.success} attributes={TextAttributes.BOLD}>
          ✓
        </text>
      )
    if (current.state === "reauth") return <text fg={theme.textMuted}>sign in expired</text>
    if (current.state === "failed")
      return (
        <box flexDirection="column">
          <text fg={theme.error} wrapMode="word">
            {current.message}
          </text>
          <text fg={theme.textMuted}>Try again</text>
        </box>
      )
    return <text fg={theme.textMuted}> </text>
  }

  return (
    <box
      flexDirection="row"
      gap={2}
      paddingLeft={2}
      onMouseOver={() => {
        if (clickable()) setHover(true)
      }}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!clickable()) return
        if (phase().state === "idle") props.onIdle()
        else props.onActivate()
      }}
    >
      <text fg={hover() ? theme.text : theme.textMuted} attributes={hover() ? TextAttributes.BOLD : undefined}>
        {props.title}
      </text>
      {status()}
    </box>
  )
}

export function AwsRow(props: { phase: AwsPhase; onIdle: () => void; onActivate: () => void }) {
  return <CloudRow title="AWS" phase={props.phase} onIdle={props.onIdle} onActivate={props.onActivate} />
}

export function GithubRow(props: { phase: GithubPhase; onIdle: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const phase = () => props.phase
  const clickable = () => {
    const current = phase()
    return current.state === "idle" || current.state === "needs_auth" || current.state === "failed"
  }

  const status = (): JSX.Element => {
    const current = phase()
    if (current.state === "checking") return <Spinner color={theme.textMuted}>Checking…</Spinner>
    if (current.state === "working") return <Spinner color={theme.textMuted}>{current.step}</Spinner>
    if (current.state === "connected")
      return (
        <text fg={theme.success} attributes={TextAttributes.BOLD}>
          ✓
        </text>
      )
    if (current.state === "needs_auth") return <text fg={theme.textMuted}>token needed</text>
    if (current.state === "failed")
      return (
        <box flexDirection="column">
          <text fg={theme.error} wrapMode="word">
            {current.message}
          </text>
          <text fg={theme.textMuted}>Try again</text>
        </box>
      )
    return <text fg={theme.textMuted}> </text>
  }

  return (
    <box
      flexDirection="row"
      gap={2}
      paddingLeft={2}
      onMouseOver={() => {
        if (clickable()) setHover(true)
      }}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!clickable()) return
        props.onIdle()
      }}
    >
      <text fg={hover() ? theme.text : theme.textMuted} attributes={hover() ? TextAttributes.BOLD : undefined}>
        GitHub
      </text>
      {status()}
    </box>
  )
}
