import { EOL } from "os"
import { Effect } from "effect"
import { CLOUD_PROVIDERS, isCloudProviderID } from "@cloudpilot-ai/core/cloud-provider/catalog"
import { detectAllCloudProviders, detectCloudProvider } from "@cloudpilot-ai/core/cloud-provider/detect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"

const CloudProviderListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list cloud service providers",
  instance: false,
  handler: Effect.fn("Cli.cloud-provider.list")(function* () {
    for (const provider of CLOUD_PROVIDERS) {
      process.stdout.write(`${provider.id} (${provider.name})` + EOL)
      process.stdout.write(`  ${provider.description}` + EOL)
    }
  }),
})

const CloudProviderStatusCommand = effectCmd({
  command: "status [provider]",
  describe: "show whether each cloud service provider is connected on this machine",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", {
        type: "string",
        describe: `one of: ${CLOUD_PROVIDERS.map((item) => item.id).join(", ")}`,
      })
      .option("json", { type: "boolean", default: false, describe: "print machine-readable JSON" }),
  handler: Effect.fn("Cli.cloud-provider.status")(function* (args) {
    const target = args.provider
    if (target && !isCloudProviderID(target)) return yield* fail(`Unknown cloud provider "${target}".`)
    const items = yield* Effect.promise(() =>
      target && isCloudProviderID(target)
        ? detectCloudProvider(target).then((item) => [item])
        : detectAllCloudProviders(),
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(items, null, 2) + EOL)
      return
    }
    for (const item of items) {
      process.stdout.write(`${item.provider} (${item.name}): ${item.state}` + EOL)
      process.stdout.write(`  ${item.summary}` + EOL)
      if (item.nextStep) process.stdout.write(`  Next: ${item.nextStep}` + EOL)
    }
  }),
})

export const CloudProviderCommand = cmd({
  command: "cloud-provider",
  aliases: ["cloud-providers", "cloud"],
  describe: "manage cloud service providers",
  builder: (yargs) => yargs.command(CloudProviderListCommand).command(CloudProviderStatusCommand).demandCommand(),
  async handler() {},
})
