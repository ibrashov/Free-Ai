const vscode = require("vscode");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const providerCatalog = require("./provider-catalog.json");

const execFileAsync = promisify(execFile);

const OPENCODE_PROVIDER = "opencode";
const OPENCODE_MODEL = "anthropic/claude-sonnet-4-0";
const DEFAULT_LOCAL_CODER_MODEL = "ollama/qwen2.5-coder:3b";
const PROVIDER_STATE_KEY = "freeAi.providerState";
const DISCOVERY_FILE = "provider-candidates.json";

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

  context.subscriptions.push(
    vscode.commands.registerCommand("freeAiConsole.refreshFreeModels", async () => {
      await provider.refreshFreeModels();
    }),
    vscode.commands.registerCommand("freeAiConsole.testProviders", async () => {
      await provider.testProviders();
    }),
    vscode.commands.registerCommand("freeAiConsole.openProviderStatus", async () => {
      await provider.openProviderStatus();
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
    this.pendingEdits = new Map();
    this.providerState = normalizeProviderState(this.context.globalState.get(PROVIDER_STATE_KEY, {}));
    this.discoveryUri = vscode.Uri.joinPath(this.context.globalStorageUri, DISCOVERY_FILE);
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
        await this.answer(message.prompt, message.provider, message.displayPrompt, message.attachedFiles);
      }
      if (message.type === "pickFiles") {
        await this.pickFilesForPrompt();
      }
      if (message.type === "applyEdit") {
        await this.applyPendingEdit(message.editId);
      }
      if (message.type === "refreshModels") {
        await this.refreshFreeModels();
      }
      if (message.type === "testProviders") {
        await this.testProviders();
      }
      if (message.type === "showProviderStatus") {
        await this.openProviderStatus();
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

  

  async answer(prompt, provider, displayPrompt, attachedFiles) {
    if (!this.view) {
      return;
    }

    let text = String(prompt || "").trim();
    if (!text) {
      return;
    }

    const routeText = text;
    let userDisplay = String(displayPrompt || text).trim();
    let editSourceFiles = Array.isArray(attachedFiles) ? [...attachedFiles] : [];

    const referencedFiles = await this.resolveWorkspaceFileReferences(text);
    const hasReferencedFiles = referencedFiles.length > 0 || editSourceFiles.length > 0;
    if (referencedFiles.length > 0) {
      text = appendFilesToPrompt(text, referencedFiles);
      editSourceFiles = editSourceFiles.concat(referencedFiles.map((file) => ({
        name: file.name,
        path: file.path
      })));
      userDisplay += "\n\nAuto-read files:\n" + referencedFiles.map((file) => `- ${file.name}${file.truncated ? " (truncated)" : ""}`).join("\n");
    }

    this.addToHistory("user", userDisplay);

    this.post({ type: "status", text: "Thinking..." });

    try {
      const config = this.getConfig();
      const requestedProvider = provider || config.defaultProvider;
      const route = selectRoute({
        prompt: routeText,
        requestedProvider,
        autoMode: config.autoMode,
        catalog: this.getCatalog(config),
        providerState: this.providerState,
        hasReferencedFiles
      });
      const results = [];
      this.postProviderStatus({
        mode: route.mode,
        reason: route.reason,
        providers: route.providers.map((item) => item.label)
      });

      for (const selectedProvider of route.providers) {
        this.post({ type: "status", text: `${route.mode}: ${selectedProvider.label} (${route.reason})...` });

        try {
          const answer = selectedProvider.id === OPENCODE_PROVIDER
            ? await askOpenCode({
              command: config.openCodeCommand,
              model: config.openCodeModel,
              localModel: config.localCoderModel,
              authToken: config.authToken,
              prompt: text,
              fallbackToOllama: config.openCodeFallbackToOllama
            })
            : await askFreeProvider(config.gatewayUrl, config.authToken, selectedProvider, text, config.localCoderModel);
          if (!String(answer || "").trim()) {
            throw new Error("empty response");
          }
          await this.markProviderReady(selectedProvider.id);
          results.push({ provider: selectedProvider.id, answer: answer || "" });
          if (!route.compare) {
            break;
          }
        } catch (error) {
          await this.markProviderFailure(selectedProvider.id, error, config.providerCooldownMinutes);
          results.push({ provider: selectedProvider.id, error: getErrorMessage(error) });
        }
      }

      const successful = results.filter((result) => result.answer);
      if (successful.length === 0) {
        const errors = results.map((result) => `${result.provider}: ${result.error || "empty response"}`).join("\n");
        throw new Error(`All selected providers failed:\n${errors}`);
      }

      const edits = this.extractFirstAllowedEdits(successful, editSourceFiles);
      const visibleAnswer = formatProviderResults(results);
      
      this.addToHistory("assistant", visibleAnswer);
      
      this.post({ type: "answer", text: visibleAnswer, edits });
      this.postProviderStatus();
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.addToHistory("error", errorMsg);
      this.post({ type: "error", text: errorMsg });
    }
  }

  post(message) {
    this.view.webview.postMessage(message);
  }

  getConfig() {
    const config = vscode.workspace.getConfiguration("freeAiConsole");
    return {
      gatewayUrl: config.get("gatewayUrl", "http://127.0.0.1:8082").replace(/\/$/, ""),
      authToken: config.get("authToken", "freecc"),
      defaultProvider: config.get("defaultProvider", "auto"),
      autoMode: config.get("autoMode", "balanced"),
      freePolicy: config.get("freePolicy", "no-card"),
      openCodeCommand: config.get("openCodeCommand", getDefaultOpenCodeCommand()),
      openCodeModel: config.get("openCodeModel", OPENCODE_MODEL),
      openCodeFallbackToOllama: config.get("openCodeFallbackToOllama", true),
      providerCooldownMinutes: config.get("providerCooldownMinutes", 10),
      localCoderModel: config.get("localCoderModel", DEFAULT_LOCAL_CODER_MODEL)
    };
  }

  getCatalog(config = this.getConfig()) {
    return buildProviderCatalog(config);
  }

  async saveProviderState() {
    await this.context.globalState.update(PROVIDER_STATE_KEY, this.providerState);
  }

  async markProviderReady(providerId) {
    const current = this.providerState[providerId] || {};
    this.providerState[providerId] = {
      ...current,
      status: providerId === "ollama" ? "Local" : "Ready",
      lastError: "",
      cooldownUntil: 0,
      updatedAt: new Date().toISOString()
    };
    await this.saveProviderState();
  }

  async markProviderFailure(providerId, error, cooldownMinutes) {
    const message = getErrorMessage(error);
    const rateLimited = isQuotaOrRateLimitError(message);
    const minutes = Math.max(1, Number(cooldownMinutes || 10));
    const cooldownUntil = Date.now() + minutes * 60 * 1000;
    this.providerState[providerId] = {
      status: rateLimited ? "Rate limited" : "Cooling down",
      lastError: message,
      cooldownUntil,
      updatedAt: new Date().toISOString()
    };
    await this.saveProviderState();
  }

  getProviderStatusLines(config = this.getConfig()) {
    return this.getCatalog(config).map((provider) => {
      const state = getProviderRuntimeState(provider, this.providerState);
      const model = provider.id === "ollama" ? config.localCoderModel : provider.model;
      const until = state.cooldownUntil > Date.now()
        ? ` until ${new Date(state.cooldownUntil).toLocaleTimeString()}`
        : "";
      const detail = state.lastError ? ` - ${state.lastError}` : "";
      return `${provider.label}: ${state.status}${until} (${provider.role}, ${model})${detail}`;
    });
  }

  postProviderStatus(route) {
    if (!this.view) {
      return;
    }
    this.post({
      type: "providerStatus",
      route,
      providers: this.getProviderStatusLines()
    });
  }

  async openProviderStatus() {
    const content = [
      "# Free AI Provider Status",
      "",
      ...this.getProviderStatusLines().map((line) => `- ${line}`)
    ].join("\n");
    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
    this.postProviderStatus();
  }

  async testProviders() {
    const config = this.getConfig();
    const catalog = this.getCatalog(config).filter((provider) => provider.enabled);
    const results = [];
    this.post({ type: "status", text: "Testing Free AI providers..." });

    for (const provider of catalog) {
      try {
        const answer = provider.id === OPENCODE_PROVIDER
          ? await askOpenCode({
            command: config.openCodeCommand,
            model: config.openCodeModel,
            localModel: config.localCoderModel,
            authToken: config.authToken,
            prompt: "Reply with exactly OK.",
            fallbackToOllama: config.openCodeFallbackToOllama
          })
          : await askFreeProvider(config.gatewayUrl, config.authToken, provider, "Reply with exactly OK.", config.localCoderModel, 40);
        await this.markProviderReady(provider.id);
        results.push(`${provider.label}: OK${answer ? ` - ${String(answer).slice(0, 80)}` : ""}`);
      } catch (error) {
        await this.markProviderFailure(provider.id, error, config.providerCooldownMinutes);
        results.push(`${provider.label}: ${getErrorMessage(error)}`);
      }
    }

    const text = results.join("\n");
    this.post({ type: "answer", text: `Provider test results:\n${text}`, edits: [] });
    this.postProviderStatus();
  }

  async refreshFreeModels() {
    const config = this.getConfig();
    this.post({ type: "status", text: "Refreshing free model candidates..." });
    const result = await discoverFreeModelCandidates(config);
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.discoveryUri, Buffer.from(JSON.stringify(result, null, 2), "utf8"));
    const text = `Found ${result.candidates.length} candidate model(s). Stored locally as ${DISCOVERY_FILE}. Candidates are not enabled until tested.`;
    vscode.window.showInformationMessage(text);
    this.post({ type: "answer", text, edits: [] });
  }

  async pickFilesForPrompt() {
    if (!this.view) {
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add file",
      filters: {
        "Text/code files": ["txt", "md", "js", "ts", "jsx", "tsx", "dart", "py", "java", "kt", "html", "css", "json", "yaml", "yml", "xml", "csv", "log", "sql"],
        "All files": ["*"]
      }
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const maxFiles = 5;
    const maxCharsPerFile = 50000;
    const files = [];

    for (const uri of uris.slice(0, maxFiles)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString("utf8");
        const text = raw.length > maxCharsPerFile ? raw.slice(0, maxCharsPerFile) : raw;
        files.push({
          name: uri.path.split(/[\\/]/).pop() || "file",
          path: uri.fsPath,
          size: bytes.byteLength,
          text,
          truncated: raw.length > maxCharsPerFile
        });
      } catch (error) {
        this.post({ type: "error", text: `Could not read file: ${getErrorMessage(error)}` });
      }
    }

    if (files.length > 0) {
      this.post({ type: "filesPicked", files });
    }
  }

  async resolveWorkspaceFileReferences(prompt) {
    const refs = extractWorkspaceFileReferences(prompt);
    if (refs.length === 0 || !vscode.workspace.workspaceFolders?.length) {
      return [];
    }

    const files = [];
    const seen = new Set();
    const maxFiles = 5;
    const maxCharsPerFile = 50000;

    for (const ref of refs) {
      if (files.length >= maxFiles) {
        break;
      }

      const uri = await findWorkspaceFile(ref);
      if (!uri || seen.has(uri.fsPath)) {
        continue;
      }
      seen.add(uri.fsPath);

      if (isUnsafeFilePath(uri.fsPath)) {
        this.post({ type: "status", text: `Skipped protected file reference: ${ref}` });
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString("utf8");
        if (raw.includes("\u0000")) {
          this.post({ type: "status", text: `Skipped binary file reference: ${ref}` });
          continue;
        }
        const text = raw.length > maxCharsPerFile ? raw.slice(0, maxCharsPerFile) : raw;
        files.push({
          name: path.basename(uri.fsPath),
          path: uri.fsPath,
          size: bytes.byteLength,
          text,
          truncated: raw.length > maxCharsPerFile
        });
      } catch (error) {
        this.post({ type: "error", text: `Could not read @${ref}: ${getErrorMessage(error)}` });
      }
    }

    return files;
  }

  extractAllowedEdits(answer, attachedFiles) {
    const allowed = new Map();
    for (const file of attachedFiles || []) {
      if (file && file.path) {
        allowed.set(normalizeFsPath(file.path), file);
      }
    }

    const rawEdits = extractFileEditBlocks(answer);
    const edits = [];
    for (const edit of rawEdits) {
      const normalized = normalizeFsPath(edit.path);
      if (!normalized || !allowed.has(normalized) || typeof edit.content !== "string") {
        continue;
      }
      const original = allowed.get(normalized);
      edits.push({
        path: original.path,
        name: original.name || edit.path,
        content: edit.content
      });
    }

    if (edits.length === 0) {
      return [];
    }

    const editId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.pendingEdits.set(editId, edits);
    return edits.map((edit, index) => ({
      editId,
      index,
      name: edit.name,
      path: edit.path,
      size: Buffer.byteLength(edit.content, "utf8")
    }));
  }

  extractFirstAllowedEdits(results, attachedFiles) {
    for (const result of results) {
      const edits = this.extractAllowedEdits(result.answer || "", attachedFiles);
      if (edits.length > 0) {
        return edits;
      }
    }
    return [];
  }

  async applyPendingEdit(editId) {
    const edits = this.pendingEdits.get(editId);
    if (!edits || edits.length === 0) {
      this.post({ type: "error", text: "No pending edit found. Ask Free AI to generate the edit again." });
      return;
    }

    const names = edits.map((edit) => edit.name || edit.path).join(", ");
    const choice = await vscode.window.showWarningMessage(
      `Apply Free AI edit to ${edits.length} file(s)? ${names}`,
      { modal: true },
      "Apply"
    );
    if (choice !== "Apply") {
      this.post({ type: "status", text: "Edit was not applied." });
      return;
    }

    try {
      for (const edit of edits) {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(edit.path), Buffer.from(edit.content, "utf8"));
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.path));
        await vscode.window.showTextDocument(doc, { preview: false });
      }
      this.pendingEdits.delete(editId);
      this.post({ type: "editApplied", text: `Applied edit to ${edits.length} file(s).` });
    } catch (error) {
      this.post({ type: "error", text: `Could not apply edit: ${getErrorMessage(error)}` });
    }
  }

  getHtml(webview) {
    const nonce = getNonce();
    const defaultProvider = vscode.workspace
      .getConfiguration("freeAiConsole")
      .get("defaultProvider", "auto");
    const initialHistory = safeJsonForHtml(this.history);
    const initialProviders = safeJsonForHtml(this.getProviderStatusLines());

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
    .prompt-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .prompt-actions button {
      flex: 1;
    }
    #send {
      flex: 2;
      margin-top: 0;
    }
    .attached-files {
      display: none;
      margin-top: 8px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    .attached-files.visible {
      display: block;
    }
    .route-panel {
      margin: 0 0 10px 0;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    .route-line {
      margin-bottom: 6px;
      opacity: 0.9;
    }
    .provider-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 90px;
      overflow: auto;
      opacity: 0.85;
    }
    .utility-actions {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 10px;
    }
    .utility-actions button {
      padding: 6px 8px;
      font-size: 12px;
    }
    .file-chip {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .file-chip:last-child {
      border-bottom: 0;
    }
    .file-remove {
      padding: 0 6px;
      background: transparent;
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-panel-border);
    }
    #history,
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
    .edit-actions {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .edit-list {
      margin: 0 0 8px 0;
      padding-left: 18px;
      opacity: 0.85;
    }
    .apply-edit {
      width: 100%;
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
        ${providerOption("auto", "Auto - multi AI", defaultProvider)}
        ${providerOption("opencode", "OpenCode Agent", defaultProvider)}
        ${providerOption("cerebras", "Cerebras", defaultProvider)}
        ${providerOption("gemini", "Gemini", defaultProvider)}
        ${providerOption("gemini-fast", "Gemini Fast", defaultProvider)}
        ${providerOption("groq", "Groq", defaultProvider)}
        ${providerOption("openrouter", "OpenRouter", defaultProvider)}
        ${providerOption("ollama", "Ollama", defaultProvider)}
      </select>
    </div>
  </div>
  <div class="route-panel">
    <div id="route-line" class="route-line">Mode: Ready</div>
    <div id="provider-list" class="provider-list"></div>
  </div>
  <div class="utility-actions">
    <button id="status-providers" title="Open provider status">Status</button>
    <button id="test-providers" title="Test configured providers">Test</button>
    <button id="refresh-models" title="Refresh free model candidates">Refresh</button>
  </div>
  <textarea id="prompt" placeholder="Ask Free AI. Type your question here."></textarea>
  <div id="attached-files" class="attached-files"></div>
  <div class="prompt-actions">
    <button id="add-file" title="Attach text/code files so Free AI can read them">Add file</button>
    <button id="send">Send</button>
  </div>
  <div id="messages" class="messages"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const providerEl = document.getElementById("provider");
    const messagesEl = document.getElementById("messages");
    const sendEl = document.getElementById("send");
    const historyEl = document.getElementById("history");
    const addFileEl = document.getElementById("add-file");
    const attachedFilesEl = document.getElementById("attached-files");
    const routeLineEl = document.getElementById("route-line");
    const providerListEl = document.getElementById("provider-list");
    const statusProvidersEl = document.getElementById("status-providers");
    const testProvidersEl = document.getElementById("test-providers");
    const refreshModelsEl = document.getElementById("refresh-models");
    let historyEntries = ${initialHistory};
    let providerStatusEntries = ${initialProviders};
    let showingHistory = false;
    let attachedFiles = [];
    
    if (historyEl) {
      historyEl.addEventListener("click", toggleHistory);
    }
    addFileEl.addEventListener("click", () => {
      vscode.postMessage({ type: "pickFiles" });
    });
    statusProvidersEl.addEventListener("click", () => {
      vscode.postMessage({ type: "showProviderStatus" });
    });
    testProvidersEl.addEventListener("click", () => {
      vscode.postMessage({ type: "testProviders" });
    });
    refreshModelsEl.addEventListener("click", () => {
      vscode.postMessage({ type: "refreshModels" });
    });
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
        const item = addMessage("ai", message.text);
        if (message.edits && message.edits.length) {
          attachEditActions(item, message.edits);
        }
        remember("assistant", message.text);
        sendEl.disabled = false;
      }
      if (message.type === "error") {
        clearStatus();
        addMessage("error", message.text);
        remember("error", message.text);
        sendEl.disabled = false;
      }
      if (message.type === "filesPicked") {
        attachedFiles = attachedFiles.concat(message.files || []);
        renderAttachedFiles();
      }
      if (message.type === "editApplied") {
        clearStatus();
        addMessage("status", message.text);
      }
      if (message.type === "providerStatus") {
        providerStatusEntries = message.providers || providerStatusEntries;
        renderProviderStatus(message.route);
      }
      
    });
    renderProviderStatus();
    

    function send() {
      const basePrompt = promptEl.value.trim();
      if (!basePrompt && attachedFiles.length === 0) return;
      const prompt = buildPromptWithFiles(basePrompt);
      const displayPrompt = buildDisplayPrompt(basePrompt);

      addMessage("user", displayPrompt);
      remember("user", displayPrompt);

      setStatus("Thinking...");
      sendEl.disabled = true;
      vscode.postMessage({
        type: "ask",
        prompt,
        displayPrompt,
        attachedFiles: attachedFiles.map(file => ({ name: file.name, path: file.path })),
        provider: providerEl.value
      });
      promptEl.value = "";
      attachedFiles = [];
      renderAttachedFiles();
    }

    function buildPromptWithFiles(basePrompt) {
      if (attachedFiles.length === 0) {
        return basePrompt;
      }

      const parts = [basePrompt || "Read the attached file(s) and help me with them."];
      parts.push("\\nIf I ask you to edit an attached file, return the COMPLETE replacement content for each edited file inside exactly one block like this:");
      parts.push("<free_ai_file_edits><file path=\\"exact attached file path\\">complete new file content</file></free_ai_file_edits>");
      parts.push("Only use paths from the attached files. Do not say the edit was applied; VS Code will ask me to confirm.");
      parts.push("\\n\\n--- ATTACHED FILES ---");
      attachedFiles.forEach((file, index) => {
        parts.push("\\n[" + (index + 1) + "] " + file.name + " (" + file.path + ")" + (file.truncated ? " [truncated]" : ""));
        parts.push("~~~text\\n" + file.text + "\\n~~~");
      });
      parts.push("--- END ATTACHED FILES ---");
      return parts.join("\\n");
    }

    function buildDisplayPrompt(basePrompt) {
      if (attachedFiles.length === 0) {
        return basePrompt;
      }

      const names = attachedFiles.map(file => "- " + file.name + (file.truncated ? " (truncated)" : "")).join("\\n");
      return (basePrompt || "Read the attached file(s).") + "\\n\\nAttached files:\\n" + names;
    }

    function renderAttachedFiles() {
      attachedFilesEl.textContent = "";
      attachedFilesEl.classList.toggle("visible", attachedFiles.length > 0);

      attachedFiles.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "file-chip";
        const name = document.createElement("span");
        name.textContent = file.name + " (" + Math.ceil((file.size || 0) / 1024) + " KB)" + (file.truncated ? " - truncated" : "");
        const remove = document.createElement("button");
        remove.className = "file-remove";
        remove.textContent = "x";
        remove.title = "Remove file";
        remove.addEventListener("click", () => {
          attachedFiles.splice(index, 1);
          renderAttachedFiles();
        });
        row.appendChild(name);
        row.appendChild(remove);
        attachedFilesEl.appendChild(row);
      });
    }

    function renderProviderStatus(route) {
      if (route && routeLineEl) {
        routeLineEl.textContent = "Mode: " + route.mode + " - " + route.reason + " -> " + (route.providers || []).join(", ");
      }
      if (!providerListEl) return;
      providerListEl.textContent = "";
      (providerStatusEntries || []).forEach((line) => {
        const row = document.createElement("div");
        row.textContent = line;
        providerListEl.appendChild(row);
      });
    }

    function remember(role, text) {
      historyEntries.push({
        role,
        text,
        timestamp: new Date().toISOString()
      });
    }

    function toggleHistory() {
      if (!historyEl) return;
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
      return item;
    }

    function attachEditActions(item, edits) {
      const wrap = document.createElement("div");
      wrap.className = "edit-actions";
      const list = document.createElement("ul");
      list.className = "edit-list";
      edits.forEach((edit) => {
        const li = document.createElement("li");
        li.textContent = edit.name + " (" + Math.ceil((edit.size || 0) / 1024) + " KB)";
        list.appendChild(li);
      });
      const button = document.createElement("button");
      button.className = "apply-edit";
      button.textContent = "Apply edit";
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "applyEdit", editId: edits[0].editId });
        button.disabled = true;
        button.textContent = "Waiting for confirmation...";
      });
      wrap.appendChild(list);
      wrap.appendChild(button);
      item.appendChild(wrap);
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

