import { parse } from 'stacktrace-parser';

import { fetch } from '../../../utils/fetch';
import { type ToolOwner, classifyOwner } from './ModelContextPolicy';

interface SymbolicatedFrame {
  file?: string | null;
}

/**
 * Attributes a registration to the app or to a package by symbolicating the stack the app sent
 * through Metro's `/symbolicate` endpoint. Returns `unknown` when symbolication fails.
 */
export async function resolveToolOwnerAsync({
  stack,
  projectRoot,
  serverBaseUrl,
  fetchImpl = fetch,
}: {
  stack: string | undefined;
  projectRoot: string;
  serverBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ToolOwner> {
  if (!stack) {
    return { kind: 'unknown' };
  }
  const frames = parse(stack)
    .filter((frame) => frame.file && frame.lineNumber != null)
    .map((frame) => ({
      file: frame.file,
      lineNumber: frame.lineNumber,
      column: frame.column != null ? frame.column - 1 : null,
      methodName: frame.methodName,
    }));
  if (frames.length === 0) {
    return { kind: 'unknown' };
  }

  // Frames that already point at source files (web builds, or monorepo setups) need no symbolication.
  if (frames.every((frame) => !/^https?:/.test(frame.file!))) {
    return classifyOwner(
      frames.map((frame) => frame.file),
      projectRoot
    );
  }

  try {
    const response = await fetchImpl(`${serverBaseUrl}/symbolicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: frames }),
    });
    if (!response.ok) {
      return { kind: 'unknown' };
    }
    const body = (await response.json()) as { stack?: SymbolicatedFrame[] };
    if (!Array.isArray(body?.stack)) {
      return { kind: 'unknown' };
    }
    return classifyOwner(
      body.stack.map((frame) => frame?.file),
      projectRoot
    );
  } catch {
    return { kind: 'unknown' };
  }
}
