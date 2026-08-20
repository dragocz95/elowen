import { describe, it, expect } from 'vitest';
import { Singleflight } from '../../src/shared/singleflight.js';

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('Singleflight', () => {
  it('coalesces concurrent calls for the same key onto one run', async () => {
    const flight = new Singleflight<string>();
    const gate = deferred<string>();
    let runs = 0;

    const a = flight.run('k', () => { runs += 1; return gate.promise; });
    const b = flight.run('k', () => { runs += 1; return gate.promise; });

    expect(runs).toBe(1);
    gate.resolve('value');
    expect(await a).toBe('value');
    expect(await b).toBe('value');
  });

  it('runs different keys concurrently', async () => {
    const flight = new Singleflight<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const keys: string[] = [];

    const a = flight.run('a', () => { keys.push('a'); return first.promise; });
    const b = flight.run('b', () => { keys.push('b'); return second.promise; });

    expect(keys).toEqual(['a', 'b']);
    second.resolve('B');
    first.resolve('A');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('starts fresh work once the previous run settled', async () => {
    const flight = new Singleflight<number>();
    let runs = 0;
    expect(await flight.run('k', () => { runs += 1; return Promise.resolve(1); })).toBe(1);
    expect(await flight.run('k', () => { runs += 1; return Promise.resolve(2); })).toBe(2);
    expect(runs).toBe(2);
  });

  it('shares a rejection with every joined caller and does not wedge the key', async () => {
    const flight = new Singleflight<number>();
    const gate = deferred<number>();

    const a = flight.run('k', () => gate.promise);
    const b = flight.run('k', () => gate.promise);
    gate.reject(new Error('boom'));

    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    // The failed entry was evicted: the next caller gets a real run, not the cached failure.
    expect(await flight.run('k', () => Promise.resolve(7))).toBe(7);
  });

  it('a late settle never evicts a newer run for the same key', async () => {
    const flight = new Singleflight<string>();
    const first = deferred<string>();

    const a = flight.run('k', () => first.promise);
    first.resolve('first');
    expect(await a).toBe('first');

    // Second run registered; its entry must survive whatever the first run's teardown does.
    const second = deferred<string>();
    const b = flight.run('k', () => second.promise);
    let joins = 0;
    const c = flight.run('k', () => { joins += 1; return Promise.resolve('unexpected'); });
    expect(joins).toBe(0);

    second.resolve('second');
    expect(await b).toBe('second');
    expect(await c).toBe('second');
  });
});
