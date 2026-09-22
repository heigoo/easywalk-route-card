/**
 * 分页测量与文本行拆分（第 10.3 节第 2～9 步）。
 * 在离屏纸面容器中用真实排版测量块高度；拆分点必须落在行边界，
 * 两段直接拼接还原原文（可回归断言）；不用 Canvas measureText 自行断行。
 */
import type { CardBlock, CardViewModel } from '../route-card/viewModel';
import { PAGE_HEIGHT_BUDGET, PAPER_WIDTH, PIXEL_RATIO, type PageBlockRef } from './paginate';
import { mountBlock as defaultMount, type BlockMount } from '../route-card/RouteCard';

/** 渲染用的具体块：拆分产生的副本带 partIndex 与部分文本 */
export type RenderBlock = CardBlock & { partIndex?: number };

export interface RenderPage {
  pageIndex: number;
  pageCount: number;
  blocks: RenderBlock[];
  blockRefs: PageBlockRef[];
  continuationLabelText: string | null;
  footText: string;
}

const GAP = 12; // 与 RouteCard.module.css .paper 的 gap 保持一致
/** 拆分至少留出：一行正文 + “续”标记行 */
const MIN_SPLIT_REMAINING = 96;

export class ExportError extends Error {
  constructor(
    message: string,
    readonly blockId: string | null = null,
  ) {
    super(message);
  }
}

/** 离屏容器：固定 360px 逻辑宽度、不限高、移出可视区（第 10.3 节第 2 步） */
function makeOffscreenRoot(): HTMLDivElement {
  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.width = `${PAPER_WIDTH}px`;
  root.style.pointerEvents = 'none';
  document.body.appendChild(root);
  return root;
}

/** 等待字体就绪；未就绪不生成图片（第 10.3 节失败与边界） */
async function waitForFonts(): Promise<void> {
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
  } catch {
    throw new ExportError('字体未就绪，请重试');
  }
}

function measure(el: HTMLElement): number {
  const h = el.getBoundingClientRect().height;
  if (!h || h <= 0) throw new ExportError('测得高度为 0，请重试');
  return h;
}

/**
 * 对纯文本元素按行拆分：以不超过 maxHeight 为条件取最大字符偏移，
 * 用 Range + getClientRects 判断偏移落在行边界；按码位步进，不拆散代理对。
 * 返回各段文本；各段直接拼接必须还原原文。
 */
export function splitTextAtHeight(textEl: HTMLElement, fullText: string, maxHeight: number): string[] {
  if (!textEl.firstChild) return [fullText];
  const top = textEl.getBoundingClientRect().top;
  const fits = (charCount: number): boolean => {
    if (charCount <= 0) return true;
    const range = document.createRange();
    range.setStart(textEl.firstChild!, 0);
    range.setEnd(textEl.firstChild!, charCount);
    const rects = range.getClientRects();
    if (rects.length === 0) return charCount === 0;
    return rects[rects.length - 1].bottom - top <= maxHeight;
  };

  if (fits(fullText.length)) return [fullText];

  let lo = 0;
  let hi = fullText.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  while (cut > 0 && !isAtLineStart(textEl, cut)) cut--;
  if (cut <= 0) throw new ExportError('剩余空间不足一行，无法拆分');
  const head = fullText.slice(0, cut);
  const rest = fullText.slice(cut);
  return [head, ...splitTextAtHeight(textEl, rest, maxHeight)];
}

function isAtLineStart(el: HTMLElement, offset: number): boolean {
  const at = document.createRange();
  at.setStart(el.firstChild!, offset);
  at.setEnd(el.firstChild!, offset);
  const atRects = at.getClientRects();
  if (atRects.length === 0) return true;
  const prev = document.createRange();
  prev.setStart(el.firstChild!, offset - 1);
  prev.setEnd(el.firstChild!, offset);
  const prevRects = prev.getClientRects();
  if (prevRects.length === 0) return true;
  return atRects[0].top > prevRects[prevRects.length - 1].top;
}

