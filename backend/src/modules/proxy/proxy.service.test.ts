// Pure-function tests for the round-robin + block-detection logic
// used by proxy.service.ts. We extract the algorithms here so they
// can be exercised without a Prisma mock.

interface Proxy {
  id: string;
  blockCount: number;
  status: 'ACTIVE' | 'BLOCKED';
}

function rotate(proxies: Proxy[], index: number): { picked: Proxy | null; nextIndex: number } {
  if (proxies.length === 0) return { picked: null, nextIndex: index };
  const picked = proxies[index % proxies.length];
  return { picked, nextIndex: (index + 1) % proxies.length };
}

function applyBlockReport(proxy: Proxy, blockThreshold = 3): Proxy {
  const blockCount = proxy.blockCount + 1;
  return {
    ...proxy,
    blockCount,
    status: blockCount >= blockThreshold ? 'BLOCKED' : proxy.status,
  };
}

const make = (id: string, blockCount = 0): Proxy => ({ id, blockCount, status: 'ACTIVE' });

describe('proxy rotation', () => {
  it('returns null when pool is empty', () => {
    const { picked, nextIndex } = rotate([], 0);
    expect(picked).toBeNull();
    expect(nextIndex).toBe(0);
  });

  it('cycles through all proxies in order', () => {
    const pool = [make('a'), make('b'), make('c')];
    let idx = 0;
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { picked, nextIndex } = rotate(pool, idx);
      order.push(picked!.id);
      idx = nextIndex;
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('handles a single-proxy pool', () => {
    const pool = [make('only')];
    const { picked, nextIndex } = rotate(pool, 0);
    expect(picked!.id).toBe('only');
    expect(nextIndex).toBe(0);
  });
});

describe('proxy block reporting', () => {
  it('increments block count without flipping status below threshold', () => {
    const result = applyBlockReport(make('p', 0));
    expect(result.blockCount).toBe(1);
    expect(result.status).toBe('ACTIVE');
  });

  it('flips status to BLOCKED when threshold is reached', () => {
    const result = applyBlockReport(make('p', 2));
    expect(result.blockCount).toBe(3);
    expect(result.status).toBe('BLOCKED');
  });

  it('respects custom block threshold', () => {
    const result = applyBlockReport(make('p', 0), 1);
    expect(result.status).toBe('BLOCKED');
  });
});
