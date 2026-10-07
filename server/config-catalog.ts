import { randomUUID } from 'node:crypto';
import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigCatalog } from '../shared/types.js';
import { getPermissionSettings, permissionSettingsPath } from './permissions.js';
import { listSkills } from './skills.js';
import { agentInstructionsPath, agentMemoryPath, agentsPath, dataRoot, loadAgents, personaPath } from './storage.js';
import { aigcSettingsPath, credentialStatus, getAigcSettings } from './aigc.js';
import { listMcpServers } from './mcp-registry.js';

export const configCatalogPath = path.join(dataRoot, 'config-catalog.json');
let writes: Promise<ConfigCatalog> = Promise.resolve(null as unknown as ConfigCatalog);

async function modifiedAt(file: string): Promise<string | undefined> {
  try { return (await stat(file)).mtime.toISOString(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function buildCatalog(): Promise<ConfigCatalog> {
  const [agents, skills, agentSavedAt, permissionSavedAt, aigcSavedAt] = await Promise.all([
    loadAgents(), listSkills(), modifiedAt(agentsPath), modifiedAt(permissionSettingsPath), modifiedAt(aigcSettingsPath),
  ]);
  return {
    path: configCatalogPath,
    generatedAt: new Date().toISOString(),
    agents: agents.map(({ persona: _persona, ...agent }) => ({
      ...agent,
      metadataPath: agentsPath,
      personaPath: personaPath(agent.id),
      instructionsPath: agentInstructionsPath(agent.id),
      memoryPath: agentMemoryPath(agent.id),
      savedAt: agentSavedAt ?? '',
    })),
    skills: await Promise.all(skills.map(async (skill) => ({
      name: skill.name, description: skill.description, path: skill.path,
      savedAt: await modifiedAt(skill.path) ?? '',
    }))),
    mcpServers: await listMcpServers(),
    globalPermissions: { ...getPermissionSettings(), path: permissionSettingsPath, savedAt: permissionSavedAt },
    aigcSettings: { ...getAigcSettings(), path: aigcSettingsPath, savedAt: aigcSavedAt, credentialStatus: credentialStatus() },
  };
}

export function refreshConfigCatalog(): Promise<ConfigCatalog> {
  const next = writes.catch(() => null as unknown as ConfigCatalog).then(async () => {
    const catalog = await buildCatalog();
    const temporary = `${configCatalogPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(catalog, null, 2), 'utf8');
    await rename(temporary, configCatalogPath);
    return catalog;
  });
  writes = next;
  return next;
}
