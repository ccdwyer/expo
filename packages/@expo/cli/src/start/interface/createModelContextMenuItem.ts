import chalk from 'chalk';

import * as Log from '../../log';
import { selectAsync } from '../../utils/prompts';
import { describeBlockReason, describeOwner } from '../server/modelContext/ModelContextPolicy';
import type { ModelContextRegistry } from '../server/modelContext/ModelContextRegistry';
import type { MoreToolMenuItem } from './createDevToolsMenuItems';

/**
 * Menu entry that lists tools the running app registered through `modelContext` from `expo/devtools` and lets
 * the developer allow a blocked package for this session. Hidden while no app is connected.
 */
export function createModelContextMenuItem(registry: ModelContextRegistry): MoreToolMenuItem[] {
  if (registry.listConnections().length === 0) {
    return [];
  }
  const blockedCount = registry.listBlockedTools().length;
  return [
    {
      title: chalk`App model context tools${blockedCount > 0 ? chalk.yellow(` (${blockedCount} blocked)`) : ''}`,
      value: 'modelContextTools',
      action: async () => {
        printTools(registry);
        const blockedPackages = [
          ...new Set(
            registry
              .listBlockedTools()
              .filter((tool) => tool.blockedReason === 'package-not-allowed')
              .map((tool) => (tool.owner.kind === 'package' ? tool.owner.name : null))
              .filter((name): name is string => name != null)
          ),
        ];
        const untrusted = registry.listConnections().filter((c) => !c.trusted && !c.approved);
        if (blockedPackages.length === 0 && untrusted.length === 0) {
          return;
        }
        try {
          const value = await selectAsync(chalk`{dim Allow for this session}`, [
            ...blockedPackages.map((name) => ({
              title: `Allow tools from package "${name}"`,
              value: `package:${name}`,
            })),
            ...untrusted.map((connection) => ({
              title: `Trust connection ${connection.id}${connection.platform ? ` (${connection.platform})` : ''}`,
              value: `connection:${connection.id}`,
            })),
            { title: 'Cancel', value: 'cancel' },
          ]);
          if (value.startsWith('package:')) {
            registry.allowPackageForSession(value.slice('package:'.length));
            Log.log(
              chalk`Allowed for this session. Add it to {bold expo.extra.modelContext.allowedPackages} in app.json to persist.`
            );
          } else if (value.startsWith('connection:')) {
            registry.approveConnectionForSession(value.slice('connection:'.length));
          }
        } catch {
          // Handle aborting prompt
        }
      },
    },
  ];
}

function printTools(registry: ModelContextRegistry) {
  const allowed = registry.listAllowedTools();
  const blocked = registry.listBlockedTools();
  if (allowed.length === 0 && blocked.length === 0) {
    Log.log(chalk.dim('The connected app has not registered any tools.'));
    return;
  }
  for (const tool of allowed) {
    Log.log(chalk`  {green ●} {bold ${tool.mcpName}} {dim — ${describeOwner(tool.owner)}}`);
  }
  for (const tool of blocked) {
    Log.log(
      chalk`  {yellow ○} {bold ${tool.mcpName}} {dim — ${describeOwner(tool.owner)}, blocked: ${describeBlockReason(tool.blockedReason!, tool.owner)}}`
    );
  }
}
