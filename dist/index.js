#!/usr/bin/env node
/**
 * copilot-gemini-bridge MCP Server
 *
 * Bridges Claude (Opus) → GPT-5.2 (via Copilot SDK) → Gemini (via gemini-mcp-tool)
 * GPT-5.2 autonomously decides when to delegate heavy lifting to Gemini.
 *
 * Architecture:
 *   Claude Code (Opus)
 *     → calls this MCP server's "ask-copilot-with-gemini" tool
 *       → Copilot SDK spawns GPT-5.2 session with Gemini as available MCP tool
 *         → GPT autonomously calls Gemini when beneficial
 *       → GPT synthesizes and returns response to Opus
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { CopilotClient, } from "@github/copilot-sdk";
import { resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
// --- Configuration (override via env vars) ---
// Path to gemini-mcp-tool. Override: GEMINI_MCP_PATH
const GEMINI_MCP_PATH = process.env.GEMINI_MCP_PATH ||
    resolve(homedir(), "mcp-servers/gemini-mcp-tool/dist/index.js");
// Default model for the Copilot session. Override: COPILOT_MODEL
const DEFAULT_MODEL = process.env.COPILOT_MODEL || "gpt-5.2";
// Default reasoning effort (low/medium/high/xhigh). Override: COPILOT_REASONING_EFFORT
const VALID_REASONING_EFFORTS = [
    "low",
    "medium",
    "high",
    "xhigh",
];
function parseReasoningEffort(value) {
    if (value && VALID_REASONING_EFFORTS.includes(value)) {
        return value;
    }
    return "high";
}
const DEFAULT_REASONING_EFFORT = parseReasoningEffort(process.env.COPILOT_REASONING_EFFORT);
// Request timeout in ms. Override: COPILOT_TIMEOUT
const DEFAULT_TIMEOUT = Number(process.env.COPILOT_TIMEOUT) || 300_000;
// Gemini MCP tools exposed to the orchestrator model. Override: GEMINI_TOOLS (comma-separated)
// These must match the actual tool names registered by gemini-mcp-tool:
//   ask-gemini, brainstorm, fetch-chunk, Help, ping, timeout-test
// Note: Gemini CLI's *internal* tools (codebase_investigator, glob, read_file, etc.)
// are used by Gemini internally when processing ask-gemini requests - they are NOT
// separate MCP tools and don't need to be listed here.
const GEMINI_TOOL_ALLOWLIST = process.env.GEMINI_TOOLS
    ? process.env.GEMINI_TOOLS.split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : ["ask-gemini", "brainstorm", "fetch-chunk"];
// Gemini model to use. Override: GEMINI_MODEL
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "auto-gemini-3";
const VALID_GEMINI_MODELS = [
    "auto-gemini-3",
    "auto-gemini-2.5",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
];
// Whether Copilot can use write/execute tools. Override: COPILOT_WRITE_ACCESS=true|false
// When false, Copilot can still read files and fetch URLs but cannot execute shell
// commands or modify files. Gemini MCP tools are always restricted by the allowlist above.
const DEFAULT_WRITE_ACCESS = process.env.COPILOT_WRITE_ACCESS !== "false";
// Copilot tools excluded when write access is disabled.
// Read-only tools (view, grep, glob, web_fetch, web_search) remain available.
const WRITE_TOOLS = [
    "bash",
    "write_bash",
    "create",
    "edit",
    "task",
];
// Permission kinds that are always allowed (even in read-only mode)
const READ_ONLY_ALLOWED_KINDS = new Set(["mcp", "read", "url"]);
// System message builder - includes the selected Gemini model
function buildSystemMessage(geminiModel) {
    return `You have access to Gemini (Google's AI) as an MCP tool called "gemini".
When processing requests, autonomously delegate to Gemini when it would be beneficial:

DELEGATE TO GEMINI FOR:
- Large context analysis (Gemini has massive context windows)
- Web search and current information retrieval
- Summarization of large codebases or documents
- Complex reasoning tasks that benefit from a second perspective
- Brainstorming and creative ideation

HANDLE YOURSELF:
- Simple questions with straightforward answers
- Code generation where you have sufficient context
- Tasks requiring your specific capabilities

When delegating, use Gemini's "ask-gemini" tool with clear, detailed prompts.
IMPORTANT: Always pass model: "${geminiModel}" when calling ask-gemini.
Synthesize Gemini's responses with your own analysis before returning to the user.
Always provide a unified, coherent response - don't just relay Gemini's output verbatim.`;
}
// --- Logging ---
function log(level, ...args) {
    const ts = new Date().toISOString();
    process.stderr.write(`[${ts}] [${level}] ${args.map(String).join(" ")}\n`);
}
// --- Singleton CopilotClient (with init lock) ---
let singletonClient;
let clientInitPromise;
async function getClient() {
    if (singletonClient)
        return singletonClient;
    // Prevent concurrent initialization race
    if (clientInitPromise)
        return clientInitPromise;
    clientInitPromise = (async () => {
        log("INFO", "Creating singleton CopilotClient...");
        const client = new CopilotClient({
            logLevel: "warning",
        });
        await client.start();
        singletonClient = client;
        log("INFO", "CopilotClient started");
        return client;
    })();
    try {
        return await clientInitPromise;
    }
    catch (error) {
        clientInitPromise = undefined; // Allow retry on failure
        throw error;
    }
}
async function shutdownClient() {
    if (!singletonClient)
        return;
    log("INFO", "Shutting down CopilotClient...");
    const client = singletonClient;
    singletonClient = undefined;
    clientInitPromise = undefined;
    try {
        await client.stop();
    }
    catch {
        try {
            await client.forceStop();
        }
        catch {
            // Last resort
        }
    }
}
async function runBridge(options) {
    const { prompt, model = DEFAULT_MODEL, reasoningEffort = DEFAULT_REASONING_EFFORT, geminiModel = DEFAULT_GEMINI_MODEL, context, timeout = DEFAULT_TIMEOUT, writeAccess = DEFAULT_WRITE_ACCESS, } = options;
    log("INFO", `Starting bridge: model=${model}, reasoning=${reasoningEffort}, gemini=${geminiModel}, write=${writeAccess}, timeout=${timeout}ms`);
    // Build the full prompt with optional context
    const fullPrompt = context
        ? `${prompt}\n\n--- Additional Context ---\n${context}`
        : prompt;
    // Configure Gemini as an MCP server available to the orchestrator
    const geminiMcpConfig = {
        type: "local",
        command: "node",
        args: [GEMINI_MCP_PATH],
        tools: GEMINI_TOOL_ALLOWLIST,
    };
    const client = await getClient();
    let session;
    try {
        log("INFO", "Creating Copilot session with Gemini MCP...");
        // Create session with model and Gemini as available MCP server
        session = await client.createSession({
            model,
            reasoningEffort,
            ...(writeAccess ? {} : { excludedTools: WRITE_TOOLS }),
            systemMessage: {
                mode: "append",
                content: buildSystemMessage(geminiModel),
            },
            mcpServers: {
                gemini: geminiMcpConfig,
            },
            onPermissionRequest: async (request) => {
                // Always allow MCP, read, and URL permissions
                if (READ_ONLY_ALLOWED_KINDS.has(request.kind)) {
                    log("DEBUG", `Approving ${request.kind} permission`);
                    return { kind: "approved" };
                }
                // Allow shell/write when write access is enabled
                if (writeAccess) {
                    log("DEBUG", `Approving ${request.kind} (write access enabled)`);
                    return { kind: "approved" };
                }
                // Deny shell/write in read-only mode
                log("WARN", `Denying ${request.kind} (write access disabled)`);
                return {
                    kind: "denied-by-rules",
                    rules: [{ description: "Write access is disabled - only read operations permitted" }],
                };
            },
            // No user input needed - fully autonomous
            onUserInputRequest: async () => ({
                answer: "Proceed autonomously - do not ask for user input.",
                wasFreeform: true,
            }),
        });
        log("INFO", `Session created: ${session.sessionId}`);
        // Track events for debugging
        const events = [];
        session.on("tool.execution_start", (event) => {
            const toolName = event.data.toolName;
            const mcpServer = event.data.mcpServerName;
            const label = mcpServer ? `${mcpServer}:${toolName}` : toolName;
            log("DEBUG", `Tool call: ${label}`);
            events.push(label);
        });
        // Send the prompt and wait for completion
        log("INFO", "Sending prompt...");
        const response = await session.sendAndWait({ prompt: fullPrompt }, timeout);
        // Extract the response content
        const content = response?.data?.content;
        if (!content) {
            log("WARN", "No content in response, checking session history...");
            const messages = await session.getMessages();
            const assistantMessages = messages.filter((m) => m.type === "assistant.message");
            const lastMsg = assistantMessages[assistantMessages.length - 1];
            if (lastMsg && lastMsg.type === "assistant.message") {
                return lastMsg.data.content || "No response generated.";
            }
            return "No response generated.";
        }
        const toolsUsed = events.length > 0 ? `\n\n[Tools used: ${events.join(", ")}]` : "";
        log("INFO", `Response received. Tools used: ${events.join(", ") || "none"}`);
        return content + toolsUsed;
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log("ERROR", `Bridge error: ${msg}`);
        throw new Error(`Copilot-Gemini bridge failed: ${msg}`);
    }
    finally {
        // Always clean up the session
        if (session) {
            try {
                await session.destroy();
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
}
// --- MCP Server ---
const server = new Server({
    name: "copilot-gemini-bridge",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Register tools
server.setRequestHandler(ListToolsRequestSchema, async (_request) => {
    return {
        tools: [
            {
                name: "ask-copilot-with-gemini",
                description: `Send a prompt to GPT-5.2 which has autonomous access to Gemini's tools.
GPT will decide when to delegate to Gemini for heavy lifting (large context analysis,
web search, summarization, brainstorming). Returns GPT's synthesized response.
Use this for complex analysis tasks where token arbitrage is beneficial -
Gemini handles the heavy lifting (request-based pricing) while GPT synthesizes.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        prompt: {
                            type: "string",
                            description: "The prompt/question to send to GPT-5.2. Be specific about what you want analyzed.",
                        },
                        model: {
                            type: "string",
                            description: `Model to use. Default: ${DEFAULT_MODEL}. Options: gpt-5.2, gpt-5.2-codex, gpt-5.1, gpt-5.1-codex, gpt-5, gpt-4.1`,
                            default: DEFAULT_MODEL,
                        },
                        reasoningEffort: {
                            type: "string",
                            enum: ["low", "medium", "high", "xhigh"],
                            description: `Reasoning effort level. Default: ${DEFAULT_REASONING_EFFORT}. Higher = better quality but slower/more tokens.`,
                            default: DEFAULT_REASONING_EFFORT,
                        },
                        geminiModel: {
                            type: "string",
                            description: `Gemini model to use. Default: ${DEFAULT_GEMINI_MODEL}. Auto modes let Gemini CLI pick pro/flash. Manual modes select a specific model.`,
                            default: DEFAULT_GEMINI_MODEL,
                            enum: VALID_GEMINI_MODELS,
                        },
                        context: {
                            type: "string",
                            description: "Optional additional context (code snippets, file contents, etc.) to include with the prompt.",
                        },
                        timeout: {
                            type: "number",
                            description: `Timeout in ms. Default: ${DEFAULT_TIMEOUT}. Increase for very large tasks.`,
                            default: DEFAULT_TIMEOUT,
                        },
                        writeAccess: {
                            type: "boolean",
                            description: `Allow Copilot to use write/execute tools (bash, create, edit). Gemini is always read-only. Default: ${DEFAULT_WRITE_ACCESS}.`,
                            default: DEFAULT_WRITE_ACCESS,
                        },
                    },
                    required: ["prompt"],
                },
            },
        ],
    };
});
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "ask-copilot-with-gemini") {
        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }
    const { prompt, model, reasoningEffort, geminiModel, context, timeout, writeAccess, } = (args || {});
    if (!prompt || typeof prompt !== "string") {
        return {
            content: [{ type: "text", text: "Error: prompt is required and must be a string" }],
            isError: true,
        };
    }
    const effort = parseReasoningEffort(reasoningEffort);
    // Validate geminiModel if provided
    const validatedGeminiModel = geminiModel && VALID_GEMINI_MODELS.includes(geminiModel)
        ? geminiModel
        : undefined;
    // Validate timeout if provided
    const validatedTimeout = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
    try {
        const result = await runBridge({
            prompt,
            model: typeof model === "string" ? model : undefined,
            reasoningEffort: effort,
            geminiModel: validatedGeminiModel,
            context: typeof context === "string" ? context : undefined,
            timeout: validatedTimeout,
            writeAccess: typeof writeAccess === "boolean" ? writeAccess : undefined,
        });
        return {
            content: [{ type: "text", text: result }],
            isError: false,
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error: ${msg}` }],
            isError: true,
        };
    }
});
// --- Startup & Shutdown ---
function validateConfig() {
    if (!existsSync(GEMINI_MCP_PATH)) {
        log("WARN", `Gemini MCP not found at ${GEMINI_MCP_PATH} - tool calls will fail until it's installed`);
    }
    const envEffort = process.env.COPILOT_REASONING_EFFORT;
    if (envEffort && !VALID_REASONING_EFFORTS.includes(envEffort)) {
        log("WARN", `Invalid COPILOT_REASONING_EFFORT="${envEffort}", using "high". Valid: ${VALID_REASONING_EFFORTS.join(", ")}`);
    }
    const envTimeout = process.env.COPILOT_TIMEOUT;
    if (envTimeout && (isNaN(Number(envTimeout)) || Number(envTimeout) <= 0)) {
        log("WARN", `Invalid COPILOT_TIMEOUT="${envTimeout}", using ${DEFAULT_TIMEOUT}ms`);
    }
    const envGeminiModel = process.env.GEMINI_MODEL;
    if (envGeminiModel && !VALID_GEMINI_MODELS.includes(envGeminiModel)) {
        log("WARN", `Unrecognized GEMINI_MODEL="${envGeminiModel}" - passing through (may be a new model)`);
    }
}
async function main() {
    log("INFO", "Starting copilot-gemini-bridge MCP server...");
    validateConfig();
    log("INFO", `Config: model=${DEFAULT_MODEL}, reasoning=${DEFAULT_REASONING_EFFORT}, write=${DEFAULT_WRITE_ACCESS}, timeout=${DEFAULT_TIMEOUT}ms`);
    log("INFO", `Gemini: model=${DEFAULT_GEMINI_MODEL}, path=${GEMINI_MCP_PATH}`);
    log("INFO", `Gemini MCP tool allowlist: ${GEMINI_TOOL_ALLOWLIST.join(", ")}`);
    log("INFO", `Copilot write access: ${DEFAULT_WRITE_ACCESS}${DEFAULT_WRITE_ACCESS ? "" : ` (excluded: ${WRITE_TOOLS.join(", ")})`}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("INFO", "copilot-gemini-bridge listening on stdio");
}
// Graceful shutdown
process.on("SIGINT", async () => {
    log("INFO", "SIGINT received, shutting down...");
    await shutdownClient();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    log("INFO", "SIGTERM received, shutting down...");
    await shutdownClient();
    process.exit(0);
});
main().catch((error) => {
    log("ERROR", "Fatal error:", error);
    process.exit(1);
});