function appendFilesToPrompt(basePrompt, files) {
  if (!files || files.length === 0) {
    return basePrompt;
  }

  const parts = [String(basePrompt || "")];
  parts.push("\nIf I ask you to edit an attached file, return the COMPLETE replacement content for each edited file inside exactly one block like this:");
  parts.push('<free_ai_file_edits><file path="exact attached file path">complete new file content</file></free_ai_file_edits>');
  parts.push("Only use paths from the attached files. Do not say the edit was applied; VS Code will ask me to confirm.");
  parts.push("\n\n--- ATTACHED FILES ---");
  files.forEach((file, index) => {
    parts.push(`\n[${index + 1}] ${file.name} (${file.path})${file.truncated ? " [truncated]" : ""}`);
    parts.push(`~~~text\n${file.text}\n~~~`);
  });
  parts.push("--- END ATTACHED FILES ---");
  return parts.join("\n");
}

function extractAtFileReferences(prompt) {
  const refs = [];
  const seen = new Set();
  const re = /@([^\s"'`<>|]+(?:\.[A-Za-z0-9_+-]+)?)/g;
  let match;

  while ((match = re.exec(String(prompt || ""))) !== null) {
    const ref = match[1].replace(/[),.;:!?]+$/, "");
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    refs.push(ref);
  }

  return refs.slice(0, 8);
}

function extractWorkspaceFileReferences(prompt) {
  const refs = [];
  const seen = new Set();

  for (const ref of extractAtFileReferences(prompt)) {
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }

  const re = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_+-]{1,12})(?=$|[\s"'`),.;:!?])/g;
  let match;
  while ((match = re.exec(String(prompt || ""))) !== null) {
    const ref = match[1].replace(/[),.;:!?]+$/, "");
    if (!ref || ref.startsWith("http") || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    refs.push(ref);
  }

  return refs.slice(0, 8);
}

async function findWorkspaceFile(ref) {
  const clean = String(ref || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) {
    return null;
  }

  if (path.isAbsolute(ref)) {
    const uri = vscode.Uri.file(ref);
    return isInsideWorkspace(uri.fsPath) ? uri : null;
  }

  const exclude = "{**/.git/**,**/node_modules/**,**/.venv/**,**/build/**,**/dist/**,**/.dart_tool/**,**/.pytest_cache/**}";
  const glob = clean.includes("/") ? clean : `**/${clean}`;
  const matches = await vscode.workspace.findFiles(glob, exclude, 20);
  if (!matches.length) {
    return null;
  }

  matches.sort((a, b) => {
    const aExact = path.basename(a.fsPath).toLowerCase() === path.basename(clean).toLowerCase() ? 0 : 1;
    const bExact = path.basename(b.fsPath).toLowerCase() === path.basename(clean).toLowerCase() ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.fsPath.length - b.fsPath.length;
  });
  return matches[0];
}

function isInsideWorkspace(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  const normalized = normalizeFsPath(filePath);
  return folders.some((folder) => {
    const root = normalizeFsPath(folder.uri.fsPath);
    return normalized === root || normalized.startsWith(root + "/");
  });
}

function isUnsafeFilePath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const lower = normalizeFsPath(filePath);
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  return /(^|[\/._-])(secret|token|credential|credentials|apikey|api-key|private-key|id_rsa|id_dsa|id_ed25519)([\/._-]|$)/i.test(lower)
    || /\.(pem|p12|pfx|key)$/i.test(base);
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

async function askFreeProvider(gatewayUrl, authToken, provider, prompt, localCoderModel, maxTokens = 1400) {
  const selectedModel = provider.id === "ollama" ? (localCoderModel || provider.model) : provider.model;
  await applyGatewayModel(gatewayUrl, selectedModel);
  return askGateway(gatewayUrl, authToken, prompt, maxTokens);
}

async function askOpenCode(options) {
  const {
    command,
    model,
    localModel,
    authToken,
    prompt,
    fallbackToOllama
  } = options || {};
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("OpenCode Agent needs an open workspace folder.");
  }

  const agentPrompt = [
    "You are being called from the user's Free AI VS Code panel.",
    "Use a small context first. Read only files that are relevant to the user's request.",
    "Read project files when the request asks about files, code, or project review.",
    "If the user explicitly asks to fix/edit/change files, make the smallest useful edits and then summarize what changed.",
    "If the request is only a question or review, answer in chat without editing files.",
    "",
    "User request:",
    String(prompt || "")
  ].join("\n");

  try {
    return await runOpenCode({
      command,
      model: model || OPENCODE_MODEL,
      authToken,
      prompt: agentPrompt,
      cwd: workspaceFolder.uri.fsPath
    });
  } catch (error) {
    if (!fallbackToOllama || !isQuotaOrRateLimitError(getErrorMessage(error))) {
      throw error;
    }
    return runOpenCode({
      command,
      model: normalizeOpenCodeOllamaModel(localModel || DEFAULT_LOCAL_CODER_MODEL),
      authToken,
      prompt: agentPrompt,
      cwd: workspaceFolder.uri.fsPath
    });
  }
}

