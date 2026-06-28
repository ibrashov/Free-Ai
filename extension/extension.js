const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const providerCatalog = require("./provider-catalog.json");

const execFileAsync = promisify(execFile);

const OPENCODE_PROVIDER = "opencode";
const STEP_AGENT_PROVIDER = "step-agent";
const DEFAULT_LOCAL_CODER_MODEL = "ollama/qwen2.5-coder:3b";
const OPENCODE_MODEL = "ollama/qwen3:8b";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_COMMAND = "ollama serve";
const DEFAULT_OLLAMA_MODELS_DIRECTORY = "C:\\OllamaModels";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8082";
const DEFAULT_GATEWAY_COMMAND = "fcc-server";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DISCOVERY_TIMEOUT_MS = 15000;
const GATEWAY_HEALTH_TIMEOUT_MS = 2500;
const GATEWAY_STARTUP_TIMEOUT_MS = 20000;
const OLLAMA_STARTUP_TIMEOUT_MS = 20000;
const PROVIDER_TEST_TIMEOUT_MS = 60000;
const PROVIDER_STATE_KEY = "freeAi.providerState";
const DISCOVERY_FILE = "provider-candidates.json";
const CHATS_FILE = "chats.json";
const CHAT_CONTEXT_MESSAGE_LIMIT = 16;
const CHAT_CONTEXT_CHAR_LIMIT = 24000;
const STEP_AGENT_PLAN_MAX_TOKENS = 700;
const STEP_AGENT_VERIFY_MAX_TOKENS = 700;
const STEP_AGENT_DEFAULT_STEP_TOKENS = 900;

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
    }),
    vscode.commands.registerCommand("freeAiConsole.startGateway", async () => {
      await provider.startGatewayFromCommand();
    }),
    vscode.commands.registerCommand("freeAiConsole.checkGateway", async () => {
      await provider.checkGateway({ showMessage: true });
    })
  );
}

