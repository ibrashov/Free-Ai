const assert = require("assert");
const Module = require("module");
const vm = require("vm");

const vscodeWindow = {
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      },
      Uri: {
        joinPath: () => ({})
      },
      window: vscodeWindow
    };
  }
  return originalLoad(request, parent, isMain);
};

const { _test } = require("./extension");

const config = {
  localCoderModel: "ollama/qwen2.5-coder:3b",
  openCodeModel: "ollama/qwen2.5-coder:3b",
  mimoCodeModel: "ollama/qwen2.5-coder:3b",
  stepAgentPlannerProvider: "auto"
};
const catalog = _test.buildProviderCatalog(config);
const combinedProvider = catalog.find((provider) => provider.id === "opencode-mimocode");
const openCodeProvider = catalog.find((provider) => provider.id === "opencode");
const mimoCodeProvider = catalog.find((provider) => provider.id === "mimocode");
const stepAgentProvider = catalog.find((provider) => provider.id === "step-agent");

function createProvider(configOverrides = {}) {
  const provider = new _test.FreeAiViewProvider({}, {
    globalStorageUri: {},
    globalState: {
      get: (_key, fallback) => fallback,
      update: async () => {}
    }
  });
  provider.getConfig = () => ({
    autoStartOllama: true,
    ollamaCommand: "ollama serve",
    ollamaModelsDirectory: "C:\\OllamaModels",
    ollamaStartupTimeoutMs: 3000,
    ollamaUrl: "http://127.0.0.1:11434",
    localCoderModel: "ollama/qwen2.5-coder:3b",
    openCodeModel: "ollama/qwen2.5-coder:3b",
    mimoCodeCommand: "mimo",
    mimoCodeModel: "ollama/qwen2.5-coder:3b",
    mimoCodeAgent: "build",
    mimoCodeAllowWorkspaceWrites: true,
    openCodeFallbackToOllama: true,
    stepAgentPlannerProvider: "auto",
    stepAgentMaxSteps: 5,
    stepAgentRepairPasses: 1,
    stepAgentStepMaxTokens: 900,
    ...configOverrides
  });
  return provider;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

assert.ok(openCodeProvider.enabled);
assert.equal(openCodeProvider.model, "ollama/qwen2.5-coder:3b");
assert.ok(mimoCodeProvider.enabled);
assert.equal(mimoCodeProvider.model, "ollama/qwen2.5-coder:3b");
assert.ok(combinedProvider.enabled);
assert.equal(combinedProvider.model, "ollama/qwen2.5-coder:3b + ollama/qwen2.5-coder:3b");
assert.ok(stepAgentProvider.enabled);
assert.match(stepAgentProvider.model, /planner:auto -> ollama\/qwen2\.5-coder:3b/);

function route(input) {
  return _test.selectRoute({
    prompt: input.prompt || "",
    requestedProvider: input.requestedProvider || "auto",
    autoMode: input.autoMode || "balanced",
    catalog,
    providerState: input.providerState || {},
    hasReferencedFiles: Boolean(input.hasReferencedFiles)
  });
}

assert.equal(route({ prompt: "Explain promises simply" }).mode, "Cheap");
assert.equal(route({ prompt: "Explain promises simply" }).providers[0].id, "cerebras");
assert.ok(!route({ prompt: "Explain promises simply" }).providers.some((provider) => provider.id === "gemini-fast"));
assert.equal(route({ prompt: "Create a calculator app" }).mode, "Step Agent");
assert.equal(route({ prompt: "Create a calculator app" }).providers[0].id, "step-agent");
assert.equal(route({ prompt: "\u0441\u043e\u0437\u0434\u0430\u0439 \u043a\u0430\u043b\u044c\u043a\u0443\u043b\u044f\u0442\u043e\u0440" }).providers[0].id, "step-agent");
assert.equal(route({ prompt: "Use step by step mode for a landing page" }).providers[0].id, "step-agent");
const manualGeminiFast = route({ prompt: "Explain APIs", requestedProvider: "gemini-fast" });
assert.equal(manualGeminiFast.providers[0].id, "gemini-fast");
assert.equal(manualGeminiFast.providers[1].id, "ollama");
assert.equal(route({ prompt: "Explain APIs", requestedProvider: "ollama" }).providers.length, 1);
assert.equal(route({ prompt: "anything", requestedProvider: "step-agent" }).mode, "Step Agent");
assert.equal(route({ prompt: "anything", requestedProvider: "step-agent" }).providers[0].id, "step-agent");

assert.equal(route({ prompt: "проверь весь проект" }).mode, "Hybrid Agent");
assert.equal(route({ prompt: "проверь весь проект" }).providers[0].id, "opencode-mimocode");

assert.equal(route({ prompt: "README.md проверь", hasReferencedFiles: true }).mode, "File Review");
assert.notEqual(route({ prompt: "README.md проверь", hasReferencedFiles: true }).providers[0].id, "opencode-mimocode");

const attachedReadPrompt = [
  "read this file and tell what is there",
  "",
  "If I ask you to edit an attached file, return the COMPLETE replacement content for each edited file inside exactly one block like this:",
  '<free_ai_file_edits><file path="exact attached file path">complete new file content</file></free_ai_file_edits>',
  "Only use paths from the attached files. Do not say the edit was applied; VS Code will ask me to confirm.",
  "",
  "--- ATTACHED FILES ---",
  "[1] arrays.html (C:\\Users\\Anuar\\Web\\lab3\\task1\\arrays.html)",
  "~~~text",
  "<html><body><script>let styles = [\"Jazz\", \"Blues\"];</script></body></html>",
  "~~~",
  "--- END ATTACHED FILES ---"
].join("\n");
assert.equal(_test.stripPromptForIntent(attachedReadPrompt), "read this file and tell what is there");
const attachedReadRoute = route({ prompt: attachedReadPrompt, hasReferencedFiles: true });
assert.equal(attachedReadRoute.mode, "File Review");
assert.notEqual(attachedReadRoute.providers[0].id, "opencode-mimocode");

assert.equal(route({ prompt: "\u043f\u0440\u043e\u0432\u0435\u0440\u044c \u0432\u0435\u0441\u044c \u043f\u0440\u043e\u0435\u043a\u0442" }).providers[0].id, "opencode-mimocode");
assert.equal(route({ prompt: "arrays.html \u043d\u0443\u0436\u043d\u043e \u0438\u0441\u043f\u0440\u0430\u0432\u0438\u0442\u044c", hasReferencedFiles: true }).providers[0].id, "opencode-mimocode");
assert.equal(route({ prompt: "\u043e\u0442\u0432\u0435\u0442\u044c \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e" }).providers[0].id, "ollama");

assert.equal(route({ prompt: "anything", autoMode: "survival" }).mode, "Local");
assert.equal(route({ prompt: "anything", autoMode: "survival" }).providers[0].id, "ollama");
assert.equal(route({ prompt: "answer with gemma" }).providers[0].id, "gemma");
assert.equal(route({ prompt: "problem15.dart нужно исправить" }).providers[0].id, "opencode-mimocode");
assert.equal(route({ prompt: "ответь локально" }).providers[0].id, "ollama");

const cooled = {
  cerebras: {
    status: "Rate limited",
    lastError: "429",
    cooldownUntil: Date.now() + 60000
  }
};
assert.equal(route({ prompt: "Explain maps", providerState: cooled }).providers[0].id, "groq");
assert.ok(!route({ prompt: "Compare maps", autoMode: "compare" }).providers.some((provider) => provider.id === "gemini-fast" || provider.id === "gemini"));

assert.equal(_test.isQuotaOrRateLimitError("Provider rate limit reached"), true);
assert.equal(_test.normalizeOllamaApiModel("ollama/gemma3:4b"), "gemma3:4b");
assert.equal(_test.normalizeOllamaApiModel("qwen2.5-coder:3b"), "qwen2.5-coder:3b");
const defaultOllamaCommand = _test.normalizeOllamaCommand("ollama serve");
assert.match(defaultOllamaCommand, /ollama/i);
assert.match(defaultOllamaCommand, /\bserve\b/i);
assert.doesNotMatch(defaultOllamaCommand, /powershell|cmd/i);
assert.deepEqual(_test.splitCommandLine('"C:\\Program Files\\Ollama\\ollama.exe" serve'), [
  "C:\\Program Files\\Ollama\\ollama.exe",
  "serve"
]);
assert.deepEqual(_test.getOllamaStartEnv({ ollamaModelsDirectory: "C:\\OllamaModels" }), {
  OLLAMA_MODELS: "C:\\OllamaModels"
});
assert.deepEqual(_test.getOllamaStartEnv({ ollamaModelsDirectory: "   " }), {});
assert.deepEqual(_test.getProviderOllamaModels(openCodeProvider, {
  localCoderModel: "ollama/qwen2.5-coder:3b",
  openCodeModel: "open_router/google/gemma-4-31b-it:free",
  openCodeFallbackToOllama: true
}), ["qwen2.5-coder:3b"]);
assert.deepEqual(_test.getRequiredOllamaModels({
  localCoderModel: "ollama/qwen2.5-coder:3b",
  openCodeModel: "open_router/google/gemma-4-31b-it:free",
  openCodeFallbackToOllama: true
}, [], ["ollama/gemma3:4b"]), ["gemma3:4b", "qwen2.5-coder:3b"]);
assert.equal(_test.getGatewayProviderTestId("gemini-fast"), "gemini");
assert.equal(_test.getGatewayProviderTestId("openrouter"), "open_router");
assert.equal(_test.getGatewayProviderTestId("ollama"), "");
assert.equal(_test.normalizeGatewayModelName("gemini/models/gemini-2.0-flash"), "models/gemini-2.0-flash");
assert.equal(_test.normalizeGatewayModelName("groq/llama-3.1-8b-instant"), "llama-3.1-8b-instant");
assert.equal(_test.getAutoChatProviders(catalog).some((provider) => provider.id === "gemini-fast"), false);

const brokenOllamaError = _test.formatOllamaError(JSON.stringify({
  error: "llama-server process has terminated: exit status 1: error loading model: llama_model_loader: failed to load model from C:\\Users\\\ufffd\ufffd\ufffd\ufffd\ufffd\\.ollama\\models\\blobs\\sha256-4a188102020e9c9530b687fd6400f775c45e90a0d7baafe65bd0a36963fbb7ba"
}), "qwen2.5-coder:3b", 500);
assert.match(brokenOllamaError, /failed to load from its model storage/);
assert.match(brokenOllamaError, /Repair-OllamaLocalModels\.ps1 -Model qwen2\.5-coder:3b/);
assert.doesNotMatch(brokenOllamaError, /sha256-4a188102020e9c9530b687fd6400f775c45e90a0d7baafe65bd0a36963fbb7ba/);

const missingOllamaError = _test.formatOllamaError("model 'qwen2.5-coder:3b' not found, try pulling it first", "qwen2.5-coder:3b", 404);
assert.match(missingOllamaError, /not visible to the active server/);

const gatewayFetchError = _test.formatFetchFailure("http://127.0.0.1:8082/v1/messages", new Error("fetch failed"));
assert.match(gatewayFetchError, /free-claude-code gateway/);
assert.match(gatewayFetchError, /fcc-server/);

const ollamaFetchError = _test.formatFetchFailure("http://127.0.0.1:11434/api/chat", new Error("fetch failed"));
assert.match(ollamaFetchError, /local Ollama/);

const brokenLocalState = _test.getProviderRuntimeState(
  { id: "ollama", role: "local-fallback" },
  {
    ollama: {
      status: "Cooling down",
      lastError: "Ollama model failed",
      cooldownUntil: Date.now() + 60000
    }
  }
);
assert.equal(brokenLocalState.status, "Cooling down");
assert.equal(brokenLocalState.lastError, "Ollama model failed");
assert.equal(_test.getProviderRuntimeState({ id: "ollama", role: "local-fallback" }, {}).status, "Local");
assert.equal(_test.providerUsesGateway({ id: "cerebras", model: "cerebras/gpt-oss-120b" }, {}), true);
assert.equal(_test.providerUsesGateway({ id: "gemma", model: "ollama/gemma3:4b" }, {}), false);
assert.equal(_test.providerUsesGateway(openCodeProvider, config), false);
assert.equal(_test.providerUsesGateway(mimoCodeProvider, config), false);
assert.equal(_test.providerUsesGateway(combinedProvider, config), false);
assert.equal(_test.providerUsesGateway(stepAgentProvider, config), true);
assert.equal(_test.providerUsesOllama(openCodeProvider, config), true);
assert.equal(_test.providerUsesOllama(mimoCodeProvider, config), true);
assert.equal(_test.providerUsesOllama(combinedProvider, config), true);
assert.equal(_test.providerUsesOllama(stepAgentProvider, config), true);
assert.equal(_test.providerRequiresOllama(openCodeProvider, config), true);
assert.equal(_test.providerRequiresOllama(mimoCodeProvider, config), true);
assert.equal(_test.providerRequiresOllama(combinedProvider, config), true);
assert.equal(_test.providerRequiresOllama(stepAgentProvider, config), true);
assert.deepEqual(_test.getProviderOllamaModels(stepAgentProvider, config), ["qwen2.5-coder:3b"]);
assert.deepEqual(_test.getProviderOllamaModels(mimoCodeProvider, config), ["qwen2.5-coder:3b"]);
assert.deepEqual(_test.getProviderOllamaModels(combinedProvider, config), ["qwen2.5-coder:3b"]);
assert.deepEqual(_test.getOpenCodeRunArgs("hello", "ollama/qwen2.5-coder:3b"), [
  "run",
  "hello",
  "-m",
  "ollama/qwen2.5-coder:3b",
  "--format",
  "json"
]);
assert.equal(_test.getOpenCodeRunArgs("line one\nline two", "ollama/qwen2.5-coder:3b")[1], "line one\\nline two");
const nullByteOpenCodeArgs = _test.getOpenCodeRunArgs("a\u0000b\r\nc", "ollama/qwen2.5-coder:3b\u0000");
assert.equal(nullByteOpenCodeArgs[1], "ab\\nc");
assert.equal(nullByteOpenCodeArgs[3], "ollama/qwen2.5-coder:3b");
assert.equal(nullByteOpenCodeArgs.some((arg) => String(arg).includes("\u0000")), false);
assert.deepEqual(_test.getMimoCodeRunArgs("hello", "ollama/qwen2.5-coder:3b", {
  agent: "build",
  allowWorkspaceWrites: true
}), [
  "run",
  "hello",
  "-m",
  "ollama/qwen2.5-coder:3b",
  "--format",
  "json",
  "--agent",
  "build",
  "--dangerously-skip-permissions"
]);
const nullByteMimoCodeArgs = _test.getMimoCodeRunArgs("hello\u0000", "ollama/qwen2.5-coder:3b\u0000", {
  agent: "build\u0000",
  dir: "C:\\tmp\u0000x",
  allowWorkspaceWrites: true
});
assert.equal(nullByteMimoCodeArgs.some((arg) => String(arg).includes("\u0000")), false);
assert.match(_test.buildCombinedAgentPlanPrompt("Fix tests"), /Do not edit files/);
assert.equal(_test.buildCombinedAgentImplementationPrompt("Fix tests", "Plan text"), "Fix tests");
assert.match(_test.buildCombinedAgentReviewPrompt("Fix tests", "Plan text", "Done"), /reviewing and repairing/);
assert.equal(_test.buildMimoCodeAgentPrompt("Fix tests"), "Fix tests");
if (process.platform === "win32") {
  assert.equal(_test.normalizeOpenCodeCommand("opencode"), "opencode.cmd");
  assert.equal(_test.normalizeOpenCodeCommand(""), "opencode.cmd");
  assert.equal(_test.normalizeMimoCodeCommand("mimo"), "mimo.cmd");
  assert.equal(_test.normalizeMimoCodeCommand(""), "mimo.cmd");
  const openCodeInvocation = _test.getOpenCodeProcessInvocation("opencode", ["--version"]);
  assert.deepEqual(openCodeInvocation, { commandLine: '"opencode.cmd" "--version"' });
  const mimoCodeInvocation = _test.getMimoCodeProcessInvocation("mimo", ["--version"]);
  assert.deepEqual(mimoCodeInvocation, { commandLine: '"mimo.cmd" "--version"' });
} else {
  assert.equal(_test.normalizeOpenCodeCommand("opencode"), "opencode");
  assert.equal(_test.normalizeMimoCodeCommand("mimo"), "mimo");
  assert.deepEqual(_test.getOpenCodeProcessInvocation("opencode", ["--version"]), {
    command: "opencode",
    args: ["--version"]
  });
  assert.deepEqual(_test.getMimoCodeProcessInvocation("mimo", ["--version"]), {
    command: "mimo",
    args: ["--version"]
  });
}
assert.equal(_test.parseOpenCodeRunOutput([
  JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
  JSON.stringify({ type: "text", part: { type: "text", text: "Hel" } }),
  JSON.stringify({ type: "text", part: { type: "text", text: "lo" } })
].join("\n")), "Hello");
assert.deepEqual(_test.normalizeLocalAgentCommand(JSON.stringify({
  action: "write_file",
  path: "result.txt",
  content: "OK"
})), {
  action: "write_file",
  path: "result.txt",
  content: "OK",
  oldText: "",
  newText: "",
  answer: ""
});
assert.deepEqual(_test.normalizeLocalAgentCommand(JSON.stringify({
  newFile: "/result.txt",
  content: "OK"
})), {
  action: "write_file",
  path: "/result.txt",
  content: "OK",
  oldText: "",
  newText: "",
  answer: ""
});
assert.deepEqual(_test.normalizeLocalAgentCommand([
  "```json",
  JSON.stringify({
    name: "write",
    arguments: {
      filePath: "./result.txt",
      content: "OK"
    }
  }),
  "```"
].join("\n")), {
  action: "write_file",
  path: "./result.txt",
  content: "OK",
  oldText: "",
  newText: "",
  answer: ""
});

const parsedStepPlan = _test.parseStepAgentPlan([
  "```json",
  JSON.stringify({
    goal: "Build calculator",
    steps: [
      { title: "HTML", instruction: "Create controls", expected: "Buttons exist" },
      { title: "Logic", instruction: "Add JS math", expected: "Operations work" },
      { title: "Review", instruction: "Check edge cases", expected: "No obvious bugs" }
    ],
    verification: ["Calculator can add", "Calculator can clear"]
  }),
  "```"
].join("\n"), 2);
assert.equal(parsedStepPlan.steps.length, 2);
assert.equal(parsedStepPlan.steps[0].title, "HTML");
assert.deepEqual(parsedStepPlan.verification, ["Calculator can add", "Calculator can clear"]);

const fallbackStepPlan = _test.createFallbackStepAgentPlan("Create a calculator", 3);
assert.equal(fallbackStepPlan.steps.length, 3);
assert.match(_test.buildStepAgentPlanPrompt("Create a calculator", 4), /Return JSON only/);
assert.match(_test.buildStepAgentWorkerPrompt({
  userPrompt: "Create a calculator",
  plan: fallbackStepPlan,
  step: fallbackStepPlan.steps[0],
  stepIndex: 0,
  previousResults: []
}), /Current step 1/);

const firstChat = _test.createChatRecord("New chat", [
  { role: "user", text: "My name is Anuar", timestamp: "2026-06-15T10:00:00.000Z" },
  { role: "assistant", text: "Nice to meet you", timestamp: "2026-06-15T10:00:01.000Z" },
  { role: "error", text: "temporary failure", timestamp: "2026-06-15T10:00:02.000Z" }
]);
const secondChat = _test.createChatRecord("Separate topic", []);
const chatStore = _test.normalizeChatStore({
  activeChatId: secondChat.id,
  chats: [firstChat, secondChat]
});
assert.equal(chatStore.activeChatId, secondChat.id);
assert.equal(chatStore.chats.length, 2);
assert.equal(_test.createChatTitle("A very useful first question\nwith details"), "A very useful first question");

const conversationPrompt = _test.appendConversationContext("What is my name?", firstChat.messages);
assert.match(conversationPrompt, /My name is Anuar/);
assert.match(conversationPrompt, /Nice to meet you/);
assert.doesNotMatch(conversationPrompt, /temporary failure/);
assert.match(conversationPrompt, /Current user request:\nWhat is my name\?/);

const deleteProvider = new _test.FreeAiViewProvider({}, {
  globalStorageUri: {},
  globalState: {
    get: (_key, fallback) => fallback,
    update: async () => {}
  }
});
let deleteSaveQueued = false;
const deletePosts = [];
deleteProvider.queueSaveChats = () => {
  deleteSaveQueued = true;
};
deleteProvider.post = (message) => {
  deletePosts.push(message);
};
deleteProvider.view = {};
deleteProvider.chats = [firstChat, secondChat];
deleteProvider.activeChatId = firstChat.id;
deleteProvider.deleteChat(firstChat.id);
assert.equal(deleteProvider.chats.some((chat) => chat.id === firstChat.id), false);
assert.equal(deleteProvider.activeChatId, secondChat.id);
assert.equal(deleteSaveQueued, true);
assert.equal(deletePosts[0].type, "chatState");

deleteProvider.chats = [secondChat];
deleteProvider.activeChatId = secondChat.id;
deleteProvider.deleteChat(secondChat.id);
assert.equal(deleteProvider.chats.length, 1);
assert.notEqual(deleteProvider.chats[0].id, secondChat.id);
assert.equal(deleteProvider.activeChatId, deleteProvider.chats[0].id);

const viewProvider = new _test.FreeAiViewProvider({}, {
  globalStorageUri: {},
  globalState: {
    get: (_key, fallback) => fallback,
    update: async () => {}
  }
});
viewProvider.chats = [firstChat];
viewProvider.activeChatId = firstChat.id;
const html = viewProvider.getHtml({});
assert.equal(html.includes('id="delete-active-chat"'), false);
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "webview script should be present");
new vm.Script(scriptMatch[1]);

