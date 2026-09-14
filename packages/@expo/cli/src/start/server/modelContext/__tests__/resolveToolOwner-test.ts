import { resolveToolOwnerAsync } from '../resolveToolOwner';

jest.mock('../../../../log');

const HERMES_STACK = [
  'Error',
  '    at registerTool (http://localhost:8081/index.bundle?platform=ios&dev=true:1200:30)',
  '    at TodoScreen (http://localhost:8081/index.bundle?platform=ios&dev=true:3400:12)',
  '    at renderWithHooks (http://localhost:8081/index.bundle?platform=ios&dev=true:9000:1)',
].join('\n');

function mockFetch(stack: { file: string | null }[], ok = true) {
  return jest.fn(async () => ({ ok, json: async () => ({ stack }) })) as any;
}

describe(resolveToolOwnerAsync, () => {
  it('symbolicates bundle frames and classifies the closest non-registry frame', async () => {
    const fetchImpl = mockFetch([
      { file: '/app/node_modules/@expo/devtools/build/modelContext/ModelContextClient.js' },
      { file: '/app/src/TodoScreen.tsx' },
      {
        file: '/app/node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js',
      },
    ]);
    await expect(
      resolveToolOwnerAsync({
        stack: HERMES_STACK,
        projectRoot: '/app',
        serverBaseUrl: 'http://localhost:8081',
        fetchImpl,
      })
    ).resolves.toEqual({ kind: 'project', file: '/app/src/TodoScreen.tsx' });

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8081/symbolicate', expect.anything());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.stack[0]).toMatchObject({ lineNumber: 1200, column: 29 });
  });

  it('attributes package frames', async () => {
    const fetchImpl = mockFetch([
      { file: 'node_modules/@expo/devtools/build/modelContext/ModelContextClient.js' },
      { file: 'node_modules/expo-sqlite/build/tools.js' },
    ]);
    await expect(
      resolveToolOwnerAsync({
        stack: HERMES_STACK,
        projectRoot: '/app',
        serverBaseUrl: 'http://localhost:8081',
        fetchImpl,
      })
    ).resolves.toMatchObject({ kind: 'package', name: 'expo-sqlite' });
  });

  it('classifies without symbolication when frames already point at files', async () => {
    const fetchImpl = jest.fn();
    await expect(
      resolveToolOwnerAsync({
        stack: 'Error\n    at register (/app/node_modules/some-pkg/index.js:1:1)',
        projectRoot: '/app',
        serverBaseUrl: 'http://localhost:8081',
        fetchImpl,
      })
    ).resolves.toMatchObject({ kind: 'package', name: 'some-pkg' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns unknown without a stack or when symbolication fails', async () => {
    await expect(
      resolveToolOwnerAsync({ stack: undefined, projectRoot: '/app', serverBaseUrl: '' })
    ).resolves.toEqual({ kind: 'unknown' });
    await expect(
      resolveToolOwnerAsync({
        stack: HERMES_STACK,
        projectRoot: '/app',
        serverBaseUrl: 'http://localhost:8081',
        fetchImpl: mockFetch([], false),
      })
    ).resolves.toEqual({ kind: 'unknown' });
    await expect(
      resolveToolOwnerAsync({
        stack: HERMES_STACK,
        projectRoot: '/app',
        serverBaseUrl: 'http://localhost:8081',
        fetchImpl: jest.fn(async () => {
          throw new Error('offline');
        }) as any,
      })
    ).resolves.toEqual({ kind: 'unknown' });
  });
});
