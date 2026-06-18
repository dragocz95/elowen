export class OrcaClient {
  constructor(private base: string, private token?: string) {}
  private async req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`orca API ${res.status} on ${path}`);
    return res.json();
  }
  tasks() { return this.req('/tasks'); }
  createTask(input: unknown) { return this.req('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  ready() { return this.req('/tasks/ready'); }
  sessions() { return this.req('/sessions'); }
  engage(input: unknown) { return this.req('/missions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  close(taskId: string, opts?: { summary?: string; outcome?: string }) {
    return this.req(`/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', result_summary: opts?.summary, outcome: opts?.outcome }) });
  }
}