async function runOpenCode(options) {
  const { command, model, authToken, prompt, cwd } = options;
  const { stdout, stderr } = await execFileAsync(
    normalizeOpenCodeCommand(command),
    ["run", String(prompt || ""), "-m", model || OPENCODE_MODEL],
    {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: authToken || "freecc"
      },
      maxBuffer: 1024 * 1024 * 8,
      timeout: 180000,
      windowsHide: true
    }
  );

  const output = cleanTerminalText(stdout || "").trim();
  const errorOutput = cleanTerminalText(stderr || "").trim();
  const text = output || errorOutput || "(OpenCode finished without text output)";
  if (isQuotaOrRateLimitError(text)) {
    throw new Error(text);
  }
  return text;
}

function selectProviders(prompt, requestedProvider) {
  if (requestedProvider && requestedProvider !== "auto") {
    return [requestedProvider];
  }

  const lower = String(prompt || "").toLowerCase();

  if (shouldUseOpenCodeAgent(lower)) {
    return [OPENCODE_PROVIDER];
  }

  if (/(offline|local|private|privacy|ollama|локально|офлайн|приват)/i.test(lower)) {
    return ["ollama", "cerebras"];
  }

  return providerCatalog.filter((provider) => provider.role === "chat").sort((a, b) => a.priority - b.priority).map((provider) => provider.id);
}