class FreeAiViewProvider {
  constructor(extensionUri, context) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.view = undefined;
    this.chatsUri = vscode.Uri.joinPath(this.context.globalStorageUri, CHATS_FILE);
    this.legacyHistoryUri = vscode.Uri.joinPath(this.context.globalStorageUri, "history.json");
    this.chats = [];
    this.activeChatId = "";
    this.chatSave = Promise.resolve();
    this.pendingEdits = new Map();
    this.providerState = normalizeProviderState(this.context.globalState.get(PROVIDER_STATE_KEY, {}));
    this.discoveryUri = vscode.Uri.joinPath(this.context.globalStorageUri, DISCOVERY_FILE);
    this.gatewayStatus = {
      state: "unknown",
      text: "Gateway: not checked",
      detail: ""
    };
    this.gatewayStartPromise = null;
    this.ollamaStartPromise = null;
  }

  async loadChats() {
    const stored = await this.readChatsFile();
    if (stored) {
      const normalized = normalizeChatStore(stored);
      this.chats = normalized.chats;
      this.activeChatId = normalized.activeChatId;
    } else {
      const fileHistory = await this.readLegacyHistoryFile();
      const globalHistory = normalizeHistory(this.context.globalState.get("freeAi.history", []));
      const legacyHistory = mergeHistory(fileHistory, globalHistory);
      const migrated = legacyHistory.length > 0
        ? createChatRecord("Imported chat history", legacyHistory)
        : createChatRecord();
      this.chats = [migrated];
      this.activeChatId = migrated.id;
      await this.saveChats();
      if (globalHistory.length > 0) {
        await this.context.globalState.update("freeAi.history", undefined);
      }
    }

    if (!this.getActiveChat()) {
      const chat = createChatRecord();
      this.chats.unshift(chat);
      this.activeChatId = chat.id;
      await this.saveChats();
    }
  }

  async readChatsFile() {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.chatsUri);
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return null;
    }
  }

  async readLegacyHistoryFile() {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.legacyHistoryUri);
      const raw = Buffer.from(bytes).toString("utf8");
      return normalizeHistory(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  async saveChats() {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const json = JSON.stringify({
      version: 1,
      activeChatId: this.activeChatId,
      chats: this.chats
    }, null, 2);
    await vscode.workspace.fs.writeFile(this.chatsUri, Buffer.from(json, "utf8"));
  }

  queueSaveChats() {
    this.chatSave = this.chatSave
      .then(() => this.saveChats())
      .catch((error) => {
        console.error("Failed to save Free AI chats", error);
      });
  }

  getActiveChat() {
    return this.chats.find((chat) => chat.id === this.activeChatId) || null;
  }

  getSortedChats() {
    return [...this.chats].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  ensureChat(chatId, activate = true) {
    const requested = this.chats.find((chat) => chat.id === chatId);
    if (requested) {
      if (activate) {
        this.activeChatId = requested.id;
      }
      return requested;
    }

    const active = this.getActiveChat();
    if (active) {
      return active;
    }

    const chat = createChatRecord();
    this.chats.unshift(chat);
    this.activeChatId = chat.id;
    return chat;
  }

  createNewChat() {
    const chat = createChatRecord();
    this.chats.unshift(chat);
    this.activeChatId = chat.id;
    this.queueSaveChats();
    this.postChatState();
  }

  selectChat(chatId) {
    const chat = this.chats.find((item) => item.id === chatId);
    if (!chat) {
      return;
    }
    this.activeChatId = chat.id;
    this.queueSaveChats();
    this.postChatState();
  }

  deleteChat(chatId) {
    const id = String(chatId || "");
    const existing = this.chats.find((item) => item.id === id);
    if (!existing) {
      return;
    }

    const wasActive = this.activeChatId === id;
    this.chats = this.chats.filter((item) => item.id !== id);

    if (this.chats.length === 0) {
      const chat = createChatRecord();
      this.chats = [chat];
      this.activeChatId = chat.id;
    } else if (wasActive || !this.getActiveChat()) {
      this.activeChatId = this.getSortedChats()[0].id;
    }

    this.queueSaveChats();
    this.postChatState();
  }

  async requestDeleteChat(chatId) {
    const id = String(chatId || "");
    const chat = this.chats.find((item) => item.id === id);
    if (!chat) {
      return;
    }

    const title = chat.title || "New chat";
    const choice = await vscode.window.showWarningMessage(
      `Delete this chat permanently?\n\n${title}`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") {
      return;
    }

    this.deleteChat(id);
  }

  addToHistory(role, text, chatId = this.activeChatId, activate = true) {
    const chat = this.ensureChat(chatId, activate);
    const timestamp = new Date().toISOString();
    chat.messages.push({
      role: String(role),
      text: String(text || ""),
      timestamp
    });
    if (role === "user" && chat.messages.filter((message) => message.role === "user").length === 1) {
      chat.title = createChatTitle(text);
    }
    chat.updatedAt = timestamp;
    if (activate) {
      this.activeChatId = chat.id;
    }
    this.queueSaveChats();
    return chat;
  }

  getChatState() {
    return {
      activeChatId: this.activeChatId,
      chats: this.getSortedChats()
    };
  }

  postChatState() {
    if (!this.view) {
      return;
    }
    this.post({
      type: "chatState",
      state: this.getChatState()
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
        await this.answer(
          message.prompt,
          message.provider,
          message.displayPrompt,
          message.attachedFiles,
          message.chatId
        );
      }
      if (message.type === "newChat") {
        this.createNewChat();
      }
      if (message.type === "selectChat") {
        this.selectChat(message.chatId);
      }
      if (message.type === "deleteChat") {
        await this.requestDeleteChat(message.chatId);
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
      if (message.type === "checkGateway") {
        await this.checkGateway({ showMessage: false });
      }
      if (message.type === "startGateway") {
        await this.ensureGatewayRunning({ force: true, showMessage: false });
      }
    });

    this.loadChats().then(() => {
      webviewView.webview.html = this.getHtml(webviewView.webview);
      this.postGatewayStatus();
      this.ensureGatewayRunning({ force: false, showMessage: false });
      this.ensureOllamaRunning({ force: false, showMessage: false });
    }).catch((error) => {
      const chat = createChatRecord();
      this.chats = [chat];
      this.activeChatId = chat.id;
      webviewView.webview.html = this.getHtml(webviewView.webview);
      this.postGatewayStatus();
      this.ensureGatewayRunning({ force: false, showMessage: false });
      this.ensureOllamaRunning({ force: false, showMessage: false });
      this.post({ type: "error", text: `Could not load chat database: ${getErrorMessage(error)}` });
    });
  }

  

  async answer(prompt, provider, displayPrompt, attachedFiles, chatId) {
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
    const chat = this.ensureChat(chatId);
    const previousMessages = [...chat.messages];

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

    this.addToHistory("user", userDisplay, chat.id);
    text = appendConversationContext(text, previousMessages);

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
      if (route.providers.some((item) => providerUsesGateway(item, config))) {
        const gateway = await this.ensureGatewayRunning({ force: false, showMessage: false });
        if (gateway.state !== "ready") {
          throw new Error(`${gateway.text}${gateway.detail ? `: ${gateway.detail}` : ""}`);
        }
      }

      for (const selectedProvider of route.providers) {
        this.post({ type: "status", text: `${route.mode}: ${selectedProvider.label} (${route.reason})...` });

        try {
          const selectedOllamaModels = getProviderOllamaModels(selectedProvider, config);
          if (providerRequiresOllama(selectedProvider, config)) {
            const ollama = await this.ensureOllamaRunning({
              force: false,
              showMessage: false,
              models: selectedOllamaModels
            });
            if (ollama.state !== "ready") {
              throw new Error(`${ollama.text}${ollama.detail ? `: ${ollama.detail}` : ""}`);
            }
          }

          const answer = selectedProvider.id === OPENCODE_PROVIDER
            ? await askOpenCode({
              command: config.openCodeCommand,
              model: config.openCodeModel,
              localModel: config.localCoderModel,
              authToken: config.authToken,
              prompt: text,
              fallbackToOllama: config.openCodeFallbackToOllama,
              ensureOllama: (model) => this.ensureOllamaRunning({
                force: false,
                showMessage: false,
                models: [model]
              })
            })
            : selectedProvider.id === STEP_AGENT_PROVIDER
              ? await this.askStepAgent(text, config)
            : await askFreeProvider(config, selectedProvider, text);
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
      
      this.addToHistory("assistant", visibleAnswer, chat.id, false);
      
      this.post({
        type: "answer",
        text: visibleAnswer,
        edits,
        chatId: chat.id,
        chatState: this.getChatState()
      });
      this.postProviderStatus();
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.addToHistory("error", errorMsg, chat.id, false);
      this.post({
        type: "error",
        text: errorMsg,
        chatId: chat.id,
        chatState: this.getChatState()
      });
    }
  }

  post(message) {
    this.view.webview.postMessage(message);
  }

  setGatewayStatus(state, text, detail = "") {
    this.gatewayStatus = {
      state,
      text,
      detail
    };
    this.postGatewayStatus();
    return this.gatewayStatus;
  }

  postGatewayStatus() {
    if (!this.view) {
      return;
    }
    this.post({
      type: "gatewayStatus",
      status: this.gatewayStatus
    });
  }

  async checkGateway(options = {}) {
    const { showMessage = false } = options;
    const config = this.getConfig();
    this.setGatewayStatus("checking", `Gateway: checking ${config.gatewayUrl}...`);

    const health = await getGatewayHealth(config.gatewayUrl);
    if (health.ok) {
      const status = this.setGatewayStatus("ready", `Gateway: running at ${config.gatewayUrl}`);
      if (showMessage) {
        vscode.window.showInformationMessage(status.text);
      }
      return status;
    }

    const status = this.setGatewayStatus("stopped", `Gateway: not running at ${config.gatewayUrl}`, health.error);
    if (showMessage) {
      vscode.window.showWarningMessage(`${status.text}. ${status.detail}`);
    }
    return status;
  }

  async startGatewayFromCommand() {
    return this.ensureGatewayRunning({ force: true, showMessage: true });
  }

  async ensureGatewayRunning(options = {}) {
    const { force = false, showMessage = false } = options;
    const config = this.getConfig();

    const existing = await getGatewayHealth(config.gatewayUrl);
    if (existing.ok) {
      const status = this.setGatewayStatus("ready", `Gateway: running at ${config.gatewayUrl}`);
      if (showMessage) {
        vscode.window.showInformationMessage(status.text);
      }
      return status;
    }

    if (!force && !config.autoStartGateway) {
      return this.setGatewayStatus(
        "disabled",
        "Gateway: auto-start is off",
        `Enable freeAiConsole.autoStartGateway or start ${config.gatewayCommand || DEFAULT_GATEWAY_COMMAND}.`
      );
    }

    if (this.gatewayStartPromise) {
      return this.gatewayStartPromise;
    }

    this.gatewayStartPromise = this.startGatewayProcess(config, showMessage)
      .finally(() => {
        this.gatewayStartPromise = null;
      });

    return this.gatewayStartPromise;
  }

  async startGatewayProcess(config, showMessage) {
    const commandLine = config.gatewayCommand || DEFAULT_GATEWAY_COMMAND;
    this.setGatewayStatus("starting", `Gateway: starting with ${commandLine}...`);

    try {
      await spawnDetachedProcess(commandLine);
      const health = await waitForGatewayHealth(config.gatewayUrl, config.gatewayStartupTimeoutMs);
      if (!health.ok) {
        throw new Error(health.error || `Gateway did not become healthy within ${Math.round(config.gatewayStartupTimeoutMs / 1000)}s.`);
      }

      const status = this.setGatewayStatus("ready", `Gateway: running at ${config.gatewayUrl}`);
      if (showMessage) {
        vscode.window.showInformationMessage(status.text);
      }
      return status;
    } catch (error) {
      const message = getErrorMessage(error);
      const status = this.setGatewayStatus("error", "Gateway: could not start", message);
      if (showMessage) {
        vscode.window.showErrorMessage(`${status.text}. ${status.detail}`);
      }
      return status;
    }
  }

  async ensureOllamaRunning(options = {}) {
    const { force = false, showMessage = false, models = [] } = options;
    const config = this.getConfig();
    const requiredModels = getRequiredOllamaModels(config, this.getCatalog(config), models);

    const existing = await this.checkOllamaHealth(config.ollamaUrl);
    if (existing.ok) {
      const modelStatus = await this.checkOllamaModels(config.ollamaUrl, requiredModels);
      if (!modelStatus.ok) {
        if (!isLocalServiceUrl(config.ollamaUrl)) {
          return {
            state: "stopped",
            text: `Ollama: model storage is not ready at ${config.ollamaUrl}`,
            detail: formatOllamaModelStatusError(modelStatus, config)
          };
        }

        if (!force && !config.autoStartOllama) {
          return {
            state: "disabled",
            text: "Ollama: auto-start is off",
            detail: `${formatOllamaModelStatusError(modelStatus, config)} Enable freeAiConsole.autoStartOllama or restart Ollama manually.`
          };
        }

        if (!config.ollamaModelsDirectory) {
          return {
            state: "error",
            text: "Ollama: model storage is not ready",
            detail: `${formatOllamaModelStatusError(modelStatus, config)} Set freeAiConsole.ollamaModelsDirectory or repair the active Ollama server.`
          };
        }

        if (this.ollamaStartPromise) {
          return this.ollamaStartPromise;
        }

        this.ollamaStartPromise = this.restartOllamaProcess(config, showMessage, requiredModels)
          .finally(() => {
            this.ollamaStartPromise = null;
          });

        return this.ollamaStartPromise;
      }

      const status = {
        state: "ready",
        text: `Ollama: running at ${config.ollamaUrl}`,
        detail: ""
      };
      if (showMessage) {
        vscode.window.showInformationMessage(status.text);
      }
      return status;
    }

    if (!isLocalServiceUrl(config.ollamaUrl)) {
      return {
        state: "stopped",
        text: `Ollama: not running at ${config.ollamaUrl}`,
        detail: existing.error
      };
    }

    if (!force && !config.autoStartOllama) {
      return {
        state: "disabled",
        text: "Ollama: auto-start is off",
        detail: "Enable freeAiConsole.autoStartOllama or start Ollama manually."
      };
    }

    if (this.ollamaStartPromise) {
      return this.ollamaStartPromise;
    }

    this.ollamaStartPromise = this.startOllamaProcess(config, showMessage, requiredModels)
      .finally(() => {
        this.ollamaStartPromise = null;
      });

    return this.ollamaStartPromise;
  }

  async startOllamaProcess(config, showMessage, models = []) {
    const commandLine = config.ollamaCommand || getDefaultOllamaCommand();

    try {
      await spawnDetachedProcess(commandLine, {
        env: getOllamaStartEnv(config)
      });
      const health = await waitForOllamaHealth(config.ollamaUrl, config.ollamaStartupTimeoutMs);
      if (!health.ok) {
        throw new Error(health.error || `Ollama did not become ready within ${Math.round(config.ollamaStartupTimeoutMs / 1000)}s.`);
      }

      const requiredModels = getRequiredOllamaModels(config, this.getCatalog(config), models);
      const modelStatus = await this.checkOllamaModels(config.ollamaUrl, requiredModels);
      if (!modelStatus.ok) {
        throw new Error(formatOllamaModelStatusError(modelStatus, config));
      }

      const status = {
        state: "ready",
        text: `Ollama: running at ${config.ollamaUrl}`,
        detail: ""
      };
      if (showMessage) {
        vscode.window.showInformationMessage(status.text);
      }
      return status;
    } catch (error) {
      const status = {
        state: "error",
        text: "Ollama: could not start",
        detail: getErrorMessage(error)
      };
      if (showMessage) {
        vscode.window.showErrorMessage(`${status.text}. ${status.detail}`);
      }
      return status;
    }
  }

  async checkOllamaHealth(ollamaUrl) {
    return getOllamaHealth(ollamaUrl);
  }

  async checkOllamaModels(ollamaUrl, models) {
    return getOllamaModelStatus(ollamaUrl, models);
  }

  async restartOllamaProcess(config, showMessage, models = []) {
    if (showMessage) {
      vscode.window.showInformationMessage(`Restarting Ollama with OLLAMA_MODELS=${config.ollamaModelsDirectory}.`);
    }
    await stopOllamaProcesses();
    return this.startOllamaProcess(config, showMessage, models);
  }

  getConfig() {
    const config = vscode.workspace.getConfiguration("freeAiConsole");
    return {
      gatewayUrl: config.get("gatewayUrl", DEFAULT_GATEWAY_URL).replace(/\/$/, ""),
      authToken: config.get("authToken", "freecc"),
      autoStartGateway: config.get("autoStartGateway", true),
      gatewayCommand: config.get("gatewayCommand", DEFAULT_GATEWAY_COMMAND),
      gatewayStartupTimeoutMs: Math.max(
        3000,
        Number(config.get("gatewayStartupTimeoutSeconds", GATEWAY_STARTUP_TIMEOUT_MS / 1000)) * 1000
      ),
      autoStartOllama: config.get("autoStartOllama", true),
      ollamaCommand: normalizeOllamaCommand(config.get("ollamaCommand", DEFAULT_OLLAMA_COMMAND)),
      ollamaModelsDirectory: String(config.get("ollamaModelsDirectory", DEFAULT_OLLAMA_MODELS_DIRECTORY) || "").trim(),
      ollamaStartupTimeoutMs: Math.max(
        3000,
        Number(config.get("ollamaStartupTimeoutSeconds", OLLAMA_STARTUP_TIMEOUT_MS / 1000)) * 1000
      ),
      defaultProvider: config.get("defaultProvider", "auto"),
      autoMode: config.get("autoMode", "balanced"),
      freePolicy: config.get("freePolicy", "no-card"),
      stepAgentPlannerProvider: config.get("stepAgentPlannerProvider", "auto"),
      stepAgentMaxSteps: clampInteger(config.get("stepAgentMaxSteps", 5), 2, 10),
      stepAgentRepairPasses: clampInteger(config.get("stepAgentRepairPasses", 1), 0, 2),
      stepAgentStepMaxTokens: clampInteger(config.get("stepAgentStepMaxTokens", STEP_AGENT_DEFAULT_STEP_TOKENS), 200, 3000),
      openCodeCommand: config.get("openCodeCommand", getDefaultOpenCodeCommand()),
      openCodeModel: config.get("openCodeModel", OPENCODE_MODEL),
      openCodeFallbackToOllama: config.get("openCodeFallbackToOllama", true),
      providerCooldownMinutes: config.get("providerCooldownMinutes", 10),
      localCoderModel: config.get("localCoderModel", DEFAULT_LOCAL_CODER_MODEL),
      ollamaUrl: config.get("ollamaUrl", DEFAULT_OLLAMA_URL).replace(/\/$/, ""),
      requestTimeoutMs: Math.max(
        10000,
        Number(config.get("requestTimeoutSeconds", DEFAULT_REQUEST_TIMEOUT_MS / 1000)) * 1000
      )
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
    const provider = providerCatalog.find((item) => item.id === providerId);
    this.providerState[providerId] = {
      ...current,
      status: provider?.role === "local-fallback" ? "Local" : "Ready",
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
      const model = provider.id === "ollama"
        ? config.localCoderModel
        : provider.id === STEP_AGENT_PROVIDER
          ? `planner:${config.stepAgentPlannerProvider || "auto"} -> ${config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL}`
          : provider.model;
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
    const testConfig = {
      ...config,
      requestTimeoutMs: Math.min(config.requestTimeoutMs, PROVIDER_TEST_TIMEOUT_MS)
    };
    const catalog = this.getCatalog(config).filter((provider) => provider.enabled);
    if (catalog.some((provider) => providerUsesGateway(provider, config))) {
      await this.ensureGatewayRunning({ force: false, showMessage: false });
    }
    if (catalog.some((provider) => providerUsesOllama(provider, config))) {
      await this.ensureOllamaRunning({ force: false, showMessage: false });
    }
    const results = [];
    this.post({ type: "status", text: "Testing Free AI providers..." });

    for (const provider of catalog) {
      this.post({ type: "status", text: `Testing ${provider.label} (max 60s)...` });
      try {
        const answer = await testProviderAvailability(testConfig, provider);
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
    await this.ensureOllamaRunning({ force: false, showMessage: false });
    const result = await discoverFreeModelCandidates(config);
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.discoveryUri, Buffer.from(JSON.stringify(result, null, 2), "utf8"));
    const text = `Found ${result.candidates.length} candidate model(s). Stored locally as ${DISCOVERY_FILE}. Candidates are not enabled until tested.`;
    vscode.window.showInformationMessage(text);
    this.post({ type: "answer", text, edits: [] });
  }

  async askStepAgent(prompt, config = this.getConfig()) {
    const catalog = this.getCatalog(config);
    const planner = selectStepAgentPlannerProvider({
      config,
      catalog,
      providerState: this.providerState
    });
    const localModel = config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL;

    const ollama = await this.ensureOllamaRunning({
      force: false,
      showMessage: false,
      models: [localModel]
    });
    if (ollama.state !== "ready") {
      throw new Error(`${ollama.text}${ollama.detail ? `: ${ollama.detail}` : ""}`);
    }

    if (planner && providerUsesGateway(planner, config)) {
      const gateway = await this.ensureGatewayRunning({ force: false, showMessage: false });
      if (gateway.state !== "ready") {
        throw new Error(`${gateway.text}${gateway.detail ? `: ${gateway.detail}` : ""}`);
      }
    }

    if (planner && providerRequiresOllama(planner, config)) {
      const plannerOllama = await this.ensureOllamaRunning({
        force: false,
        showMessage: false,
        models: getProviderOllamaModels(planner, config)
      });
      if (plannerOllama.state !== "ready") {
        throw new Error(`${plannerOllama.text}${plannerOllama.detail ? `: ${plannerOllama.detail}` : ""}`);
      }
    }

    return runStepAgent({
      userPrompt: prompt,
      planner,
      workerModel: localModel,
      maxSteps: config.stepAgentMaxSteps,
      repairPasses: config.stepAgentRepairPasses,
      stepMaxTokens: config.stepAgentStepMaxTokens,
      askPlanner: async (plannerPrompt) => {
        if (!planner) {
          throw new Error("No planner provider is available.");
        }
        try {
          const answer = await askFreeProvider(config, planner, plannerPrompt, STEP_AGENT_PLAN_MAX_TOKENS);
          await this.markProviderReady(planner.id);
          return answer;
        } catch (error) {
          await this.markProviderFailure(planner.id, error, config.providerCooldownMinutes);
          throw error;
        }
      },
      askWorker: (workerPrompt, maxTokens) => askOllamaDirect(
        config.ollamaUrl || DEFAULT_OLLAMA_URL,
        localModel,
        workerPrompt,
        maxTokens,
        config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
      ),
      onStatus: (text) => this.post({ type: "status", text })
    });
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
    const initialChatState = safeJsonForHtml(this.getChatState());
    const initialProviders = safeJsonForHtml(this.getProviderStatusLines());
    const initialGatewayStatus = safeJsonForHtml(this.gatewayStatus);

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
    .chat-header {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .chat-title {
      overflow: hidden;
      font-weight: 600;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-header button {
      padding: 6px 9px;
      font-size: 12px;
    }
    .chat-panel {
      display: none;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .chat-panel.visible {
      display: block;
    }
    .chat-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 260px;
      overflow-y: auto;
    }
    .chat-item-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 72px;
      gap: 4px;
      align-items: stretch;
    }
    .chat-item {
      min-width: 0;
      width: 100%;
      padding: 8px;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px solid transparent;
      text-align: left;
      white-space: normal;
    }
    .chat-item:hover,
    .chat-item.active {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-panel-border);
    }
    .chat-item-title {
      display: block;
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-item-meta {
      display: block;
      margin-top: 3px;
      font-size: 11px;
      opacity: 0.7;
    }
    .chat-delete {
      align-self: stretch;
      padding: 0 8px;
      color: var(--vscode-errorForeground);
      background: transparent;
      border: 1px solid transparent;
      min-width: 64px;
      white-space: nowrap;
    }
    .chat-delete:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-inputValidation-errorBorder);
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
    .gateway-panel {
      margin: 0 0 10px 0;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    .gateway-panel-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .gateway-status {
      overflow-wrap: anywhere;
      font-weight: 600;
    }
    .gateway-status.ready {
      color: var(--vscode-charts-green);
    }
    .gateway-status.error,
    .gateway-status.stopped {
      color: var(--vscode-errorForeground);
    }
    .gateway-status.starting,
    .gateway-status.checking {
      color: var(--vscode-textLink-foreground);
    }
    .gateway-detail {
      display: none;
      margin-top: 4px;
      overflow-wrap: anywhere;
      opacity: 0.72;
      font-size: 11px;
    }
    .gateway-detail.visible {
      display: block;
    }
    .gateway-actions {
      display: flex;
      gap: 6px;
    }
    .gateway-actions button {
      padding: 5px 8px;
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
    .messages {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 8px;
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
  <div class="chat-header">
    <button id="toggle-chats" title="Open chat history">Chats</button>
    <div id="active-chat-title" class="chat-title">New chat</div>
    <button id="new-chat" title="Start a new chat">New chat</button>
  </div>
  <div id="chat-panel" class="chat-panel">
    <div id="chat-list" class="chat-list"></div>
  </div>
  <div class="toolbar">
    <div class="toolbar-left">
      <select id="provider" aria-label="Provider">
        ${providerOption("auto", "Auto - multi AI", defaultProvider)}
        ${providerOption("step-agent", "Step Agent", defaultProvider)}
        ${providerOption("opencode", "OpenCode Agent", defaultProvider)}
        ${providerOption("cerebras", "Cerebras", defaultProvider)}
        ${providerOption("gemini", "Gemini", defaultProvider)}
        ${providerOption("gemini-fast", "Gemini Fast", defaultProvider)}
        ${providerOption("groq", "Groq", defaultProvider)}
        ${providerOption("openrouter", "OpenRouter", defaultProvider)}
        ${providerOption("gemma", "Gemma Local", defaultProvider)}
        ${providerOption("ollama", "Ollama", defaultProvider)}
      </select>
    </div>
  </div>
  <div class="gateway-panel">
    <div class="gateway-panel-header">
      <div>
        <div id="gateway-status" class="gateway-status">Gateway: not checked</div>
        <div id="gateway-detail" class="gateway-detail"></div>
      </div>
      <div class="gateway-actions">
        <button id="gateway-check" title="Check local gateway health">Check</button>
        <button id="gateway-start" title="Start fcc-server">Start</button>
      </div>
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
    <button id="send" title="Send message (Enter)" aria-label="Send message">Send</button>
  </div>
  <div id="messages" class="messages"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const providerEl = document.getElementById("provider");
    const messagesEl = document.getElementById("messages");
    const sendEl = document.getElementById("send");
    const addFileEl = document.getElementById("add-file");
    const attachedFilesEl = document.getElementById("attached-files");
    const toggleChatsEl = document.getElementById("toggle-chats");
    const newChatEl = document.getElementById("new-chat");
    const chatPanelEl = document.getElementById("chat-panel");
    const chatListEl = document.getElementById("chat-list");
    const activeChatTitleEl = document.getElementById("active-chat-title");
    const routeLineEl = document.getElementById("route-line");
    const providerListEl = document.getElementById("provider-list");
    const statusProvidersEl = document.getElementById("status-providers");
    const testProvidersEl = document.getElementById("test-providers");
    const refreshModelsEl = document.getElementById("refresh-models");
    const gatewayStatusEl = document.getElementById("gateway-status");
    const gatewayDetailEl = document.getElementById("gateway-detail");
    const gatewayCheckEl = document.getElementById("gateway-check");
    const gatewayStartEl = document.getElementById("gateway-start");
    let chatState = ${initialChatState};
    let activeChatId = chatState.activeChatId || "";
    let providerStatusEntries = ${initialProviders};
    let gatewayStatus = ${initialGatewayStatus};
    let attachedFiles = [];
    
    toggleChatsEl.addEventListener("click", () => {
      chatPanelEl.classList.toggle("visible");
    });
    newChatEl.addEventListener("click", () => {
      chatPanelEl.classList.remove("visible");
      vscode.postMessage({ type: "newChat" });
    });
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
    gatewayCheckEl.addEventListener("click", () => {
      vscode.postMessage({ type: "checkGateway" });
    });
    gatewayStartEl.addEventListener("click", () => {
      vscode.postMessage({ type: "startGateway" });
    });
    sendEl.addEventListener("click", send);
    promptEl.addEventListener("keydown", handlePromptSubmitKey, true);
    promptEl.addEventListener("keypress", handlePromptSubmitKey, true);
    window.addEventListener("keydown", handlePromptSubmitKey, true);
    window.addEventListener("keypress", handlePromptSubmitKey, true);

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "status") {
        setStatus(message.text);
      }
      if (message.type === "answer") {
        clearStatus();
        if (message.chatState) {
          updateChatState(message.chatState, false);
        }
        if (!message.chatId || message.chatId === activeChatId) {
          const item = addMessage("ai", message.text);
          if (message.edits && message.edits.length) {
            attachEditActions(item, message.edits);
          }
        }
        sendEl.disabled = false;
      }
      if (message.type === "error") {
        clearStatus();
        if (message.chatState) {
          updateChatState(message.chatState, false);
        }
        if (!message.chatId || message.chatId === activeChatId) {
          addMessage("error", message.text);
        }
        sendEl.disabled = false;
      }
      if (message.type === "chatState") {
        updateChatState(message.state, true);
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
      if (message.type === "gatewayStatus") {
        gatewayStatus = message.status || gatewayStatus;
        renderGatewayStatus(gatewayStatus);
      }
      
    });
    updateChatState(chatState, true);
    renderProviderStatus();
    renderGatewayStatus(gatewayStatus);
    

    function send() {
      if (sendEl.disabled) return;
      const basePrompt = promptEl.value.trim();
      if (!basePrompt && attachedFiles.length === 0) return;
      const prompt = buildPromptWithFiles(basePrompt);
      const displayPrompt = buildDisplayPrompt(basePrompt);

      addMessage("user", displayPrompt);
      rememberLocalMessage("user", displayPrompt);

      setStatus("Thinking...");
      sendEl.disabled = true;
      vscode.postMessage({
        type: "ask",
        prompt,
        displayPrompt,
        attachedFiles: attachedFiles.map(file => ({ name: file.name, path: file.path })),
        provider: providerEl.value,
        chatId: activeChatId
      });
      promptEl.value = "";
      attachedFiles = [];
      renderAttachedFiles();
    }

    function handlePromptSubmitKey(event) {
      if (event.target && event.target !== promptEl) return;
      if (!isPromptSubmitKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      send();
    }

    function isPromptSubmitKey(event) {
      const key = String(event.key || "").toLowerCase();
      const code = String(event.code || "").toLowerCase();
      const keyCode = event.keyCode || event.which;
      const isEnter = key === "enter"
        || key === "numpadenter"
        || code === "enter"
        || code === "numpadenter"
        || keyCode === 13;
      const isComposing = event.isComposing || keyCode === 229;
      return isEnter && !event.shiftKey && !isComposing;
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

    function renderGatewayStatus(status) {
      const current = status || {};
      const state = current.state || "unknown";
      gatewayStatusEl.className = "gateway-status " + state;
      gatewayStatusEl.textContent = current.text || "Gateway: not checked";
      gatewayDetailEl.textContent = current.detail || "";
      gatewayDetailEl.classList.toggle("visible", Boolean(current.detail));
      gatewayStartEl.disabled = state === "starting" || state === "ready";
      gatewayCheckEl.disabled = state === "checking" || state === "starting";
    }

    function getActiveChat() {
      return (chatState.chats || []).find((chat) => chat.id === activeChatId) || null;
    }

    function rememberLocalMessage(role, text) {
      const chat = getActiveChat();
      if (!chat) return;
      const timestamp = new Date().toISOString();
      chat.messages = chat.messages || [];
      chat.messages.push({
        role,
        text,
        timestamp
      });
      chat.updatedAt = timestamp;
      if (role === "user" && chat.messages.filter((message) => message.role === "user").length === 1) {
        chat.title = makeLocalChatTitle(text);
        activeChatTitleEl.textContent = chat.title;
      }
      renderChatList();
    }

    function updateChatState(nextState, renderMessages) {
      if (!nextState || !Array.isArray(nextState.chats)) return;
      chatState = nextState;
      activeChatId = nextState.activeChatId || "";
      renderChatList();
      const chat = getActiveChat();
      activeChatTitleEl.textContent = chat ? chat.title : "New chat";
      if (renderMessages) {
        renderActiveChat();
      }
    }

    function requestDeleteChat(chat) {
      if (!chat) return;
      vscode.postMessage({ type: "deleteChat", chatId: chat.id });
    }

    function renderChatList() {
      chatListEl.textContent = "";
      (chatState.chats || []).forEach((chat) => {
        const row = document.createElement("div");
        row.className = "chat-item-row";

        const item = document.createElement("button");
        item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");
        item.type = "button";

        const title = document.createElement("span");
        title.className = "chat-item-title";
        title.textContent = chat.title || "New chat";

        const meta = document.createElement("span");
        meta.className = "chat-item-meta";
        const count = Array.isArray(chat.messages) ? chat.messages.length : 0;
        const date = chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : "";
        meta.textContent = count + " messages" + (date ? " - " + date : "");

        item.appendChild(title);
        item.appendChild(meta);
        item.addEventListener("click", () => {
          chatPanelEl.classList.remove("visible");
          vscode.postMessage({ type: "selectChat", chatId: chat.id });
        });

        const deleteButton = document.createElement("button");
        deleteButton.className = "chat-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.title = "Delete this chat permanently";
        deleteButton.setAttribute("aria-label", "Delete chat");
        deleteButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          requestDeleteChat(chat);
        });

        row.appendChild(item);
        row.appendChild(deleteButton);
        chatListEl.appendChild(row);
      });
    }

    function renderActiveChat() {
      messagesEl.textContent = "";
      const chat = getActiveChat();
      const entries = chat && Array.isArray(chat.messages) ? chat.messages : [];
      if (entries.length === 0) {
        addMessage("status empty-history", "Start a new conversation.");
        return;
      }

      entries.forEach((entry) => {
        addMessage(entry.role === "assistant" ? "ai" : entry.role, entry.text);
      });
    }

    function makeLocalChatTitle(text) {
      const firstLine = String(text || "").split(/\\r?\\n/).find((line) => line.trim()) || "New chat";
      const compact = firstLine.replace(/\\s+/g, " ").trim();
      return compact.length > 48 ? compact.slice(0, 45) + "..." : compact;
    }

    function addMessage(kind, text) {
      if (kind === "user" || kind === "ai" || kind === "error") {
        const empty = messagesEl.querySelector(".empty-history");
        if (empty) empty.remove();
      }
      const item = document.createElement("div");
      item.className = "msg " + kind;
      item.textContent = text;
      messagesEl.appendChild(item);
      item.scrollIntoView({ block: "end" });
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
      messagesEl.appendChild(item);
      item.scrollIntoView({ block: "end" });
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

function createChatId() {
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createChatTitle(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "New chat";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

function createChatRecord(title = "New chat", messages = []) {
  const normalizedMessages = normalizeHistory(messages);
  const now = new Date().toISOString();
  return {
    id: createChatId(),
    title: String(title || "New chat"),
    createdAt: normalizedMessages[0]?.timestamp || now,
    updatedAt: normalizedMessages[normalizedMessages.length - 1]?.timestamp || now,
    messages: normalizedMessages
  };
}

function normalizeChatStore(value) {
  const source = value && Array.isArray(value.chats) ? value.chats : [];
  const seen = new Set();
  const chats = [];

  for (const item of source) {
    if (!item || !Array.isArray(item.messages)) {
      continue;
    }
    let id = String(item.id || createChatId());
    if (seen.has(id)) {
      id = createChatId();
    }
    seen.add(id);

    const messages = normalizeHistory(item.messages);
    const createdAt = item.createdAt || messages[0]?.timestamp || new Date().toISOString();
    const updatedAt = item.updatedAt || messages[messages.length - 1]?.timestamp || createdAt;
    chats.push({
      id,
      title: String(item.title || createChatTitle(messages.find((message) => message.role === "user")?.text)),
      createdAt,
      updatedAt,
      messages
    });
  }

  if (chats.length === 0) {
    chats.push(createChatRecord());
  }

  const requestedActiveId = String(value?.activeChatId || "");
  const activeChatId = chats.some((chat) => chat.id === requestedActiveId)
    ? requestedActiveId
    : chats[0].id;

  return {
    activeChatId,
    chats
  };
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

function appendConversationContext(currentPrompt, messages) {
  const candidates = normalizeHistory(messages)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-CHAT_CONTEXT_MESSAGE_LIMIT);
  if (candidates.length === 0) {
    return String(currentPrompt || "");
  }

  const selected = [];
  let usedChars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const remaining = CHAT_CONTEXT_CHAR_LIMIT - usedChars;
    if (remaining <= 0) {
      break;
    }
    const text = String(message.text || "");
    const clipped = text.length > remaining ? text.slice(text.length - remaining) : text;
    selected.unshift({
      role: message.role,
      text: clipped
    });
    usedChars += clipped.length;
  }

  const transcript = selected
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`)
    .join("\n\n");

  return [
    "Continue the saved conversation below. Use it as context and do not claim that you forgot earlier messages.",
    "",
    "--- SAVED CHAT CONTEXT ---",
    transcript,
    "--- END SAVED CHAT CONTEXT ---",
    "",
    "Current user request:",
    String(currentPrompt || "")
  ].join("\n");
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function splitCommandLine(value) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;

  while ((match = pattern.exec(String(value || ""))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }

  return tokens;
}

function spawnDetachedProcess(commandLine, options = {}) {
  const [command, ...args] = splitCommandLine(commandLine);
  if (!command) {
    throw new Error("Command is empty.");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;

    try {
      child = spawn(command, args, {
        detached: true,
        env: {
          ...process.env,
          ...(options.env || {})
        },
        stdio: "ignore",
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}

async function stopOllamaProcesses() {
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/IM", "ollama.exe", "/F", "/T"], {
        windowsHide: true
      });
    } else {
      await execFileAsync("pkill", ["-x", "ollama"]);
    }
  } catch {
    // No running Ollama process is fine; the next health check will validate startup.
  }
  await sleep(1000);
}

function getDefaultOllamaCommand() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const installedExe = path.join(localAppData, "Programs", "Ollama", "ollama.exe");
      if (fs.existsSync(installedExe)) {
        return `"${installedExe}" serve`;
      }
    }
  }
  return DEFAULT_OLLAMA_COMMAND;
}

function normalizeOllamaCommand(command) {
  const value = String(command || "").trim();
  const lower = value.toLowerCase();
  if (!value || lower === "ollama" || lower === DEFAULT_OLLAMA_COMMAND) {
    return getDefaultOllamaCommand();
  }
  return value;
}

function getOllamaStartEnv(config = {}) {
  const modelDir = String(config.ollamaModelsDirectory || "").trim();
  return modelDir ? { OLLAMA_MODELS: modelDir } : {};
}

function normalizeRequiredOllamaModel(model) {
  const value = String(model || "").trim();
  if (!value) {
    return "";
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("ollama/")) {
    return normalizeOllamaApiModel(value);
  }
  if (lower.startsWith("ollama:")) {
    return value.slice("ollama:".length).trim();
  }
  return value.includes("/") ? "" : value;
}

function addRequiredOllamaModel(models, model) {
  const normalized = normalizeRequiredOllamaModel(model);
  if (normalized && !models.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
    models.push(normalized);
  }
}

function normalizeRequiredOllamaModels(models) {
  const result = [];
  for (const model of Array.isArray(models) ? models : [models]) {
    addRequiredOllamaModel(result, model);
  }
  return result;
}

function getProviderOllamaModels(provider, config = {}) {
  const models = [];
  if (!provider) {
    return models;
  }

  if (provider.id === STEP_AGENT_PROVIDER) {
    addRequiredOllamaModel(models, config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL);
    const planner = selectStepAgentPlannerProvider({
      config,
      catalog: buildProviderCatalog(config),
      providerState: {}
    });
    if (planner && planner.id !== STEP_AGENT_PROVIDER) {
      for (const model of getProviderOllamaModels(planner, config)) {
        addRequiredOllamaModel(models, model);
      }
    }
    return models;
  }

  const selectedModel = provider.id === OPENCODE_PROVIDER
    ? (config.openCodeModel || provider.model || OPENCODE_MODEL)
    : provider.id === "ollama"
      ? (config.localCoderModel || provider.model || DEFAULT_LOCAL_CODER_MODEL)
      : provider.model;
  addRequiredOllamaModel(models, selectedModel);

  if (provider.id === OPENCODE_PROVIDER && config.openCodeFallbackToOllama !== false) {
    addRequiredOllamaModel(models, config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL);
  }

  return models;
}

function getRequiredOllamaModels(config = {}, catalog = [], extraModels = []) {
  const models = normalizeRequiredOllamaModels(extraModels);

  for (const provider of Array.isArray(catalog) ? catalog : []) {
    if (provider?.enabled === false) {
      continue;
    }
    for (const model of getProviderOllamaModels(provider, config)) {
      addRequiredOllamaModel(models, model);
    }
  }

  for (const model of getProviderOllamaModels({
    id: OPENCODE_PROVIDER,
    model: config.openCodeModel || OPENCODE_MODEL
  }, config)) {
    addRequiredOllamaModel(models, model);
  }

  return models;
}

function formatOllamaModelStatusError(status = {}, config = {}) {
  const missing = Array.isArray(status.missing) ? status.missing.filter(Boolean) : [];
  const modelDir = String(config.ollamaModelsDirectory || "").trim();
  const repairHint = missing.length > 0
    ? ` Run .\\scripts\\Repair-OllamaLocalModels.ps1 -Model ${missing[0]}.`
    : "";
  const restartHint = modelDir
    ? ` Restart Ollama with OLLAMA_MODELS=${modelDir}.`
    : " Configure freeAiConsole.ollamaModelsDirectory or restart Ollama with the correct OLLAMA_MODELS value.";

  if (missing.length > 0) {
    return `Required Ollama model(s) are not visible to the active server: ${missing.join(", ")}.${restartHint}${repairHint}`;
  }

  return `Could not verify Ollama model storage.${status.error ? ` ${status.error}` : ""}${restartHint}`;
}

function isLocalServiceUrl(value) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\b/i.test(String(value || ""));
}

async function getGatewayHealth(gatewayUrl, timeoutMs = GATEWAY_HEALTH_TIMEOUT_MS) {
  const url = `${String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/$/, "")}/health`;

  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    const raw = await response.text();
    let status = "";
    try {
      const json = raw ? JSON.parse(raw) : {};
      status = String(json.status || json.ok || "");
    } catch {
      status = raw;
    }

    const healthy = response.ok && (!status || /healthy|ok|true/i.test(status));
    return {
      ok: healthy,
      detail: raw || `HTTP ${response.status}`,
      error: healthy ? "" : raw || `Gateway health failed: HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      detail: "",
      error: getErrorMessage(error)
    };
  }
}

async function getOllamaHealth(ollamaUrl, timeoutMs = GATEWAY_HEALTH_TIMEOUT_MS) {
  const url = `${String(ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, "")}/api/version`;

  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    const raw = await response.text();
    return {
      ok: response.ok,
      detail: raw || `HTTP ${response.status}`,
      error: response.ok ? "" : raw || `Ollama health failed: HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      detail: "",
      error: getErrorMessage(error)
    };
  }
}

async function getOllamaModelStatus(ollamaUrl, requiredModels = [], timeoutMs = GATEWAY_HEALTH_TIMEOUT_MS) {
  const required = normalizeRequiredOllamaModels(requiredModels);
  if (required.length === 0) {
    return {
      ok: true,
      required: [],
      missing: [],
      models: [],
      error: ""
    };
  }

  const url = `${String(ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, "")}/api/tags`;
  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        required,
        missing: [],
        models: [],
        error: raw || `Ollama model list failed: HTTP ${response.status}`
      };
    }

    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      return {
        ok: false,
        required,
        missing: [],
        models: [],
        error: "Ollama returned an invalid model list."
      };
    }

    const models = Array.isArray(json.models)
      ? json.models.map((model) => normalizeRequiredOllamaModel(model?.name || model?.model)).filter(Boolean)
      : [];
    const visible = new Set(models.map((model) => model.toLowerCase()));
    const missing = required.filter((model) => !visible.has(model.toLowerCase()));

    return {
      ok: missing.length === 0,
      required,
      missing,
      models,
      error: missing.length > 0 ? `Missing model(s): ${missing.join(", ")}` : ""
    };
  } catch (error) {
    return {
      ok: false,
      required,
      missing: [],
      models: [],
      error: getErrorMessage(error)
    };
  }
}

async function waitForGatewayHealth(gatewayUrl, timeoutMs = GATEWAY_STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || GATEWAY_STARTUP_TIMEOUT_MS);
  let last = {
    ok: false,
    error: "Gateway was not checked."
  };

  while (Date.now() < deadline) {
    last = await getGatewayHealth(gatewayUrl);
    if (last.ok) {
      return last;
    }
    await sleep(500);
  }

  return last;
}

async function waitForOllamaHealth(ollamaUrl, timeoutMs = OLLAMA_STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || OLLAMA_STARTUP_TIMEOUT_MS);
  let last = {
    ok: false,
    error: "Ollama was not checked."
  };

  while (Date.now() < deadline) {
    last = await getOllamaHealth(ollamaUrl);
    if (last.ok) {
      return last;
    }
    await sleep(500);
  }

  return last;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyGatewayModel(gatewayUrl, model, timeoutMs = DISCOVERY_TIMEOUT_MS) {
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

  const response = await fetchWithTimeout(`${gatewayUrl}/admin/api/config/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`Could not switch model: HTTP ${response.status}`);
  }
}

async function testProviderAvailability(config, provider) {
  const selectedModel = provider.id === "ollama"
    ? (config.localCoderModel || provider.model)
    : provider.model;

  if (String(selectedModel || "").startsWith("ollama/")) {
    const answer = await askOllamaDirect(
      config.ollamaUrl || DEFAULT_OLLAMA_URL,
      selectedModel,
      "Reply with exactly OK.",
      4,
      config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    );
    return answer || "local model responded";
  }

  if (provider.id === OPENCODE_PROVIDER) {
    const local = providerRequiresOllama(provider, config) ? "local Ollama model" : "configured model";
    return `${normalizeOpenCodeCommand(config.openCodeCommand)} configured with ${local}; chat smoke test skipped`;
  }

  if (provider.id === STEP_AGENT_PROVIDER) {
    const planner = selectStepAgentPlannerProvider({
      config,
      catalog: buildProviderCatalog(config),
      providerState: {}
    });
    const plannerLabel = planner?.label || "fallback planner";
    return `Step Agent configured: ${plannerLabel} planner -> ${config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL} worker; multi-step smoke test skipped`;
  }

  const gatewayProviderId = getGatewayProviderTestId(provider);
  if (gatewayProviderId) {
    return testGatewayProviderAvailability(config, gatewayProviderId, provider);
  }

  return askFreeProvider(config, provider, "Reply with exactly OK.", 40);
}

function getGatewayProviderTestId(providerOrId) {
  const id = typeof providerOrId === "string" ? providerOrId : providerOrId?.id;
  const map = {
    openrouter: "open_router",
    "gemini-fast": "gemini",
    gemini: "gemini",
    groq: "groq",
    cerebras: "cerebras"
  };
  return map[id] || "";
}

async function testGatewayProviderAvailability(config, gatewayProviderId, provider) {
  const response = await fetchWithTimeout(
    `${config.gatewayUrl}/admin/api/providers/${gatewayProviderId}/test`,
    { method: "POST" },
    config.requestTimeoutMs || PROVIDER_TEST_TIMEOUT_MS
  );

  const raw = await response.text();
  let result = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = { raw };
  }

  if (!response.ok || result.ok === false) {
    throw new Error(result.error_type || result.error || raw || `Provider test failed: HTTP ${response.status}`);
  }

  const models = Array.isArray(result.models) ? result.models.map(String) : [];
  if (models.length === 0) {
    return "provider reachable; no model list returned";
  }

  const expected = normalizeGatewayModelName(provider.model);
  const modelVisible = !expected || models.some((model) => normalizeGatewayModelName(model) === expected);
  if (!modelVisible) {
    throw new Error(`Provider reachable, but configured model "${provider.model}" was not listed`);
  }

  return `${models.length} model(s), configured model visible`;
}

function normalizeGatewayModelName(value) {
  return String(value || "")
    .trim()
    .replace(/^(open_router|gemini|groq|cerebras)\//i, "")
    .toLowerCase();
}

async function askFreeProvider(config, provider, prompt, maxTokens = 1400) {
  const selectedModel = provider.id === "ollama"
    ? (config.localCoderModel || provider.model)
    : provider.model;
  if (String(selectedModel || "").startsWith("ollama/")) {
    return askOllamaDirect(
      config.ollamaUrl || DEFAULT_OLLAMA_URL,
      selectedModel,
      prompt,
      maxTokens,
      config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    );
  }
  await applyGatewayModel(config.gatewayUrl, selectedModel);
  return askGateway(
    config.gatewayUrl,
    config.authToken,
    prompt,
    maxTokens,
    config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
  );
}

async function askOllamaDirect(
  ollamaUrl,
  model,
  prompt,
  maxTokens = 1400,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
) {
  const apiModel = normalizeOllamaApiModel(model);
  const response = await fetchWithTimeout(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: apiModel,
      stream: false,
      options: {
        num_ctx: 2048,
        num_predict: maxTokens
      },
      messages: [
        {
          role: "system",
          content: getFreeAiSystemPrompt()
        },
        {
          role: "user",
          content: String(prompt || "")
        }
      ]
    })
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatOllamaError(text, apiModel, response.status));
  }

  const json = await response.json();
  return String(json?.message?.content || json?.response || "").trim();
}

async function askOpenCode(options) {
  const {
    command,
    model,
    localModel,
    authToken,
    prompt,
    fallbackToOllama,
    ensureOllama,
    timeoutMs
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
      cwd: workspaceFolder.uri.fsPath,
      timeoutMs
    });
  } catch (error) {
    if (!fallbackToOllama || !isQuotaOrRateLimitError(getErrorMessage(error))) {
      throw error;
    }
    const fallbackModel = normalizeOpenCodeOllamaModel(localModel || DEFAULT_LOCAL_CODER_MODEL);
    if (typeof ensureOllama === "function") {
      const ollama = await ensureOllama(fallbackModel);
      if (ollama?.state !== "ready") {
        throw new Error(`OpenCode fallback needs local Ollama. ${ollama?.text || "Ollama is not ready"}${ollama?.detail ? `: ${ollama.detail}` : ""}`);
      }
    }
    return runOpenCode({
      command,
      model: fallbackModel,
      authToken,
      prompt: agentPrompt,
      cwd: workspaceFolder.uri.fsPath,
      timeoutMs
    });
  }
}

async function runOpenCode(options) {
  const { command, model, authToken, prompt, cwd, timeoutMs } = options;
  const runArgs = getOpenCodeRunArgs(prompt, model || OPENCODE_MODEL);
  const invocation = getOpenCodeProcessInvocation(command, runArgs);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: authToken || "freecc",
        NO_COLOR: "1"
      },
      maxBuffer: 1024 * 1024 * 8,
      timeout: timeoutMs || 180000,
      windowsHide: true
    }
  );

  const output = parseOpenCodeRunOutput(stdout) || cleanTerminalText(stdout || "").trim();
  const errorOutput = cleanTerminalText(stderr || "").trim();
  const text = output || errorOutput || "(OpenCode finished without text output)";
  if (isQuotaOrRateLimitError(text)) {
    throw new Error(text);
  }
  return text;
}

