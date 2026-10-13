# CloudPilot AI

AI-powered development tool, built as a Bun + TypeScript monorepo.

## Requirements

- [Bun](https://bun.sh) 1.3.14 or newer
- Git

## Setup

```bash
git clone https://github.com/rishithambala/CloudPilotAI.git
cd CloudPilotAI
bun install
bun dev
```

On Windows, install Bun with `powershell -c "irm bun.sh/install.ps1 | iex"`.

Set your AI provider key before running, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Project layout

- `packages/cloudpilot-ai` – main CLI / TUI entry point (`src/index.ts`)
- `packages/core`, `packages/server`, `packages/llm`, `packages/tui` – core libraries
- `packages/sdk/js` – JavaScript SDK
- `patches/` – dependency patches applied by `bun install`
