export interface SandboxWorkspaceRef {
  workspaceId: string;
  projectId: number;
}

export interface SandboxWorkspaceBinding extends SandboxWorkspaceRef {
  accountUserId: number;
  path: string;
}