function getOpenCodeRunArgs(prompt, model) {
  return ["run", String(prompt || ""), "-m", model || OPENCODE_MODEL, "--format", "json"];
}

function isWindowsCommandShim(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command || ""));
}

function getOpenCodeProcessInvocation(command, args = []) {
  const normalizedCommand = normalizeOpenCodeCommand(command);
  if (!isWindowsCommandShim(normalizedCommand)) {
    return {
      command: normalizedCommand,
      args
    };
  }

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", normalizedCommand, ...args]
  };
}

async function runStepAgent(options = {}) {
  const userPrompt = String(options.userPrompt || "").trim();
  const maxSteps = clampInteger(options.maxSteps, 2, 10);
  const repairPasses = clampInteger(options.repairPasses, 0, 2);
  const stepMaxTokens = clampInteger(options.stepMaxTokens, 200, 3000);
  const workerModel = options.workerModel || DEFAULT_LOCAL_CODER_MODEL;
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const plannerLabel = options.planner?.label || formatProviderName(options.planner?.id) || "Fallback planner";

  if (!userPrompt) {
    throw new Error("Step Agent needs a prompt.");
  }
  if (typeof options.askWorker !== "function") {
    throw new Error("Step Agent needs a local Ollama worker.");
  }

  let rawPlan = "";
  let planError = "";
  if (typeof options.askPlanner === "function") {
    try {
      onStatus("Step Agent: planning small Ollama steps...");
      rawPlan = await options.askPlanner(buildStepAgentPlanPrompt(userPrompt, maxSteps));
    } catch (error) {
      planError = getErrorMessage(error);
    }
  }

  const parsedPlan = parseStepAgentPlan(rawPlan, maxSteps);
  const plan = parsedPlan || createFallbackStepAgentPlan(userPrompt, maxSteps);
  const planSource = parsedPlan ? plannerLabel : "fallback plan";
  const stepResults = [];

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    onStatus(`Step Agent: step ${index + 1}/${plan.steps.length} - ${step.title}...`);
    try {
      const output = await options.askWorker(
        buildStepAgentWorkerPrompt({
          userPrompt,
          plan,
          step,
          stepIndex: index,
          previousResults: stepResults
        }),
        stepMaxTokens
      );
      stepResults.push({
        title: step.title,
        output: String(output || "").trim() || "(empty step output)",
        error: ""
      });
    } catch (error) {
      stepResults.push({
        title: step.title,
        output: "",
        error: getErrorMessage(error)
      });
      break;
    }
  }

  let verification = "";
  const hadStepError = stepResults.some((result) => result.error);
  if (!hadStepError && stepResults.length > 0) {
    try {
      onStatus("Step Agent: verifying the step results...");
      verification = await options.askWorker(
        buildStepAgentVerificationPrompt({ userPrompt, plan, stepResults }),
        STEP_AGENT_VERIFY_MAX_TOKENS
      );
    } catch (error) {
      verification = `VERDICT: NEEDS_FIX\nVerification failed: ${getErrorMessage(error)}`;
    }
  }

  const repairs = [];
  if (!hadStepError && shouldRunStepAgentRepair(verification)) {
    for (let pass = 0; pass < repairPasses; pass += 1) {
      try {
        onStatus(`Step Agent: repair pass ${pass + 1}/${repairPasses}...`);
        const repair = await options.askWorker(
          buildStepAgentRepairPrompt({
            userPrompt,
            plan,
            stepResults,
            verification,
            pass
          }),
          stepMaxTokens
        );
        repairs.push(String(repair || "").trim());
        break;
      } catch (error) {
        repairs.push(`Repair pass failed: ${getErrorMessage(error)}`);
        break;
      }
    }
  }

  return formatStepAgentResult({
    plan,
    planSource,
    plannerLabel,
    planError,
    workerModel,
    stepResults,
    verification,
    repairs
  });
}

