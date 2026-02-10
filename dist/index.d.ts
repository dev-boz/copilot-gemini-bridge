#!/usr/bin/env node
/**
 * copilot-gemini-bridge MCP Server
 *
 * Bridges Claude (Opus) → GPT-5.3 Codex (via Copilot SDK) → Gemini (via gemini-mcp-tool)
 * GPT-5.3 Codex autonomously decides when to delegate heavy lifting to Gemini.
 *
 * Architecture:
 *   Claude Code (Opus)
 *     → calls this MCP server's "ask-copilot-with-gemini" tool
 *       → Copilot SDK spawns GPT-5.3 Codex session with Gemini as available MCP tool
 *         → GPT autonomously calls Gemini when beneficial
 *       → GPT synthesizes and returns response to Opus
 */
export {};
