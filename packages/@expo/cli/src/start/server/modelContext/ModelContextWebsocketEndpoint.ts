import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';

import { isLocalSocket, isMatchingOrigin } from '../../../utils/net';
import {
  HelloParamsSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  LIMITS,
  RegisterToolParamsSchema,
  UnregisterToolParamsSchema,
  formatIssues,
} from './ModelContext.schema';
import { ModelContextRegistry, ToolRegistrationError } from './ModelContextRegistry';

export const MODEL_CONTEXT_ENDPOINT = '/_expo/model-context';

let nextConnectionId = 1;

/**
 * WebSocket endpoint apps use to register runtime tools. Every message is validated with Zod
 * before it reaches the registry. Binary frames are ignored.
 */
export function createModelContextWebsocketEndpoint({
  registry,
  serverBaseUrl,
}: {
  registry: ModelContextRegistry;
  serverBaseUrl: string;
}): Record<string, WebSocketServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.messageBytes });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connectionId = `mc-${nextConnectionId++}`;
    const trusted = isLocalSocket(request.socket) && isMatchingOrigin(request, serverBaseUrl);

    registry.addConnection({
      id: connectionId,
      trusted,
      remoteAddress: request.socket.remoteAddress,
      send: (message) => socket.send(message),
    });

    const reply = (
      id: string | number | undefined,
      body: { result?: unknown; error?: unknown }
    ) => {
      if (id == null) return;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
    };

    socket.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (json == null || typeof json !== 'object') {
        return;
      }

      // Responses to `tools/call` come back with the call id and a result or error.
      const response = JsonRpcResponseSchema.safeParse(json);
      if (response.success && !('method' in json)) {
        registry.handleResponse(connectionId, response.data);
        return;
      }

      const request = JsonRpcRequestSchema.safeParse(json);
      if (!request.success) {
        return;
      }
      const { id, method, params } = request.data;

      try {
        switch (method) {
          case 'modelContext/hello': {
            const hello = HelloParamsSchema.parse(params);
            registry.markHello(connectionId, hello.platform);
            reply(id, { result: { ok: true } });
            break;
          }
          case 'modelContext/registerTool': {
            const tool = await registry.registerToolAsync(
              connectionId,
              RegisterToolParamsSchema.parse(params)
            );
            reply(id, {
              result: { name: tool.name, status: tool.status, reason: tool.blockedReason },
            });
            break;
          }
          case 'modelContext/unregisterTool': {
            const { name } = UnregisterToolParamsSchema.parse(params);
            reply(id, { result: { removed: registry.unregisterTool(connectionId, name) } });
            break;
          }
          default:
            reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
        }
      } catch (error: any) {
        const message =
          error?.name === 'ZodError'
            ? `Invalid params for ${method}: ${formatIssues(error)}`
            : (error?.message ?? String(error));
        const code = error instanceof ToolRegistrationError ? error.code : -32602;
        reply(id, { error: { code, message } });
      }
    });

    const cleanup = () => registry.removeConnection(connectionId);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  return { [MODEL_CONTEXT_ENDPOINT]: wss };
}
