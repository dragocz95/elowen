import type { ConfigStore } from '../store/configStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { ExternalIdentityInput, ExternalIdentityResult, UserStore } from '../store/userStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { UserSettingStore } from '../store/userSettingStore.js';
import { logger } from '../shared/logger.js';

const PROVIDER = 'msteams';

export interface MicrosoftProvisioningCatalogs {
  models(): Promise<readonly string[]>;
  plugins(): Promise<readonly string[]>;
  tools(): Promise<readonly string[]>;
}

export interface MicrosoftProvisioningDependencies {
  config: ConfigStore;
  users: UserStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  userSettings?: UserSettingStore;
  project?: { id: number };
  catalogs?: MicrosoftProvisioningCatalogs;
  log?: { warn(message: string): void };
}

interface MicrosoftProvisioningConfig {
  defaultProjects: number[];
  defaultModels: string[];
  defaultModel: string;
  defaultPlugins: string[];
  allowedTools: string[];
  defaultYolo: boolean;
}

interface ResolvedProvisioningDefaults {
  projectIds: number[];
  allowedModels: string[];
  defaultModel: string;
  plugins: string[];
  allowedTools: string[];
  defaultYolo: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const stringList = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map(text).filter(Boolean))]
  : [];
const projectIds = (value: unknown): number[] => {
  const values = Array.isArray(value) ? value : text(value).split(',');
  return [...new Set(values
    .map((entry) => Number(text(entry)))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0))];
};

/** The ONE owner of Microsoft account defaults, shared by browser SSO and delegated Teams onboarding.
 *
 *  Catalog resolution happens before account creation, then creation plus every default write stays
 *  synchronous — no caller can observe a freshly created account between those writes. An identity that
 *  already exists takes the fast path and is never re-provisioned: admin edits remain authoritative. */
export class MicrosoftAccountProvisioner {
  private readonly log: { warn(message: string): void };

  constructor(private readonly d: MicrosoftProvisioningDependencies) {
    this.log = d.log ?? logger('auth');
  }

  async linkOrProvision(input: ExternalIdentityInput): Promise<ExternalIdentityResult> {
    const existing = this.d.users.externalIdentity(input.provider, input.tenantId, input.subjectId);
    if (existing) return { user: existing, created: false };

    const defaults = await this.resolveDefaults(this.config());
    const result = this.d.users.linkExternalIdentity(input);
    if (result.created) this.apply(result.user.id, defaults);
    return result;
  }

  private config(): MicrosoftProvisioningConfig {
    const raw = this.d.config.pluginConfig(PROVIDER);
    return {
      defaultProjects: projectIds(raw.ssoDefaultProjects),
      defaultModels: stringList(raw.ssoDefaultModels),
      defaultModel: text(raw.ssoDefaultModel),
      defaultPlugins: stringList(raw.ssoDefaultPlugins),
      allowedTools: stringList(raw.ssoAllowedTools),
      defaultYolo: raw.ssoDefaultYolo === true,
    };
  }

  private async resolveDefaults(cfg: MicrosoftProvisioningConfig): Promise<ResolvedProvisioningDefaults> {
    const projectIds = cfg.defaultProjects.filter((projectId) => {
      const known = projectId === this.d.project?.id || Boolean(this.d.projects?.get(projectId));
      if (!known) this.log.warn(`Microsoft provisioning ignored unknown default project #${projectId}`);
      return known;
    });

    let allowedModels: string[] = [];
    let defaultModel = '';
    const requestedModels = [...new Set([...cfg.defaultModels, cfg.defaultModel].filter(Boolean))];
    if (requestedModels.length > 0) {
      const knownModels = await this.knownDefaults('model', requestedModels, this.d.catalogs?.models);
      allowedModels = cfg.defaultModels.filter((value) => knownModels.has(value));
      if (cfg.defaultModel && knownModels.has(cfg.defaultModel)) {
        if (cfg.defaultModels.length === 0 || allowedModels.includes(cfg.defaultModel)) defaultModel = cfg.defaultModel;
        else this.log.warn(`Microsoft provisioning ignored default model ${cfg.defaultModel}: it is not in the configured model allow-list`);
      }
    }

    let plugins: string[] = [];
    if (cfg.defaultPlugins.length > 0) {
      const knownPlugins = await this.knownDefaults('plugin', cfg.defaultPlugins, this.d.catalogs?.plugins);
      plugins = cfg.defaultPlugins.filter((value) => knownPlugins.has(value));
    }

    let allowedTools: string[] = [];
    if (cfg.allowedTools.length > 0) {
      const knownTools = await this.knownDefaults('tool', cfg.allowedTools, this.d.catalogs?.tools);
      allowedTools = cfg.allowedTools.filter((value) => knownTools.has(value));
    }
    return { projectIds, allowedModels, defaultModel, plugins, allowedTools, defaultYolo: cfg.defaultYolo };
  }

  private apply(userId: number, defaults: ResolvedProvisioningDefaults): void {
    for (const projectId of defaults.projectIds) this.d.userProjects?.assign(userId, projectId);
    if (defaults.allowedModels.length > 0) this.d.users.setAllowedExecs(userId, defaults.allowedModels);
    if (defaults.defaultModel) this.d.users.setProfile(userId, { default_exec: defaults.defaultModel });
    if (defaults.plugins.length > 0) this.d.users.setGrantedPlugins(userId, defaults.plugins);
    if (defaults.allowedTools.length > 0) this.d.users.setAllowedTools(userId, defaults.allowedTools);
    this.d.userSettings?.setPermissionSettings(userId, { yolo: defaults.defaultYolo });
  }

  private async knownDefaults(
    kind: 'model' | 'plugin' | 'tool',
    requested: string[],
    load: (() => Promise<readonly string[]>) | undefined,
  ): Promise<Set<string>> {
    if (!load) {
      this.log.warn(`Microsoft provisioning ignored configured default ${kind}s: the live catalog is unavailable`);
      return new Set();
    }
    let known: Set<string>;
    try {
      known = new Set(await load());
    } catch (error) {
      this.log.warn(`Microsoft provisioning ignored configured default ${kind}s: catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return new Set();
    }
    for (const value of requested) {
      if (!known.has(value)) this.log.warn(`Microsoft provisioning ignored unknown default ${kind} ${value}`);
    }
    return known;
  }
}
