import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { sleep, withTimeout, verifyFileExists, filterExistingFiles } from './utils.js';

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow slight timing variance
  });

  it('resolves with void', async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

describe('withTimeout', () => {
  it('resolves when promise settles before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  it('rejects when promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 500));
    await expect(withTimeout(slow, 50, 'slow-op')).rejects.toThrow('slow-op timed out after 50ms');
  });

  it('propagates the original rejection if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('original error');
  });

  it('uses default label when none provided', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 500));
    await expect(withTimeout(slow, 10)).rejects.toThrow('Operation timed out');
  });
});

describe('verifyFileExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'utils-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for an existing file with content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello');
    expect(await verifyFileExists(filePath)).toBe(true);
  });

  it('returns false for a non-existent file', async () => {
    expect(await verifyFileExists(path.join(tmpDir, 'nope.txt'))).toBe(false);
  });

  it('returns false for an empty (0-byte) file', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, '');
    expect(await verifyFileExists(filePath)).toBe(false);
  });
});

describe('filterExistingFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'utils-filter-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns only files that exist', async () => {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    await fs.writeFile(a, 'content-a');
    // b does not exist

    const result = await filterExistingFiles([a, b]);
    expect(result).toEqual([a]);
  });

  it('returns empty array when all files are missing', async () => {
    const result = await filterExistingFiles([
      path.join(tmpDir, 'x.txt'),
      path.join(tmpDir, 'y.txt'),
    ]);
    expect(result).toEqual([]);
  });

  it('returns all files when all exist', async () => {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    await fs.writeFile(a, 'a');
    await fs.writeFile(b, 'b');

    const result = await filterExistingFiles([a, b]);
    expect(result).toEqual([a, b]);
  });
});
