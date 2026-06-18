import type { en } from './dictionaries/en';

type Widen<T> = T extends string ? string : T extends object ? { [K in keyof T]: Widen<T[K]> } : T;

export type LocaleDict = Widen<typeof en>;