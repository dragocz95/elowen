export class OrcaClient {
  constructor(private base: string) {}
  private async req(path: string, init?: RequestInit) {
    const res = await fetch(`${this.base}${path}`, init);
    if (!res.ok) throw new Error(`orca API ${res.status} on ${path}`);
    return res.json();
  }
  tasks() { return this.req('/tasks'); }
  createTask(input: unknown) { return this.req('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  ready() { return this.req('/tasks/ready'); }
  sessions() { return this.req('/sessions'); }
  engage(input: unknown) { return this.req('/missions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
}
