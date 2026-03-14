import { describe, it, expect } from 'vitest';
import { Semaphore } from '../core/semaphore.js';

describe('Semaphore', () => {
  it('allows immediate acquisition when count > 0', async () => {
    const sem = new Semaphore(2);
    // Should resolve immediately without blocking
    await sem.acquire();
    await sem.acquire();
    // Acquired both slots — verify by releasing and re-acquiring
    sem.release();
    await expect(sem.acquire()).resolves.toBeUndefined();
  });

  it('blocks a third caller when count is 2', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let thirdResolved = false;

    const third = sem.acquire().then(() => {
      thirdResolved = true;
    });

    // Give microtasks a tick to settle — third should still be pending
    await new Promise(r => setTimeout(r, 10));
    expect(thirdResolved).toBe(false);

    // Release one slot — third should now resolve
    sem.release();
    await third;
    expect(thirdResolved).toBe(true);
  });

  it('preserves FIFO ordering for queued waiters', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // occupy the only slot

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    sem.release(); // let p1 through
    await p1;
    sem.release(); // let p2 through
    await p2;
    sem.release(); // let p3 through
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('restores count to initial value after equal acquire/release pairs', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    sem.release();
    sem.release();
    // Should be able to acquire 3 times again
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    // 4th should block — test with a race against a tiny timeout
    let blocked = true;
    const race = Promise.race([
      sem.acquire().then(() => { blocked = false; }),
      new Promise(r => setTimeout(r, 20)),
    ]);
    await race;
    expect(blocked).toBe(true);
  });
});
