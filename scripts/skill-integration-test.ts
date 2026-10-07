import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SkillDraftRecord, SkillRecord } from '../shared/types.js';
import { loadAgents } from '../server/storage.js';
import { listSkills, skillPath } from '../server/skills.js';
import { publishDraft } from '../server/skill-drafts.js';

const base = process.env.SKILL_TEST_URL ?? 'http://127.0.0.1:8787';
const names = Array.from({ length: 3 }, (_, index) => `skill-test-${Date.now().toString(36)}-${index}`);
const created: string[] = [];
const draftIds: string[] = [];
const temp = await mkdtemp(path.join(tmpdir(), 'skill-test-'));
async function api<T>(route: string, options?: RequestInit, expected = 200): Promise<T> {
  const response = await fetch(`${base}/api${route}`, options);
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
  return data as T;
}
function json(body: unknown, extra: Record<string, string> = {}): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }; }
function content(slug: string, extra = '') { return `---\nname: ${slug}\ndescription: Test Skill for secure import.\n${extra}---\n\n# Instructions\n\nRead the task and report a brief result.\n`; }
async function zip(file: string, entries: Array<{ name: string; content?: string; base64?: string; symlink?: boolean }>) {
  const script = `import sys,zipfile,json,stat,base64\nitems=json.loads(sys.argv[2])\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for item in items:\n  info=zipfile.ZipInfo(item['name'])\n  info.create_system=3\n  info.external_attr=((stat.S_IFLNK if item.get('symlink') else stat.S_IFREG)|0o644)<<16\n  z.writestr(info,base64.b64decode(item['base64']) if item.get('base64') else item.get('content',''))\n`;
  const command = process.platform === 'win32' ? 'py' : 'python3';
  execFileSync(command, [...(process.platform === 'win32' ? ['-3'] : []), '-c', script, file, JSON.stringify(entries)]);
  return readFile(file);
}
const initialAgents = JSON.stringify((await loadAgents()).map((item) => [item.id, item.skills]));
const initialSkills = await listSkills();
const original = await Promise.all(initialSkills.map(async (item) => [item.slug, await readFile(skillPath(item.slug))] as const));
try {
  let draft = await api<SkillDraftRecord>('/skill-drafts', json({ mode: 'new', slug: names[0], description: 'Test Skill for secure import.', body: '# Instructions\n\nRead the task and report a brief result.' }), 201);
  draftIds.push(draft.id);
  assert.equal(draft.files.length, 1);
  draft = await api<SkillDraftRecord>(`/skill-drafts/${draft.id}/validate`, { method: 'POST', headers: { 'If-Match': String(draft.version) } });
  assert.equal(draft.validation?.valid, true, JSON.stringify(draft.validation));
  const published = await api<{ skill: SkillRecord }>(`/skill-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'If-Match': String(draft.version) } });
  assert.equal(published.skill.name, `workbench:${names[0]}`); created.push(names[0]);
  let editA = await api<SkillDraftRecord>('/skill-drafts', json({ mode: 'edit', slug: names[0] }), 201); draftIds.push(editA.id);
  const editB = await api<SkillDraftRecord>('/skill-drafts', json({ mode: 'edit', slug: names[0] }), 201); draftIds.push(editB.id);
  const concurrent = await Promise.all(['# First', '# Second'].map((heading) => fetch(`${base}/api/skill-drafts/${editA.id}/files?path=SKILL.md`, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-Match': String(editA.version) }, body: content(names[0], 'license: MIT\n') + heading })));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
  editA = await api<SkillDraftRecord>(`/skill-drafts/${editA.id}`);
  await api(`/skill-drafts/${editA.id}/files?path=SKILL.md`, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-Match': String(editA.version - 1) }, body: content(names[0]) }, 409);
  editA = await api<SkillDraftRecord>(`/skill-drafts/${editA.id}/validate`, { method: 'POST', headers: { 'If-Match': String(editA.version) } });
  assert.equal(editA.validation?.valid, true);
  await api(`/skill-drafts/${editA.id}/publish`, { method: 'POST', headers: { 'If-Match': String(editA.version) } });
  assert.match(await readFile(skillPath(names[0]), 'utf8'), /license: MIT/);
  await api(`/skills/${names[0]}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: names[0], description: 'Updated compatibility description.', body: '# Instructions\n\nStill safe.' }) });
  assert.match(await readFile(skillPath(names[0]), 'utf8'), /license: MIT/);
  await api(`/skill-drafts/${editB.id}/publish`, { method: 'POST', headers: { 'If-Match': String(editB.version) } }, 409);

  draft = await api<SkillDraftRecord>('/skill-drafts/import?format=markdown', { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: content(names[1]) }, 201); draftIds.push(draft.id);
  draft = await api<SkillDraftRecord>(`/skill-drafts/${draft.id}/validate`, { method: 'POST', headers: { 'If-Match': String(draft.version) } });
  assert.equal(draft.validation?.valid, true);
  await api(`/skill-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'If-Match': String(draft.version) } }); created.push(names[1]);

  const archive = await zip(path.join(temp, 'valid.zip'), [
    { name: `${names[2]}/SKILL.md`, content: content(names[2]) },
    { name: `${names[2]}/references/guide.md`, content: '# Guide\n' },
    { name: `${names[2]}/scripts/check.py`, content: 'print("never run during validation")\n' },
    { name: `${names[2]}/assets/pixel.png`, base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F1sAAAAASUVORK5CYII=' },
  ]);
  draft = await api<SkillDraftRecord>('/skill-drafts/import?format=zip', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive }, 201); draftIds.push(draft.id);
  assert.equal(draft.files.filter((item) => item.kind === 'file').length, 4);
  assert.equal(draft.files.find((item) => item.path === 'assets/pixel.png')?.text, false);
  draft = await api<SkillDraftRecord>(`/skill-drafts/${draft.id}/validate`, { method: 'POST', headers: { 'If-Match': String(draft.version) } });
  assert.equal(draft.validation?.valid, true, JSON.stringify(draft.validation));
  await api(`/skill-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'If-Match': String(draft.version) } }); created.push(names[2]);
  assert.equal((await listSkills()).find((item) => item.slug === names[2])?.fileCount, 4);

  const invalid = await api<SkillDraftRecord>('/skill-drafts/import?format=markdown', { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: '---\nname: [broken\n---\nbody' }, 201); draftIds.push(invalid.id);
  const checked = await api<SkillDraftRecord>(`/skill-drafts/${invalid.id}/validate`, { method: 'POST', headers: { 'If-Match': String(invalid.version) } });
  assert.equal(checked.validation?.valid, false);
  await api(`/skill-drafts/${invalid.id}/publish`, { method: 'POST', headers: { 'If-Match': String(checked.version) } }, 400);
  const invalidForm = await api<SkillDraftRecord>('/skill-drafts', json({ mode: 'new', slug: 'Invalid_Name', description: '', body: '' }), 201); draftIds.push(invalidForm.id);
  const invalidFormCheck = await api<SkillDraftRecord>(`/skill-drafts/${invalidForm.id}/validate`, { method: 'POST', headers: { 'If-Match': String(invalidForm.version) } });
  assert.equal(invalidFormCheck.validation?.valid, false);
  for (const [name, entries] of [
    ['multiple', [{ name: 'a/SKILL.md', content: content('a') }, { name: 'b/SKILL.md', content: content('b') }]],
    ['traversal', [{ name: '../SKILL.md', content: content('bad') }]],
    ['symlink', [{ name: 'safe/SKILL.md', content: content('safe') }, { name: 'safe/link', content: '../etc', symlink: true }]],
    ['duplicate', [{ name: 'safe/SKILL.md', content: content('safe') }, { name: 'safe/SKILL.md', content: content('safe') }]],
  ] as const) {
    const badZip = await zip(path.join(temp, `${name}.zip`), [...entries]);
    await api('/skill-drafts/import?format=zip', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: badZip }, 400);
  }
  const missingZip = await zip(path.join(temp, 'missing.zip'), [{ name: 'missing/readme.md', content: 'none' }]);
  const missingDraft = await api<SkillDraftRecord>('/skill-drafts/import?format=zip', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: missingZip }, 201); draftIds.push(missingDraft.id);
  const missingCheck = await api<SkillDraftRecord>(`/skill-drafts/${missingDraft.id}/validate`, { method: 'POST', headers: { 'If-Match': String(missingDraft.version) } });
  assert.equal(missingCheck.validation?.valid, false);
  assert.equal(missingCheck.validation?.issues.some((issue) => issue.path === 'SKILL.md'), true);
  await api('/skill-drafts/import?format=zip', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: Buffer.alloc(20 * 1024 * 1024 + 1) }, 413);
  const conflict = await api<SkillDraftRecord>('/skill-drafts/import?format=markdown', { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: content(names[0]) }, 201); draftIds.push(conflict.id);
  const conflictCheck = await api<SkillDraftRecord>(`/skill-drafts/${conflict.id}/validate`, { method: 'POST', headers: { 'If-Match': String(conflict.version) } });
  assert.equal(conflictCheck.validation?.issues.some((issue) => issue.code === 'name_conflict'), true);
  const sdkFailureName = `skill-test-${Date.now().toString(36)}-failure`;
  const sdkFailure = await api<SkillDraftRecord>('/skill-drafts/import?format=markdown', { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: content(sdkFailureName) }, 201); draftIds.push(sdkFailure.id);
  await assert.rejects(publishDraft(sdkFailure.id, sdkFailure.version, async () => false), /校验未通过/);
  assert.equal((await stat(path.dirname(skillPath(sdkFailureName))).catch(() => null)), null);
  assert.equal(JSON.stringify((await loadAgents()).map((item) => [item.id, item.skills])), initialAgents);
  for (const [slug, bytes] of original) assert.deepEqual(await readFile(skillPath(slug)), bytes, `${slug} was modified`);
  console.log('Skill API, ZIP safety, SDK discovery, draft conflict and existing assignments: PASS');
} finally {
  for (const slug of created) await rm(path.dirname(skillPath(slug)), { recursive: true, force: true });
  for (const id of draftIds) await fetch(`${base}/api/skill-drafts/${id}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${base}/api/config-catalog`).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
