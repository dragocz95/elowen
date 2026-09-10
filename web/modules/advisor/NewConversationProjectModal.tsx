'use client';
import { useRef, useState } from 'react';
import { FolderGit2, Server } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe, useProjects } from '../../lib/queries';
import { useMobileViewport } from '../../lib/useMobile';
import { apiErrorMessage, elowenClient } from '../../lib/elowenClient';
import { useToast } from '../../components/ui/Toast';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { ErrorState } from '../../components/ui/states';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { OperationProgressDialog } from '../../components/ui/OperationProgressDialog';
import { useEnvironmentOperationWindow } from '../../lib/useEnvironmentOperation';
import { recreatable, requestEnvironmentAction } from '../../lib/environmentActions';
import { executionRefKey, executionRefOf, type Project, type ProjectExecutionRef } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';

/** One offered destination: a project this account may reach, or — for an administrator — the host
 *  itself with no project behind it. `key` is what the roving selection addresses; a nameless host ref
 *  has no project, so it carries its own constant. */
interface Destination {
  key: string;
  ref: ProjectExecutionRef;
  project?: Project;
}

const HOST_KEY = 'host:';

/** The projects offered to a fresh conversation, in the order they are listed, with the administrator's
 *  nameless host last. `GET /projects` is already authorization-filtered, so nothing here decides who may
 *  reach what; a project on its way out is simply not a place to start working. */
function newConversationDestinations(projects: readonly Project[], isAdmin: boolean): Destination[] {
  const items: Destination[] = projects
    .filter((p) => p.lifecycle !== 'deleting')
    .map((p) => ({ key: executionRefKey(executionRefOf(p)), ref: executionRefOf(p), project: p }));
  // An administrator with no project chosen keeps the whole host, which is what their conversations did
  // before project environments existed. Everyone else always lands in a project.
  if (isAdmin) items.push({ key: HOST_KEY, ref: { kind: 'host' } });
  return items;
}

/** Asks a brand-new conversation where it should run, once, before the first message is written.
 *
 *  The conversation already EXISTS by the time this is on screen: the daemon has picked its default
 *  target (an administrator's host, or the project this account is assigned to), so this modal is a
 *  chance to move it, never a gate in front of chatting. Dismissing it keeps that default. */
export function NewConversationProjectModal() {
  const { projectChoiceOpen, closeProjectChoice } = useBrainChat();
  if (!projectChoiceOpen) return null;
  return <NewConversationProjectDialog onClose={closeProjectChoice} />;
}

function NewConversationProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const s = t.projects;
  const { toast } = useToast();
  const { telemetry, activeSessionId } = useBrainChat();
  const projects = useProjects();
  const me = useMe();
  const phone = useMobileViewport() === true;
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isAdmin = me.data?.user?.is_admin ?? false;
  const destinations = newConversationDestinations(projects.data ?? [], isAdmin);
  // What the daemon says this conversation already runs in. It is the preselection, so confirming the
  // dialog without reading it changes nothing.
  const reported = telemetry.projectRef;
  const reportedKey = (reported && destinations.find((d) => d.key === executionRefKey(reported))?.key) ?? null;
  const chosen = focused && destinations.some((d) => d.key === focused) ? focused : reportedKey;
  // Where the hand rests before anything is chosen. A status that has not landed yet leaves the dialog
  // with no target to preselect, and the first card is then simply the one arrows and Tab start from —
  // checking it would claim a conversation runs somewhere it does not.
  const hand = chosen ?? destinations[0]?.key ?? null;
  // The environment the chosen project may still have to start. The daemon answers the switch with it
  // precisely when the environment is cold, which is the wait nobody else on this screen reports.
  const environment = useEnvironmentOperationWindow();

  const choose = async (destination: Destination) => {
    const session = activeSessionId;
    if (!session || pending) return;
    setPending(true);
    try {
      // The same authorized endpoint the chat's project picker uses; the daemon owns whether this
      // account may enter the target.
      const response = await elowenClient.brainSetExecution(destination.ref, session);
      if (response.operationId && destination.ref.projectId !== undefined) {
        environment.follow(response.operationId, destination.ref.projectId);
        return;
      }
      onClose();
    } catch (error) {
      toast(apiErrorMessage(error) || t.brainChat.projectPickerFailed, 'error');
      setPending(false);
    }
  };

  const dispatch = (action: 'start' | 'recreate') => {
    const projectId = environment.pending?.projectId;
    if (projectId === undefined) return;
    void requestEnvironmentAction(projectId, { kind: action })
      .then((operation) => environment.follow(operation.id, projectId))
      .catch((error) => toast(apiErrorMessage(error) || t.brainChat.projectPickerFailed, 'error'));
  };

  // The conversation is already switched by the time this shows: what is left is the environment coming
  // up, so the choice gives way to the window that reports it. Dismissing either one lands in the
  // composer, and the start carries on without the tab.
  if (environment.pending) {
    return (
      <OperationProgressDialog
        open
        title={t.operationProgress.actions[(environment.operation?.action.kind ?? 'start') as keyof typeof t.operationProgress.actions] ?? t.operationProgress.actions.start}
        operation={environment.operation}
        logTail={environment.logTail}
        loadError={environment.loadError}
        onRetry={() => dispatch('start')}
        onRecreate={() => dispatch('recreate')}
        recreatable={recreatable(environment.operation?.error)}
        onSettled={onClose}
        onClose={onClose}
      />
    );
  }

  /** Arrows walk the cards and carry focus with them; Enter and Space are the button's own. Both axes
   *  move by one because the cards wrap: a row holds a different number of them at every width. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key) || destinations.length === 0) return;
    event.preventDefault();
    const at = Math.max(0, destinations.findIndex((d) => d.key === hand));
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? destinations.length - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? (at + 1) % destinations.length
          : (at - 1 + destinations.length) % destinations.length;
    const key = destinations[next].key;
    setFocused(key);
    listRef.current?.querySelector<HTMLElement>(`[data-destination="${CSS.escape(key)}"]`)?.focus();
  };

  return (
    <Modal
      title={t.brainChat.newConversationProject.title}
      description={t.brainChat.newConversationProject.description}
      icon={FolderGit2}
      size="md"
      presentation={phone ? 'fullscreen' : 'center'}
      onClose={onClose}
      closeDisabled={pending}
    >
      <ModalBody>
        {projects.isError ? (
          <ErrorState message={t.projects.loadError} onRetry={() => { void projects.refetch(); }} />
        ) : destinations.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t.brainChat.newConversationProject.empty}</p>
        ) : (
          <div
            ref={listRef}
            role="radiogroup"
            aria-label={t.brainChat.newConversationProject.title}
            onKeyDown={onKeyDown}
            data-testid="new-conversation-projects"
            // A phone reads the destinations as a list down the screen; anywhere with room they sit side
            // by side and wrap onto as many rows as the width allows.
            className="flex flex-col flex-wrap gap-2 sm:flex-row"
          >
            {destinations.map((destination) => {
              const selected = destination.key === chosen;
              const project = destination.project;
              const name = project ? project.slug : t.brainChat.newConversationProject.hostOption;
              const hint = project
                ? (project.executionKind === 'managed' ? s.managed : s.host)
                : t.brainChat.newConversationProject.hostHint;
              return (
                <button
                  key={destination.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-destination={destination.key}
                  data-selected={selected || undefined}
                  {...(destination.key === hand ? { 'data-autofocus': '' } : {})}
                  tabIndex={destination.key === hand ? 0 : -1}
                  disabled={pending || !activeSessionId}
                  onFocus={() => setFocused(destination.key)}
                  onClick={() => { void choose(destination); }}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-full border px-4 py-3 text-left transition-colors disabled:opacity-40 sm:min-w-[13rem] sm:max-w-full ${selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70`}
                >
                  {project
                    ? <ProjectIcon project={project} size={20} />
                    : <Server size={20} aria-hidden className="shrink-0 text-muted-foreground" />}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">{name}</span>
                    <span className="truncate text-tiny text-muted-foreground">{hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
