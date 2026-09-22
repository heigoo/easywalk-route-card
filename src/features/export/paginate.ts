/**
 * 分页算法（第 10.3 节）：
 * - 每页逻辑高度预算 960px（所有设备一致，不随视口变化）；
 * - stickWithNext 使用组合高度判断，分页点落在 node 之前而不是 node 与 leg 之间；
 * - breakMode=text 的块超高时按文本行拆分（拆分由 DOM 测量完成，见 measure.ts）；
 * - 输出只引用块 id 与字符区间，不复制改写块内容（拆分副本由测量层生成）。
 */

/** 每页逻辑高度上限（第 10.3 节分页参数表） */
export const PAGE_HEIGHT_BUDGET = 960;
/** 逻辑宽度与像素倍率（需求 13.9） */
export const PAPER_WIDTH = 360;
export const PIXEL_RATIO = 3;

export interface PackableBlock {
  id: string;
  /** 版面高度（含相邻块间距，由测量层给出） */
  height: number;
  breakMode: 'atomic' | 'text';
  stickWithNext: boolean;
}

export interface PageBlockRef {
  blockId: string;
  partIndex: number;
  textRange: { start: number; end: number } | null;
  continuedFromPrevious: boolean;
  continuesToNext: boolean;
}

export interface CardPage {
  pageIndex: number;
  pageCount: number;
  blockRefs: PageBlockRef[];
  continuationLabelText: string | null;
}

export interface PackResult {
  pages: Array<Array<{ ref: PageBlockRef; block: PackableBlock }>>;
}

/**
 * 纯装箱：把块依序装入预算为 pageBudget 的页。
 * 返回每页的（块引用, 块）对；调用方负责文本拆分后的二次装箱。
 */
export function packBlocks(
  blocks: PackableBlock[],
  /** 每页可用正文高度（960 减去页眉页脚） */
  pageBudget: number,
): PackResult {
  const pages: PackResult['pages'] = [[]];
  let used = 0;

  const fits = (height: number) => used + height <= pageBudget;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const next = i + 1 < blocks.length ? blocks[i + 1] : null;
    const combo = block.stickWithNext && next ? block.height + next.height : block.height;

    if (fits(combo)) {
      pages[pages.length - 1].push({ ref: makeRef(block, 0), block });
      used += block.height;
      continue;
    }

    // 当前页放不下：先尝试文本拆分（仅自身超高且为可拆块时由调用方处理，这里整块另起一页）
    pages.push([{ ref: makeRef(block, 0), block }]);
    used = block.height;
  }
  return { pages };
}

function makeRef(block: PackableBlock, partIndex: number): PageBlockRef {
  return {
    blockId: block.id,
    partIndex,
    textRange: null,
    continuedFromPrevious: partIndex > 0,
    continuesToNext: false,
  };
}

/** 回填页数与页码文本（形如“第 X / Y 张”由 footText 模板承担） */
export function finalizePages(
  packed: PackResult,
  continuationFor: (pageIndex: number) => string | null,
): CardPage[] {
  const pageCount = packed.pages.length;
  return packed.pages.map((items, pageIndex) => ({
    pageIndex,
    pageCount,
    blockRefs: items.map((i) => i.ref),
    continuationLabelText: pageIndex === 0 ? null : continuationFor(pageIndex),
  }));
}