function lineHeightOf(el: HTMLElement): number {
  const lh = parseFloat(getComputedStyle(el).lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : 27;
}

interface StreamItem {
  block: RenderBlock;
  height: number; // 含 GAP
}

/**
 * 完整分页管线：测量 → 依序装箱 → 文本拆分 → 回填页码与承接信息。
 * mount 由调用方提供（默认 mountBlock），保证测量与导出渲染一致。
 */
export async function paginateCard(
  blocks: CardBlock[],
  vm: CardViewModel,
  mount: (block: CardBlock) => BlockMount = defaultMount,
  budget: number = PAGE_HEIGHT_BUDGET,
): Promise<RenderPage[]> {
  await waitForFonts();
  const root = makeOffscreenRoot();
  try {
    const measureBlock = (block: CardBlock): { height: number } => {
      const m = mount(block);
      root.appendChild(m.el);
      try {
        return { height: measure(m.el) + GAP };
      } finally {
        root.removeChild(m.el);
        m.dispose();
      }
    };

    const footerHeight = measureFooter();
    const usable = budget - 32 /* 纸面内边距 */ - footerHeight;

    const stream: StreamItem[] = blocks.map((block) => ({ block: { ...block } as RenderBlock, height: measureBlock(block).height }));
    const pages: RenderBlock[][] = [[]];
    const refs: PageBlockRef[][] = [[]];
    let used = 0;

    const place = (block: RenderBlock, ref: PageBlockRef) => {
      pages[pages.length - 1].push(block);
      refs[refs.length - 1].push(ref);
    };
    const newPage = () => {
      pages.push([]);
      refs.push([]);
      used = 0;
    };

    while (stream.length > 0) {
      const item = stream.shift()!;
      const { block, height } = item;
      const next = stream[0];
      const combo = block.stickWithNext && next ? height + next.height : height;

      if (used + combo <= usable) {
        place({ ...block }, { blockId: block.id, partIndex: 0, textRange: null, continuedFromPrevious: false, continuesToNext: false });
        used += height;
        continue;
      }

      // 可拆文本块：按行拆分，前段留在当前页，剩余回到流首继续处理
      const remaining = usable - used;
      if (block.breakMode === 'text' && 'text' in block && remaining >= MIN_SPLIT_REMAINED_GUARD) {
        const m = mount(block);
        root.appendChild(m.el);
        try {
          const target = (m.el.querySelector('[data-split-target]') as HTMLElement | null) ?? m.el;
          const reserve = lineHeightOf(target) * 1.6; // “续”标记行
          const parts = splitTextAtHeight(target, block.text, remaining - reserve);
          if (parts.length >= 2) {
            const head = parts[0];
            place(
              { ...block, text: head, partIndex: block.partIndex ?? 0 },
              { blockId: block.id, partIndex: block.partIndex ?? 0, textRange: null, continuedFromPrevious: (block.partIndex ?? 0) > 0, continuesToNext: true },
            );
            used += measureBlock({ ...block, text: head }).height;
            const rest = parts.slice(1).join('');
            stream.unshift({ block: { ...block, text: rest, partIndex: (block.partIndex ?? 0) + 1 }, height: 0 });
            newPage();
            stream[0].height = measureBlock(stream[0].block).height;
            m.dispose();
            continue;
          }
        } catch (e) {
          if (e instanceof ExportError) {
            // 剩余空间不足一行：整块下移
          } else {
            m.dispose();
            throw e;
          }
        }
        m.dispose();
      }

      // 整块另起一页；原子块自身超过整页预算 → 阻止导出并指出具体块
      if (height > usable && block.breakMode === 'atomic') {
        throw new ExportError('有内容过长超过单页高度，请精简后重试', block.id);
      }
      newPage();
      stream.unshift(item);
    }

    const pageCount = pages.length;
    const lastNodeTitleBefore = (pageIndex: number): string | null => {
      for (let p = pageIndex - 1; p >= 0; p--) {
        for (let j = pages[p].length - 1; j >= 0; j--) {
          const b = pages[p][j];
          if (b.kind === 'node') return (b as { titleText?: string }).titleText ?? null;
        }
      }
      return null;
    };

    return pages.map((pageBlocks, pageIndex) => ({
      pageIndex,
      pageCount,
      blocks: pageBlocks,
      blockRefs: refs[pageIndex],
      continuationLabelText: pageIndex === 0 ? null : `上一页接着：${lastNodeTitleBefore(pageIndex) ?? '前一站'}`,
      footText: vm.footText.replace('{page}', String(pageIndex + 1)).replace('{total}', String(pageCount)),
    }));
  } finally {
    root.remove();
  }
}

const MIN_SPLIT_REMAINED_GUARD = MIN_SPLIT_REMAINING;

/** 页脚高度测量（页脚重复出现于每页） */
function measureFooter(): number {
  const el = document.createElement('div');
  el.style.width = `${PAPER_WIDTH - 32}px`;
  el.textContent = '省脚力路线卡 · 生成于 2026-09-22 12:00 · 第 1/1 张';
  el.style.fontSize = '14px';
  el.style.lineHeight = '1.5';
  el.style.paddingTop = '8px';
  el.style.borderTop = '1px solid #e0e0e0';
  const root = makeOffscreenRoot();
  root.appendChild(el);
  try {
    return measure(el);
  } catch {
    return 40;
  } finally {
    root.remove();
  }
}

export { PIXEL_RATIO };
