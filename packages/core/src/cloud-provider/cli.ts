import { spawn } from "node:child_process"

// Provider-agnostic CLI runner shared by every cloud connect flow and the
// agent-facing status tool. Never rejects: spawn errors, non-zero exits,
// timeouts, and aborts all resolve so callers can branch on the result.

export const CLI_STEP_TIMEOUT_MS = 30 * 1000
export const CLI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export type CliRunResult = {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

export type CliRunOptions = {
  timeoutMs: number
  signal?: AbortSignal
  env?: Record<string, string>
}

export type CliRunner = (command: string, args: string[], options: CliRunOptions) => Promise<CliRunResult>

function concat(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8")
}

export const runCli: CliRunner = (command, args, options) =>
  new Promise((resolve) => {
    const { timeoutMs, signal, env } = options
    if (signal?.aborted) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", timedOut: false, aborted: true })
      return
    }
    // Windows ships gcloud/az as .cmd shims, which only resolve through a
    // shell; arguments are quoted so the shell passes them through verbatim.
    const shell = process.platform === "win32"
    const child = spawn(command, shell ? args.map(quoteWindowsArg) : args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
      shell,
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let finished = false
    const done = (result: CliRunResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => {
      child.kill("SIGTERM")
      done({ ok: false, code: null, stdout: concat(stdout), stderr: concat(stderr), timedOut: false, aborted: true })
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      done({ ok: false, code: null, stdout: concat(stdout), stderr: concat(stderr), timedOut: true, aborted: false })
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      done({
        ok: false,
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        aborted: false,
      })
    })
    child.on("close", (code) => {
      done({ ok: code === 0, code, stdout: concat(stdout), stderr: concat(stderr), timedOut: false, aborted: false })
    })
  })

export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

// Missing executables surface as ENOENT from spawn, or — through the Windows
// shell — as a "not recognized" message with exit code 1.
export function isCliMissing(result: CliRunResult): boolean {
  if (result.ok) return false
  if (/ENOENT/i.test(result.stderr)) return true
  return /is not recognized as an internal or external command|command not found/i.test(result.stderr)
}

export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? "unknown error"
}

// First meaningful line across stderr then stdout, for user-facing errors.
export function failureDetail(result: Pick<CliRunResult, "stdout" | "stderr">): string | undefined {
  return [result.stderr, result.stdout].map(lastLine).find((line) => line !== "unknown error")
}
