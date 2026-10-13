import { For, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { DialogModel } from "./dialog-model"
import { DialogProvider as DialogProviderList } from "./dialog-provider"
import { DialogCloudConnect, GithubRow, SettingRow } from "./dialog-cloud-connect"
import { CLOUD_PROVIDERS } from "../util/cloud-provider"
import { Spinner } from "./spinner"
import { createCloudConnect } from "./cloud-connect"
import { createGithubConnect } from "./github-connect"

// Settings hub behind the rail icon: connected model providers with a
// "+ New" entry, and below it only connected cloud providers with a
// "+ New cloud provider" entry. The New button opens the connect popup
// listing every available cloud provider; once connected, reopening
// Settings lists it here.
export function DialogSettings() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()

  // Same detection for every provider: cheap checks first, cached setup
  // flag, then one live call — returning users skip the first-time flow.
  const clouds = CLOUD_PROVIDERS.map((item) => ({ item, connect: createCloudConnect(item.value) }))
  const github = createGithubConnect({
    onConnected: () => dialog.replace(() => <DialogSettings />),
  })
  onCleanup(() => {
    clouds.forEach((cloud) => cloud.connect.dispose())
    github.dispose()
  })
  onMount(() => {
    clouds.forEach((cloud) => void cloud.connect.detect())
    void github.detect()
  })

  return (
    <box gap={1} paddingBottom={1} flexGrow={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Settings
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <box flexGrow={1} flexShrink={1} paddingLeft={4} paddingRight={4} flexDirection="column" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          Providers
        </text>
        <For each={sync.data.provider}>
          {(provider) => (
            <SettingRow
              title={provider.name}
              detail="✓"
              success
              onSelect={() => dialog.replace(() => <DialogModel providerID={provider.id} />)}
            />
          )}
        </For>
        <SettingRow title="Add" onSelect={() => dialog.replace(() => <DialogProviderList />)} />
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          Cloud providers
        </text>
        <For each={clouds}>
          {(cloud) => (
            <>
              <Show when={cloud.connect.phase().state === "checking"}>
                <box flexDirection="row" gap={2} paddingLeft={2}>
                  <text fg={theme.textMuted}>{cloud.item.title}</text>
                  <Spinner color={theme.textMuted}>Checking…</Spinner>
                </box>
              </Show>
              <Show when={cloud.connect.phase().state === "connected"}>
                <SettingRow title={cloud.item.title} detail="✓" success />
              </Show>
              <Show when={cloud.connect.phase().state === "reauth"}>
                <SettingRow
                  title={cloud.item.title}
                  detail="sign in expired"
                  onSelect={() =>
                    dialog.replace(() => <DialogCloudConnect onDone={() => dialog.replace(() => <DialogSettings />)} />)
                  }
                />
              </Show>
            </>
          )}
        </For>
        <SettingRow
          title="Add"
          onSelect={() =>
            dialog.replace(() => <DialogCloudConnect onDone={() => dialog.replace(() => <DialogSettings />)} />)
          }
        />
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          Integrations
        </text>
        <GithubRow
          phase={github.phase()}
          onIdle={() => void github.collectTokenInput(() => dialog.replace(() => <DialogSettings />))}
        />
      </box>
    </box>
  )
}
