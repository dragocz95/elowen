'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { EditorView } from '../../modules/editor/EditorView';

export default function EditorPage() {
  return (
    <ModuleShell moduleId="editor">
      <EditorView />
    </ModuleShell>
  );
}
