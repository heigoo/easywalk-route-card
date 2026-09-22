/**
 * 应用壳与视图切换（第 3.2 节、需求 4.1、13.8）：
 * 手机/平板单列＋编辑预览切换；≥1024px 双列（编辑＋360px 预览）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useItinerary, useItineraryDerived } from './useItinerary';
import { useIsWide } from './useMediaQuery';
import { TripEditor } from '../features/itinerary/TripEditor';
import { PaperPreview } from '../features/route-card/PaperPreview';
import { ExportPanel } from '../features/export/ExportPanel';
import { PlaceSearchPanel } from '../features/places/PlaceSearchPanel';
import { placeFromSearch } from '../features/places/placeFromSearch';
import { PlanningPanel } from '../features/planning/PlanningPanel';
import { usePlanning } from '../features/planning/usePlanning';
import { addVisitNode, setEndpoint, upsertPlace } from '../domain/itinerary';
import { safeFileName } from '../domain/format';
import styles from './App.module.css';

type View = 'edit' | 'preview';

export function App() {
  const controller = useItinerary();
  const { itinerary, apply, replace, saveState, saveError, loadError, resetAll } = controller;
  const { stats, cardStatus, cardViewModel } = useItineraryDerived(itinerary);
  const isWide = useIsWide();
  const [view, setView] = useState<View>('edit');

  /**
   * 输入框仍有焦点时点击按钮：阻止输入框同步失焦。
   * 失焦会立即提交并改变布局（如节点行出现），使 mousedown 后的按钮位移，
   * mouseup 落到别处导致 click 事件不派发（真实用户表现为“按钮点不动”）。
   * 仅在“活动元素为文本输入框 + 目标是按钮”时干预，保留正常的按下反馈。
   */
  const handleRootMouseDown = useCallback((e: React.MouseEvent) => {
    const active = document.activeElement;
    const isTextEntry =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement;
    if (isTextEntry && (e.target as HTMLElement).closest('button')) {
      e.preventDefault();
    }
  }, []);

  // 宽屏强制双列可见；窄屏保留上次视图（断点切换不丢输入，第 13.8 节）
  useEffect(() => {
    if (isWide) setView('edit');
  }, [isWide]);

  const [exportSignal, setExportSignal] = useState(0);

  /** 切到预览：窄屏压入一条历史记录，使浏览器返回键回到编辑视图（第 9.3、13.4 节） */
  const goPreview = useCallback(() => {
    setView('preview');
    if (!isWide) window.history.pushState({ view: 'preview' }, '');
  }, [isWide]);

  const goEdit = useCallback(() => {
    if (!isWide && (window.history.state as { view?: string } | null)?.view === 'preview') {
      window.history.back();
    } else {
      setView('edit');
    }
  }, [isWide]);

  useEffect(() => {
    const onPop = () => setView('edit');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const saveLabel =
    saveState === 'saveFailed'
      ? '暂时无法保存，当前编辑内容仍保留'
      : saveState === 'saved'
        ? '已保存在本机'
        : '';

  const fileBaseName = `${safeFileName(itinerary.title || '未命名行程')}${itinerary.travelDate ? `-${itinerary.travelDate}` : ''}`;

  // P1 自动规划增强：地图候选与约束规划（第 3.2 节）；默认收起，不影响 P0 主流程
  const planning = usePlanning(itinerary, apply);
  const [showPlanner, setShowPlanner] = useState(false);
  const handlePickPlace = useCallback(
    (item: Parameters<typeof placeFromSearch>[0], role: 'visit' | 'origin' | 'destination') => {
      apply((prev) => {
        const place = placeFromSearch(item);
        const withPlace = upsertPlace(prev, place);
        if (role === 'visit') return addVisitNode(withPlace, place.id, { required: true });
        return setEndpoint(withPlace, role, place.id);
      });
    },
    [apply],
  );

  const preview = (
    <div className={`${styles.previewColumn} ${isWide ? '' : styles.previewColumnNarrow}`}>
      <h2 className={styles.columnTitle}>大字路线卡预览</h2>
      {!isWide ? (
        <button type="button" className={styles.backBtn} onClick={goEdit}>
          返回编辑
        </button>
      ) : null}
      <div className={isWide ? '' : styles.previewAreaFullBleed}>
        <PaperPreview vm={cardViewModel} />
      </div>
      <ExportPanel
        vm={cardViewModel}
        statusKind={cardStatus.kind}
        fileBaseName={fileBaseName}
        trigger={exportSignal}
        showTriggerButton={isWide}
      />
    </div>
  );

  const editor = (
    <div className={styles.editorColumn}>
      <TripEditor
        itinerary={itinerary}
        apply={apply}
        stats={stats}
        cardStatus={cardStatus}
        onShowPreview={goPreview}
        onDeleteAll={resetAll}
        onReplaceItinerary={replace}
      />

      <section className={styles.p1Section} aria-label="自动规划增强">
        <div className={styles.p1Header}>
          <h2 className={styles.columnTitle}>自动规划增强</h2>
          <button
            type="button"
            className={styles.p1Toggle}
            onClick={() => setShowPlanner((v) => !v)}
            aria-expanded={showPlanner}
          >
            {showPlanner ? '收起' : '展开'}
          </button>
        </div>
        <p className={styles.p1Hint}>
          采用地图数据比较候选方案；未配置地图服务时，手动整理与导出照常可用。
        </p>
        {showPlanner ? (
          <>
            <PlaceSearchPanel city={itinerary.city} onPick={handlePickPlace} />
            <PlanningPanel itinerary={itinerary} planning={planning} onApply={apply} />
          </>
        ) : null}
      </section>
    </div>
  );

  return (
    <div className={styles.app} onMouseDown={handleRootMouseDown}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>省脚力路线卡</h1>
          <p className={styles.subtitle}>EasyWalk Route Card · 少赶一站，多歇一会</p>
        </div>
        <div className={styles.saveState} role="status" aria-live="polite">
          {loadError === 'corrupt' ? (
            <span className={styles.saveError}>本地数据损坏，已为你开启新行程</span>
          ) : loadError === 'unsupported' ? (
            <span className={styles.saveError}>本地数据版本不识别，未覆盖原内容</span>
          ) : saveError ? (
            <span className={styles.saveError}>{saveLabel}</span>
          ) : (
            <span>{saveLabel}</span>
          )}
        </div>
      </header>

      {!isWide ? (
        <nav className={styles.tabs} aria-label="视图切换">
          <button
            type="button"
            className={`${styles.tab} ${view === 'edit' ? 'active' : ''}`}
            onClick={() => setView('edit')}
            aria-pressed={view === 'edit'}
          >
            编辑行程
          </button>
          <button
            type="button"
            className={`${styles.tab} ${view === 'preview' ? 'active' : ''}`}
            onClick={goPreview}
            aria-pressed={view === 'preview'}
          >
            大字预览
          </button>
        </nav>
      ) : null}

      <main className={isWide ? styles.mainWide : view === 'preview' ? styles.mainPreviewNarrow : styles.mainNarrow}>
        {isWide ? (
          <>
            {editor}
            {preview}
          </>
        ) : view === 'edit' ? (
          editor
        ) : (
          preview
        )}
      </main>

      {!isWide ? (
        <div className={styles.bottomBar}>
          {view === 'edit' ? (
            <button type="button" className={styles.bottomPrimary} onClick={goPreview}>
              预览路线卡
            </button>
          ) : (
            <button
              type="button"
              className={styles.bottomPrimary}
              disabled={cardStatus.kind === 'blocked'}
              onClick={() => setExportSignal((n) => n + 1)}
            >
              {cardStatus.kind === 'blocked' ? '无法导出（请先完善行程）' : cardStatus.kind === 'complete' ? '导出图片' : '导出草稿'}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
