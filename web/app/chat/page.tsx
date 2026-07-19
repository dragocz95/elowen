'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { ChatView } from '../../modules/chat/ChatView';

export default function ChatPage() {
  return (
    <ModuleShell moduleId="chat">
      <ChatView />
    </ModuleShell>
  );
}
