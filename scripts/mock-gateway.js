const http = require('http');

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy' }));
    return;
  }

  if (req.method === 'POST' && url === '/v1/messages') {
    const body = await parseJsonBody(req);
    let userText = '';
    try {
      const msg = body.messages && body.messages[0] && body.messages[0].content;
      if (typeof msg === 'string') userText = msg;
      else if (Array.isArray(msg)) userText = JSON.stringify(msg);
      else userText = JSON.stringify(msg);
    } catch (e) {
      userText = '';
    }

    // Respond with SSE-like chunked data (extension will parse text)
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });

    const reply = `Mock gateway reply for request: ${Array.isArray(userText) ? '' : String(userText).slice(0,200)}`;
    const sseLines = [];
    sseLines.push(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: reply } })}`);
    sseLines.push('data: [DONE]');
    sseLines.push('');

    res.end(sseLines.join('\n'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const PORT = 8082;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock gateway listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
