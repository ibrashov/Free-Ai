# Development Notes

This project was created from a local experiment that separated free AI providers from official Claude Code.

## Main Problem

Using free providers directly inside Claude Code can be unstable:

```text
Ollama can output fake Write/Edit JSON.
Gemini can fail on tool_calls through the gateway.
Groq can return empty or unstable tool responses depending on model.
Cerebras is currently the most stable default for chat-style responses.
```

## Design Decision

The VS Code panel deliberately tells the model:

```text
Do not call tools.
Do not pretend that you edited files.
Do not output fake Write/Edit/Read JSON.
If the user asks for code, write code in the chat.
```

This keeps the free AI useful for planning while avoiding unsafe file editing.

## Important Files

`extension/extension.js`

Contains:

```text
VS Code WebViewViewProvider
provider selector
Auto Router
gateway model switching
SSE response parsing
chat UI HTML/CSS/JS
Odysseus Chat launcher
```

`scripts/Set-GatewayModel.ps1`

Switches the active gateway model.

`scripts/Ask-FreeAI.ps1`

Sends one prompt to the gateway from PowerShell.

`scripts/Install-FreeAIExtension.ps1`

Copies the extension into:

```text
%USERPROFILE%\.vscode\extensions\anuar-free-ai-console-0.1.3
```

Current version path:

```text
%USERPROFILE%\.vscode\extensions\anuar-free-ai-console-0.2.0
```
