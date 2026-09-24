/**
 * 分页算法（第 10.3 节）：
 * - 每页逻辑高度预算 960px（所有设备一致，不随视口变化）；
 * - stickWithNext 使用组合高度判断，分页点落在 node 之前而不是 node 与 leg 之间；
 * - breakMode=text 的块超高时按文本行拆分（按行切分由 DOM 测量完成，见 measure.ts）；
 * - 输出只引用块 id 与字符区间，拆分副本的文本切片在装箱时生成。
 *
 * 装箱的唯一实现：生产管线 paginateCard（measure.ts）与纯分页测试共用 packBlocks，
 * 块高度测量与文本拆分通过 PackOps 注入（生产注入 DOM 测量，测试注入纯函数假件）。
 */

/** 每页逻辑高度上限（第 10.3 节分页参数表） */
export const PAGE_HEIGHT_BUDGET = 960;
/** 逻辑宽度与像素倍率（需求 13.9） */
export const PAPER_WIDTH = 360;
export const PIXEL_RATIO = 3;
/** 拆分至少留出：一行正文 + “续”标记行；剩余空间低于该下限时整块另起一页 */
export const MIN_SPLIT_REMAINING = 96;

/** 导出失败：携带出错块 id 便于界面定位（原在 measure.ts 定义，随装箱实现迁入） */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly blockId: string | null = null,
  ) {
    super(message);
  }
}

export interface PackableBlock {
  id: string;
  /** atomic 整块不可拆；text 超高时按文本行拆分 */
  breakMode: 'atomic' | 'text';
  /** 为真时不得与紧随其后的块分到不同页 */
  stickWithNext: boolean;
  /** breakMode='text' 的块正文；拆分副本携带各自的文本切片 */
  text?: string;
  /** 拆分段序号（拆分副本携带） */
  partIndex?: number;
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

export interface PackResult<T extends PackableBlock = PackableBlock> {
  pages: Array<Array<{ ref: PageBlockRef; block: T }>>;
}

/** 装箱所需的外部能力：生产注入 DOM 测量与按行拆分，测试注入纯函数假件 */
export interface PackOps<T extends PackableBlock> {
  /** 测量块的版面高度（含相邻块间距） */
  measure(block: T): number;
  /**
   * 把可拆文本块按行拆为“前段 + 其余”，两段直接拼接必须还原原文；
   * 无法拆分（含剩余空间不足一行）返回 null，由装箱整块另起一页。
   * maxHeight 为当前页剩余高度，行高余量（如“续”标记行）由实现自行扣除。
   */
  split(block: T & { text: string }, maxHeight: number): { head: string; rest: string } | null;
}

/**
 * 统一装箱：把块依序装入预算为 pageBudget 的页（第 10.3 节第 4～8 步）。
 * - 组合高度（stickWithNext）放不下时，优先尝试按行拆分可拆文本块；
 * - 拆分前段留在当前页，剩余部分回到流首继续装箱，段序号 partIndex 递增；
 * - 无法拆分或非可拆块则整块另起一页；原子块自身超过整页预算时抛 ExportError 阻止导出。
 */
export function packBlocks<T extends PackableBlock>(
  blocks: T[],
  /** 每页可用正文高度（960 减去页眉页脚） */
  pageBudget: number,
  ops: PackOps<T>,
): PackResult<T> {
  interface Item {
    block: T;
    height: number;
  }
  const stream: Item[] = blocks.map((block) => ({ block: { ...block }, height: ops.measure(block) }));
  const pages: PackResult<T>['pages'] = [[]];
  let used = 0;

  const place = (block: T, ref: PageBlockRef): void => {
    pages[pages.length - 1].push({ ref, block });
  };
  const newPage = (): void => {
    pages.push([]);
    used = 0;
  };

  while (stream.length > 0) {
    const item = stream.shift()!;
    const { block, height } = item;
    const next = stream[0];
    const combo = block.stickWithNext && next ? height + next.height : height;

    if (used + combo <= pageBudget) {
      // 整块放置的引用 partIndex 恒为 0；拆分段序号保留在块副本上（与既有生产行为一致）
      place(
        { ...block },
        { blockId: block.id, partIndex: 0, textRange: null, continuedFromPrevious: false, continuesToNext: false },
      );
      used += height;
      continue;
    }

    // 可拆文本块：按行拆分，前段留在当前页，剩余回到流首继续处理
    const remaining = pageBudget - used;
    if (block.breakMode === 'text' && 'text' in block && remaining >= MIN_SPLIT_REMAINING) {
      const partIndex = block.partIndex ?? 0;
      try {
        const parts = ops.split(block as T & { text: string }, remaining);
        if (parts) {
          place(
            { ...block, text: parts.head, partIndex } as T,
            {
              blockId: block.id,
              partIndex,
              textRange: null,
              continuedFromPrevious: partIndex > 0,
              continuesToNext: true,
            },
          );
          used += ops.measure({ ...block, text: parts.head } as T);
          stream.unshift({ block: { ...block, text: parts.rest, partIndex: partIndex + 1 } as T, height: 0 });
          newPage();
          stream[0].height = ops.measure(stream[0].block);
          continue;
        }
      } catch (e) {
        // 拆分失败（如剩余空间不足一行）：整块另起一页；其余错误原样抛出
        if (!(e instanceof ExportError)) throw e;
      }
    }

    // 整块另起一页；原子块自身超过整页预算 → 阻止导出并指出具体块（M33）
    if (height > pageBudget && block.breakMode === 'atomic') {
      throw new ExportError('有一段内容过长超过单页高度，请精简该段后重试', block.id);
    }
    newPage();
    stream.unshift(item);
  }

  return { pages };
}

/** 回填页数与页码文本（形如“第 X / Y 张”由 footText 模板承担） */
export function finalizePages<T extends PackableBlock>(
  packed: PackResult<T>,
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