function buildStepAgentPlanPrompt(userPrompt, maxSteps) {
  return [
    "You are a planner for a VS Code chat extension.",
    "Break the user's request into small, ordered tasks for a local Ollama worker.",
    `Return JSON only, with at most ${maxSteps} steps.`,
    "Schema:",
    '{"goal":"short goal","steps":[{"title":"short title","instruction":"specific worker instruction","expected":"what should be true after this step"}],"verification":["checks to run mentally after the steps"]}',
    "Rules:",
    "- Keep every step small enough for a weak local model.",
    "- Do not ask the worker to read the whole project unless the user attached or named files.",
    "- If file edits are requested, remind the worker to return complete replacements in the provided edit block format.",
    "- Prefer useful progress over a perfect giant answer.",
    "",
    "User request:",
    userPrompt
  ].join("\n");
}

function parseStepAgentPlan(raw, maxSteps) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) {
    return null;
  }
  try {
    return normalizeStepAgentPlan(JSON.parse(jsonText), maxSteps);
  } catch {
    return null;
  }
}

function extractJsonObjectText(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return "";
  }
  return candidate.slice(start, end + 1);
}

function normalizeStepAgentPlan(value, maxSteps) {
  const limit = clampInteger(maxSteps, 2, 10);
  const rawSteps = Array.isArray(value?.steps) ? value.steps : [];
  const steps = rawSteps
    .map((step, index) => normalizeStepAgentStep(step, index))
    .filter((step) => step.instruction)
    .slice(0, limit);

  if (steps.length === 0) {
    return null;
  }

  return {
    goal: clipText(value?.goal || "Complete the user request step by step.", 400),
    steps,
    verification: normalizeStringList(value?.verification).slice(0, 6)
  };
}

