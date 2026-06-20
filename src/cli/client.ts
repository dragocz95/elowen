export class OrcaClient {
  constructor(private base: string, private token?: string) {}
  private async req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`orca API ${res.status} on ${path}`);
    // A proxy or wrong endpoint can return 200 with a non-JSON body; surface a clear error rather
    // than crashing the CLI (and the spawned agent that drives it) on an opaque SyntaxError.
    try { return await res.json(); }
    catch { throw new Error(`orca API non-JSON response on ${path}`); }
  }
  tasks() { return this.req('/tasks'); }
  createTask(input: unknown) { return this.req('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  ready() { return this.req('/tasks/ready'); }
  sessions() { return this.req('/sessions'); }
  engage(input: unknown) { return this.req('/missions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  close(taskId: string, opts?: { summary?: string; outcome?: string }) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', result_summary: opts?.summary, outcome: opts?.outcome }) });
  }
  planSubmit(jobId: string, phases: unknown) {
    return this.req(`/plan/${encodeURIComponent(jobId)}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases }) });
  }
  overseerPoll(missionId: string) {
    return this.req(`/missions/${encodeURIComponent(missionId)}/overseer/next`);
  }
  overseerDecide(missionId: string, body: { id: string; approve: boolean; confidence: number; rationale: string }) {
    return this.req(`/missions/${encodeURIComponent(missionId)}/overseer/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
}
