// Single source of truth for the cloud service providers CloudPilot knows
// about. The CLI `cloud-provider` command, the HTTP API handler, the TUI
// connect picker/Settings rows, and the agent-facing `connection_status`
// tool all read this list — never re-declare it elsewhere.

export type CloudProviderID = "aws" | "oracle" | "google-cloud" | "azure"

export interface CloudProviderDefinition {
  readonly id: CloudProviderID
  readonly name: string
  readonly description: string
  /** Executable of the official CLI used for sign-in and status checks. */
  readonly cli: string
  /** Where a user can install the CLI when it is missing. */
  readonly installUrl: string
}

export const CLOUD_PROVIDERS: ReadonlyArray<CloudProviderDefinition> = [
  {
    id: "aws",
    name: "AWS",
    description: "Amazon Web Services",
    cli: "aws",
    installUrl: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
  },
  {
    id: "oracle",
    name: "Oracle Cloud",
    description: "Oracle Cloud Infrastructure",
    cli: "oci",
    installUrl: "https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm",
  },
  {
    id: "google-cloud",
    name: "Google Cloud",
    description: "Google Cloud Platform",
    cli: "gcloud",
    installUrl: "https://cloud.google.com/sdk/docs/install",
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    description: "Microsoft Azure",
    cli: "az",
    installUrl: "https://learn.microsoft.com/cli/azure/install-azure-cli",
  },
]

export const CLOUD_PROVIDER_IDS: ReadonlyArray<CloudProviderID> = CLOUD_PROVIDERS.map((item) => item.id)

export function isCloudProviderID(id: string): id is CloudProviderID {
  return CLOUD_PROVIDER_IDS.includes(id as CloudProviderID)
}

export function getCloudProvider(id: string): CloudProviderDefinition | undefined {
  return CLOUD_PROVIDERS.find((item) => item.id === id)
}
