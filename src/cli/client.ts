export class ElowenClient {
  constructor(private base: string, private token?: string) {}
  private async req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) {
      // Surface the server's own error message (routes answer {"error": …}) — a spawned agent reads
      // this text, and "503 on /notes" says far less than "agents plugin is disabled".
      const detail = await res.json().then((b) => (b as { error?: string })?.error, () => undefined);
      // The mission/session surface is served by the agents plugin's root mounts: without the plugin
      // the mounts do not exist at all, so a 404 here almost always means "subsystem off", not a typo'd
      // id (an unknown id on a live mount answers 404 WITH an error body — kept via `detail` above).
      if (res.status === 404 && !detail && /^\/(sessions|missions)(\/|$|\?)/.test(path)) {
        throw new Error(`elowen API 404 on ${path} — agents subsystem is unavailable (the agents plugin is disabled on this daemon)`);
      }
      throw new Error(`elowen API ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`);
    }
    // A proxy or wrong endpoint can return 200 with a non-JSON body; surface a clear error rather
    // than crashing the CLI (and the spawned agent that drives it) on an opaque SyntaxError.
    try { return await res.json(); }
    catch { throw new Error(`elowen API non-JSON response on ${path}`); }
  }
  tasks() { return this.req('/tasks'); }
  createTask(input: unknown) { return this.req('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  ready() { return this.req('/tasks/ready'); }
  sessions() { return this.req('/sessions'); }
  close(taskId: string, opts?: { summary?: string; outcome?: string }) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', result_summary: opts?.summary, outcome: opts?.outcome }) });
  }
  noteAdd(target: string, body: string) {
    return this.req('/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'mission', target, body }) });
  }
  sendInput(name: string, data: string) {
    return this.req(`/sessions/${encodeURIComponent(name)}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
  }
  notes(target: string) {
    return this.req(`/notes?scope=mission&target=${encodeURIComponent(target)}`);
  }
  planSubmit(jobId: string, phases: unknown) {
    return this.req(`/plan/${encodeURIComponent(jobId)}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases }) });
  }
  overseerPoll(missionId: string) {
    return this.req(`/missions/${encodeURIComponent(missionId)}/overseer/next`);
  }
  overseerDecide(missionId: string, body: { id: string; approve: boolean; confidence: number; rationale: string; choice?: string; message?: string; restart?: boolean }) {
    return this.req(`/missions/${encodeURIComponent(missionId)}/overseer/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  askStart(taskId: string, text: string) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  }
  askPoll(taskId: string, askId: string) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}/ask/${encodeURIComponent(askId)}`);
  }
  askHistory(taskId: string) {
    return this.req(`/activity?type=message&target=${encodeURIComponent(taskId)}`);
  }
  guide(taskId: string) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}/guide`);
  }
}
