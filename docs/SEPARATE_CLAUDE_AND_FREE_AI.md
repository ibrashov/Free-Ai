# Separate Claude Code And Free AI

The clean setup is:

```text
Claude Code = real file editing, project changes, commands, tests
Free AI Console = ideas, explanations, architecture, drafts, small code snippets
Codex = reliable implementation assistant
```

## Why Separate Them

`free-claude-code` can answer normal chat prompts, but many free providers are weak with Claude Code tools like `Read`, `Write`, and `Edit`.

When we keep it separate, it becomes useful instead of unstable:

```text
Free AI thinks and drafts.
Claude Code or Codex edits files.
```

## Use Free AI Console

Open a VS Code terminal in this workspace and run:

```powershell
.\\scripts\\Start-FreeAIConsole.ps1
```

Recommended provider:

```powershell
.\\scripts\\Start-FreeAIConsole.ps1 -Provider cerebras
```

One quick request:

```powershell
.\\scripts\\Ask-FreeAI.ps1 "Explain Flutter widgets simply" -Provider cerebras
```

Switch provider inside console:

```text
/provider gemini
/provider groq
/provider openrouter
/provider ollama
```

Close console:

```text
/exit
```

## Use Official Claude Code Separately

Run this once:

```powershell
.\\scripts\\Use-OfficialClaudeCode.ps1
```

Then restart VS Code and log in to Claude Code normally.

This removes these gateway variables from VS Code settings:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
```

## Restore Free Gateway In Claude Code

If you ever want Claude Code extension to use the free gateway again:

```powershell
.\\scripts\\Use-FreeClaudeGateway.ps1
```

Then restart VS Code.

## Daily Workflow

Use Free AI Console:

```text
Make a project brief for this Flutter app idea.
Explain this error.
Give me 3 architecture options.
Write a draft widget example, but do not edit files.
```

Use Claude Code or Codex:

```text
Read this Flutter project and implement the home screen.
Fix this error in main.dart.
Run flutter analyze and fix issues.
```