function dispatchPromptKey(webview, prompt, event) {
  webview.promptEl.value = prompt;
  return webview.promptEl.dispatchEvent("keydown", event);
}

function dispatchWindowKey(webview, prompt, event) {
  webview.promptEl.value = prompt;
  return webview.dispatchWindowKeyboard("keydown", event);
}

function createWebviewHarness(script) {
  const document = createMockDocument();
  const messages = [];
  const windowListeners = {};
  const context = {
    document,
    window: {
      addEventListener(type, listener) {
        windowListeners[type] = windowListeners[type] || [];
        windowListeners[type].push(listener);
      }
    },
    acquireVsCodeApi: () => ({
      postMessage(message) {
        messages.push(message);
      }
    }),
    console
  };

  context.window.dispatchMessage = (data) => {
    for (const listener of windowListeners.message || []) {
      listener({ data });
    }
  };
  context.window.dispatchKeyboard = (type, init = {}) => {
    const event = createMockEvent(type, {
      target: document.getElementById("prompt"),
      ...init
    }, context.window);
    for (const listener of windowListeners[type] || []) {
      listener(event);
    }
    return event;
  };

  vm.createContext(context);
  new vm.Script(script).runInContext(context);

  return {
    document,
    messages,
    promptEl: document.getElementById("prompt"),
    sendEl: document.getElementById("send"),
    dispatchWindowMessage: context.window.dispatchMessage,
    dispatchWindowKeyboard: context.window.dispatchKeyboard
  };
}

