/**
 * Dynamic Fenwick tree for transcript row heights. Unknown/cold turns are represented by zero and can
 * be filled in independently without rewriting later prefix cells.
 */
export class DynamicHeightIndex {
  private values: number[] = [];
  private tree: number[] = [0];
  private capacity = 0;
  private operations = 0;

  get length(): number { return this.values.length; }

  append(value: number): void {
    assertHeight(value);
    const previousLength = this.values.length;
    this.ensureCapacity(previousLength + 1);
    this.values.push(value);

    const treeIndex = previousLength + 1;
    const rangeStart = treeIndex - lowBit(treeIndex);
    const previousRange = this.prefixSum(previousLength) - this.prefixSum(rangeStart);
    this.tree[treeIndex] = previousRange + value;
    this.operations += 1;
  }

  /** Grow with a height (zero for cold turns), or discard a suffix. */
  resize(length: number, fill = 0): void {
    assertLength(length);
    assertHeight(fill);
    if (length >= this.values.length) {
      if (this.values.length === 0 && length > 0) {
        this.capacity = nextPowerOfTwo(length);
        this.values = new Array<number>(length).fill(fill);
        this.tree = new Array<number>(this.capacity + 1).fill(0);
        for (let index = 1; index <= length; index += 1) {
          this.tree[index] = lowBit(index) * fill;
          this.operations += 1;
        }
        return;
      }
      while (this.values.length < length) this.append(fill);
      return;
    }

    // Fenwick cells at or below the new length never include a later value, so suffix truncation is
    // O(1). Stale cells above length are harmless and are overwritten if those positions grow back.
    this.values.length = length;
  }

  replace(index: number, value: number): void {
    assertIndex(index, this.values.length);
    assertHeight(value);
    const delta = value - this.values[index]!;
    if (delta === 0) return;
    this.values[index] = value;
    for (let cursor = index + 1; cursor <= this.values.length; cursor += lowBit(cursor)) {
      this.tree[cursor] = (this.tree[cursor] ?? 0) + delta;
      this.operations += 1;
    }
  }

  valueAt(index: number): number {
    assertIndex(index, this.values.length);
    return this.values[index]!;
  }

  prefixSum(end: number): number {
    assertBoundary(end, this.values.length);
    let sum = 0;
    for (let cursor = end; cursor > 0; cursor -= lowBit(cursor)) {
      sum += this.tree[cursor] ?? 0;
      this.operations += 1;
    }
    return sum;
  }

  rangeSum(start: number, end: number): number {
    assertBoundary(start, this.values.length);
    assertBoundary(end, this.values.length);
    if (start > end) throw new RangeError('height range start must not exceed end');
    return this.prefixSum(end) - this.prefixSum(start);
  }

  /** Return the first item whose cumulative end is strictly greater than offset, or length. */
  lowerBoundOffset(offset: number): number {
    if (!Number.isFinite(offset)) throw new RangeError('height offset must be finite');
    if (offset < 0) return 0;

    let index = 0;
    let sum = 0;
    for (let bit = highestPowerOfTwoAtMost(this.values.length); bit > 0; bit >>= 1) {
      const next = index + bit;
      this.operations += 1;
      if (next <= this.values.length && sum + (this.tree[next] ?? 0) <= offset) {
        index = next;
        sum += this.tree[next] ?? 0;
      }
    }
    return index;
  }

  resetOperationCount(): void { this.operations = 0; }
  operationCount(): number { return this.operations; }

  private ensureCapacity(length: number): void {
    if (length <= this.capacity) return;
    this.capacity = nextPowerOfTwo(length);
    this.tree.length = this.capacity + 1;
    this.tree[0] = 0;
  }
}

function lowBit(value: number): number { return value & -value; }

function highestPowerOfTwoAtMost(value: number): number {
  if (value < 1) return 0;
  return 2 ** Math.floor(Math.log2(value));
}

function nextPowerOfTwo(value: number): number {
  return value < 1 ? 0 : 2 ** Math.ceil(Math.log2(value));
}

function assertHeight(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('height must be a non-negative integer');
}

function assertLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('height index length must be a non-negative integer');
}

function assertBoundary(value: number, length: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) throw new RangeError('height boundary is out of range');
}

function assertIndex(value: number, length: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) throw new RangeError('height index is out of range');
}
