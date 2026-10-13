// Background AWS setup engine for the Settings cloud-provider flow. No chat
// session is ever opened: steps run as detached child processes while the
// settings row shows Connect, a spinner, re-auth, or a tick.
//
// The AWS decision tree itself lives in @cloudpilot-ai/core so the TUI and
// the agent-facing `connection_status` tool share one implementation; this
// module keeps the TUI-facing names stable.

import { CLI_LOGIN_TIMEOUT_MS, CLI_STEP_TIMEOUT_MS, type CliRunResult } from "@cloudpilot-ai/core/cloud-provider/cli"

export {
  clearLoginSession,
  cliInstalled,
  configPath,
  credentialsPath,
  detectAwsState,
  parseAwsProfiles,
  readAwsCredentials,
  removeIniKey,
  runAws,
  stsValid,
  type AwsDetectDeps,
  type AwsPresence,
} from "@cloudpilot-ai/core/cloud-provider/aws"
export { isCliMissing } from "@cloudpilot-ai/core/cloud-provider/cli"

export const AWS_SETUP_DONE_KEY = "aws_setup_done"
export const AWS_PROFILE_KEY = "aws_profile"
export const AWS_REGION_KEY = "aws_region"

export const AWS_LOGIN_TIMEOUT_MS = CLI_LOGIN_TIMEOUT_MS
export const AWS_STEP_TIMEOUT_MS = CLI_STEP_TIMEOUT_MS

export type AwsRunResult = CliRunResult