function createMockDocument() {
  const ids = [
    "prompt",
    "provider",
    "messages",
    "send",
    "add-file",
    "attached-files",
    "toggle-chats",
    "new-chat",
    "chat-panel",
    "chat-list",
    "active-chat-title",
    "route-line",
    "provider-list",
    "status-providers",
    "test-providers",
    "refresh-models",
    "gateway-status",
    "gateway-detail",
    "gateway-check",
    "gateway-start"
  ];
  const elements = new Map(ids.map((id) => [id, new MockElement("div", id)]));
  const created = [];
  elements.get("provider").value = "auto";

  return {
    createElement(tagName) {
      const element = new MockElement(tagName);
      created.push(element);
      return element;
    },
    getElementById(id) {
      if (elements.has(id)) {
        return elements.get(id);
      }

      for (const root of [...elements.values(), ...created]) {
        const match = findElement(root, (element) => element.id === id);
        if (match) {
          return match;
        }
      }
      return null;
    }
  };
}

class MockElement {
  constructor(tagName, id = "") {
    this.tagName = tagName;
    this.id = id;
    this.value = "";
    this.disabled = false;
    this.className = "";
    this.children = [];
    this.listeners = {};
    this.parentElement = null;
    this.classList = createClassList(this);
    this._textContent = "";
    this.attributes = {};
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  dispatchEvent(type, init = {}) {
    const event = createMockEvent(type, init, this);

    for (const listener of this.listeners[type] || []) {
      listener(event);
    }
    return event;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  querySelector(selector) {
    if (!selector.startsWith(".")) {
      return null;
    }
    const className = selector.slice(1);
    return findElement(this, (element) => hasClass(element, className), false);
  }

  scrollIntoView() {}
}

function createMockEvent(type, init = {}, target = null) {
  return {
    type,
    target,
    key: "",
    code: "",
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    which: 0,
    defaultPrevented: false,
    propagationStopped: false,
    ...init,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    }
  };
}

function createClassList(element) {
  return {
    add(className) {
      setClasses(element, [...getClasses(element), className]);
    },
    remove(className) {
      setClasses(element, getClasses(element).filter((item) => item !== className));
    },
    toggle(className, force) {
      const classes = getClasses(element);
      const exists = classes.includes(className);
      const shouldHave = force === undefined ? !exists : Boolean(force);
      if (shouldHave && !exists) {
        classes.push(className);
      }
      if (!shouldHave && exists) {
        classes.splice(classes.indexOf(className), 1);
      }
      setClasses(element, classes);
      return shouldHave;
    },
    contains(className) {
      return getClasses(element).includes(className);
    }
  };
}

function getClasses(element) {
  return String(element.className || "").split(/\s+/).filter(Boolean);
}

function setClasses(element, classes) {
  element.className = [...new Set(classes.filter(Boolean))].join(" ");
}

function hasClass(element, className) {
  return getClasses(element).includes(className);
}

function findElement(root, predicate, includeRoot = true) {
  if (includeRoot && predicate(root)) {
    return root;
  }
  for (const child of root.children || []) {
    const match = findElement(child, predicate, true);
    if (match) {
      return match;
    }
  }
  return null;
}

const webview = createWebviewHarness(scriptMatch[1]);
assert.ok((webview.promptEl.listeners.keydown || []).length >= 1);
assert.ok((webview.promptEl.listeners.keypress || []).length >= 1);

webview.promptEl.value = "clicked prompt";
webview.sendEl.dispatchEvent("click");
assert.equal(webview.messages.length, 1);
assert.equal(webview.messages[0].type, "ask");
assert.equal(webview.messages[0].prompt, "clicked prompt");
assert.equal(webview.promptEl.value, "");
assert.equal(webview.sendEl.disabled, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });
assert.equal(webview.sendEl.disabled, false);

