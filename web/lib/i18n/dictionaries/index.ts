import { en } from './en';
import { cs } from './cs';

export const dictionaries = { en, cs } as const;

export type Locale = keyof typeof dictionaries;