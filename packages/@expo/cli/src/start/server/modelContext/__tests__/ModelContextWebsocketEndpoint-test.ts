import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { ModelContextRegistry } from '../ModelContextRegistry';
import {
  MODEL_CONTEXT_ENDPOINT,
  createModelContextWebsocketEndpoint,
} from '../ModelContextWebsocketEndpoint';

jest.mock('../../../../log');

describe(createModelContextWebsocketEndpoint, () => {
  let server: Server;
  let registry: ModelContextRegistry;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    registry = new ModelContextRegistry('/app');
    registry.configure({ resolveOwner: async () => ({ kind: 'project' }) });
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    const endpoints = createModelContextWebsocketEndpoint({ registry, serverBaseUrl: baseUrl });
    const wss = endpoints[MODEL_CONTEXT_ENDPOINT]!;
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(headers: Record<string, string> = {}) {
    const ws = new WebSocket(baseUrl.replace('http', 'ws') + MODEL_CONTEXT_ENDPOINT, { headers });
    sockets.push(ws);
    await once(ws, 'open');
    const inbox = new EventEmitter();
    ws.on('message', (data) => inbox.emit('message', JSON.parse(data.toString())));
    const request = async (method: string, params: unknown, id = Math.random().toString(36)) => {
      const reply = once(inbox, 'message');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return (await reply)[0];
    };
    return { ws, inbox, request };
  }

  it('registers, calls and unregisters a tool over the socket', async () => {
    const { ws, inbox, request } = await connect();

    expect(
      await request('modelContext/hello', { protocolVersion: 1, platform: 'ios' })
    ).toMatchObject({
      result: { ok: true },
    });
    expect(
      await request('modelContext/registerTool', {
        name: 'add-todo',
        description: 'Add a todo',
        inputSchema: { type: 'object' },
      })
    ).toMatchObject({ result: { name: 'add-todo', status: 'allowed' } });
    expect(registry.listConnections()).toEqual([
      { id: expect.any(String), trusted: true, approved: false, platform: 'ios' },
    ]);

    // The app answers the forwarded `tools/call`.
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === 'tools/call') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: `got ${message.params.arguments.text}` }] },
          })
        );
      }
    });
    await expect(registry.callToolAsync('app__add-todo', { text: 'milk' })).resolves.toEqual({
      content: [{ type: 'text', text: 'got milk' }],
    });

    expect(await request('modelContext/unregisterTool', { name: 'add-todo' })).toMatchObject({
      result: { removed: true },
    });
    expect(registry.listTools()).toHaveLength(0);
    inbox.removeAllListeners();
  });

  it('rejects invalid params and unknown methods with JSON-RPC errors', async () => {
    const { request } = await connect();
    await request('modelContext/hello', { protocolVersion: 1 });

    expect(
      await request('modelContext/registerTool', {
        name: 'bad name!',
        description: 'x',
        inputSchema: { type: 'object' },
      })
    ).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/name/) } });

    expect(
      await request('modelContext/registerTool', {
        name: 'ref',
        description: 'x',
        inputSchema: { type: 'object', properties: { a: { $ref: '#/x' } } },
      })
    ).toMatchObject({ error: { message: expect.stringMatching(/\$ref/) } });

    expect(await request('nope', {})).toMatchObject({ error: { code: -32601 } });
    expect(registry.listTools()).toHaveLength(0);
  });

  it('marks connections from another origin as untrusted', async () => {
    const { request } = await connect({ origin: 'http://evil.example' });
    await request('modelContext/hello', { protocolVersion: 1 });
    expect(
      await request('modelContext/registerTool', {
        name: 'x',
        description: 'x',
        inputSchema: { type: 'object' },
      })
    ).toMatchObject({ result: { status: 'blocked', reason: 'untrusted-connection' } });
  });

  it('removes tools when the socket closes', async () => {
    const { ws, request } = await connect();
    await request('modelContext/hello', { protocolVersion: 1 });
    await request('modelContext/registerTool', {
      name: 'x',
      description: 'x',
      inputSchema: { type: 'object' },
    });
    expect(registry.listTools()).toHaveLength(1);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.listTools()).toHaveLength(0);
    expect(registry.listConnections()).toHaveLength(0);
  });
});
