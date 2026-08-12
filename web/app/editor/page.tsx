'use client';
import { PluginRedirect } from '../../components/shell/PluginRedirect';

/** Historical editor URL. Keep browser navigation inside the authenticated app shell. */
export default function EditorPage() {
  return <PluginRedirect to="/p/editor" />;
}
