import { registerEditorUi } from './runtime';
import { EditorPage } from './EditorPage';

registerEditorUi({
  requiresApiVersion: 1,
  pages: { '': EditorPage },
});
