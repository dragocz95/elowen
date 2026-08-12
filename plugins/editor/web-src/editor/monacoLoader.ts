import MonacoEditor, { DiffEditor as MonacoDiffEditor, loader } from '@monaco-editor/react';

// Keep Monaco self-hosted for offline daemon installations; the plugin bundle is client-only.
loader.config({ paths: { vs: '/monaco/vs' } });

export { MonacoEditor, MonacoDiffEditor };
