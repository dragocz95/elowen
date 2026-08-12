'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Historical editor URL. Keep browser navigation inside the authenticated app shell. */
export default function EditorPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/p/editor'); }, [router]);
  return null;
}
