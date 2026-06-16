const assert = require("assert");
const Module = require("module");
const vm = require("vm");

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
      window: {}
    };
  }
  return originalLoad(request, parent, isMain);
};

const { _test } = require("./extension");

const config = {
  localCoderModel: "ollama/qwen2.5-coder:3b",
  openCodeModel: "anthropic/claude-sonnet-4-0"
};
const catalog = _test.buildProviderCatalog(config);

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
assert.equal(route({ prompt: "Explain promises simply" }).providers[0].id, "gemini-fast");

assert.equal(route({ prompt: "проверь весь проект" }).mode, "Agent");
assert.equal(route({ prompt: "проверь весь проект" }).providers[0].id, "opencode");

assert.equal(route({ prompt: "README.md проверь", hasReferencedFiles: true }).mode, "File Review");
assert.notEqual(route({ prompt: "README.md проверь", hasReferencedFiles: true }).providers[0].id, "opencode");

assert.equal(route({ prompt: "anything", autoMode: "survival" }).mode, "Local");
assert.equal(route({ prompt: "anything", autoMode: "survival" }).providers[0].id, "ollama");
assert.equal(route({ prompt: "answer with gemma" }).providers[0].id, "gemma");
assert.equal(route({ prompt: "problem15.dart нужно исправить" }).providers[0].id, "opencode");
assert.equal(route({ prompt: "ответь локально" }).providers[0].id, "ollama");

const cooled = {
  "gemini-fast": {
    status: "Rate limited",
    lastError: "429",
    cooldownUntil: Date.now() + 60000
  }
};
assert.equal(route({ prompt: "Explain maps", providerState: cooled }).providers[0].id, "gemini");

assert.equal(_test.isQuotaOrRateLimitError("Provider rate limit reached"), true);
assert.equal(_test.normalizeOllamaApiModel("ollama/gemma3:4b"), "gemma3:4b");
assert.equal(_test.normalizeOllamaApiModel("qwen2.5-coder:3b"), "qwen2.5-coder:3b");

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
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "webview script should be present");
new vm.Script(scriptMatch[1]);

console.log("router tests ok");