const enterEvent = dispatchPromptKey(webview, "enter prompt", { key: "Enter", code: "Enter" });
assert.equal(webview.messages.length, 2);
assert.equal(webview.messages[1].prompt, "enter prompt");
assert.equal(enterEvent.defaultPrevented, true);
assert.equal(enterEvent.propagationStopped, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });

const processEnterEvent = dispatchPromptKey(webview, "process enter prompt", { key: "Process", code: "Enter" });
assert.equal(webview.messages.length, 3);
assert.equal(webview.messages[2].prompt, "process enter prompt");
assert.equal(processEnterEvent.defaultPrevented, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });

const numpadEnterEvent = dispatchPromptKey(webview, "numpad prompt", { key: "", code: "NumpadEnter" });
assert.equal(webview.messages.length, 4);
assert.equal(webview.messages[3].prompt, "numpad prompt");
assert.equal(numpadEnterEvent.defaultPrevented, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });

const shiftEnterEvent = dispatchPromptKey(webview, "line one", { key: "Enter", code: "Enter", shiftKey: true });
assert.equal(webview.messages.length, 4);
assert.equal(shiftEnterEvent.defaultPrevented, false);
assert.equal(webview.promptEl.value, "line one");

const composingEnterEvent = dispatchPromptKey(webview, "compose prompt", {
  key: "Enter",
  code: "Enter",
  isComposing: true,
  keyCode: 229
});
assert.equal(webview.messages.length, 4);
assert.equal(composingEnterEvent.defaultPrevented, false);
assert.equal(webview.promptEl.value, "compose prompt");

