const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) };
const window = { showWarningMessage: async () => 'Apply' };
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return {
    workspace,
    window,
    Uri: { joinPath: (base, name) => path.join(base, name), file: value => value }
  };
  return originalLoad.call(this, request, ...args);
};
const { _test } = require('./extension');
Module._load = originalLoad;

async function main() {
  assert.equal(_test.parseSseText('{"content":[{"type":"text","text":"OK"}]}'), 'OK');
  assert.equal(_test.parseSseText('data: {"type":"content_block_delta","delta":{"text":"OK"}}\n\ndata: [DONE]'), 'OK');
  assert.throws(() => _test.parseSseText('data: {"type":"error","error":{"message":"quota exceeded"}}'), /quota exceeded/);
  assert.throws(() => _test.parseSseText('data: [DONE]'), /empty/);
  for (const value of ['http://localhost:8082', 'http://127.0.0.1', 'http://[::1]:11434']) {
    assert.equal(_test.isLocalServiceUrl(value), true, value);
  }
  for (const value of ['http://localhost.evil.test', 'http://127.0.0.1@evil.test', 'file://localhost', 'invalid']) {
    assert.equal(_test.isLocalServiceUrl(value), false, value);
  }
  for (const file of ['.env', '.env.local', 'production.env', 'api_key', '.git/config', '.ssh/config', '.npmrc', 'secrets.json']) {
    assert.equal(_test.isUnsafeFilePath(file), true, file);
  }
  assert.equal(_test.isUnsafeFilePath('src/extension.js'), false);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-ai-safety-'));
  try {
    const root = path.join(temp, 'workspace');
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => _test.resolveLocalAgentPath(root, '../outside/file.txt'), /outside workspace/);
    assert.throws(() => _test.resolveLocalAgentPath(root, 'linked/new/file.txt'), /symbolic link|junction/);
    assert.throws(() => _test.resolveLocalAgentPath(root, '.git/config'), /protected/);
    assert.equal(_test.resolveLocalAgentPath(root, 'src/new.js'), path.join(root, 'src/new.js'));

    const provider = new _test.FreeAiViewProvider({}, {
      globalStorageUri: root,
      globalState: { get: (_key, fallback) => fallback }
    });
    let writes = 0;
    workspace.fs = {
      readFile: async () => Buffer.from('{broken'),
      writeFile: async () => { writes++; }
    };
    await assert.rejects(provider.readChatsFile(), /preserve/);
    await assert.rejects(provider.saveChats(), /disabled/);
    assert.equal(writes, 0);
    provider.post = () => {};
    workspace.openTextDocument = async () => ({ isDirty: false });
    workspace.fs.readFile = async () => Buffer.from('changed since attachment');
    provider.pendingEdits.set('stale', [{ path: path.join(root, 'a.js'), name: 'a.js', content: 'replacement', hash: 'old' }]);
    await provider.applyPendingEdit('stale');
    assert.equal(writes, 0, 'stale edits must not overwrite the current file');
    const xml = '<free_ai_file_edits><file path="a.js">replacement</file></free_ai_file_edits>';
    assert.deepEqual(provider.extractAllowedEdits(xml, [{ path: 'a.js', truncated: true }]), []);
    workspace.fs.readFile = async () => { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); };
    assert.equal(await provider.readChatsFile(), null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const events = [];
  const first = _test.queueGatewayRequest('http://localhost:8082', async () => {
    events.push('first start');
    await new Promise(resolve => setTimeout(resolve, 20));
    events.push('first end');
    throw new Error('provider failure');
  });
  const second = _test.queueGatewayRequest('http://localhost:8082/', async () => events.push('second'));
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(events, ['first start', 'first end', 'second']);
  if (process.platform === 'win32') {
    assert.throws(() => _test.getOpenCodeProcessInvocation('opencode', ['a" & echo injected']), /Unsafe Windows/);
    assert.equal(_test.shouldUseCodingAgentPromptFile('opencode.cmd', '!VARIABLE!'), true);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{'); // Headers arrive immediately; the body never completes.
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await _test.fetchWithTimeout(url, {}, 1000);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    await assert.rejects(_test.fetchWithTimeout(`${url}/stall`, {}, 1000), /timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(_test.fetchWithTimeout(url, { signal: controller.signal }, 1000));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('safety tests ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
