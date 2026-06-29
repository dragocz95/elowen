import type { ReactNode } from 'react';

/** Right-aligned action row anchored at the end of a page's form/content, divided from the content
 *  above by a top border. The in-page analogue of ModalFooter — use it for a single primary action
 *  (e.g. Save) at the bottom of a form, so the action has one consistent home across pages. */
export function FormFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
      {children}
    </div>
  );
}
