import type Database from 'better-sqlite3';

/** An INTERFACE (not a type alias) on purpose: better-sqlite3's types are an `export =` namespace, so
 * an alias resolves to `BetterSqlite3.Database` — a name declaration emit cannot import, which breaks
 * the composite build the agents plugin references. An interface is a real named type of ours. */
export interface Db extends Database.Database {}
