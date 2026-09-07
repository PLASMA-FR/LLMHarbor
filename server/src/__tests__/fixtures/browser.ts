// Local browser-test fixture. In-memory state and loopback upstream only.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { closeDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

process.env.LLMHARBOR_DASHBOARD_HOST = '127.0.0.1';
process.env.LLMHARBOR_DASHBOARD_PORT = '4179';

const failedPrompts = new Set<string>();
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  const lastPrompt = request.messages.findLast((message: { role: string }) => message.role === 'user')?.content;
  const slow = lastPrompt === 'slow';
  const refusal = lastPrompt === 'refuse';
  if (typeof lastPrompt === 'string' && lastPrompt.startsWith('retry-once') && !failedPrompts.has(lastPrompt)) {
    failedPrompts.add(lastPrompt);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Temporary fixture outage' } }));
    return;
  }
  const usage = { prompt_tokens: 12, completion_tokens: refusal ? 0 : 5, total_tokens: refusal ? 12 : 17 };
  const envelope = { id: 'fixture-completion', created: 1, model: 'fixture-model' };
  if (!request.stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...envelope, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Single reply ⚓.' }, finish_reason: 'stop' }], usage }));
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send(refusal ? { refusal: 'This is a simulated refusal.' } : { content: slow ? 'Working…' : 'Streaming reply ⚓.' });
  const finish = () => {
    send({}, refusal ? 'content_filter' : 'stop');
    res.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  if (slow) {
    const timer = setTimeout(finish, 20_000);
    res.once('close', () => clearTimeout(timer));
  } else finish();
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const db = initDb(':memory:');
db.prepare('INSERT INTO custom_endpoints (platform, name, base_url) VALUES (?, ?, ?)')
  .run('custom-browser', 'Browser fixture', `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`);
const key = encrypt('local-fixture');
db.prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status) VALUES ('custom-browser', ?, ?, ?, 'healthy')")
  .run(key.encrypted, key.iv, key.authTag);
db.transaction(() => {
  const insert = db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window) VALUES ('custom-browser', ?, ?, 50, 50, 8192)");
  for (let i = 0; i < 175; i++) {
    const model = insert.run(i === 0 ? 'fixture-model' : `policy-${i}`, i === 0 ? 'Browser test model' : `Policy model ${i}`);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)').run(model.lastInsertRowid, 1000 + i, i === 0 ? 1 : 0);
  }
})();
const server = createApp().listen(4179, '127.0.0.1', () => console.log('Browser fixture ready on 4179'));
function stop() {
  server.closeAllConnections();
  server.close();
  upstream.closeAllConnections();
  upstream.close();
  closeDb();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
