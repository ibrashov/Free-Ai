# Free AI VS Code Chat

Free AI VS Code Chat is a small local VS Code panel for using a `free-claude-code` gateway separately from Claude Code, Codex, and Copilot.

It was built for a simple workflow:

```text
Claude Code / Codex = real file editing
Free AI Chat = drafts, explanations, plans, small code snippets
```

The extension adds a separate **Free AI** icon to the VS Code Activity Bar. It sends chat prompts to a local gateway:

```text
http://127.0.0.1:8082
```

## What It Does

- Adds a separate **Free AI** panel inside VS Code.
- Lets you choose provider: Auto, Cerebras, Gemini, Groq, OpenRouter, Ollama.
- Uses `free-claude-code` as a local proxy.
- Keeps free AI chat separate from official Claude Code.
- Includes PowerShell scripts for testing providers and switching models.
- Avoids file editing tools by design.

## What It Does Not Do

This project does not try to replace Claude Code or Codex.

Free providers can be unstable with file-editing tools like `Read`, `Write`, and `Edit`, so this extension is designed for chat output only:

```text
good: explain, plan, draft, review pasted code
not good: directly edit project files
```

## Architecture

```text
VS Code Free AI panel
        |
        v
Local extension.js
        |
        v
free-claude-code gateway
        |
        v
Cerebras / Gemini / Groq / OpenRouter / Ollama
```

## Folder Structure

```text
extension/
  extension.js
  package.json
  media/free-ai.svg

scripts/
  Install-FreeAIExtension.ps1
  Ask-FreeAI.ps1
  Start-FreeAIConsole.ps1
  Set-GatewayModel.ps1
  Test-GatewayProviders.ps1
  Use-FreeClaudeGateway.ps1
  Use-OfficialClaudeCode.ps1

docs/
  FREE_AI_VSCODE_PANEL.md
  SEPARATE_CLAUDE_AND_FREE_AI.md
  API_PROVIDER_SWITCHING.md
```

## Requirements

- Windows
- VS Code
- PowerShell
- `free-claude-code` installed and running
- At least one configured provider key in `free-claude-code`

Recommended providers:

```text
Cerebras
Gemini
Groq
OpenRouter
Ollama
```

## Install The VS Code Panel

From this repository:

```powershell
.\scripts\Install-FreeAIExtension.ps1
```

Then restart VS Code or run:

```text
Ctrl+Shift+P
Developer: Reload Window
```

You should see a new **Free AI** icon in the VS Code Activity Bar.

## Start The Gateway

Run:

```powershell
fcc-server
```

If you see:

```text
WinError 10048
```

that usually means the server is already running on port `8082`. You do not need to start it twice.

Check health:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8082/health"
```

Expected:

```json
{"status":"healthy"}
```

## One-Shot Terminal Usage

```powershell
.\scripts\Ask-FreeAI.ps1 "Explain Flutter widgets simply" -Provider auto
```

## Interactive Terminal Console

```powershell
.\scripts\Start-FreeAIConsole.ps1
```

Inside the console:

```text
/provider cerebras
/provider gemini
/provider groq
/provider openrouter
/provider ollama
/exit
```

## Auto Router

The current Auto mode is intentionally conservative:

```text
normal requests -> Cerebras
offline / local / private / ollama -> Ollama
default -> Cerebras
```

Gemini, Groq, and OpenRouter are still available manually, but Auto avoids them by default because gateway/tool behavior can be less stable.

## Why This Exists

Official Claude Code is much better for real file editing. Free providers are useful, but they can fail with tool calls.

This project separates the responsibilities:

```text
Free AI = thinking, planning, explanations
Claude Code / Codex = real implementation
```

## Security

Do not commit API keys.

This repository should not contain:

```text
.env files
API key files
Claude/Gateway cache
local logs
```

The scripts assume your keys are already configured inside your local `free-claude-code` setup.