function shouldUseOpenCodeAgent(lowerPrompt) {
  return /(project|codebase|workspace|repo|repository|read files|check files|review project|fix|edit|change|modify|refactor|проект|кодбейс|репозитор|прочитай файл|прочитай файлы|проверь проект|проверь код|исправь|измени|отредактируй|рефактор)/i.test(lowerPrompt);
}

function selectRoute(options) {
  const { prompt, requestedProvider, autoMode, catalog, providerState, hasReferencedFiles } = options;
  const enabled = catalog.filter((provider) => provider.enabled);
  const localProvider = enabled.find((provider) => provider.role === "local-fallback") || enabled.find((provider) => provider.id === "ollama");

  if (requestedProvider && requestedProvider !== "auto") {
    const manualProvider = enabled.find((provider) => provider.id === requestedProvider) || enabled[0];
    return {
      mode: manualProvider?.role === "agent" ? "Agent" : manualProvider?.role === "local-fallback" ? "Local" : "Manual",
      reason: "Manual provider selection",
      providers: manualProvider ? [manualProvider] : [],
      compare: false
    };
  }

  if (autoMode === "survival") {
    return {
      mode: "Local",
      reason: "Survival mode uses local Ollama first",
      providers: localProvider ? [localProvider] : firstReadyProviders(enabled, providerState, 1),
      compare: false
    };
  }

  const intent = classifyPrompt(prompt, hasReferencedFiles);
  if (intent.agent) {
    const agentProvider = enabled.find((provider) => provider.role === "agent");
    return {
      mode: "Agent",
      reason: intent.reason,
      providers: agentProvider ? [agentProvider] : localProvider ? [localProvider] : [],
      compare: false
    };
  }

  if (autoMode === "compare") {
    const compareProviders = firstReadyProviders(enabled.filter((provider) => provider.role === "chat"), providerState, 4);
    if (localProvider && compareProviders.length === 0) {
      compareProviders.push(localProvider);
    }
    return {
      mode: intent.fileReview ? "File Review" : "Cheap",
      reason: intent.fileReview ? "Compare mode with file context" : "Compare mode",
      providers: compareProviders,
      compare: true
    };
  }

  if (intent.local) {
    return {
      mode: "Local",
      reason: intent.reason,
      providers: localProvider ? [localProvider] : firstReadyProviders(enabled, providerState, 1),
      compare: false
    };
  }

  const primary = firstReadyProviders(enabled.filter((provider) => provider.role === "chat"), providerState, 1);
  const providers = primary.length > 0 ? primary : [];
  if (localProvider && !providers.some((provider) => provider.id === localProvider.id)) {
    providers.push(localProvider);
  }

  return {
    mode: intent.fileReview ? "File Review" : "Cheap",
    reason: intent.fileReview ? "Named file context was auto-read" : "Balanced mode chooses one cheap provider plus local fallback",
    providers,
    compare: false
  };
}

