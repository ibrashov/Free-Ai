const assert = require("assert");
const Module = require("module");

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
      }
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
assert.equal(route({ prompt: "anything", autoMode: "survival" }).providers[0].id, "gemma");
assert.equal(route({ prompt: "answer with gemma" }).providers[0].id, "gemma");

const cooled = {
  "gemini-fast": {
    status: "Rate limited",
    lastError: "429",
    cooldownUntil: Date.now() + 60000
  }
};
assert.equal(route({ prompt: "Explain maps", providerState: cooled }).providers[0].id, "gemini");

assert.equal(_test.isQuotaOrRateLimitError("Provider rate limit reached"), true);

console.log("router tests ok");
