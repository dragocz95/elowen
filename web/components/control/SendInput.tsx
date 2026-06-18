'use client';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useTranslation } from '../../lib/i18n';
export function SendInput({ onSend }: { onSend: (keys: string[]) => void }) {
  const [text, setText] = useState('');
  const { t } = useTranslation();
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend([text.trim(), 'Enter']); setText(''); } }}>
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.common.sendKeys} className="w-40" />
      <Button type="submit">{t.common.send}</Button>
    </form>
  );
}
