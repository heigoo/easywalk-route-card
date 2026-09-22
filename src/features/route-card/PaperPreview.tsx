/**
 * 大字卡预览视图（UI-04；第 10.3 节预览显示宽度与缩放降级）。
 * 纸面固定 360px 逻辑宽度；可用宽度不足时整体等比缩小（transform scale），
 * 同步修正占位高度；工具栏不参与缩放。
 */
import { useEffect, useRef, useState } from 'react';
import type { CardViewModel } from '../route-card/viewModel';
import { RouteCard } from '../route-card/RouteCard';
import styles from './Preview.module.css';

export interface PaperPreviewProps {
  vm: CardViewModel;
}

export function PaperPreview({ vm }: PaperPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [paperHeight, setPaperHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / 360));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const update = () => setPaperHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vm]);

  return (
    <div ref={containerRef} className={styles.previewArea} data-testid="paper-preview">
      <div style={{ height: Math.ceil(paperHeight * scale), position: 'relative' }}>
        <div
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          <div ref={paperRef}>
            <RouteCard vm={vm} />
          </div>
        </div>
      </div>
      {scale < 1 ? <p className={styles.scaleNote}>已按屏幕宽度缩小显示，导出图片仍为大字版。</p> : null}
    </div>
  );
}
