/**
 * 纯分页装箱（第 10.3 节；不依赖 DOM 布局）。
 * 测量与文本拆分以纯函数假件注入 packBlocks，与生产管线（measure.ts）共用同一装箱实现，
 * 固化生产行为：按行拆分、分页连续性、拆分段引用标记与原子块溢出拦截。
 */
import { describe, expect, it } from 'vitest';
import {
  ExportError,
  PAGE_HEIGHT_BUDGET,
  packBlocks,
  type PackOps,
  type PackableBlock,
} from '../../src/features/export/paginate';

/** 测试块：固定高度块直接给 height；文本块按“每字 1px”计高（拆分同口径） */
interface TestBlock extends PackableBlock {
  height?: number;
}

function b(id: string, height: number, opts: { stick?: boolean; breakMode?: 'atomic' | 'text' } = {}): TestBlock {
  return { id, height, breakMode: opts.breakMode ?? 'atomic', stickWithNext: opts.stick ?? false };
}

/** 文本块：备注/提醒，可按行拆分（模拟生产 note/notice，stickWithNext 默认为真） */
function note(id: string, text: string, opts: { stick?: boolean } = {}): TestBlock {
  return { id, text, breakMode: 'text', stickWithNext: opts.stick ?? true };
}

/** 拆分预留余量：模拟 measure.ts 的“一行正文 + 续标记行”行高余量 */
const SPLIT_RESERVE = 60;

const ops: PackOps<TestBlock> = {
  measure: (block) => block.height ?? block.text?.length ?? 0,
  split: (block, maxHeight) => {
    // 整字边界取最大可容字数；整段放得下或一字都放不下时返回 null（无法拆分）
    const cut = Math.floor(maxHeight - SPLIT_RESERVE);
    if (cut <= 0 || cut >= block.text.length) return null;
    return { head: block.text.slice(0, cut), rest: block.text.slice(cut) };
  },
};

describe('packBlocks（第 10.3 节）', () => {
  it('顺序装箱：超过预算另起一页', () => {
    const { pages } = packBlocks([b('a', 400), b('b', 400), b('c', 400)], 960, ops);
    expect(pages).toHaveLength(2);
    expect(pages[0].map((i) => i.block.id)).toEqual(['a', 'b']);
    expect(pages[1].map((i) => i.block.id)).toEqual(['c']);
  });

  it('stickWithNext：node 不与随后的 leg 被分页切开', () => {
    const node = b('node1', 300, { stick: true });
    const leg = b('leg1', 100);
    const { pages } = packBlocks([b('fill', 600), node, leg, b('tail', 100)], 960, ops);
    // fill(600)+node(300)+leg(100)=1000>960 → node 与 leg 一起下移
    expect(pages).toHaveLength(2);
    expect(pages[0].map((i) => i.block.id)).toEqual(['fill']);
    expect(pages[1].map((i) => i.block.id)).toEqual(['node1', 'leg1', 'tail']);
  });

  it('整页预算常量 960，所有设备一致', () => {
    expect(PAGE_HEIGHT_BUDGET).toBe(960);
  });

  it('长文本按行拆分：前段留页、剩余续排，拼接还原原文且段引用递进', () => {
    const text = '备'.repeat(2400);
    const { pages } = packBlocks([b('fill', 300), note('note1', text)], 960, ops);
    // fill(300) 后剩余 660：首段 600 字（预留 60），其余 1800 字续排 → 900 + 900
    expect(pages).toHaveLength(3);
    expect(pages[0].map((i) => i.block.id)).toEqual(['fill', 'note1']);

    const parts = pages.flat().filter((i) => i.block.id === 'note1');
    expect(parts.map((p) => p.block.text)).toEqual([text.slice(0, 600), text.slice(600, 1500), text.slice(1500)]);
    expect(parts.map((p) => p.block.text).join('')).toBe(text); // 两段直接拼接还原原文
    expect(parts.map((p) => p.block.partIndex)).toEqual([0, 1, 2]);
    expect(parts.map((p) => p.ref)).toEqual([
      { blockId: 'note1', partIndex: 0, textRange: null, continuedFromPrevious: false, continuesToNext: true },
      { blockId: 'note1', partIndex: 1, textRange: null, continuedFromPrevious: true, continuesToNext: true },
      // 生产现状口径：整块放置的引用 partIndex 恒为 0，段序号保留在块副本上
      { blockId: 'note1', partIndex: 0, textRange: null, continuedFromPrevious: false, continuesToNext: false },
    ]);
  });

  it('剩余空间不足拆分下限 96：文本块整块另起一页', () => {
    const { pages } = packBlocks([b('a', 900), note('n', '注'.repeat(500))], 960, ops);
    // a 用掉 900，剩余 60 < 96（一行正文 + 续标记行）→ 不拆分，整块下移
    expect(pages.map((p) => p.map((i) => i.block.id))).toEqual([['a'], ['n']]);
  });

  it('原子块自身超过整页预算：抛出 ExportError 并指出具体块', () => {
    let caught: unknown;
    try {
      packBlocks([b('big', 1000)], 960, ops);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExportError);
    expect((caught as ExportError).message).toBe('有一段内容过长超过单页高度，请精简该段后重试');
    expect((caught as ExportError).blockId).toBe('big');
  });

  it('6 景点长备注（T15/D13）：node 与备注不拆开，备注按行拆分完整保留，分页连续', () => {
    const texts = Array.from({ length: 6 }, (_, i) => `第${i + 1}站备注：`.padEnd(20, '注') + '注'.repeat(760));
    const blocks: TestBlock[] = [];
    for (let i = 0; i < 6; i++) {
      blocks.push(b(`node${i + 1}`, 150, { stick: true }));
      blocks.push(note(`note${i + 1}`, texts[i]));
      if (i < 5) blocks.push(b(`leg${i + 1}`, 60));
    }
    const { pages } = packBlocks(blocks, 960, ops);

    // 分页连续：无空页；前 5 站各占 2 页（node+备注首段 / 备注剩余段+leg），
    // 末站备注无后续块、整段放得下则不拆分，占 1 页
    expect(pages.every((p) => p.length > 0)).toBe(true);
    expect(pages).toHaveLength(11);
    for (let i = 0; i < 6; i++) {
      const pageIdx = i * 2;
      // stickWithNext：node 与其备注（首段）不被分页切开
      expect(pages[pageIdx].map((x) => x.block.id)).toEqual([`node${i + 1}`, `note${i + 1}`]);

      // 备注按行拆分完整保留：各段拼接还原原文，段序号连续递增
      const parts = pages.flat().filter((x) => x.block.id === `note${i + 1}`);
      expect(parts.map((p) => p.block.text).join('')).toBe(texts[i]);
      expect(parts.map((p) => p.block.partIndex ?? 0)).toEqual(parts.map((_, idx) => idx));
      if (i < 5) expect(parts).toHaveLength(2); // 前 5 站备注超高被拆为两段
    }
  });
});
