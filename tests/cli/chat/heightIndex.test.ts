import { describe, expect, it } from 'vitest';
import { DynamicHeightIndex } from '../../../src/cli/chat/heightIndex.js';

const prefix = (values: number[], end: number): number =>
  values.slice(0, end).reduce((sum, value) => sum + value, 0);

const lowerBoundOffset = (values: number[], offset: number): number => {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (sum > offset) return index;
  }
  return values.length;
};

describe('DynamicHeightIndex', () => {
  it('supports zero-height growth, point replacement, sums and offset lookup across capacity changes', () => {
    const index = new DynamicHeightIndex();
    index.resize(3);
    expect(index.length).toBe(3);
    expect(index.prefixSum(3)).toBe(0);
    expect(index.lowerBoundOffset(0)).toBe(3);

    index.replace(1, 4);
    index.append(2);
    index.append(0);
    index.append(7);
    index.resize(17);
    index.replace(16, 3);

    expect(index.prefixSum(4)).toBe(6);
    expect(index.rangeSum(2, 17)).toBe(12);
    expect(index.lowerBoundOffset(-1)).toBe(0);
    expect(index.lowerBoundOffset(0)).toBe(1);
    expect(index.lowerBoundOffset(3)).toBe(1);
    expect(index.lowerBoundOffset(4)).toBe(3);
    expect(index.lowerBoundOffset(5)).toBe(3);
    expect(index.lowerBoundOffset(6)).toBe(5);
    expect(index.lowerBoundOffset(15)).toBe(16);
    expect(index.lowerBoundOffset(16)).toBe(17);

    index.resize(5);
    expect(index.length).toBe(5);
    expect(index.prefixSum(5)).toBe(6);
    expect(index.lowerBoundOffset(6)).toBe(5);
    index.append(9);
    expect(index.prefixSum(6)).toBe(15);
    expect(index.lowerBoundOffset(6)).toBe(5);
  });

  it('matches a deterministic randomized array oracle', () => {
    const index = new DynamicHeightIndex();
    const values: number[] = [];
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };

    for (let operation = 0; operation < 5_000; operation += 1) {
      const choice = random() % 5;
      if (choice <= 1 || values.length === 0) {
        const value = random() % 9;
        values.push(value);
        index.append(value);
      } else if (choice === 2) {
        const at = random() % values.length;
        const value = random() % 9;
        values[at] = value;
        index.replace(at, value);
      } else if (choice === 3) {
        const end = random() % (values.length + 1);
        const start = random() % (end + 1);
        expect(index.prefixSum(end)).toBe(prefix(values, end));
        expect(index.rangeSum(start, end)).toBe(prefix(values, end) - prefix(values, start));
      } else {
        const total = prefix(values, values.length);
        const offset = (random() % (total + 3)) - 1;
        expect(index.lowerBoundOffset(offset)).toBe(lowerBoundOffset(values, offset));
      }
    }

    expect(index.length).toBe(values.length);
    expect(index.prefixSum(index.length)).toBe(prefix(values, values.length));
  });

  it('keeps 1,200 old point updates and offset lookups logarithmic by counted tree steps', () => {
    const turns = 16_384;
    const operations = 1_200;
    const index = new DynamicHeightIndex();
    index.resize(turns, 3);
    index.resetOperationCount();

    for (let operation = 0; operation < operations; operation += 1) {
      index.replace(operation, operation % 2 === 0 ? 5 : 2);
      index.lowerBoundOffset(operation * 7);
    }

    const logarithmicStepBound = operations * 2 * (Math.ceil(Math.log2(turns)) + 1);
    expect(index.operationCount()).toBeLessThanOrEqual(logarithmicStepBound);
  });

  it('bulk-initializes cold and estimated histories in one linear pass', () => {
    const turns = 40_000;
    const cold = new DynamicHeightIndex();
    cold.resize(turns);
    expect(cold.operationCount()).toBe(turns);
    expect(cold.prefixSum(turns)).toBe(0);

    const estimated = new DynamicHeightIndex();
    estimated.resize(turns, 6);
    expect(estimated.operationCount()).toBe(turns);
    expect(estimated.prefixSum(turns)).toBe(turns * 6);
  });
});