const keyCodeEnterEvent = dispatchPromptKey(webview, "keycode prompt", { keyCode: 13, which: 13 });
assert.equal(webview.messages.length, 5);
assert.equal(webview.messages[4].prompt, "keycode prompt");
assert.equal(keyCodeEnterEvent.defaultPrevented, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });

webview.promptEl.value = "keypress prompt";
const keypressEnterEvent = webview.promptEl.dispatchEvent("keypress", { key: "Enter" });
assert.equal(webview.messages.length, 6);
assert.equal(webview.messages[5].prompt, "keypress prompt");
assert.equal(keypressEnterEvent.defaultPrevented, true);
webview.dispatchWindowMessage({ type: "answer", text: "OK" });

const windowEnterEvent = dispatchWindowKey(webview, "window prompt", { key: "Enter", code: "Enter" });
assert.equal(webview.messages.length, 7);
assert.equal(webview.messages[6].prompt, "window prompt");
assert.equal(windowEnterEvent.defaultPrevented, true);

const deleteButton = findElement(
  webview.document.getElementById("chat-list"),
  (element) => hasClass(element, "chat-delete")
);
assert.ok(deleteButton, "chat delete button should be rendered");
const deleteClickEvent = deleteButton.dispatchEvent("click");
assert.equal(deleteClickEvent.defaultPrevented, true);
assert.equal(deleteClickEvent.propagationStopped, true);
assert.equal(webview.messages.length, 8);
assert.equal(webview.messages[7].type, "deleteChat");
assert.equal(webview.messages[7].chatId, firstChat.id);
assert.equal(webview.document.getElementById("delete-active-chat"), null);

