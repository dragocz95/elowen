'use client';
import { useState } from 'react';
import { useUsers } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useLogout } from '../../lib/mutations';
import { clearToken } from '../../lib/token';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Section } from '../../components/ui/Section';

export function UsersPanel() {
  const users = useUsers();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const logout = useLogout();
  const { toast } = useToast();

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  function handleDelete(id: number) {
    deleteUser.mutate(id, {
      onSuccess: () => toast('User deleted'),
      onError: (err) => toast(String(err), 'error'),
    });
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createUser.mutate(
      { username: newUsername, password: newPassword },
      {
        onSuccess: () => {
          toast('User created');
          setNewUsername('');
          setNewPassword('');
        },
        onError: (err) => toast(String(err), 'error'),
      },
    );
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => {
        clearToken();
        window.location.reload();
      },
      onError: () => {
        // Clear token and reload even if the server call fails.
        clearToken();
        window.location.reload();
      },
    });
  }

  if (users.isLoading) return <LoadingState />;
  if (users.isError) return <ErrorState message="Failed to load users" onRetry={() => users.refetch()} />;

  const data = users.data ?? [];

  return (
    <div className="flex flex-col gap-4 p-3">
      <Section title="Users">
        {data.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Username</TH>
                <TH>Created</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <tbody>
              {data.map((user) => (
                <TR key={user.id}>
                  <TD>{user.username}</TD>
                  <TD mono>{user.created_at}</TD>
                  <TD>
                    <Button
                      variant="danger"
                      disabled={data.length <= 1 || deleteUser.isPending}
                      onClick={() => handleDelete(user.id)}
                    >
                      Delete
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Add user">
        <form onSubmit={handleCreate} className="flex flex-col gap-2 max-w-sm p-3">
          <input
            type="text"
            placeholder="Username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            className="bg-bg border border-border rounded-none px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <input
            type="password"
            placeholder="Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="bg-bg border border-border rounded-none px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <div>
            <Button type="submit" variant="accent" disabled={createUser.isPending || !newUsername || !newPassword}>
              Add
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Session">
        <div className="p-3">
          <Button variant="danger" onClick={handleLogout} disabled={logout.isPending}>
            Logout
          </Button>
        </div>
      </Section>
    </div>
  );
}
