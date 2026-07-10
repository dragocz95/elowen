import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider } from '../lib/i18n';
import { ThemeProvider } from '../lib/useTheme';
import { EffectsProvider } from '../lib/useEffects';
import { domMax } from 'motion/react';

export function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <EffectsProvider features={domMax}>
          <ThemeProvider>
            <LanguageProvider>{children}</LanguageProvider>
          </ThemeProvider>
        </EffectsProvider>
      </QueryClientProvider>
    ),
  };
}