function classifyPrompt(prompt, hasReferencedFiles) {
  const text = String(prompt || "").toLowerCase();
  const projectWide = /(project|codebase|workspace|repo|repository|whole project|entire project|проект|кодбейс|репозитор|весь проект|всю папку|workspace)/i.test(text);
  const editIntent = /(fix|edit|change|modify|refactor|apply|write|исправь|измени|отредактируй|рефактор|почини|добавь|удали|перепиши)/i.test(text);
  const localIntent = /(offline|local|private|privacy|ollama|локально|офлайн|приват|без интернета|на ноуте)/i.test(text);

  if (projectWide || editIntent) {
    return {
      agent: true,
      local: false,
      fileReview: false,
      reason: projectWide ? "Project-wide request needs OpenCode Agent" : "Edit/change request needs OpenCode Agent"
    };
  }

  if (localIntent) {
    return {
      agent: false,
      local: true,
      fileReview: false,
      reason: "Local/private/offline request"
    };
  }

  return {
    agent: false,
    local: false,
    fileReview: Boolean(hasReferencedFiles),
    reason: hasReferencedFiles ? "Named file context was auto-read" : "Simple chat request"
  };
}

function firstReadyProviders(providers, providerState, count) {
  return providers
    .filter((provider) => !isProviderCoolingDown(provider.id, providerState))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, count);
}

