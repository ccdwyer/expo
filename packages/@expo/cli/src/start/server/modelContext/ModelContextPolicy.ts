import type { ExpoConfig } from '@expo/config';
import path from 'node:path';
import { z } from 'zod';

import { Log } from '../../../log';
import { isPathInside } from '../../../utils/dir';
import { ToolNameSchema, formatIssues } from './ModelContext.schema';

/**
 * Who registered a tool. Computed by the dev server from the symbolicated registration stack.
 * The analog of a WebMCP origin: `project` is same-origin, `package` is cross-origin.
 */
export type ToolOwner =
  | { kind: 'project'; file?: string }
  | { kind: 'package'; name: string; file?: string }
  | { kind: 'unknown' };

/**
 * Policy read from `expo.extra.modelContext` in the app config.
 *
 * ```json
 * { "expo": { "extra": { "modelContext": { "allowedPackages": ["expo-sqlite"], "deniedTools": ["dump-db"] } } } }
 * ```
 */
export interface ModelContextPolicy {
  /** Packages whose runtime tools are exposed to agents. Tools from other packages are blocked. */
  allowedPackages: string[];
  /** Tool names that are never exposed, whatever the owner. */
  deniedTools: string[];
}

const PolicyConfigSchema = z
  .object({
    allowedPackages: z.array(z.string().min(1).max(214)).optional(),
    deniedTools: z.array(ToolNameSchema).optional(),
  })
  .strict();

export const EMPTY_POLICY: ModelContextPolicy = { allowedPackages: [], deniedTools: [] };

export function parseModelContextPolicy(
  exp: Pick<ExpoConfig, 'extra'> | undefined
): ModelContextPolicy {
  const raw = exp?.extra?.modelContext;
  if (raw == null) {
    return EMPTY_POLICY;
  }
  const parsed = PolicyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    Log.warn(
      `Ignoring invalid "expo.extra.modelContext" config: ${formatIssues(parsed.error)}. ` +
        `Expected { allowedPackages?: string[], deniedTools?: string[] }.`
    );
    return EMPTY_POLICY;
  }
  return {
    allowedPackages: parsed.data.allowedPackages ?? [],
    deniedTools: parsed.data.deniedTools ?? [],
  };
}

export type BlockReason =
  | 'denied-tool'
  | 'package-not-allowed'
  | 'unknown-owner'
  | 'untrusted-connection';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: BlockReason };

export interface PolicyContext {
  policy: ModelContextPolicy;
  /** Packages the developer approved in the CLI for this session. */
  sessionAllowedPackages: ReadonlySet<string>;
  /** Whether the registering connection is a trusted (local, same-origin) client. */
  trustedConnection: boolean;
  /** Whether the developer approved this connection in the CLI for this session. */
  sessionApprovedConnection: boolean;
}

export function evaluatePolicy(
  owner: ToolOwner,
  toolName: string,
  context: PolicyContext
): PolicyDecision {
  if (context.policy.deniedTools.includes(toolName)) {
    return { allowed: false, reason: 'denied-tool' };
  }
  if (!context.trustedConnection && !context.sessionApprovedConnection) {
    return { allowed: false, reason: 'untrusted-connection' };
  }
  switch (owner.kind) {
    case 'project':
      return { allowed: true };
    case 'package':
      if (
        context.policy.allowedPackages.includes(owner.name) ||
        context.sessionAllowedPackages.has(owner.name)
      ) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'package-not-allowed' };
    case 'unknown':
    default:
      return { allowed: false, reason: 'unknown-owner' };
  }
}

/** Frames from these paths belong to the registry itself or to React and are skipped. */
const SKIPPED_FRAME_PATTERNS = [
  /[\\/]@expo[\\/]devtools[\\/](src|build)[\\/]modelContext[\\/]/,
  /[\\/]node_modules[\\/]react[\\/]/,
  /[\\/]node_modules[\\/]react-dom[\\/]/,
  /[\\/]node_modules[\\/]react-native[\\/]Libraries[\\/]Renderer[\\/]/,
  /[\\/]node_modules[\\/]scheduler[\\/]/,
];

const PACKAGE_FROM_PATH = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g;

/**
 * Picks the owner from symbolicated frame paths (closest call site first).
 * Paths may be absolute or relative to `projectRoot`.
 */
export function classifyOwner(
  files: (string | null | undefined)[],
  projectRoot: string
): ToolOwner {
  for (const rawFile of files) {
    if (!rawFile || rawFile.startsWith('<') || rawFile.startsWith('http')) {
      continue;
    }
    const file = path.resolve(projectRoot, rawFile);
    if (SKIPPED_FRAME_PATTERNS.some((pattern) => pattern.test(file))) {
      continue;
    }
    // The last `node_modules/<name>` segment names the package that owns the file.
    let packageName: string | null = null;
    for (const match of file.matchAll(PACKAGE_FROM_PATH)) {
      packageName = match[1] ?? null;
    }
    if (packageName) {
      return { kind: 'package', name: packageName.replace(/\\/g, '/'), file };
    }
    if (isPathInside(file, projectRoot)) {
      return { kind: 'project', file };
    }
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export function describeOwner(owner: ToolOwner): string {
  switch (owner.kind) {
    case 'project':
      return 'the app';
    case 'package':
      return `package "${owner.name}"`;
    default:
      return 'an unknown source';
  }
}

export function describeBlockReason(reason: BlockReason, owner: ToolOwner): string {
  switch (reason) {
    case 'denied-tool':
      return 'listed in "expo.extra.modelContext.deniedTools"';
    case 'package-not-allowed':
      return (
        `registered by ${describeOwner(owner)}, which is not in "expo.extra.modelContext.allowedPackages"` +
        (owner.kind === 'package' ? ` (add "${owner.name}" to allow it)` : '')
      );
    case 'unknown-owner':
      return 'registered from a source the dev server could not attribute';
    case 'untrusted-connection':
      return 'registered from a connection that is not local to the dev server';
  }
}