function normalizeStepAgentStep(step, index) {
  if (typeof step === "string") {
    return {
      title: `Step ${index + 1}`,
      instruction: clipText(step, 1200),
      expected: ""
    };
  }

  const title = clipText(step?.title || step?.name || `Step ${index + 1}`, 80);
  const instruction = clipText(step?.instruction || step?.task || step?.prompt || step?.description || "", 1200);
  const expected = clipText(step?.expected || step?.result || step?.doneWhen || "", 400);
  return {
    title: title || `Step ${index + 1}`,
    instruction,
    expected
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clipText(item, 300)).filter(Boolean);
  }
  const text = String(value || "").trim();
  return text ? [clipText(text, 300)] : [];
}

function createFallbackStepAgentPlan(userPrompt, maxSteps) {
  const steps = [
    {
      title: "Understand the request",
      instruction: "Restate the concrete deliverable, constraints, and the smallest useful output for the user request.",
      expected: "The worker knows exactly what must be produced."
    },
    {
      title: "Draft the solution",
      instruction: "Create the main answer or implementation in a compact form. If code is needed, produce complete runnable snippets instead of vague advice.",
      expected: "A first complete solution exists."
    },
    {
      title: "Check for bugs",
      instruction: "Review the draft for missing requirements, syntax mistakes, runtime problems, and usability issues. Point out fixes or produce corrected content.",
      expected: "Obvious defects are found and corrected."
    },
    {
      title: "Final assembly",
      instruction: "Combine the corrected work into the final response the user can use.",
      expected: "The final answer is coherent and complete."
    }
  ].slice(0, clampInteger(maxSteps, 2, 10));

  return {
    goal: clipText(`Complete this request without one giant Ollama prompt: ${userPrompt}`, 400),
    steps,
    verification: [
      "The final answer satisfies the original request.",
      "No step contradicts an earlier step.",
      "Code, if present, is complete enough to run or paste."
    ]
  };
}