function formatProviderResults(results) {
  return results.map((result) => {
    const title = `### ${formatProviderName(result.provider)}`;
    if (result.error) {
      return `${title}\n\nProvider failed: ${result.error}`;
    }

    const answer = stripFileEditBlocks(result.answer || "(empty response)").trim() || "(edit prepared)";
    return `${title}\n\n${answer}`;
  }).join("\n\n---\n\n");
}

function formatProviderName(provider) {
  const found = providerCatalog.find((item) => item.id === provider);
  return found?.label || provider;
}

function getDefaultOpenCodeCommand() {
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function normalizeOpenCodeCommand(command) {
  const value = String(command || "").trim();
  if (process.platform === "win32" && (!value || value.toLowerCase() === "opencode")) {
    return "opencode.cmd";
  }
  return value || getDefaultOpenCodeCommand();
}

function cleanTerminalText(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}

function buildProviderCatalog(config) {
  return providerCatalog.map((provider) => {
    if (provider.id === "ollama") {
      return {
        ...provider,
        model: config.localCoderModel || provider.model
      };
    }
    if (provider.id === OPENCODE_PROVIDER) {
      return {
        ...provider,
        model: config.openCodeModel || provider.model
      };
    }
    return { ...provider };
  }).sort((a, b) => a.priority - b.priority);
}

function normalizeProviderState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [key, state] of Object.entries(value)) {
    if (!state || typeof state !== "object") {
      continue;
    }
    normalized[key] = {
      status: String(state.status || "Ready"),
      lastError: String(state.lastError || ""),
      cooldownUntil: Number(state.cooldownUntil || 0),
      updatedAt: state.updatedAt || ""
    };
  }
  return normalized;
}

