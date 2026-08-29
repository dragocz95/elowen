import type { Tone } from '../../components/ui/tone';

/** Risk level → Badge tone (high danger, medium warning, low muted). */
export const RISK_TONE: Record<'low' | 'medium' | 'high', Tone> = { low: 'muted', medium: 'warning', high: 'danger' };

// A read-only pill for a contribution / hook name.
export const namePill = 'rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground';

// Connection-ish plain keys that belong with the secrets section (endpoints/ids), not with behavior.
export const CONNECTION_KEYS = new Set(['guildId', 'threadIds', 'notifyChannelId', 'channelId', 'apiUrl', 'baseUrl', 'url', 'endpoint', 'host', 'port', 'appId', 'clientId', 'webhookUrl']);
