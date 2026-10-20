import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('../index.mjs', import.meta.url));
const cli = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent').replace(/\/index\.js$/, '/cli.js'));
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], { env, timeout: 25000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
    // Pi consumes redirected stdin before running a print-mode prompt.
    child.stdin.end();
  });
}
function sendEvents(res, events) {
  res.setHeader('content-type', 'text/event-stream');
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

test('Pi 1.3 CLI preserves the model catalog and streams all three protocols', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-zenmux-runtime-'));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ zenmux: { type: 'oauth', access: 'mock-local-only', refresh: 'mock-refresh', expires: Date.now() + 3600000 } }));
  await writeFile(join(dir, 'fixture.txt'), 'TOOL_FIXTURE_OK');
  const requests = [];
  const models = [
    { slug: 'test/messages', api: 'messages' },
    { slug: 'test/responses', api: 'responses' },
    { slug: 'test/completions', api: 'chat.completions' },
  ];
  const server = createServer(async (req, res) => {
    if (req.url === '/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: models }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
    if (req.url.startsWith('/anthropic/v1/messages')) {
      const body = JSON.parse(raw);
      const toolTest = JSON.stringify(body.messages).includes('TOOL_CALL_TEST');
      const hasResult = body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
      if (toolTest && !hasResult) {
        assert.ok(body.tools.some(tool => tool.name === 'read'), 'tool definitions must survive transcript conversion');
        sendEvents(res, [
          ['message_start', { message: { id: 'msg_tool', type: 'message', role: 'assistant', model: 'test/messages', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
          ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool_read', name: 'read', input: {} } }],
          ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: join(dir, 'fixture.txt') }) } }],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
          ['message_stop', {}],
        ]);
        return;
      }
      if (toolTest) assert.ok(JSON.stringify(body.messages).includes('TOOL_FIXTURE_OK'), 'tool result must reach the follow-up request');
      sendEvents(res, [
        ['message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test/messages', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PI_MESSAGES_OK' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    } else if (req.url === '/v1/responses') {
      const item = { type: 'message', id: 'msg_response', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PI_RESPONSES_OK', annotations: [] }] };
      sendEvents(res, [
        ['response.created', { response: { id: 'resp_test', status: 'in_progress', output: [] } }],
        ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.content_part.added', { output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } }],
        ['response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: 'PI_RESPONSES_OK' }],
        ['response.output_item.done', { output_index: 0, item }],
        ['response.completed', { response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
      ]);
    } else if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'text/event-stream');
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'PI_COMPLETIONS_OK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]) res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', model: 'test/completions', ...chunk })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, ZENMUX_MODEL_CATALOG_URL: `${base}/models`, ZENMUX_API_BASE_URL: `${base}/v1`, ZENMUX_ANTHROPIC_BASE_URL: `${base}/anthropic`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const common = ['--no-extensions', '-e', extension, '--no-skills', '--no-context-files', '--no-session', '--no-tools', '--approve'];
  const listed = await run([...common, '--list-models', 'zenmux'], env);
  for (const model of models) assert.ok(listed.stdout.includes(model.slug), JSON.stringify(listed));
  for (const [model, expected] of [['messages', 'PI_MESSAGES_OK'], ['responses', 'PI_RESPONSES_OK'], ['completions', 'PI_COMPLETIONS_OK']]) {
    const result = await run([...common, '--offline', '--provider', 'zenmux', '--model', `test/${model}`, '-p', 'Reply OK'], env);
    assert.ok(result.stdout.includes(expected), JSON.stringify(result));
  }
  const toolResult = await run([...common, '--offline', '--tools', 'read', '--provider', 'zenmux', '--model', 'test/messages', '-p', 'TOOL_CALL_TEST: read the fixture then reply OK'], env);
  assert.ok(toolResult.stdout.includes('PI_MESSAGES_OK'), JSON.stringify(toolResult));
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer mock-local-only');
    assert.equal(request.headers['x-title'], 'Pi');
    assert.ok(request.headers['x-zenmux-session-id']);
  }
  assert.ok(requests[0].body.system?.length, 'Pi system prompt must reach Anthropic');
  assert.ok(requests[1].body.instructions || requests[1].body.input.some(x => x.role === 'system' || x.role === 'developer'), 'Pi system prompt must reach Responses');
  assert.ok(requests[2].body.messages.some(x => x.role === 'system' || x.role === 'developer'), 'Pi system prompt must reach Chat Completions');
});
