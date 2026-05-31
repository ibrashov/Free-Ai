# API Provider Switching

This file explains how to use the API keys added to `free-claude-code`.

## Current Working Providers

Configured and tested:

```text
OpenRouter
Gemini
Groq
Cerebras
```

Configured but not working correctly yet:

```text
Mistral
Mistral Codestral
```

Local fallback:

```text
Ollama
```

## Recommended Order

Use this order for the current setup:

```text
1. Cerebras    - best current default for Free AI and Claude Code compatibility
2. OpenRouter  - useful fallback, but free models can hit provider limits
3. Gemini      - good for normal chat, but can fail on tool_calls in Claude Code
4. Groq        - very fast, but some models behave poorly with tool calls
5. Ollama      - local fallback, slower and less stable in Claude Code
```

## Switch Active Gateway Model

Run from the Flutter workspace:

```powershell
.\\scripts\\Set-GatewayModel.ps1 -Provider cerebras
```

Other options:

```powershell
.\\scripts\\Set-GatewayModel.ps1 -Provider gemini-fast
.\\scripts\\Set-GatewayModel.ps1 -Provider groq
.\\scripts\\Set-GatewayModel.ps1 -Provider cerebras
.\\scripts\\Set-GatewayModel.ps1 -Provider openrouter
.\\scripts\\Set-GatewayModel.ps1 -Provider ollama
```

Custom model:

```powershell
.\\scripts\\Set-GatewayModel.ps1 -Provider custom -Model "groq/qwen/qwen3-32b"
```

## Test Providers

```powershell
.\\scripts\\Test-GatewayProviders.ps1
```

This prints provider status and model names, but does not print API keys.

## Suggested Usage

For Claude Code in VS Code:

```text
Start with Cerebras.
Use Gemini for normal chat/brief generation, not as the first file-editing agent.
Use Groq for short experiments.
Use OpenRouter when you want to try its free model list.
Use Ollama only when you need local/offline fallback.
```

For real file editing, Codex is still the most reliable executor.
