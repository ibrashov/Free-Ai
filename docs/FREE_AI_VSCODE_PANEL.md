# Free AI VS Code Panel

This is a small local VS Code extension that adds a separate `Free AI` panel.

It uses:

```text
http://127.0.0.1:8082
```

So it needs `free-claude-code` server running.

## Install

From the Flutter workspace:

```powershell
.\\scripts\\Install-FreeAIExtension.ps1
```

Then restart VS Code.

## Use

Open the `Free AI` icon in the VS Code Activity Bar.

The panel is separate from:

```text
Claude Code
Codex
Copilot
```

It is for:

```text
plans
briefs
explanations
draft code
architecture ideas
```

It should not be used for real file editing.

## Providers

The panel can switch:

```text
Cerebras
Gemini
Gemini Fast
Groq
OpenRouter
Ollama
```

Recommended default:

```text
Auto
```

## Auto Provider Router

`Auto` chooses a provider from the request:

```text
normal requests -> Cerebras
compare -> Cerebras / Groq / OpenRouter
offline / private / local -> Ollama
default -> Cerebras
```

Gemini and Gemini Fast are still available as manual choices, but Auto avoids them to preserve their small free quota. Groq and OpenRouter remain Auto fallbacks.
