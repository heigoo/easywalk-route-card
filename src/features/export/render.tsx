/**
 * 逐页渲染为 PNG（第 10.3 节第 10 步；需求 R06、13.9）：
 * 每页独立 360px 容器，3 倍像素密度输出 1080px 宽；
 * 每页渲染完成立即卸载并释放对象 URL，不同时保留全部大画布。
 */
import { createRoot, type Root } from 'react-dom/client';
import { toPng } from 'html-to-image';
import type { CardViewModel } from '../route-card/viewModel';
import { RouteCard } from '../route-card/RouteCard';
import { PAPER_WIDTH, PIXEL_RATIO } from './paginate';
import { ExportError, type RenderPage } from './measure';

export interface RenderedPage {
  page: RenderPage;
  blob: Blob;
}

/** 单页渲染：失败只报该页，可重试（第 10.3 节失败与边界） */
export async function renderPageToPng(vm: CardViewModel, page: RenderPage): Promise<Blob> {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  document.body.appendChild(host);
  let root: Root | null = null;
  try {
    root = createRoot(host);
    await new Promise<void>((resolve) => {
      root!.render(<RouteCard vm={vm} blocks={page.blocks} footText={page.footText} continuationLabelText={page.continuationLabelText} innerRef={() => resolve()} />);
    });
    const paper = host.querySelector<HTMLElement>('[data-testid="route-card-paper"]');
    if (!paper) throw new ExportError('纸面渲染失败，请重试');
    await new Promise((r) => setTimeout(r, 50)); // 等待布局稳定
    const dataUrl = await toPng(paper, {
      pixelRatio: PIXEL_RATIO,
      width: PAPER_WIDTH,
      canvasWidth: PAPER_WIDTH * PIXEL_RATIO,
      backgroundColor: '#ffffff',
    });
    // M37：toBlob 直接转 Blob，避免 dataURL 经 fetch 的内存峰值
    const blob = await new Promise<Blob | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => resolve(b), 'image/png');
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
    if (!blob || blob.size === 0) throw new ExportError('生成空白图片，请重试');
    return blob;
  } finally {
    if (root) {
      try {
        root.unmount();
      } catch {
        // 忽略卸载异常
      }
    }
    host.remove();
  }
}

/** 依次渲染全部页；某页失败即抛出该页错误，已成功页由调用方保留 */
export async function renderAllPages(vm: CardViewModel, pages: RenderPage[]): Promise<RenderedPage[]> {
  const out: RenderedPage[] = [];
  for (const page of pages) {
    const blob = await renderPageToPng(vm, page);
    out.push({ page, blob });
  }
  return out;
}