async function runOllamaAutoStartTests() {
  const runningProvider = createProvider();
  let runningStarts = 0;
  runningProvider.checkOllamaHealth = async () => ({ ok: true, error: "" });
  runningProvider.checkOllamaModels = async () => ({ ok: true, missing: [], error: "" });
  runningProvider.startOllamaProcess = async () => {
    runningStarts += 1;
    throw new Error("already-running Ollama should not be started");
  };
  const running = await runningProvider.ensureOllamaRunning();
  assert.equal(running.state, "ready");
  assert.equal(runningStarts, 0);

  const disabledProvider = createProvider({ autoStartOllama: false });
  let disabledStarts = 0;
  disabledProvider.checkOllamaHealth = async () => ({ ok: false, error: "connection refused" });
  disabledProvider.startOllamaProcess = async () => {
    disabledStarts += 1;
    throw new Error("disabled auto-start should not start Ollama");
  };
  const disabled = await disabledProvider.ensureOllamaRunning();
  assert.equal(disabled.state, "disabled");
  assert.equal(disabledStarts, 0);

  const remoteProvider = createProvider({ ollamaUrl: "https://ollama.example.test" });
  let remoteStarts = 0;
  remoteProvider.checkOllamaHealth = async () => ({ ok: false, error: "not reachable" });
  remoteProvider.startOllamaProcess = async () => {
    remoteStarts += 1;
    throw new Error("remote Ollama URL should not start a local process");
  };
  const remote = await remoteProvider.ensureOllamaRunning();
  assert.equal(remote.state, "stopped");
  assert.equal(remoteStarts, 0);

  const wrongStoreProvider = createProvider();
  let restarts = 0;
  let restartModels = [];
  wrongStoreProvider.checkOllamaHealth = async () => ({ ok: true, error: "" });
  wrongStoreProvider.checkOllamaModels = async (_url, models) => ({
    ok: false,
    required: models,
    missing: ["qwen2.5-coder:3b"],
    models: [],
    error: "Missing model(s): qwen2.5-coder:3b"
  });
  wrongStoreProvider.restartOllamaProcess = async (_config, _showMessage, models) => {
    restarts += 1;
    restartModels = models;
    return {
      state: "ready",
      text: "Ollama: running at http://127.0.0.1:11434",
      detail: ""
    };
  };
  const repaired = await wrongStoreProvider.ensureOllamaRunning({
    models: ["ollama/qwen2.5-coder:3b"]
  });
  assert.equal(repaired.state, "ready");
  assert.equal(restarts, 1);
  assert.ok(restartModels.includes("qwen2.5-coder:3b"));

  const missingDisabledProvider = createProvider({ autoStartOllama: false });
  let disabledRestarts = 0;
  missingDisabledProvider.checkOllamaHealth = async () => ({ ok: true, error: "" });
  missingDisabledProvider.checkOllamaModels = async () => ({
    ok: false,
    missing: ["qwen2.5-coder:3b"],
    error: "Missing model(s): qwen2.5-coder:3b"
  });
  missingDisabledProvider.restartOllamaProcess = async () => {
    disabledRestarts += 1;
    throw new Error("disabled auto-start should not restart Ollama");
  };
  const missingDisabled = await missingDisabledProvider.ensureOllamaRunning();
  assert.equal(missingDisabled.state, "disabled");
  assert.equal(disabledRestarts, 0);

  const concurrentProvider = createProvider();
  let healthChecks = 0;
  let starts = 0;
  let finishStart;
  const startedStatus = {
    state: "ready",
    text: "Ollama: running at http://127.0.0.1:11434",
    detail: ""
  };
  concurrentProvider.checkOllamaHealth = async () => {
    healthChecks += 1;
    return { ok: false, error: "connection refused" };
  };
  concurrentProvider.startOllamaProcess = async () => {
    starts += 1;
    return new Promise((resolve) => {
      finishStart = () => resolve(startedStatus);
    });
  };

  const first = concurrentProvider.ensureOllamaRunning();
  const second = concurrentProvider.ensureOllamaRunning();
  await nextTick();
  assert.equal(starts, 1);

  const third = concurrentProvider.ensureOllamaRunning();
  await nextTick();
  assert.equal(starts, 1);
  assert.equal(healthChecks, 3);

  finishStart();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results, [startedStatus, startedStatus, startedStatus]);
  assert.equal(concurrentProvider.ollamaStartPromise, null);
}

