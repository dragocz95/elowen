'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';

export type EffectsMode = 'auto' | 'full' | 'reduced' | 'off';
export type ResolvedEffectsMode = Exclude<EffectsMode, 'auto'>;

const EFFECTS_STORAGE_KEY = 'elowen:effects';
const DEFAULT_EFFECTS_MODE: EffectsMode = 'auto';

interface EffectsValue {
  mode: EffectsMode;
  resolvedMode: ResolvedEffectsMode;
  motionEnabled: boolean;
  ambientMotionEnabled: boolean;
  setMode: (mode: EffectsMode) => void;
}

const EffectsContext = createContext<EffectsValue | null>(null);
const loadMotionFeatures = () => import('./motionFeatures').then((module) => module.default);

function isEffectsMode(value: string | null): value is EffectsMode {
  return value === 'auto' || value === 'full' || value === 'reduced' || value === 'off';
}

function readStoredMode(): EffectsMode {
  try {
    const stored = localStorage.getItem(EFFECTS_STORAGE_KEY);
    return isEffectsMode(stored) ? stored : DEFAULT_EFFECTS_MODE;
  } catch {
    return DEFAULT_EFFECTS_MODE;
  }
}

function readsReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function readBootstrappedMode(): ResolvedEffectsMode {
  try {
    const value = document.documentElement.getAttribute('data-effects');
    return value === 'reduced' || value === 'off' ? value : 'full';
  } catch {
    return 'full';
  }
}

export function resolveEffectsMode(mode: EffectsMode, systemReduced: boolean): ResolvedEffectsMode {
  return mode === 'auto' ? (systemReduced ? 'reduced' : 'full') : mode;
}

function applyDocumentMode(mode: EffectsMode, resolvedMode: ResolvedEffectsMode) {
  document.documentElement.setAttribute('data-effects-mode', mode);
  document.documentElement.setAttribute('data-effects', resolvedMode);
}

/**
 * Per-device visual-effects preference and the single Motion feature boundary for the web app.
 * `auto` follows the OS reduced-motion preference; explicit modes always win. `off` also disables
 * CSS motion through the root data attribute configured here.
 */
export function EffectsProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<EffectsMode>(DEFAULT_EFFECTS_MODE);
  const [systemReduced, setSystemReduced] = useState(false);
  const [bootstrappedMode] = useState<ResolvedEffectsMode>(readBootstrappedMode);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setModeState(readStoredMode());
    setSystemReduced(readsReducedMotion());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setSystemReduced(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  const resolvedMode = hydrated ? resolveEffectsMode(mode, systemReduced) : bootstrappedMode;

  useEffect(() => {
    if (!hydrated) return;
    applyDocumentMode(mode, resolvedMode);
  }, [hydrated, mode, resolvedMode]);

  const setMode = useCallback((nextMode: EffectsMode) => {
    setModeState(nextMode);
    try { localStorage.setItem(EFFECTS_STORAGE_KEY, nextMode); } catch { /* unavailable storage is harmless */ }
    applyDocumentMode(nextMode, resolveEffectsMode(nextMode, readsReducedMotion()));
  }, []);

  const value = useMemo<EffectsValue>(() => ({
    mode,
    resolvedMode,
    motionEnabled: resolvedMode !== 'off',
    ambientMotionEnabled: resolvedMode === 'full',
    setMode,
  }), [mode, resolvedMode, setMode]);

  return (
    <EffectsContext.Provider value={value}>
      <LazyMotion features={loadMotionFeatures} strict>
        <MotionConfig reducedMotion={resolvedMode === 'full' ? 'never' : 'always'}>
          {children}
        </MotionConfig>
      </LazyMotion>
    </EffectsContext.Provider>
  );
}

export function useEffects(): EffectsValue {
  const context = useContext(EffectsContext);
  if (!context) throw new Error('useEffects must be used within EffectsProvider');
  return context;
}