function buildStepAgentWorkerPrompt(options = {}) {
  const previous = formatPreviousStepResults(options.previousResults || []);
  const step = options.step || {};
  return [
    "You are the local Ollama worker inside a step-by-step agent loop.",
    "Work only on the current step. Keep the answer focused and avoid repeating the whole conversation.",
    "If the user asks for file edits, return COMPLETE replacement content only inside this exact block:",
    '<free_ai_file_edits><file path="exact attached file path">complete new file content</file></free_ai_file_edits>',
    "Do not claim that files were applied; VS Code will ask the user to confirm.",
    "",
    "Original user request:",
    options.userPrompt || "",
    "",
    "Overall goal:",
    options.plan?.goal || "",
    "",
    previous ? `Previous step results:\n${previous}\n` : "Previous step results:\n(none)\n",
    `Current step ${Number(options.stepIndex || 0) + 1}: ${step.title || "Step"}`,
    step.instruction || "",
    step.expected ? `Expected result: ${step.expected}` : "",
    "",
    "Return the useful work for this step. If you find a bug or missing requirement, explain the cause and the fix."
  ].filter((part) => part !== "").join("\n");
}

function formatPreviousStepResults(results) {
  return (Array.isArray(results) ? results : [])
    .map((result, index) => {
      const body = result.error
        ? `ERROR: ${result.error}`
        : clipText(result.output || "", 1800);
      return `Step ${index + 1} - ${result.title || "result"}:\n${body}`;
    })
    .join("\n\n");
}

