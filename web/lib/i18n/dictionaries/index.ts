import { en } from './en';
import { cs } from './cs';
import { sk } from './sk';

export const dictionaries = { en, cs, sk } as const;

export type Locale = keyof typeof dictionaries;