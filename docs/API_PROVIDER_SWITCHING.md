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
Gemma Local
```

## Recommended Order

Use this order for the current setup:

```text
1. Gemini Fast - cheap default for simple chat
2. Cerebras    - strong fallback for normal chat
3. Groq        - fast fallback, but token-per-minute limits can hit quickly
4. OpenRouter  - useful free-model fallback, but daily free requests are limited
5. Gemma Local - compact local model through Ollama, no API quota
6. Ollama      - local coder fallback, no API quota
7. OpenCode    - project/file agent mode, with Ollama fallback when cloud is rate-limited
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
.\\scripts\\Set-GatewayModel.ps1 -Provider gemma
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

For Free AI Console in VS Code:

```text
Use Auto balanced for normal questions.
Use Auto compare only when you really want multiple model opinions.
Use survival mode when cloud quotas are exhausted.
Use OpenCode Agent for project-wide review or edits.
Use Ollama local fallback when you need long free sessions.
```

For real file editing, Codex is still the most reliable executor.
