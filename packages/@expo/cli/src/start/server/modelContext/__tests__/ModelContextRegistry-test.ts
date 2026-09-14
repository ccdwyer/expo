import type { ToolOwner } from '../ModelContextPolicy';
import { ModelContextRegistry, toMcpName } from '../ModelContextRegistry';

jest.mock('../../../../log');

const PROJECT_ROOT = '/app';

const TODO_TOOL = {
  name: 'add-todo',
  description: 'Add a todo',
  inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
};

function createRegistry(owners: Record<string, ToolOwner> = {}) {
  const registry = new ModelContextRegistry(PROJECT_ROOT);
  // The fake resolver reads the owner from the `stack` string so tests can pick it per tool.
  registry.configure({
    serverBaseUrl: 'http://localhost:8081',
    resolveOwner: async ({ stack }) => owners[stack ?? ''] ?? { kind: 'project' },
  });
  return registry;
}

function connect(registry: ModelContextRegistry, id = 'c1', trusted = true) {
  const send = jest.fn();
  registry.addConnection({ id, trusted, send });
  registry.markHello(id, 'ios');
  return { id, send };
}

describe(ModelContextRegistry, () => {
  it('requires hello before registering', async () => {
    const registry = createRegistry();
    registry.addConnection({ id: 'c1', trusted: true, send: jest.fn() });
    await expect(registry.registerToolAsync('c1', TODO_TOOL)).rejects.toThrow(/hello/);
  });

  it('allows project tools and exposes them under app__', async () => {
    const registry = createRegistry();
    connect(registry);
    const tool = await registry.registerToolAsync('c1', TODO_TOOL);
    expect(tool).toMatchObject({
      status: 'allowed',
      mcpName: 'app__add-todo',
      owner: { kind: 'project' },
    });
    expect(registry.listAllowedTools()).toHaveLength(1);
  });

  it('blocks package tools until the package is allowed', async () => {
    const registry = createRegistry({ sqlite: { kind: 'package', name: 'expo-sqlite' } });
    connect(registry);
    const tool = await registry.registerToolAsync('c1', {
      ...TODO_TOOL,
      name: 'query',
      stack: 'sqlite',
    });
    expect(tool).toMatchObject({
      status: 'blocked',
      blockedReason: 'package-not-allowed',
      mcpName: 'pkg_expo-sqlite__query',
    });
    await expect(registry.callToolAsync('pkg_expo-sqlite__query', {})).rejects.toThrow(/blocked/);

    const onChange = jest.fn();
    registry.on('change', onChange);
    registry.allowPackageForSession('expo-sqlite');
    expect(registry.getToolByMcpName('pkg_expo-sqlite__query')).toMatchObject({
      status: 'allowed',
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('allows package tools listed in the policy', async () => {
    const registry = createRegistry({ sqlite: { kind: 'package', name: 'expo-sqlite' } });
    registry.configure({ policy: { allowedPackages: ['expo-sqlite'], deniedTools: [] } });
    connect(registry);
    const tool = await registry.registerToolAsync('c1', { ...TODO_TOOL, stack: 'sqlite' });
    expect(tool.status).toBe('allowed');
  });

  it('blocks denied tools from any owner', async () => {
    const registry = createRegistry();
    registry.configure({ policy: { allowedPackages: [], deniedTools: ['add-todo'] } });
    connect(registry);
    const tool = await registry.registerToolAsync('c1', TODO_TOOL);
    expect(tool).toMatchObject({ status: 'blocked', blockedReason: 'denied-tool' });
  });

  it('blocks tools from untrusted connections until approved', async () => {
    const registry = createRegistry();
    connect(registry, 'lan', false);
    const tool = await registry.registerToolAsync('lan', TODO_TOOL);
    expect(tool).toMatchObject({ status: 'blocked', blockedReason: 'untrusted-connection' });
    registry.approveConnectionForSession('lan');
    expect(registry.getToolByMcpName('app__add-todo')).toMatchObject({ status: 'allowed' });
  });

  it('rejects a name already held by a different owner', async () => {
    const registry = createRegistry({ evil: { kind: 'package', name: 'evil-pkg' } });
    connect(registry);
    await registry.registerToolAsync('c1', TODO_TOOL);
    await expect(
      registry.registerToolAsync('c1', { ...TODO_TOOL, description: 'Shadow', stack: 'evil' })
    ).rejects.toThrow(/already registered by the app/);
    expect(registry.getToolByMcpName('app__add-todo')?.descriptor.description).toBe('Add a todo');
  });

  it('replaces a tool re-registered by the same owner (fast refresh)', async () => {
    const registry = createRegistry();
    connect(registry);
    await registry.registerToolAsync('c1', TODO_TOOL);
    await registry.registerToolAsync('c1', { ...TODO_TOOL, description: 'Add a todo item' });
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0]!.descriptor.description).toBe('Add a todo item');
  });

  it('unregisters tools and clears them when the connection closes', async () => {
    const registry = createRegistry();
    connect(registry);
    await registry.registerToolAsync('c1', TODO_TOOL);
    await registry.registerToolAsync('c1', { ...TODO_TOOL, name: 'list-todos' });
    expect(registry.unregisterTool('c1', 'add-todo')).toBe(true);
    expect(registry.unregisterTool('other', 'list-todos')).toBe(false);
    registry.removeConnection('c1');
    expect(registry.listTools()).toHaveLength(0);
  });

  it('caps the number of tools per connection', async () => {
    const registry = createRegistry();
    connect(registry);
    for (let i = 0; i < 200; i++) {
      await registry.registerToolAsync('c1', { ...TODO_TOOL, name: `tool-${i}` });
    }
    await expect(
      registry.registerToolAsync('c1', { ...TODO_TOOL, name: 'one-more' })
    ).rejects.toThrow(/at most 200/);
  });

  describe('callToolAsync', () => {
    it('forwards the call and resolves with the validated result', async () => {
      const registry = createRegistry();
      const { send } = connect(registry);
      await registry.registerToolAsync('c1', TODO_TOOL);

      const promise = registry.callToolAsync('app__add-todo', { text: 'milk' });
      expect(send).toHaveBeenCalledTimes(1);
      const request = JSON.parse(send.mock.calls[0][0]);
      expect(request).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'add-todo', arguments: { text: 'milk' }, timeoutMs: 10000 },
      });

      expect(
        registry.handleResponse('c1', {
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: 'Added' }] },
        })
      ).toBe(true);
      await expect(promise).resolves.toEqual({ content: [{ type: 'text', text: 'Added' }] });
    });

    it('rejects on tool errors and invalid results', async () => {
      const registry = createRegistry();
      const { send } = connect(registry);
      await registry.registerToolAsync('c1', TODO_TOOL);

      const failing = registry.callToolAsync('app__add-todo', {});
      registry.handleResponse('c1', {
        jsonrpc: '2.0',
        id: JSON.parse(send.mock.calls[0][0]).id,
        error: { code: -32000, message: 'boom' },
      });
      await expect(failing).rejects.toThrow('boom');

      const invalid = registry.callToolAsync('app__add-todo', {});
      registry.handleResponse('c1', {
        jsonrpc: '2.0',
        id: JSON.parse(send.mock.calls[1][0]).id,
        result: { content: 'not-an-array' },
      });
      await expect(invalid).rejects.toThrow(/invalid result/);
    });

    it('ignores responses from a different connection', async () => {
      const registry = createRegistry();
      const { send } = connect(registry);
      connect(registry, 'c2');
      await registry.registerToolAsync('c1', TODO_TOOL);
      const promise = registry.callToolAsync('app__add-todo', {});
      const id = JSON.parse(send.mock.calls[0][0]).id;
      expect(registry.handleResponse('c2', { jsonrpc: '2.0', id, result: { content: [] } })).toBe(
        false
      );
      registry.handleResponse('c1', { jsonrpc: '2.0', id, result: { content: [] } });
      await expect(promise).resolves.toEqual({ content: [] });
    });

    it('times out and rejects when the app disconnects', async () => {
      jest.useFakeTimers();
      try {
        const registry = createRegistry();
        connect(registry);
        await registry.registerToolAsync('c1', TODO_TOOL);

        const timedOut = registry.callToolAsync('app__add-todo', {}, { timeoutMs: 50 });
        jest.advanceTimersByTime(60);
        await expect(timedOut).rejects.toThrow(/timed out after 50ms/);

        const disconnected = registry.callToolAsync('app__add-todo', {});
        registry.removeConnection('c1');
        await expect(disconnected).rejects.toThrow(/disconnected/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects unknown tools', async () => {
      const registry = createRegistry();
      await expect(registry.callToolAsync('app__nope', {})).rejects.toThrow(/Unknown tool/);
    });
  });
});

describe(toMcpName, () => {
  it('namespaces by owner', () => {
    expect(toMcpName('x', { kind: 'project' })).toBe('app__x');
    expect(toMcpName('x', { kind: 'package', name: '@scope/pkg' })).toBe('pkg_scope_pkg__x');
    expect(toMcpName('x', { kind: 'unknown' })).toBe('unknown__x');
  });
});
