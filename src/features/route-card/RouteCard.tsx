/**
 * 大字卡渲染（需求 R05、第 10.2 节）。
 * 只读纸面：消费 CardViewModel，不读取全局编辑状态或原始地图响应。
 * 预览渲染全部块；导出按页渲染给定块序列（第 10.3 节第 10 步）。
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { CardBlock, CardViewModel } from './viewModel';
import styles from './RouteCard.module.css';

export interface RouteCardProps {
  vm: CardViewModel;
  /** 只渲染这些块（导出分页后的单页）；缺省渲染全部 */
  blocks?: CardBlock[];
  /** 页脚文本（含回填页码）；缺省用 vm.footText */
  footText?: string;
  /** 续页承接文本 */
  continuationLabelText?: string | null;
  innerRef?: React.Ref<HTMLDivElement>;
}

const STATUS_LABEL: Record<CardViewModel['status']['kind'], string | null> = {
  complete: null,
  draft: '草稿 · 信息待确认',
  violated: '草稿 · 已超你设置的上限',
  blocked: '无法导出：请先完善行程',
};

export function RouteCard({ vm, blocks, footText, continuationLabelText, innerRef }: RouteCardProps) {
  const list = blocks ?? vm.blocks;
  const statusLabel = STATUS_LABEL[vm.status.kind];
  return (
    <div className={`paper ${styles.paper}`} ref={innerRef} data-testid="route-card-paper">
      {continuationLabelText ? <div className={styles.continuation}>{continuationLabelText}</div> : null}
      {statusLabel ? (
        <div className={`${styles.statusLine} ${vm.status.kind}`} role="note">
          {statusLabel}
        </div>
      ) : null}
      {list.map((block) => (
        <Block key={`${block.id}-${'partIndex' in block ? (block as { partIndex?: number }).partIndex ?? 0 : 0}`} block={block} />
      ))}
      <div className={styles.footer}>{footText ?? vm.footText.replace('{page}/{total}', '预览')}</div>
    </div>
  );
}

/**
 * 单块同步挂载：供导出测量使用，与纸面渲染共用同一 Block 组件与样式，
 * 保证“测量与导出使用同一字体、字号、行高与内边距”（第 10.3 节第 3 步）。
 */
export interface BlockMount {
  el: HTMLElement;
  dispose: () => void;
}

export function mountBlock(block: CardBlock): BlockMount {
  const el = document.createElement('div');
  el.style.width = '328px'; // 360 - 16×2，与纸面内容区一致
  const root = createRoot(el);
  flushSync(() => root.render(<Block block={block} />));
  return {
    el,
    dispose: () => {
      try {
        root.unmount();
      } catch {
        // 已卸载
      }
      el.remove();
    },
  };
}

function Block({ block }: { block: CardBlock }) {
  switch (block.kind) {
    case 'header':
      return (
        <header className={styles.header}>
          <div className={styles.title}>{block.titleText}</div>
          {block.subtitleText ? <div className={styles.subtitle}>{block.subtitleText}</div> : null}
          {block.dateText ? <div className={styles.dateLine}>出游日期 {block.dateText}</div> : null}
          <div className={styles.dateLine}>生成于 {block.generatedAtText}</div>
        </header>
      );
    case 'summary':
      return (
        <section className={styles.summary} aria-label="行程摘要">
          {block.items.map((item) => (
            <div key={item.key} className={`${styles.summaryItem} ${item.state === 'violated' ? 'violated' : item.state === 'known' ? '' : 'warn'}`}>
              <span className={styles.label}>{item.labelText}</span>
              <span className={styles.value}>
                {item.valueText}
                {item.unitText ? <span className={styles.unit}>{item.unitText}</span> : null}
              </span>
              {item.noteText ? <span className={styles.note}>{item.noteText}</span> : null}
            </div>
          ))}
        </section>
      );
    case 'notice':
      return (
        <div className={`${styles.notice} ${block.severity}`} role="note" data-split-target>
          {block.text}
        </div>
      );
    case 'node':
      return (
        <section className={styles.node} aria-label={block.titleText}>
          {block.sectionTitleText ? <h3 className={styles.sectionTitle}>{block.sectionTitleText}</h3> : null}
          <div className={styles.nodeHead}>
            {block.indexText ? <span className={styles.nodeIndex}>{block.indexText}</span> : null}
            {block.role === 'origin' ? <span className={styles.nodeRole}>起点 · </span> : null}
            {block.role === 'destination' ? <span className={styles.nodeRole}>终点 · </span> : null}
            <span className={styles.nodeTitle}>{block.titleText}</span>
            {block.badges.map((b) => (
              <span key={b.text} className={`${styles.badge} ${b.tone === 'warning' ? 'warning' : ''}`}>
                {b.text}
              </span>
            ))}
          </div>
          <div className={styles.nodeMeta}>
            {block.metaLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          {block.notices.map((n) => (
            <div key={n.text} className={styles.nodeNotice}>
              {n.text}
            </div>
          ))}
        </section>
      );
    case 'leg':
      return (
        <div className={`${styles.leg} ${block.state === 'missing' ? 'missing' : ''}`}>
          <span className={styles.legMain}>{block.mainText}</span>
          {block.secondaryText ? <span className={styles.legSecondary}>{block.secondaryText}</span> : null}
        </div>
      );
    case 'note':
      return (
        <div className={styles.note} data-split-target data-part-index={('partIndex' in block ? (block as { partIndex?: number }).partIndex : 0) ?? 0}>
          {('partIndex' in block ? (block as { partIndex?: number }).partIndex : 0) ? '（续）' : ''}
          {block.text}
        </div>
      );
    case 'skipped':
      return (
        <section className={styles.skipped} aria-label="已跳过的景点">
          <div className={styles.skippedTitle}>本次暂不前往</div>
          {block.items.map((item) => (
            <div key={item.titleText} className={styles.skippedItem}>
              <span className={styles.name}>{item.titleText}</span>
              {item.noteText ? <span className={styles.note}>{item.noteText}</span> : null}
            </div>
          ))}
        </section>
      );
    case 'source':
      return (
        <section className={styles.source} aria-label="数据来源与提醒">
          {block.items.map((item) => (
            <div key={item.labelText} className={styles.sourceItem}>
              <span className={styles.label}>{item.labelText}</span>
              <span>{item.valueText}</span>
            </div>
          ))}
          <div className={styles.checkText}>{block.checkText}</div>
        </section>
      );
  }
}
