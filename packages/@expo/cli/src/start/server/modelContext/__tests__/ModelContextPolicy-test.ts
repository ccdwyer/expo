import {
  classifyOwner,
  evaluatePolicy,
  parseModelContextPolicy,
  type PolicyContext,
} from '../ModelContextPolicy';

jest.mock('../../../../log');

const PROJECT_ROOT = '/app';

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    policy: { allowedPackages: [], deniedTools: [] },
    sessionAllowedPackages: new Set(),
    trustedConnection: true,
    sessionApprovedConnection: false,
    ...overrides,
  };
}

describe(parseModelContextPolicy, () => {
  it('returns an empty policy without config', () => {
    expect(parseModelContextPolicy(undefined)).toEqual({ allowedPackages: [], deniedTools: [] });
    expect(parseModelContextPolicy({ extra: {} })).toEqual({
      allowedPackages: [],
      deniedTools: [],
    });
  });

  it('reads allowedPackages and deniedTools from expo.extra.modelContext', () => {
    expect(
      parseModelContextPolicy({
        extra: { modelContext: { allowedPackages: ['expo-sqlite'], deniedTools: ['dump-db'] } },
      })
    ).toEqual({ allowedPackages: ['expo-sqlite'], deniedTools: ['dump-db'] });
  });

  it('ignores invalid config', () => {
    expect(
      parseModelContextPolicy({ extra: { modelContext: { enabled: true, allowedPackages: 'x' } } })
    ).toEqual({ allowedPackages: [], deniedTools: [] });
  });
});

describe(classifyOwner, () => {
  it('attributes project files to the app', () => {
    expect(classifyOwner(['/app/src/screens/Todo.tsx'], PROJECT_ROOT)).toEqual({
      kind: 'project',
      file: '/app/src/screens/Todo.tsx',
    });
    expect(classifyOwner(['app/index.tsx'], PROJECT_ROOT)).toMatchObject({ kind: 'project' });
  });

  it('attributes node_modules files to their package', () => {
    expect(classifyOwner(['/app/node_modules/expo-sqlite/build/index.js'], PROJECT_ROOT)).toEqual({
      kind: 'package',
      name: 'expo-sqlite',
      file: '/app/node_modules/expo-sqlite/build/index.js',
    });
    expect(classifyOwner(['node_modules/@scope/pkg/dist/tools.js'], PROJECT_ROOT)).toMatchObject({
      kind: 'package',
      name: '@scope/pkg',
    });
  });

  it('uses the innermost node_modules segment for nested dependencies', () => {
    expect(
      classifyOwner(['/app/node_modules/a/node_modules/b/index.js'], PROJECT_ROOT)
    ).toMatchObject({ kind: 'package', name: 'b' });
  });

  it('skips registry and React frames', () => {
    expect(
      classifyOwner(
        [
          '/app/node_modules/@expo/devtools/build/modelContext/ModelContextClient.js',
          '/app/node_modules/@expo/devtools/build/modelContext/hooks.js',
          '/app/src/App.tsx',
          '/app/node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js',
        ],
        PROJECT_ROOT
      )
    ).toMatchObject({ kind: 'project', file: '/app/src/App.tsx' });
  });

  it('returns unknown for files outside the project and for empty stacks', () => {
    expect(classifyOwner(['/elsewhere/file.js'], PROJECT_ROOT)).toEqual({ kind: 'unknown' });
    expect(classifyOwner([], PROJECT_ROOT)).toEqual({ kind: 'unknown' });
    expect(
      classifyOwner(['<native>', null, 'http://localhost:8081/index.bundle'], PROJECT_ROOT)
    ).toEqual({
      kind: 'unknown',
    });
  });
});

describe(evaluatePolicy, () => {
  it('allows project tools on trusted connections', () => {
    expect(evaluatePolicy({ kind: 'project' }, 'add-todo', context())).toEqual({ allowed: true });
  });

  it('blocks package tools unless allowed by config or session', () => {
    const owner = { kind: 'package' as const, name: 'expo-sqlite' };
    expect(evaluatePolicy(owner, 'query', context())).toEqual({
      allowed: false,
      reason: 'package-not-allowed',
    });
    expect(
      evaluatePolicy(
        owner,
        'query',
        context({ policy: { allowedPackages: ['expo-sqlite'], deniedTools: [] } })
      )
    ).toEqual({ allowed: true });
    expect(
      evaluatePolicy(owner, 'query', context({ sessionAllowedPackages: new Set(['expo-sqlite']) }))
    ).toEqual({ allowed: true });
  });

  it('denied tools win over every owner', () => {
    const policy = { allowedPackages: ['expo-sqlite'], deniedTools: ['drop-db'] };
    expect(evaluatePolicy({ kind: 'project' }, 'drop-db', context({ policy }))).toEqual({
      allowed: false,
      reason: 'denied-tool',
    });
  });

  it('blocks unknown owners', () => {
    expect(evaluatePolicy({ kind: 'unknown' }, 'x', context())).toEqual({
      allowed: false,
      reason: 'unknown-owner',
    });
  });

  it('blocks untrusted connections until approved', () => {
    expect(evaluatePolicy({ kind: 'project' }, 'x', context({ trustedConnection: false }))).toEqual(
      {
        allowed: false,
        reason: 'untrusted-connection',
      }
    );
    expect(
      evaluatePolicy(
        { kind: 'project' },
        'x',
        context({ trustedConnection: false, sessionApprovedConnection: true })
      )
    ).toEqual({ allowed: true });
  });
});
