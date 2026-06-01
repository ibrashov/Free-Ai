const vscode = require("vscode");

const PROVIDER_MODELS = {
  cerebras: "cerebras/gpt-oss-120b",
  gemini: "gemini/models/gemini-2.5-flash",
  "gemini-fast": "gemini/models/gemini-2.0-flash",
  groq: "groq/qwen/qwen3-32b",
  openrouter: "open_router/google/gemma-4-31b-it:free",
  ollama: "ollama/qwen2.5-coder:7b"
};

function activate(context) {
  const provider = new FreeAiViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("freeAiConsole.chatView", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freeAiConsole.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.freeAiConsole");
    })
  );
}

class FreeAiViewProvider {
  constructor(extensionUri, context) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.view = undefined;
    this.historyUri = vscode.Uri.joinPath(this.context.globalStorageUri, "history.json");
    this.history = [];
    this.historySave = Promise.resolve();
  }

  async loadHistory() {
    const fileHistory = await this.readHistoryFile();
    const legacyHistory = normalizeHistory(this.context.globalState.get("freeAi.history", []));
    this.history = mergeHistory(fileHistory, legacyHistory);

    if (this.history.length > fileHistory.length || legacyHistory.length > 0) {
      await this.saveHistory();
      await this.context.globalState.update("freeAi.history", undefined);
    }
  }

  async readHistoryFile() {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.historyUri);
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw);
      return normalizeHistory(parsed);
    } catch {
      return [];
    }
  }

  async saveHistory() {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const json = JSON.stringify(this.history, null, 2);
    await vscode.workspace.fs.writeFile(this.historyUri, Buffer.from(json, "utf8"));
  }

  addToHistory(role, text) {
    this.history.push({
      role: role,
      text: text,
      timestamp: new Date().toISOString()
    });
    this.queueSaveHistory();
  }

  queueSaveHistory() {
    this.historySave = this.historySave
      .then(() => this.saveHistory())
      .catch((error) => {
        console.error("Failed to save Free AI history", error);
      });
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ask") {
        await this.answer(message.prompt, message.provider);
      }
    });

    this.loadHistory().then(() => {
      webviewView.webview.html = this.getHtml(webviewView.webview);
    }).catch((error) => {
      this.history = [];
      webviewView.webview.html = this.getHtml(webviewView.webview);
      this.post({ type: "error", text: `Could not load history database: ${getErrorMessage(error)}` });
    });
  }

  

  async answer(prompt, provider) {
    if (!this.view) {
      return;
    }

    const text = String(prompt || "").trim();
    if (!text) {
      return;
    }

    this.addToHistory("user", text);

    this.post({ type: "status", text: "Thinking..." });

    try {
      const config = vscode.workspace.getConfiguration("freeAiConsole");
      const gatewayUrl = config.get("gatewayUrl", "http://127.0.0.1:8082").replace(/\/$/, "");
      const authToken = config.get("authToken", "freecc");
      const requestedProvider = provider || config.get("defaultProvider", "auto");
      const selectedProvider = selectProvider(text, requestedProvider);
      const selectedModel = PROVIDER_MODELS[selectedProvider] || PROVIDER_MODELS.cerebras;

      this.post({ type: "status", text: `Thinking with ${selectedProvider}...` });
      await applyGatewayModel(gatewayUrl, selectedModel);
      const answer = await askGateway(gatewayUrl, authToken, text);
      
      this.addToHistory("assistant", answer || "(empty response)");
      
      this.post({ type: "answer", text: answer || "(empty response)" });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.addToHistory("error", errorMsg);
      this.post({ type: "error", text: errorMsg });
    }
  }

  post(message) {
    this.view.webview.postMessage(message);
  }

  getHtml(webview) {
    const nonce = getNonce();
    const defaultProvider = vscode.workspace
      .getConfiguration("freeAiConsole")
      .get("defaultProvider", "cerebras");
    const initialHistory = safeJsonForHtml(this.history);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Free AI Console</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .toolbar-left {
      flex: 1;
      min-width: 0;
    }
    select, textarea, button {
      font: inherit;
    }
    select {
      width: 100%;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 6px;
    }
    textarea {
      width: 100%;
      min-height: 92px;
      box-sizing: border-box;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      padding: 8px;
    }
    button {
      padding: 8px 12px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #send {
      width: 100%;
      margin-top: 8px;
    }
    #history {
      flex-shrink: 0;
    }
    .messages {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      white-space: pre-wrap;
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      background: var(--vscode-editor-background);
    }
    .user {
      border-left: 3px solid var(--vscode-textLink-foreground);
    }
    .ai {
      border-left: 3px solid var(--vscode-charts-green);
    }
    .assistant {
      border-left: 3px solid var(--vscode-charts-green);
    }
    .error {
      border-left: 3px solid var(--vscode-errorForeground);
    }
    .status {
      opacity: 0.8;
    }
    .empty-history {
      opacity: 0.75;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <select id="provider" aria-label="Provider">
        ${providerOption("auto", "Auto", defaultProvider)}
        ${providerOption("cerebras", "Cerebras", defaultProvider)}
        ${providerOption("gemini", "Gemini", defaultProvider)}
        ${providerOption("gemini-fast", "Gemini Fast", defaultProvider)}
        ${providerOption("groq", "Groq", defaultProvider)}
        ${providerOption("openrouter", "OpenRouter", defaultProvider)}
        ${providerOption("ollama", "Ollama", defaultProvider)}
      </select>
    </div>
    <button id="history" title="Show local request history">History</button>
  </div>
  <textarea id="prompt" placeholder="Ask Free AI. Type your question here."></textarea>
  <button id="send">Send</button>
  <div id="messages" class="messages"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const providerEl = document.getElementById("provider");
    const messagesEl = document.getElementById("messages");
    const sendEl = document.getElementById("send");
    const historyEl = document.getElementById("history");
    let historyEntries = ${initialHistory};
    let showingHistory = false;
    
    historyEl.addEventListener("click", toggleHistory);
    sendEl.addEventListener("click", send);
    promptEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        send();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "status") {
        setStatus(message.text);
      }
      if (message.type === "answer") {
        clearStatus();
        addMessage("ai", message.text);
        remember("assistant", message.text);
        sendEl.disabled = false;
      }
      if (message.type === "error") {
        clearStatus();
        addMessage("error", message.text);
        remember("error", message.text);
        sendEl.disabled = false;
      }
      
    });
    

    function send() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;

      addMessage("user", prompt);
      remember("user", prompt);

      setStatus("Thinking...");
      sendEl.disabled = true;
      vscode.postMessage({
        type: "ask",
        prompt,
        provider: providerEl.value
      });
      promptEl.value = "";
    }

    function remember(role, text) {
      historyEntries.push({
        role,
        text,
        timestamp: new Date().toISOString()
      });
    }

    function toggleHistory() {
      showingHistory = !showingHistory;
      historyEl.textContent = showingHistory ? "Chat" : "History";
      messagesEl.textContent = "";

      if (!showingHistory) {
        return;
      }

      const entries = historyEntries.slice(-80).reverse();
      if (entries.length === 0) {
        addMessage("status empty-history", "No saved history yet.");
        return;
      }

      entries.forEach((entry) => {
        const stamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
        const label = entry.role === "user" ? "You" : entry.role === "assistant" ? "Free AI" : "Error";
        addMessage(entry.role === "assistant" ? "ai" : entry.role, stamp ? label + " - " + stamp + "\\n" + entry.text : label + "\\n" + entry.text);
      });
    }

    function addMessage(kind, text) {
      const item = document.createElement("div");
      item.className = "msg " + kind;
      item.textContent = text;
      messagesEl.prepend(item);
    }

    function setStatus(text) {
      clearStatus();
      const item = document.createElement("div");
      item.className = "msg status";
      item.id = "status";
      item.textContent = text;
      messagesEl.prepend(item);
    }

    function clearStatus() {
      const old = document.getElementById("status");
      if (old) old.remove();
    }
  </script>
