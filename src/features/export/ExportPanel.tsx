/**
 * 导出面板（UI-07；需求 R06、第 10.1、10.4 节）。
 * - 点击时冻结当前 VM 快照，导出期间编辑不影响本次结果（T14）；
 * - blocked 状态阻止导出并解释原因；draft/violated 显示“导出草稿”且提示随图保留；
 * - 逐页生成、逐页保存；只提示“图片已生成”，不误报“已保存到相册”。
 */
import { useEffect, useRef, useState } from 'react';
import type { CardViewModel } from '../route-card/viewModel';
import { paginateCard, ExportError, type RenderPage } from './measure';
import { renderPageToPng } from './render';
import styles from './Export.module.css';
import editor from '../itinerary/Editor.module.css';

export interface ExportPanelProps {
  vm: CardViewModel;
  statusKind: CardViewModel['status']['kind'];
  fileBaseName: string;
  /** 每次递增表示外部请求触发一次导出（手机预览视图的吸底按钮） */
  trigger?: number;
  /** 是否渲染本面板内的导出按钮；窄屏由吸底操作栏承担主入口（需求 9.3） */
  showTriggerButton?: boolean;
}

interface PageItem {
  page: RenderPage;
  url: string;
}

type Phase = 'idle' | 'paginating' | 'rendering' | 'done' | 'failed';

export function ExportPanel({ vm, statusKind, fileBaseName, trigger = 0, showTriggerButton = true }: ExportPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pages, setPages] = useState<PageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const snapshotRef = useRef<CardViewModel | null>(null);
  const urlsRef = useRef<string[]>([]);

  const blocked = statusKind === 'blocked';

  const releaseUrls = () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
    setPages([]);
  };

  useEffect(() => releaseUrls, []);

  // 外部触发（窄屏预览视图的吸底导出按钮）
  useEffect(() => {
    if (trigger > 0) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  const start = async () => {
    // 冻结点击时的快照；后续编辑不影响本次导出
    const snapshot = vm;
    snapshotRef.current = snapshot;
    setError(null);
    setFailedPage(null);
    releaseUrls();
    setPhase('paginating');
    try {
      const renderPages = await paginateCard(snapshot.blocks, snapshot);
      setPhase('rendering');
      const items: PageItem[] = [];
      for (const p of renderPages) {
        try {
          const blob = await renderPageToPng(snapshot, p);
          const url = URL.createObjectURL(blob);
          urlsRef.current.push(url);
          items.push({ page: p, url });
          setPages([...items]); // 已成功页不丢失，逐页可见
        } catch (e) {
          // 某页渲染失败：只提示该页，允许重试（第 10.3 节失败与边界）
          setFailedPage(p.pageIndex + 1);
          setError(e instanceof Error ? e.message : '该页生成失败');
          setPages([...items]);
          setPhase(items.length > 0 ? 'done' : 'failed');
          return;
        }
      }
      setPages(items);
      setPhase('done');
    } catch (e) {
      if (e instanceof ExportError) {
        setError(e.message);
      } else {
        setError('生成失败，请重试');
      }
      setPhase('failed');
    }
  };

  const savePage = (item: PageItem) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = `${fileBaseName}-第${item.page.pageIndex + 1}张.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const label = blocked ? '无法导出' : statusKind === 'complete' ? '导出图片' : '导出草稿';

  return (
    <section className={styles.panel} aria-label="图片导出">
      <div className={styles.row}>
        {showTriggerButton ? (
          <button
            type="button"
            className={`${editor.btn} ${editor.primary}`}
            disabled={blocked || phase === 'paginating' || phase === 'rendering'}
            onClick={start}
          >
            {label}
          </button>
        ) : null}
        {phase === 'paginating' ? <span aria-live="polite">正在排版分页…</span> : null}
        {phase === 'rendering' ? <span aria-live="polite">正在生成大字卡…</span> : null}
      </div>

      {blocked ? <p className={styles.hint}>请先完善行程：至少添加一个有效景点，并修正提示的无效内容。</p> : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
          {failedPage !== null ? (
            <button
              type="button"
              className={`${editor.btn} ${editor.small}`}
              style={{ marginLeft: 'var(--sp-3)' }}
              onClick={start}
            >
              重试
            </button>
          ) : null}
        </p>
      ) : null}

      {phase === 'done' && pages.length > 0 ? (
        <>
          <p className={styles.hint} aria-live="polite">
            图片已生成，共 {pages.length} 张。请逐张保存后发到家庭群；浏览器如拦截多文件下载，请逐张点击保存。
          </p>
          <ol className={styles.pageList}>
            {pages.map((item) => (
              <li key={item.page.pageIndex} className={styles.pageItem}>
                <img src={item.url} alt={`路线卡第 ${item.page.pageIndex + 1} 张预览`} className={styles.thumb} />
                <button type="button" className={`${editor.btn} ${editor.small}`} onClick={() => savePage(item)}>
                  保存第 {item.page.pageIndex + 1} 张
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
