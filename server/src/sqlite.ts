import { createRequire } from 'node:module';

type Statement = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

const require = createRequire(import.meta.url);
export const DatabaseSync = require('node:sqlite').DatabaseSync as new (path: string) => SQLiteDatabase;
