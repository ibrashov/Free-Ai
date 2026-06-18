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
- Lets you choose provider: Auto, OpenCode Agent, Cerebras, Gemini, Groq, OpenRouter, Ollama.
- Uses quota-aware routing with cooldowns and local Ollama fallback.
- Starts the local `free-claude-code` gateway automatically when the panel opens.
- Shows gateway health and manual Start/Check controls inside the Free AI panel.
- Opens local Odysseus Chat from VS Code with the **Odysseus** button or command.
- Saves separate local chat sessions and lets you reopen and continue them.
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

Odysseus Chat can run next to it:

VS Code command / Free AI button
        |
        v
Odysseus local UI
http://127.0.0.1:7000
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
- `free-claude-code` installed and available as `fcc-server`
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

## Open Odysseus Chat In VS Code

If Odysseus is running locally, use either:

```text
Free AI panel -> Odysseus
Ctrl+Shift+P -> Free AI: Open Odysseus Chat
```

Default URL:

```text
http://127.0.0.1:7000
```

Change it in VS Code settings if your Odysseus server uses another address:

```json
"freeAiConsole.odysseusUrl": "http://127.0.0.1:7000"
```

## Start The Gateway

Normally you do not need to open the gateway admin page or start the server manually. When the **Free AI** panel opens, the extension checks:

```text
http://127.0.0.1:8082/health
```

If the gateway is not running, it starts:

```powershell
fcc-server
```

The panel also has **Start** and **Check** buttons for the gateway.

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

You can change or disable the automatic startup in VS Code settings:

```json
"freeAiConsole.autoStartGateway": true,
"freeAiConsole.gatewayCommand": "fcc-server",
"freeAiConsole.gatewayStartupTimeoutSeconds": 20
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
/provider gemma
/provider ollama
/exit
```

## Auto Router

Auto mode is quota-aware and keeps Gemini out of automatic routing:

```text
balanced simple requests -> Cerebras/Groq/OpenRouter candidate, then Ollama fallback
compare mode -> several non-Gemini cloud providers
project / file editing / codebase review requests -> OpenCode Agent
gemma -> Gemma Local
offline / local / private / ollama -> Ollama
survival mode -> Gemma Local first
```

Gemini and Gemini Fast remain available as manual choices, but Auto avoids them to preserve their small free quota. If a provider returns quota/rate-limit errors, Free AI Console puts it in cooldown and avoids it temporarily. The gateway has one active model at a time, so compare mode runs providers sequentially.

OpenCode Agent is available as a separate provider and is also selected automatically for requests that ask to check the project, edit files, fix code, or refactor. If OpenCode's cloud/gateway model is rate-limited, it can retry through local Ollama.

## Provider Tools

Command Palette:

```text
Free AI: Refresh Free Models
Free AI: Test Providers
Free AI: Open Provider Status
```

The refresh command stores discovered model candidates locally in VS Code extension storage. Candidates are not enabled automatically.

The provider test command uses gateway admin provider checks for cloud providers instead of sending a generated chat response, so it is much less likely to burn Gemini/Groq/Cerebras quota.

Local provider calls use the Ollama HTTP API and stop after `freeAiConsole.requestTimeoutSeconds` (120 seconds by default). They do not silently pull missing models. If Gemma is installed in `C:\OllamaModels` but the active server does not list it, restart Ollama with:

```powershell
.\scripts\Repair-OllamaLocalModels.ps1 -Model gemma3:4b
```

## Free Limits And Local Survival

For the current no-card strategy, provider limits, and the Ollama repair workflow, see:

```text
docs/FREE_LIMITS_AND_LOCAL_SURVIVAL.md
```

## OpenCode Gateway Experiment

This repo includes an experimental OpenCode config template:

```text
opencode.gateway.example.json
```

It points OpenCode's Anthropic provider `baseURL` at the local `free-claude-code` gateway:

```text
http://127.0.0.1:8082
```

After installing OpenCode, copy the template to `opencode.json`, run `opencode`, then use `/connect` for Anthropic and try `freecc` as the local gateway key. This depends on how OpenCode sends Anthropic auth headers, so treat it as a compatibility test rather than a guaranteed production setup.

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

## Quick start — Run & Package

- Run in debugger (recommended):

- Open this workspace in VS Code.
- Press `F5` to launch the Extension Development Host.
- In the new host window open the Free AI view from the activity bar or run the command `Free AI: Open Chat`.
- Type a prompt and press Send, or press Enter. Use Shift+Enter for a new line.

## Request History

- Every conversation is saved as a separate chat.
- Use **Chats** to reopen an earlier conversation and **New chat** to start a clean one.
- The first request becomes the chat title automatically.
- Reopened chats include recent messages as model context, so follow-up requests remember the conversation.
- Chats persist between VS Code sessions in `chats.json` inside the extension storage folder.
- Existing flat `history.json` data is migrated into an **Imported chat history** conversation.

Chat context is intentionally bounded to recent messages so a long conversation does not grow every request without limit. This is conversation memory only; long-term Odysseus-style memory is a separate future layer.

Package & install a VSIX

From PowerShell inside the repository run:

```powershell
cd .\extension
npx @vscode/vsce package
```

This will create a `.vsix` file inside the `extension` folder (for example `extension/anuar-free-ai-console-0.2.0.vsix`). Install it with:

```powershell
code --install-extension .\extension\anuar-free-ai-console-0.2.0.vsix
```

Configuration

Set the gateway and token in your User or Workspace settings (Settings UI or `settings.json`):

```json
"freeAiConsole.gatewayUrl": "http://127.0.0.1:8082",
"freeAiConsole.authToken": "freecc",
"freeAiConsole.autoStartGateway": true,
"freeAiConsole.gatewayCommand": "fcc-server",
"freeAiConsole.odysseusUrl": "http://127.0.0.1:7000",
"freeAiConsole.defaultProvider": "auto",
"freeAiConsole.autoMode": "balanced",
"freeAiConsole.freePolicy": "no-card",
"freeAiConsole.openCodeFallbackToOllama": true,
"freeAiConsole.providerCooldownMinutes": 10,
"freeAiConsole.localCoderModel": "ollama/qwen2.5-coder:3b"
```

If you want me to install the generated VSIX now or launch the Extension Development Host for a quick interactive test, say which one and I'll proceed.

The scripts assume your keys are already configured inside your local `free-claude-code` setup.

## Direction

The intended direction is an installable local app or site-like UI:

```text
Free AI Chat UI
        |
        v
local gateway managed in the background
        |
        v
user-owned provider keys and local models
```

Each user should enter and own their own API keys locally. The project should avoid shipping shared keys, committing keys, or depending on one developer's gateway configuration.