function buildStepAgentVerificationPrompt(options = {}) {
  return [
    "You are verifying a step-by-step local Ollama result.",
    "Look for missing requirements, contradictions, syntax/runtime bugs, and unclear final output.",
    "Start with exactly one verdict line: VERDICT: PASS or VERDICT: NEEDS_FIX.",
    "If it needs fixing, explain the root cause and the smallest repair.",
    "",
    "Original user request:",
    options.userPrompt || "",
    "",
    "Plan:",
    formatStepAgentPlan(options.plan),
    "",
    "Step outputs:",
    formatPreviousStepResults(options.stepResults || [])
  ].join("\n");
}

function buildStepAgentRepairPrompt(options = {}) {
  return [
    "The verifier found issues in the step-by-step result.",
    "Produce the corrected final answer now. Keep it concise but complete.",
    "If file edits are needed, use the exact <free_ai_file_edits> format and complete replacement content.",
    "",
    "Original user request:",
    options.userPrompt || "",
    "",
    "Plan:",
    formatStepAgentPlan(options.plan),
    "",
    "Previous step outputs:",
    formatPreviousStepResults(options.stepResults || []),
    "",
    "Verifier feedback:",
    options.verification || ""
  ].join("\n");
}

function shouldRunStepAgentRepair(verification) {
  const text = String(verification || "");
  if (/VERDICT:\s*PASS/i.test(text)) {
    return false;
  }
  return /VERDICT:\s*NEEDS_FIX|needs[_ -]?fix|bug|error|missing|fail/i.test(text);
}

function formatStepAgentResult(result = {}) {
  const parts = [
    `Planner: ${result.planSource || result.plannerLabel || "fallback plan"}`,
    `Worker: ${result.workerModel || DEFAULT_LOCAL_CODER_MODEL}`,
    ""
  ];

  if (result.planError) {
    parts.push(`Planner fallback reason: ${result.planError}`, "");
  }

  parts.push("Plan:");
  parts.push(formatStepAgentPlan(result.plan));
  parts.push("");

  for (const [index, step] of (result.stepResults || []).entries()) {
    parts.push(`Step ${index + 1}: ${step.title || "Step"}`);
    if (step.error) {
      parts.push(`Step failed: ${step.error}`);
      break;
    }
    parts.push(clipText(step.output || "(empty step output)", 8000));
    parts.push("");
  }

  if (result.verification) {
    parts.push("Verification:");
    parts.push(clipText(result.verification, 3000));
    parts.push("");
  }

  for (const [index, repair] of (result.repairs || []).entries()) {
    parts.push(`Repair pass ${index + 1}:`);
    parts.push(clipText(repair || "(empty repair output)", 8000));
    parts.push("");
  }

  return parts.join("\n").trim();
}

function formatStepAgentPlan(plan = {}) {
  const lines = [];
  if (plan.goal) {
    lines.push(`Goal: ${plan.goal}`);
  }
  for (const [index, step] of (plan.steps || []).entries()) {
    const expected = step.expected ? ` Expected: ${step.expected}` : "";
    lines.push(`${index + 1}. ${step.title}: ${step.instruction}${expected}`);
  }
  if (Array.isArray(plan.verification) && plan.verification.length > 0) {
    lines.push(`Checks: ${plan.verification.join("; ")}`);
  }
  return lines.join("\n");
}

function selectStepAgentPlannerProvider(options = {}) {
  const config = options.config || {};
  const catalog = Array.isArray(options.catalog) ? options.catalog : buildProviderCatalog(config);
  const requested = String(config.stepAgentPlannerProvider || "auto").trim();
  const enabled = catalog.filter((provider) => provider.enabled !== false);

  if (requested && requested !== "auto") {
    const manual = catalog.find((provider) => provider.id === requested && provider.id !== STEP_AGENT_PROVIDER);
    if (manual) {
      return manual;
    }
  }

  const primary = firstReadyProviders(
    getAutoChatProviders(enabled).filter((provider) => provider.id !== STEP_AGENT_PROVIDER),
    options.providerState || {},
    1
  )[0];
  return primary || getPreferredLocalProvider(catalog);
}

function clipText(value, maxLength) {
  const text = String(value || "").trim();
  const limit = Math.max(1, Number(maxLength) || 1);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3).trim()}...`;
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function selectProviders(prompt, requestedProvider) {
  if (requestedProvider && requestedProvider !== "auto") {
    return [requestedProvider];
  }

  const lower = String(prompt || "").toLowerCase();

  if (shouldUseOpenCodeAgent(lower)) {
    return [OPENCODE_PROVIDER];
  }

  if (/gemma/i.test(lower)) {
    return ["gemma", "ollama", "cerebras"];
  }

  if (/(локально|офлайн|приват|без интернета|на ноуте)/i.test(lower)) {
    return ["ollama", "cerebras"];
  }

  if (/(offline|local|private|privacy|ollama|локально|офлайн|приват)/i.test(lower)) {
    return ["ollama", "cerebras"];
  }

  return getAutoChatProviders(providerCatalog).map((provider) => provider.id);
}

function shouldUseOpenCodeAgent(lowerPrompt) {
  if (/(проект|кодбейс|репозит[оа]р|прочитай файл|прочитай файлы|проверь проект|проверь код|исправ|измен|отредакт|рефактор)/i.test(lowerPrompt)) {
    return true;
  }
  return /(project|codebase|workspace|repo|repository|read files|check files|review project|fix|edit|change|modify|refactor|проект|кодбейс|репозитор|прочитай файл|прочитай файлы|проверь проект|проверь код|исправь|измени|отредактируй|рефактор)/i.test(lowerPrompt);
}

function selectRoute(options) {
  const { prompt, requestedProvider, autoMode, catalog, providerState, hasReferencedFiles } = options;
  const enabled = catalog.filter((provider) => provider.enabled);
  const localProvider = getPreferredLocalProvider(catalog);

  if (requestedProvider && requestedProvider !== "auto") {
    const manualProvider = catalog.find((provider) => provider.id === requestedProvider) || enabled[0] || catalog[0];
    const providers = manualProvider ? [manualProvider] : [];
    if (manualProvider?.role === "chat" && localProvider && localProvider.id !== manualProvider.id) {
      providers.push(localProvider);
    }
    return {
      mode: manualProvider?.id === STEP_AGENT_PROVIDER ? "Step Agent" : manualProvider?.role === "agent" ? "Agent" : manualProvider?.role === "local-fallback" ? "Local" : "Manual",
      reason: manualProvider?.role === "chat" ? "Manual provider selection with local fallback" : "Manual provider selection",
      providers,
      compare: false
    };
  }

  if (/\bgemma\b/i.test(String(prompt || ""))) {
    const gemmaProvider = catalog.find((provider) => provider.id === "gemma");
    if (gemmaProvider) {
      return {
        mode: "Local",
        reason: "Gemma was requested explicitly",
        providers: [gemmaProvider],
        compare: false
      };
    }
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
  if (intent.stepAgent) {
    const stepProvider = catalog.find((provider) => provider.id === STEP_AGENT_PROVIDER);
    return {
      mode: "Step Agent",
      reason: intent.reason,
      providers: stepProvider ? [stepProvider] : localProvider ? [localProvider] : [],
      compare: false
    };
  }

  if (intent.agent) {
    const agentProvider = catalog.find((provider) => provider.role === "agent");
    return {
      mode: "Agent",
      reason: intent.reason,
      providers: agentProvider ? [agentProvider] : localProvider ? [localProvider] : [],
      compare: false
    };
  }

  if (autoMode === "compare") {
    const compareProviders = firstReadyProviders(getAutoChatProviders(enabled), providerState, 4);
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

  const primary = firstReadyProviders(getAutoChatProviders(enabled), providerState, 1);
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
  const stepAgentIntent = hasStepAgentIntent(text);
  const cyrillicProjectWide = /(проект|кодбейс|репозит[оа]р|весь проект|всю папку|workspace)/i.test(text);
  const cyrillicEditIntent = /(исправ|измен|отредакт|рефактор|почин|добав|удал|перепиш)/i.test(text);
  const cyrillicLocalIntent = /(локально|офлайн|приват|без интернета|на ноуте)/i.test(text);
  const projectWide = /(project|codebase|workspace|repo|repository|whole project|entire project|проект|кодбейс|репозитор|весь проект|всю папку|workspace)/i.test(text);
  const editIntent = /(fix|edit|change|modify|refactor|apply|write|исправь|измени|отредактируй|рефактор|почини|добавь|удали|перепиши)/i.test(text);
  const localIntent = /(offline|local|private|privacy|ollama|gemma|локально|офлайн|приват|без интернета|на ноуте)/i.test(text);

  if (projectWide || cyrillicProjectWide) {
    return {
      agent: true,
      stepAgent: false,
      local: false,
      fileReview: false,
      reason: "Project-wide request needs OpenCode Agent"
    };
  }

  if (stepAgentIntent) {
    return {
      agent: false,
      stepAgent: true,
      local: false,
      fileReview: false,
      reason: "Build-style request is safer as small Ollama steps"
    };
  }

  if (editIntent || cyrillicEditIntent) {
    return {
      agent: true,
      stepAgent: false,
      local: false,
      fileReview: false,
      reason: "Edit/change request needs OpenCode Agent"
    };
  }

  if (localIntent || cyrillicLocalIntent) {
    return {
      agent: false,
      stepAgent: false,
      local: true,
      fileReview: false,
      reason: "Local/private/offline request"
    };
  }

  return {
    agent: false,
    stepAgent: false,
    local: false,
    fileReview: Boolean(hasReferencedFiles),
    reason: hasReferencedFiles ? "Named file context was auto-read" : "Simple chat request"
  };
}

function hasStepAgentIntent(text) {
  const value = String(text || "").toLowerCase();
  const explicit = /(step[-\s]?agent|step by step|small steps|orchestrator|planner)/i.test(value)
    || /(?:\u043f\u043e\u0448\u0430\u0433|\u0430\u0433\u0435\u043d\u0442|\u043e\u0440\u043a\u0435\u0441\u0442\u0440|\u043f\u043b\u0430\u043d\u0438\u0440)/i.test(value);
  const englishBuild = /(?:create|build|make|generate|write|implement|develop).{0,80}(?:calculator|app|website|page|component|script|tool|program|game)/i.test(value);
  const russianBuild = /(?:\u0441\u043e\u0437\u0434\u0430|\u0441\u0434\u0435\u043b\u0430|\u043d\u0430\u043f\u0438\u0448|\u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442|\u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440).{0,80}(?:\u043a\u0430\u043b\u044c\u043a\u0443\u043b\u044f\u0442\u043e\u0440|\u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d|\u0441\u0430\u0439\u0442|\u0441\u0442\u0440\u0430\u043d\u0438\u0446|\u0441\u043a\u0440\u0438\u043f\u0442|\u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442|\u0438\u0433\u0440)/i.test(value);
  return explicit || englishBuild || russianBuild;
}

function getPreferredLocalProvider(providers) {
  const localProviders = providers.filter((provider) => provider.role === "local-fallback" || provider.id === "ollama");
  return localProviders.find((provider) => provider.id === "ollama")
    || localProviders.find((provider) => normalizeOllamaApiModel(provider.model) === normalizeOllamaApiModel(DEFAULT_LOCAL_CODER_MODEL))
    || localProviders.sort((a, b) => a.priority - b.priority)[0];
}

function getAutoChatProviders(providers) {
  return providers
    .filter((provider) => provider.role === "chat" && provider.autoEnabled !== false)
    .sort((a, b) => a.priority - b.priority);
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

function parseOpenCodeRunOutput(value) {
  const parts = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed);
      const text = event?.part?.type === "text" ? event.part.text : "";
      if (typeof text === "string" && text) {
        parts.push(text);
      }
    } catch {
      // Ignore non-JSON progress lines from older OpenCode versions.
    }
  }
  return parts.join("").trim();
}

function cleanTerminalText(value) {
  const cleaned = String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/.\u0008/g, "")
    .trim();
  return cleaned
    .split(/\r?\n/)
    .filter((line) => !/^[\s\u2800-\u28ff]+$/.test(line))
    .join("\n")
    .trim();
}

function providerUsesGateway(provider, config = {}) {
  if (!provider) {
    return false;
  }
  if (provider.id === STEP_AGENT_PROVIDER) {
    const planner = selectStepAgentPlannerProvider({
      config,
      catalog: buildProviderCatalog(config),
      providerState: {}
    });
    return planner && planner.id !== STEP_AGENT_PROVIDER
      ? providerUsesGateway(planner, config)
      : false;
  }
  const model = provider.id === OPENCODE_PROVIDER
    ? (config.openCodeModel || provider.model)
    : provider.id === "ollama"
      ? (config.localCoderModel || provider.model)
      : provider.model;
  return !String(model || "").startsWith("ollama/");
}

function providerUsesOllama(provider, config = {}) {
  if (!provider) {
    return false;
  }
  if (provider.id === STEP_AGENT_PROVIDER) {
    return true;
  }
  if (provider.id === OPENCODE_PROVIDER) {
    return String(config.openCodeModel || provider.model || "").startsWith("ollama/")
      || Boolean(config.openCodeFallbackToOllama);
  }
  const model = provider.id === "ollama"
    ? (config.localCoderModel || provider.model)
    : provider.model;
  return String(model || "").startsWith("ollama/");
}

function providerRequiresOllama(provider, config = {}) {
  if (!provider) {
    return false;
  }
  if (provider.id === STEP_AGENT_PROVIDER) {
    return true;
  }
  const model = provider.id === OPENCODE_PROVIDER
    ? (config.openCodeModel || provider.model)
    : provider.id === "ollama"
      ? (config.localCoderModel || provider.model)
      : provider.model;
  return String(model || "").startsWith("ollama/");
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
    if (provider.id === STEP_AGENT_PROVIDER) {
      return {
        ...provider,
        model: `planner:${config.stepAgentPlannerProvider || "auto"} -> ${config.localCoderModel || DEFAULT_LOCAL_CODER_MODEL}`
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
    const state = providerState[provider.id] || {};
    if (state.lastError && Number(state.cooldownUntil || 0) > Date.now()) {
      return {
        status: state.status || "Local failed",
        lastError: state.lastError,
        cooldownUntil: Number(state.cooldownUntil || 0)
      };
    }
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
  await collectOllamaCandidates(result, config);
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
    const response = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/models",
      {},
      DISCOVERY_TIMEOUT_MS
    );
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

async function collectOllamaCandidates(result, config) {
  try {
    const response = await fetchWithTimeout(
      `${config.ollamaUrl || DEFAULT_OLLAMA_URL}/api/tags`,
      {},
      DISCOVERY_TIMEOUT_MS
    );
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
    const response = await fetchWithTimeout(`${config.gatewayUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${config.authToken}`
      }
    }, DISCOVERY_TIMEOUT_MS);
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

async function askGateway(
  gatewayUrl,
  authToken,
  prompt,
  maxTokens = 1400,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
) {
  const systemPrompt = getFreeAiSystemPrompt();

  const response = await fetchWithTimeout(`${gatewayUrl}/v1/messages`, {
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
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Gateway request failed: HTTP ${response.status}`);
  }

  const raw = await response.text();
  return parseSseText(raw);
}