async function runStepAgentTests() {
  const statuses = [];
  const workerPrompts = [];
  const result = await _test.runStepAgent({
    userPrompt: "Create a calculator app",
    planner: { id: "cerebras", label: "Cerebras" },
    workerModel: "ollama/qwen2.5-coder:3b",
    maxSteps: 3,
    repairPasses: 1,
    stepMaxTokens: 500,
    askPlanner: async () => JSON.stringify({
      goal: "Create a calculator app",
      steps: [
        { title: "Markup", instruction: "Create the calculator UI", expected: "UI is complete" },
        { title: "Logic", instruction: "Add arithmetic behavior", expected: "Buttons calculate results" }
      ],
      verification: ["Addition works"]
    }),
    askWorker: async (prompt) => {
      workerPrompts.push(prompt);
      if (/verifying/i.test(prompt)) {
        return "VERDICT: PASS\nThe calculator flow is consistent.";
      }
      return `Output for ${workerPrompts.length}`;
    },
    onStatus: (text) => statuses.push(text)
  });

  assert.match(result, /Planner: Cerebras/);
  assert.match(result, /Step 1: Markup/);
  assert.match(result, /Verification:/);
  assert.equal(workerPrompts.length, 3);
  assert.ok(statuses.some((status) => /step 1\/2/i.test(status)));

  const fallbackResult = await _test.runStepAgent({
    userPrompt: "Create a calculator app",
    planner: { id: "cerebras", label: "Cerebras" },
    workerModel: "ollama/qwen2.5-coder:3b",
    maxSteps: 2,
    repairPasses: 0,
    stepMaxTokens: 500,
    askPlanner: async () => {
      throw new Error("429");
    },
    askWorker: async (prompt) => /verifying/i.test(prompt)
      ? "VERDICT: PASS"
      : "fallback worker output"
  });
  assert.match(fallbackResult, /Planner: fallback plan/);
  assert.match(fallbackResult, /Planner fallback reason: 429/);

  const smoke = await _test.testProviderAvailability({
    ...config,
    localCoderModel: "ollama/qwen2.5-coder:3b",
    requestTimeoutMs: 1000
  }, stepAgentProvider);
  assert.match(smoke, /Step Agent configured/);
}

