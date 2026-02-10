# copilot-gemini-bridge

MCP server that bridges GPT-5.3 Codex (via GitHub Copilot SDK) with Gemini for token arbitrage.

## Architecture

```
Claude Code (Opus)
  → calls "ask-copilot-with-gemini" tool on this MCP server
    → Copilot SDK creates GPT-5.3 Codex session (singleton client, per-request sessions)
      → GPT has Gemini available as an MCP tool (restricted allowlist)
      → GPT autonomously decides when to delegate to Gemini
      → Gemini handles heavy lifting (request-based pricing = cheap tokens)
    → GPT synthesizes and returns response to Opus
```

## Why?

- **Token arbitrage**: Gemini is request-based pricing (effectively free), while GPT is token-based
- **Best of both**: GPT's reasoning + Gemini's massive context window and web search
- **Autonomous delegation**: GPT decides when Gemini is the right tool for the job via system message guidance

## Setup

### Prerequisites

- Node.js >= 22
- GitHub Copilot CLI installed and authenticated (`copilot /login`)
- [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool) installed (default path: `~/mcp-servers/gemini-mcp-tool/`)

### Install

```bash
cd ~/mcp-servers/copilot-gemini-bridge
npm install
npm run build
```

### Register with Claude Code

```bash
claude mcp add --scope user copilot-gemini -- node ~/mcp-servers/copilot-gemini-bridge/dist/index.js
```

## Usage

Once registered, use from Claude Code:

```
Use ask-copilot-with-gemini to analyze this codebase for security issues
```

GPT-5.3 Codex will automatically delegate to Gemini for heavy analysis, then synthesize findings.

## Tool Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | The prompt to send to GPT-5.3 Codex |
| `model` | string | No | `gpt-5.3-codex` | Copilot model to orchestrate with |
| `reasoningEffort` | string | No | `high` | Reasoning effort: `low`, `medium`, `high`, `xhigh` (model-dependent, see below) |
| `geminiModel` | string | No | `auto-gemini-3` | Which Gemini model to use for delegated work |
| `context` | string | No | - | Additional context (code snippets, file contents) |
| `timeout` | number | No | `300000` | Timeout in ms |
| `writeAccess` | boolean | No | `true` | Allow Copilot to use write/execute tools (bash, create, edit) |

## Available Models

### Copilot (orchestrator)

| Model | Reasoning effort | Description |
|-------|-----------------|-------------|
| `gpt-5.3-codex` | none | Latest codex, autonomous reasoning (default) |
| `gpt-5.2` | low, medium, high | Latest non-codex, best configurable reasoning |
| `gpt-5.2-codex` | low, medium, high, xhigh | Code-optimized with full reasoning range |
| `gpt-5.1-codex-max` | low, medium, high, xhigh | Max-tier previous gen codex |
| `gpt-5.1` / `gpt-5.1-codex` | low, medium, high | Previous gen |
| `gpt-5.1-codex-mini` | low, medium, high | Lightweight codex |
| `gpt-5` / `gpt-5-mini` | low, medium, high | Older gen |
| `gpt-4.1` | none | Legacy |

Reasoning effort support is auto-detected at startup via `listModels()`. If a requested level isn't supported by the chosen model, it's automatically clamped to a valid level.

### Gemini (delegated heavy lifting)

| Model | Description |
|-------|-------------|
| `auto-gemini-3` | CLI picks best of gemini-3-pro / gemini-3-flash (default) |
| `auto-gemini-2.5` | CLI picks best of gemini-2.5-pro / gemini-2.5-flash |
| `gemini-3-pro-preview` | Latest pro, maximum capability |
| `gemini-3-flash-preview` | Latest flash, fast |
| `gemini-2.5-pro` | Previous gen pro |
| `gemini-2.5-flash` | Previous gen flash |
| `gemini-2.5-flash-lite` | Lightest, cheapest |

## Environment Variables

All defaults can be overridden via environment variables. Set them in your shell or in the MCP server config.

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_MODEL` | `gpt-5.3-codex` | Default Copilot model |
| `COPILOT_REASONING_EFFORT` | `high` | Default reasoning effort (`low`/`medium`/`high`/`xhigh`) |
| `COPILOT_TIMEOUT` | `300000` | Default timeout in ms |
| `COPILOT_WRITE_ACCESS` | `true` | Allow Copilot write tools (`true`/`false`) |
| `GEMINI_MODEL` | `auto-gemini-3` | Default Gemini model |
| `GEMINI_MCP_PATH` | `~/mcp-servers/gemini-mcp-tool/dist/index.js` | Path to gemini-mcp-tool |
| `GEMINI_TOOLS` | `ask-gemini,brainstorm,fetch-chunk` | Comma-separated Gemini MCP tool allowlist |

### Example: Read-only mode with Gemini 2.5 Pro

```bash
claude mcp add --scope user copilot-gemini -- \
  env COPILOT_WRITE_ACCESS=false GEMINI_MODEL=gemini-2.5-pro \
  node ~/mcp-servers/copilot-gemini-bridge/dist/index.js
```

## Security Model

### Two-layer isolation

**Gemini (untrusted, limited visibility):**
- Restricted to a strict MCP tool allowlist: `ask-gemini`, `brainstorm`, `fetch-chunk`
- These are the tools registered by [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool). Gemini CLI's internal tools (file reading, code search, etc.) are used *within* `ask-gemini` processing but are not directly exposed as MCP tools
- No shell, write, or edit access at the MCP layer

**Copilot (trusted, full context):**
- Write access enabled by default (Copilot has full session context and is human-initiated)
- Set `writeAccess: false` per-call or `COPILOT_WRITE_ACCESS=false` globally to restrict to read-only
- In read-only mode: `bash`, `write_bash`, `create`, `edit`, `task` are excluded; read operations (`view`, `grep`, `glob`, `web_fetch`, `web_search`) remain available

### Permission handling

| Permission kind | Write access ON | Write access OFF |
|----------------|-----------------|------------------|
| `mcp` | Approved | Approved |
| `read` | Approved | Approved |
| `url` | Approved | Approved |
| `shell` | Approved | Denied |
| `write` | Approved | Denied |

## How It Works

1. **Singleton client**: One `CopilotClient` instance is created on first use (with init lock to prevent races) and reused across requests
2. **Per-request sessions**: Each tool call creates a fresh `CopilotSession` with the configured model, reasoning effort, and Gemini MCP server
3. **System message**: GPT is instructed to autonomously delegate to Gemini when beneficial, using the specified Gemini model
4. **Cleanup**: Sessions are always destroyed in `finally` blocks; client shuts down gracefully on SIGINT/SIGTERM
5. **Tool tracking**: Response includes a `[Tools used: ...]` footer showing which tools GPT called
6. **Input validation**: Tool arguments are type-checked at runtime; invalid values fall back to defaults

## Development

```bash
npm run build    # Compile TypeScript
npm run start    # Run the server
npm run dev      # Build + run
```

## Dependencies

- [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) - Copilot CLI JSON-RPC SDK
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - MCP server framework
- [`gemini-mcp-tool`](https://github.com/jamubc/gemini-mcp-tool) - Gemini CLI wrapped as MCP server (runtime dependency, not npm)
