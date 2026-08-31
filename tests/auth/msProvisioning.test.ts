import { describe, expect, it, vi } from 'vitest';
import { MicrosoftAccountProvisioner } from '../../src/auth/msProvisioning.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openDb } from '../../src/store/db.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';
import { UserStore } from '../../src/store/userStore.js';

function setup(over: { yolo?: boolean } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/home'),(2,'shared','/shared')").run();
  const config = new ConfigStore(db);
  config.update({ plugins: { enabled: ['msteams'], config: { msteams: {
    ssoDefaultProjects: ['2', '999'],
    ssoDefaultModels: ['azure/luna', 'azure/missing'],
    ssoDefaultModel: 'azure/luna',
    ssoDefaultPlugins: ['raynet', 'missing-plugin'],
    ssoAllowedTools: ['RaynetSearch', 'MissingTool'],
    ssoDefaultYolo: over.yolo === true,
  } } } });
  const users = new UserStore(db);
  const admin = users.create('admin', 'secret-password');
  users.setAdmin(admin.id, true);
  const userSettings = new UserSettingStore(db);
  const userProjects = new UserProjectStore(db);
  const catalogs = {
    models: vi.fn(async () => ['azure/luna']),
    plugins: vi.fn(async () => ['raynet']),
    tools: vi.fn(async () => ['RaynetSearch']),
  };
  const warnings: string[] = [];
  const provisioner = new MicrosoftAccountProvisioner({
    config, users, userSettings, projects: new ProjectStore(db), userProjects, project: { id: 1 }, catalogs,
    log: { warn: (message) => warnings.push(message) },
  });
  return { provisioner, users, userSettings, userProjects, catalogs, warnings };
}

const identity = (subjectId = 'entra-1') => ({
  provider: 'msteams', tenantId: 'tenant-1', subjectId,
  preferredUsername: 'new.person', name: 'New Person', email: 'new.person@example.test',
});

describe('MicrosoftAccountProvisioner', () => {
  it('applies one validated Microsoft onboarding template to a newly created account', async () => {
    const { provisioner, users, userSettings, userProjects, warnings } = setup({ yolo: true });

    const result = await provisioner.linkOrProvision(identity());
    const user = users.get(result.user.id)!;

    expect(result.created).toBe(true);
    expect(userProjects.forUser(user.id)).toEqual([2]);
    expect(user.allowed_execs).toEqual(['azure/luna']);
    expect(user.default_exec).toBe('azure/luna');
    expect(user.granted_plugins).toEqual(['raynet']);
    expect(user.allowed_tools).toEqual(['RaynetSearch']);
    expect(userSettings.permissionSettings(user.id).yolo).toBe(true);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('unknown default project #999'),
      expect.stringContaining('unknown default model azure/missing'),
      expect.stringContaining('unknown default plugin missing-plugin'),
      expect.stringContaining('unknown default tool MissingTool'),
    ]));
  });

  it('takes the existing-identity fast path without loading catalogs or overwriting admin changes', async () => {
    const { provisioner, users, userSettings, userProjects, catalogs } = setup({ yolo: true });
    const first = await provisioner.linkOrProvision(identity());
    users.setAllowedExecs(first.user.id, ['custom/model']);
    users.setGrantedPlugins(first.user.id, ['skills']);
    users.setAllowedTools(first.user.id, ['Read']);
    users.setProfile(first.user.id, { default_exec: 'custom/model' });
    userSettings.setPermissionSettings(first.user.id, { yolo: false });
    userProjects.unassign(first.user.id, 2);
    for (const load of Object.values(catalogs)) load.mockClear();

    const second = await provisioner.linkOrProvision(identity());
    const user = users.get(first.user.id)!;

    expect(second).toMatchObject({ created: false, user: { id: first.user.id } });
    expect(user.allowed_execs).toEqual(['custom/model']);
    expect(user.default_exec).toBe('custom/model');
    expect(user.granted_plugins).toEqual(['skills']);
    expect(user.allowed_tools).toEqual(['Read']);
    expect(userSettings.permissionSettings(user.id).yolo).toBe(false);
    expect(userProjects.forUser(user.id)).toEqual([]);
    for (const load of Object.values(catalogs)) expect(load).not.toHaveBeenCalled();
  });

  it('applies defaults only for the winner when two first-login requests race', async () => {
    const { provisioner, users } = setup();
    const [a, b] = await Promise.all([provisioner.linkOrProvision(identity('race')), provisioner.linkOrProvision(identity('race'))]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.user.id).toBe(b.user.id);
    expect(users.list().filter((user) => user.username === 'new.person')).toHaveLength(1);
  });
});
