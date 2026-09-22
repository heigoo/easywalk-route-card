/**
 * 纯分页装箱（第 10.3 节；不依赖 DOM 布局）。
 */
import { describe, expect, it } from 'vitest';
import { packBlocks, PAGE_HEIGHT_BUDGET } from '../../src/features/export/paginate';

function b(id: string, height: number, opts: { stick?: boolean; breakMode?: 'atomic' | 'text' } = {}) {
  return { id, height, breakMode: opts.breakMode ?? 'atomic', stickWithNext: opts.stick ?? false };
}

describe('packBlocks（第 10.3 节）', () => {
  it('顺序装箱：超过预算另起一页', () => {
    const { pages } = packBlocks([b('a', 400), b('b', 400), b('c', 400)], 960);
    expect(pages).toHaveLength(2);
    expect(pages[0].map((i) => i.block.id)).toEqual(['a', 'b']);
    expect(pages[1].map((i) => i.block.id)).toEqual(['c']);
  });

  it('stickWithNext：node 不与随后的 leg 被分页切开', () => {
    const node = b('node1', 300, { stick: true });
    const leg = b('leg1', 100);
    const { pages } = packBlocks([b('fill', 600), node, leg, b('tail', 100)], 960);
    // fill(600)+node(300)+leg(100)=1000>960 → node 与 leg 一起下移
    expect(pages).toHaveLength(2);
    expect(pages[0].map((i) => i.block.id)).toEqual(['fill']);
    expect(pages[1].map((i) => i.block.id)).toEqual(['node1', 'leg1', 'tail']);
  });

  it('整页预算常量 960，所有设备一致', () => {
    expect(PAGE_HEIGHT_BUDGET).toBe(960);
  });
});
