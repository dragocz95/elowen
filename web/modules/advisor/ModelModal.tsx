'use client';

import { useState } from 'react';
import { Cpu } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Input } from '../../components/ui/Input';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { ModelOptionList } from './ModelOptionList';

/** The web dock's `/model` overlay. It replaces the composer dropdown the slash used to hijack, which
 *  listed models as flat `provider/model` text among the command suggestions — a picker pretending to be a
 *  command menu. Same catalog and same rows as the header popover (ModelOptionList), just given the room to
 *  show the provider grouping and brand icons. Picking switches the conversation in place and closes. */
export function ModelModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');

  // `inspect`: pick one row and it closes — a browsing surface, not something you work in, so a phone
  // gets a bottom sheet.
  return (
    <Modal title={t.brainChat.modelPicker} onClose={onClose} size="md" icon={Cpu} intent="inspect">
      <ModalBody gap={4}>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t.modelModal.filterPlaceholder}
          aria-label={t.modelModal.filterPlaceholder}
        />
        <div role="listbox" aria-label={t.brainChat.modelPicker} className="max-h-[26rem] overflow-y-auto rounded-md border border-border py-1">
          <ModelOptionList filter={filter} onPick={onClose} />
        </div>
      </ModalBody>
    </Modal>
  );
}