function getProviderRuntimeState(provider, providerState) {
  if (provider.role === "local-fallback") {
    return {
      status: "Local",
      lastError: "",
      cooldownUntil: 0
    };
  }
  const state = providerState[provider.id] || {};
  if (Number(state.cooldownUntil || 0) > Date.now()) {
    return {
      status: state.status || "Cooling down",
      lastError: state.lastError || "",
      cooldownUntil: Number(state.cooldownUntil || 0)
    };
  }
  return {
    status: state.status === "Rate limited" || state.status === "Cooling down" ? "Ready" : state.status || "Ready",
    lastError: state.cooldownUntil ? "" : state.lastError || "",
    cooldownUntil: 0
  };
}

function isProviderCoolingDown(providerId, providerState) {
  const state = providerState[providerId];
  return Boolean(state && Number(state.cooldownUntil || 0) > Date.now());
}

function isQuotaOrRateLimitError(value) {
  return /(429|rate limit|rate-limit|quota|too many requests|provider rate limit|402|insufficient|limit reached|try again later|retry-after)/i.test(String(value || ""));
}

function normalizeOpenCodeOllamaModel(model) {
  const value = String(model || DEFAULT_LOCAL_CODER_MODEL).trim();
  if (value.startsWith("ollama/")) {
    return value;
  }
  if (value.startsWith("ollama:")) {
    return `ollama/${value.slice("ollama:".length)}`;
  }
  return `ollama/${value}`;
}

