'use client';
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';

// Serve Monaco from our own static assets (public/monaco/vs) instead of the default jsdelivr CDN,
// so a self-hosted/offline daemon never phones home. Assets are copied by scripts/copy-monaco.mjs.
loader.config({ paths: { vs: '/monaco/vs' } });

// Monaco is browser-only (web workers); never SSR it.
export const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), { ssr: false });
export const MonacoDiffEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.DiffEditor), { ssr: false });