(async () => {
  await runOllamaAutoStartTests();
  await runStepAgentTests();

  const confirmFirstChat = _test.createChatRecord("Confirm delete", []);
  const confirmSecondChat = _test.createChatRecord("Keep chat", []);
  const requestDeleteProvider = new _test.FreeAiViewProvider({}, {
    globalStorageUri: {},
    globalState: {
      get: (_key, fallback) => fallback,
      update: async () => {}
    }
  });
  let requestSaveQueued = false;
  const requestPosts = [];
  requestDeleteProvider.queueSaveChats = () => {
    requestSaveQueued = true;
  };
  requestDeleteProvider.post = (message) => {
    requestPosts.push(message);
  };
  requestDeleteProvider.view = {};
  requestDeleteProvider.chats = [confirmFirstChat, confirmSecondChat];
  requestDeleteProvider.activeChatId = confirmFirstChat.id;

  const warningCalls = [];
  vscodeWindow.showWarningMessage = async (...args) => {
    warningCalls.push(args);
    return undefined;
  };
  await requestDeleteProvider.requestDeleteChat(confirmFirstChat.id);
  assert.equal(requestDeleteProvider.chats.some((chat) => chat.id === confirmFirstChat.id), true);
  assert.equal(requestSaveQueued, false);
  assert.equal(requestPosts.length, 0);
  assert.equal(warningCalls.length, 1);
  assert.match(warningCalls[0][0], /Confirm delete/);
  assert.equal(warningCalls[0][2], "Delete");

  vscodeWindow.showWarningMessage = async (...args) => {
    warningCalls.push(args);
    return "Delete";
  };
  await requestDeleteProvider.requestDeleteChat(confirmFirstChat.id);
  assert.equal(requestDeleteProvider.chats.some((chat) => chat.id === confirmFirstChat.id), false);
  assert.equal(requestDeleteProvider.activeChatId, confirmSecondChat.id);
  assert.equal(requestSaveQueued, true);
  assert.equal(requestPosts[0].type, "chatState");

  console.log("router tests ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