function getFreeAiSystemPrompt() {
  return `You are the user's separate Free AI assistant.

Important rules:
- Answer in the same language as the user's request unless the user asks otherwise.
- Do not call tools.
- You cannot directly edit files yourself.
- Do not output fake Write/Edit/Read JSON.
- If the user asks for code, write code in the chat.
- If the user asks for architecture, answer in Markdown.
- If the user asks to edit an attached file, return the complete replacement content using exactly this XML-like block:
<free_ai_file_edits><file path="exact attached file path">complete new file content</file></free_ai_file_edits>
- Only use paths that appear in the attached file list.
- Do not claim the edit was applied. The VS Code extension will ask the user to confirm before writing.`;
}

function normalizeOllamaApiModel(model) {
  const value = String(model || "").trim();
  return value.startsWith("ollama/") ? value.slice("ollama/".length) : value;
}

function extractErrorText(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string") {
      return parsed.error.trim();
    }
    if (parsed && typeof parsed.message === "string") {
      return parsed.message.trim();
    }
  } catch {
    // Some providers return plain text, not JSON.
  }
  return text;
}

function compactErrorDetail(value, maxLength = 360) {
  const compact = String(value || "")
    .replace(/C:\\Users\\[^\\]+\\.ollama\\models\\blobs\\sha256-[a-f0-9]+/gi, "old Windows user-profile Ollama blob path")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3).trim()}...`;
}

function isOllamaStorageLoadError(value) {
  const text = String(value || "");
  return /llama-server process has terminated|llama_model_loader|failed to load model/i.test(text)
    && /\\.ollama\\models\\blobs|old Windows user-profile Ollama blob path|\ufffd/i.test(text);
}

function formatOllamaError(raw, apiModel, status) {
  const text = extractErrorText(raw);
  if (isOllamaStorageLoadError(text)) {
    return [
      `Ollama model "${apiModel}" failed to load from its model storage.`,
      "The active Ollama server is probably still using a broken Windows user-profile model path instead of C:\\OllamaModels.",
      `Run .\\scripts\\Repair-OllamaLocalModels.ps1 -Model ${apiModel}, then reload VS Code.`,
      `Detail: ${compactErrorDetail(text)}`
    ].join(" ");
  }

  if (status === 404 || /model.+not found|pull model/i.test(text)) {
    return [
      `Ollama model "${apiModel}" is not visible to the active server.`,
      "Restart Ollama with OLLAMA_MODELS=C:\\OllamaModels.",
      `Run .\\scripts\\Repair-OllamaLocalModels.ps1 -Model ${apiModel}.`
    ].join(" ");
  }

  return text || `Ollama request failed: HTTP ${status}`;
}

function getOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return String(value || "");
  }
}

function formatFetchFailure(url, error) {
  const message = getErrorMessage(error);
  const code = error?.cause?.code || error?.code || "";
  const suffix = code ? code : message;
  const origin = getOrigin(url);

  if (/^https?:\/\/(127\.0\.0\.1|localhost):8082\b/i.test(String(url))) {
    return `Could not reach the local free-claude-code gateway at ${origin}. Start it with fcc-server, then retry. (${suffix})`;
  }

  if (/^https?:\/\/(127\.0\.0\.1|localhost):11434\b/i.test(String(url))) {
    return `Could not reach local Ollama at ${origin}. Start Ollama, then retry. (${suffix})`;
  }

  return `Network request failed for ${url}: ${message}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const duration = Math.max(1000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), duration);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(duration / 1000)}s: ${url}`);
    }
    throw new Error(formatFetchFailure(url, error));
  } finally {
    clearTimeout(timer);
  }
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
    FreeAiViewProvider,
    appendConversationContext,
    buildStepAgentPlanPrompt,
    buildStepAgentVerificationPrompt,
    buildStepAgentWorkerPrompt,
    buildProviderCatalog,
    classifyPrompt,
    createChatRecord,
    createChatTitle,
    createFallbackStepAgentPlan,
    fetchWithTimeout,
    formatStepAgentResult,
    formatFetchFailure,
    formatOllamaError,
    getAutoChatProviders,
    getGatewayProviderTestId,
    getProviderOllamaModels,
    getOllamaStartEnv,
    getRequiredOllamaModels,
    getOpenCodeRunArgs,
    getOpenCodeProcessInvocation,
    getProviderRuntimeState,
    isQuotaOrRateLimitError,
    normalizeGatewayModelName,
    normalizeOpenCodeCommand,
    normalizeOllamaCommand,
    normalizeOllamaApiModel,
    normalizeChatStore,
    normalizeProviderState,
    parseStepAgentPlan,
    parseOpenCodeRunOutput,
    providerUsesGateway,
    providerUsesOllama,
    providerRequiresOllama,
    runStepAgent,
    selectStepAgentPlannerProvider,
    selectRoute,
    splitCommandLine,
    testProviderAvailability
  }
};
