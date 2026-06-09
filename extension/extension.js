const vscode = require("vscode");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PROVIDER_MODELS = {
  cerebras: "cerebras/gpt-oss-120b",
  gemini: "gemini/models/gemini-2.5-flash",
  "gemini-fast": "gemini/models/gemini-2.0-flash",
  groq: "groq/qwen/qwen3-32b",
  openrouter: "open_router/google/gemma-4-31b-it:free",
  ollama: "ollama/qwen2.5-coder:7b"
};

const AUTO_PROVIDER_ORDER = ["cerebras", "gemini-fast", "groq", "openrouter"];
const OPENCODE_PROVIDER = "opencode";
const OPENCODE_MODEL = "anthropic/claude-sonnet-4-0";

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
    this.pendingEdits = new Map();
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

    let userDisplay = String(displayPrompt || text).trim();
    let editSourceFiles = Array.isArray(attachedFiles) ? [...attachedFiles] : [];

    const referencedFiles = await this.resolveWorkspaceFileReferences(text);
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
      const config = vscode.workspace.getConfiguration("freeAiConsole");
      const gatewayUrl = config.get("gatewayUrl", "http://127.0.0.1:8082").replace(/\/$/, "");
      const authToken = config.get("authToken", "freecc");
      const openCodeCommand = config.get("openCodeCommand", getDefaultOpenCodeCommand());
      const openCodeModel = config.get("openCodeModel", OPENCODE_MODEL);
      const requestedProvider = provider || config.get("defaultProvider", "auto");
      const selectedProviders = selectProviders(text, requestedProvider);
      const results = [];

      for (const selectedProvider of selectedProviders) {
        this.post({ type: "status", text: `Thinking with ${formatProviderName(selectedProvider)}...` });

        try {
          const answer = selectedProvider === OPENCODE_PROVIDER
            ? await askOpenCode(openCodeCommand, openCodeModel, authToken, text)
            : await askFreeProvider(gatewayUrl, authToken, selectedProvider, text);
          results.push({ provider: selectedProvider, answer: answer || "" });
        } catch (error) {
          results.push({ provider: selectedProvider, error: getErrorMessage(error) });
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
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.addToHistory("error", errorMsg);
      this.post({ type: "error", text: errorMsg });
    }
  }

  post(message) {
    this.view.webview.postMessage(message);
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
    let historyEntries = ${initialHistory};
    let showingHistory = false;
    let attachedFiles = [];
    
    if (historyEl) {
      historyEl.addEventListener("click", toggleHistory);
    }
    addFileEl.addEventListener("click", () => {
      vscode.postMessage({ type: "pickFiles" });
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
      
    });
    

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

async function askFreeProvider(gatewayUrl, authToken, provider, prompt) {
  const selectedModel = PROVIDER_MODELS[provider] || PROVIDER_MODELS.cerebras;
  await applyGatewayModel(gatewayUrl, selectedModel);
  return askGateway(gatewayUrl, authToken, prompt);
}

async function askOpenCode(openCodeCommand, openCodeModel, authToken, prompt) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("OpenCode Agent needs an open workspace folder.");
  }

  const agentPrompt = [
    "You are being called from the user's Free AI VS Code panel.",
    "Read project files when the request asks about files, code, or project review.",
    "If the user explicitly asks to fix/edit/change files, make the smallest useful edits and then summarize what changed.",
    "If the request is only a question or review, answer in chat without editing files.",
    "",
    "User request:",
    String(prompt || "")
  ].join("\n");

  const { stdout, stderr } = await execFileAsync(
    normalizeOpenCodeCommand(openCodeCommand),
    ["run", agentPrompt, "-m", openCodeModel || OPENCODE_MODEL],
    {
      cwd: workspaceFolder.uri.fsPath,
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
  if (output) {
    return output;
  }
  if (errorOutput) {
    return errorOutput;
  }
  return "(OpenCode finished without text output)";
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

  return AUTO_PROVIDER_ORDER;
}

function shouldUseOpenCodeAgent(lowerPrompt) {
  return /(project|codebase|workspace|repo|repository|read files|check files|review project|fix|edit|change|modify|refactor|проект|кодбейс|репозитор|прочитай файл|прочитай файлы|проверь проект|проверь код|исправь|измени|отредактируй|рефактор)/i.test(lowerPrompt);
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
  const names = {
    cerebras: "Cerebras",
    gemini: "Gemini",
    "gemini-fast": "Gemini Fast",
    groq: "Groq",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    opencode: "OpenCode Agent"
  };
  return names[provider] || provider;
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

async function askGateway(gatewayUrl, authToken, prompt) {
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
  deactivate
};