async function discoverFreeModelCandidates(config) {
  const result = {
    refreshedAt: new Date().toISOString(),
    candidates: [],
    sources: []
  };

  await collectOpenRouterCandidates(result);
  await collectOllamaCandidates(result);
  await collectGatewayCandidates(result, config);
  await collectStaticCandidateHints(result);

  const seen = new Set();
  result.candidates = result.candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return result;
}

async function collectOpenRouterCandidates(result) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    const models = Array.isArray(json.data) ? json.data : [];
    for (const model of models) {
      if (model && typeof model.id === "string" && model.id.endsWith(":free")) {
        result.candidates.push({
          source: "openrouter",
          id: model.id,
          name: model.name || model.id,
          status: "candidate",
          enabled: false
        });
      }
    }
    result.sources.push({ source: "openrouter", status: "ok", count: models.length });
  } catch (error) {
    result.sources.push({ source: "openrouter", status: "failed", error: getErrorMessage(error) });
  }
}

async function collectOllamaCandidates(result) {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    const models = Array.isArray(json.models) ? json.models : [];
    for (const model of models) {
      if (model && typeof model.name === "string") {
        result.candidates.push({
          source: "ollama",
          id: `ollama/${model.name}`,
          name: model.name,
          status: "candidate",
          enabled: false
        });
      }
    }
    result.sources.push({ source: "ollama", status: "ok", count: models.length });
  } catch (error) {
    result.sources.push({ source: "ollama", status: "failed", error: getErrorMessage(error) });
  }
}

async function collectGatewayCandidates(result, config) {
  try {
    const response = await fetch(`${config.gatewayUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${config.authToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    const models = Array.isArray(json.data) ? json.data : [];
    for (const model of models) {
      const id = model.id || model.name || model.display_name;
      if (id) {
        result.candidates.push({
          source: "gateway",
          id: String(id),
          name: model.display_name || model.name || String(id),
          status: "candidate",
          enabled: false
        });
      }
    }
    result.sources.push({ source: "gateway", status: "ok", count: models.length });
  } catch (error) {
    result.sources.push({ source: "gateway", status: "failed", error: getErrorMessage(error) });
  }
}

async function collectStaticCandidateHints(result) {
  const hints = [
    { source: "github-models", id: "github/low-tier-models", name: "GitHub Models low-tier free API candidates" },
    { source: "cloudflare-workers-ai", id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Cloudflare Workers AI Qwen Coder candidate" },
    { source: "cloudflare-workers-ai", id: "@cf/openai/gpt-oss-20b", name: "Cloudflare Workers AI GPT OSS 20B candidate" },
    { source: "opencode-models", id: "models.dev", name: "OpenCode/models.dev provider directory candidates" }
  ];
  for (const hint of hints) {
    result.candidates.push({
      ...hint,
      status: "manual-source",
      enabled: false
    });
  }
  result.sources.push({ source: "static-hints", status: "ok", count: hints.length });
}

async function askGateway(gatewayUrl, authToken, prompt, maxTokens = 1400) {
  const systemPrompt = `You are the user's separate Free AI assistant.

Important rules:
- Do not call tools.
- You cannot directly edit files yourself.
- Do not output fake Write/Edit/Read JSON.
- If the user asks for code, write code in the chat.
- If the user asks for architecture, answer in Markdown.
- If the user asks to edit an attached file, return the complete replacement content using exactly this XML-like block:
<free_ai_file_edits><file path="exact attached file path">complete new file content</file></free_ai_file_edits>
- Only use paths that appear in the attached file list.
- Do not claim the edit was applied. The VS Code extension will ask the user to confirm before writing.`;

  const response = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: maxTokens,
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

function stripFileEditBlocks(text) {
  return String(text || "")
    .replace(/<free_ai_file_edits>[\s\S]*?<\/free_ai_file_edits>/gi, "")
    .trim();
}

function extractFileEditBlocks(text) {
  const edits = [];
  const re = /<free_ai_file_edits>([\s\S]*?)<\/free_ai_file_edits>/gi;
  let match;

  while ((match = re.exec(String(text || ""))) !== null) {
    const raw = match[1].trim();
    const fileRe = /<file\s+path=(["'])(.*?)\1>([\s\S]*?)<\/file>/gi;
    let fileMatch;
    let foundRawFile = false;
    while ((fileMatch = fileRe.exec(raw)) !== null) {
      foundRawFile = true;
      edits.push({
        path: decodeHtmlEntities(fileMatch[2]),
        content: decodeHtmlEntities(fileMatch[3]).replace(/^\r?\n/, "").replace(/\r?\n$/, "")
      });
    }
    if (foundRawFile) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item.path === "string" && typeof item.content === "string") {
          edits.push({ path: item.path, content: item.content });
        }
      }
    } catch {
      // Ignore malformed edit blocks; the answer text is still shown to the user.
    }
  }

  return edits;
}

function normalizeFsPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
  deactivate,
  _test: {
    buildProviderCatalog,
    classifyPrompt,
    isQuotaOrRateLimitError,
    normalizeProviderState,
    selectRoute
  }
};
