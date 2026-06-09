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
- Lets you choose provider: Auto multi-AI, Cerebras, Gemini, Groq, OpenRouter, Ollama.
- Opens local Odysseus Chat from VS Code with the **Odysseus** button or command.
- Saves local request history and lets you view it from the panel.
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

## Auto Multi-AI Router

Auto mode now asks several configured providers one after another and shows all successful answers in one response:

```text
normal requests -> Cerebras, Gemini Fast, Groq, OpenRouter
offline / local / private / ollama -> Ollama, then Cerebras fallback
```

The gateway has one active model at a time, so Auto runs providers sequentially instead of switching them in parallel. If one provider fails or hits a free-tier limit, the panel still keeps the other provider answers.

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
- Type a prompt and press Send (or Ctrl/Cmd+Enter).

## Request History

- All requests and responses are automatically saved locally in VS Code
- History persists between sessions
- History is stored in a local `history.json` database in the extension storage folder
- Click **History** in the Free AI panel to view recent saved messages

Package & install a VSIX

From PowerShell inside the repository run:

```powershell
cd .\extension
npx @vscode/vsce package
```

This will create a `.vsix` file inside the `extension` folder (for example `extension/anuar-free-ai-console-0.1.5.vsix`). Install it with:

```powershell
code --install-extension .\extension\anuar-free-ai-console-0.1.5.vsix
```

Configuration

Set the gateway and token in your User or Workspace settings (Settings UI or `settings.json`):

```json
"freeAiConsole.gatewayUrl": "http://127.0.0.1:8082",
"freeAiConsole.authToken": "freecc",
"freeAiConsole.odysseusUrl": "http://127.0.0.1:7000",
"freeAiConsole.defaultProvider": "cerebras"
```

If you want me to install the generated VSIX now or launch the Extension Development Host for a quick interactive test, say which one and I'll proceed.

The scripts assume your keys are already configured inside your local `free-claude-code` setup.
