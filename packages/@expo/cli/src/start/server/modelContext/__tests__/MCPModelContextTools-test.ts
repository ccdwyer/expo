import { addModelContextMcpCapabilities } from '../MCPModelContextTools';
import { ModelContextRegistry } from '../ModelContextRegistry';

jest.mock('../../../../log');

type ToolHandler = (args: any) => Promise<any>;

function createMockMcpServer() {
  const tools = new Map<string, { config: any; handler: ToolHandler }>();
  return {
    tools,
    server: {
      registerTool: jest.fn((name: string, config: any, handler: ToolHandler) => {
        tools.set(name, { config, handler });
      }),
    } as any,
  };
}

describe(addModelContextMcpCapabilities, () => {
  it('registers app_list_tools and app_call_tool', () => {
    const { server, tools } = createMockMcpServer();
    addModelContextMcpCapabilities(server, new ModelContextRegistry('/app'));
    expect([...tools.keys()]).toEqual(['app_list_tools', 'app_call_tool']);
  });

  it('reports when no app is connected', async () => {
    const { server, tools } = createMockMcpServer();
    addModelContextMcpCapabilities(server, new ModelContextRegistry('/app'));
    const result = await tools.get('app_list_tools')!.handler({});
    expect(result.content[0].text).toMatch(/No app is connected/);
  });

  it('lists allowed tools with attribution and blocked tools with reasons', async () => {
    const registry = new ModelContextRegistry('/app');
    registry.configure({
      resolveOwner: async ({ stack }) =>
        stack === 'pkg' ? { kind: 'package', name: 'expo-sqlite' } : { kind: 'project' },
    });
    registry.addConnection({ id: 'c1', trusted: true, send: jest.fn() });
    registry.markHello('c1');
    await registry.registerToolAsync('c1', {
      name: 'add-todo',
      description: 'Add a todo',
      inputSchema: { type: 'object' },
    });
    await registry.registerToolAsync('c1', {
      name: 'query',
      description: 'Run SQL',
      inputSchema: { type: 'object' },
      stack: 'pkg',
    });

    const { server, tools } = createMockMcpServer();
    addModelContextMcpCapabilities(server, registry);
    const result = await tools.get('app_list_tools')!.handler({});
    const body = JSON.parse(result.content[0].text);
    expect(body.tools).toEqual([
      {
        name: 'app__add-todo',
        description: '[Registered at runtime by the app] Add a todo',
        inputSchema: { type: 'object' },
        owner: 'project',
      },
    ]);
    expect(body.blocked).toEqual([
      {
        name: 'pkg_expo-sqlite__query',
        owner: 'package "expo-sqlite"',
        reason: expect.stringContaining('allowedPackages'),
      },
    ]);
  });

  it('forwards app_call_tool to the app and maps the result', async () => {
    const registry = new ModelContextRegistry('/app');
    registry.configure({ resolveOwner: async () => ({ kind: 'project' }) });
    const send = jest.fn((message: string) => {
      const request = JSON.parse(message);
      registry.handleResponse('c1', {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: `echo:${request.params.arguments.text}` }] },
      });
    });
    registry.addConnection({ id: 'c1', trusted: true, send });
    registry.markHello('c1');
    await registry.registerToolAsync('c1', {
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object' },
    });

    const { server, tools } = createMockMcpServer();
    addModelContextMcpCapabilities(server, registry);
    const call = tools.get('app_call_tool')!.handler;

    await expect(call({ name: 'app__echo', arguments: { text: 'hi' } })).resolves.toEqual({
      content: [{ type: 'text', text: 'echo:hi' }],
      isError: undefined,
    });

    const failure = await call({ name: 'app__missing', arguments: {} });
    expect(failure.isError).toBe(true);
    expect(failure.content[0].text).toMatch(/Unknown tool/);
  });
});