</body>
</html>`;
  }
}

function providerOption(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && entry.role && typeof entry.text === "string")
    .map((entry) => ({
      role: String(entry.role),
      text: entry.text,
      timestamp: entry.timestamp || new Date().toISOString()
    }));
}

function mergeHistory(primary, secondary) {
  const seen = new Set();
  const merged = [];

  for (const entry of [...normalizeHistory(primary), ...normalizeHistory(secondary)]) {
    const key = `${entry.role}\u0000${entry.timestamp}\u0000${entry.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }

  return merged.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function applyGatewayModel(gatewayUrl, model) {
  const payload = {
    values: {
      MODEL: model,
      MODEL_OPUS: "",
      MODEL_SONNET: "",
      MODEL_HAIKU: "",
      ENABLE_MODEL_THINKING: "false",
      PROVIDER_RATE_LIMIT: "1",
      PROVIDER_RATE_WINDOW: "10"
    }
  };

  const response = await fetch(`${gatewayUrl}/admin/api/config/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Could not switch model: HTTP ${response.status}`);
  }
}

function selectProvider(prompt, requestedProvider) {
  if (requestedProvider && requestedProvider !== "auto") {
    return requestedProvider;
  }

  const lower = String(prompt || "").toLowerCase();

  if (/(offline|local|private|privacy|ollama|локально|офлайн|приват)/i.test(lower)) {
    return "ollama";
  }

  return "cerebras";
}

async function askGateway(gatewayUrl, authToken, prompt) {
  const systemPrompt = `You are the user's separate Free AI assistant.

Important rules:
- Do not call tools.
- Do not pretend that you edited files.
- Do not output fake Write/Edit/Read JSON.
- If the user asks for code, write code in the chat.
- If the user asks for architecture, answer in Markdown.`;

  const response = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1400,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: String(prompt || "")
      }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Gateway request failed: HTTP ${response.status}`);
  }

  const raw = await response.text();
  return parseSseText(raw);
}

function parseSseText(raw) {
  let output = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const jsonText = trimmed.slice(5).trim();
    if (!jsonText || jsonText === "[DONE]") {
      continue;
    }
    try {
      const event = JSON.parse(jsonText);
      const text = event && event.delta && event.delta.text;
      if (event.type === "content_block_delta" && text) {
        output += text;
      }
    } catch {
      // Ignore malformed stream lines.
    }
  }
  return output.trim();
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }
  if (error.message) {
    return error.message;
  }
  return String(error);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
