import type { TuiPlugin, TuiPluginApi } from "@cloudpilot-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, onMount } from "solid-js"
import { getConnectedCloudProviders, refreshCloudProviders } from "../../util/cloud-provider"

const id = "internal:sidebar-cloud-provider"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  // Backed by the shared connection store: connect flows update it live, and
  // this background check fills it for returning users on startup.
  const list = createMemo(() => getConnectedCloudProviders())
  onMount(() => void refreshCloudProviders())

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Cloud</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: theme().success }}>
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {item.title} <span style={{ fg: theme().textMuted }}>Connected</span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 210,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
