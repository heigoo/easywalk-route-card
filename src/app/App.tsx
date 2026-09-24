/**
 * 应用壳与视图切换（第 3.2 节、需求 4.1、13.8）：
 * 手机/平板单列＋编辑预览切换；≥1024px 双列（编辑＋360px 预览）。
 * Task 6：顶栏行程切换器 → 行程列表面板（新建/切换/复制/重命名/删除整份行程记录/重建索引）。
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
import { FestivalOverlay } from '../features/festival/FestivalOverlay';
import { festiveFeatures } from '../features/festival/festival';
import { addVisitNode, setEndpoint, upsertPlace } from '../domain/itinerary';
import { safeFileName } from '../domain/format';
import { Dialog } from '../components/Dialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { TripIndexItem } from '../storage/local';
import styles from './App.module.css';

type View = 'edit' | 'preview';

/** 面板内更新时间展示：ISO 时间转“YYYY-MM-DD HH:mm” */
function formatUpdatedAt(iso: string): string {
  return iso.includes('T') ? iso.replace('T', ' ').slice(0, 16) : iso;
}

/** 行程显示名：空标题＝未命名行程 */
function tripNameOf(item: Pick<TripIndexItem, 'title'>): string {
  return item.title.trim() || '未命名行程';
}

export function App() {
  const controller = useItinerary();
  const {
    itinerary,
    apply,
    replace,
    saveState,
    saveError,
    loadError,
    resetAll,
    trips,
    tripsError,
    refreshTrips,
    createTrip,
    switchTrip,
    copyTrip,
    renameTrip,
    deleteTrip,
    rebuildIndex,
  } = controller;
  const { stats, cardStatus, cardViewModel } = useItineraryDerived(itinerary);
  const isWide = useIsWide();
  const [view, setView] = useState<View>('edit');

  // 行程列表面板（Task 6）：重命名行内编辑、删除二次确认
  const [tripsOpen, setTripsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<TripIndexItem | null>(null);

  const openTrips = useCallback(() => {
    refreshTrips();
    setRenamingId(null);
    setTripsOpen(true);
  }, [refreshTrips]);

  const closeTrips = useCallback(() => {
    setTripsOpen(false);
    setRenamingId(null);
  }, []);

  const handleCreateTrip = useCallback(() => {
    if (createTrip()) closeTrips();
  }, [createTrip, closeTrips]);

  const handleSwitchTrip = useCallback(
    (id: string) => {
      if (switchTrip(id)) closeTrips();
    },
    [switchTrip, closeTrips],
  );

  const commitRename = useCallback(
    (id: string) => {
      if (renameTrip(id, renameValue)) setRenamingId(null);
    },
    [renameTrip, renameValue],
  );

  const confirmDeleteTrip = useCallback(() => {
    if (deleting) deleteTrip(deleting.id);
    setDeleting(null);
  }, [deleting, deleteTrip]);

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

  // 节庆动画（中秋·国庆）：节令窗口内默认开启，顶栏可手动开关；导出成功放烟花
  const [festiveOn, setFestiveOn] = useState(() => festiveFeatures(new Date()).moon || festiveFeatures(new Date()).flags);
  const [celebrateSignal, setCelebrateSignal] = useState(0);

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
        onExported={() => setCelebrateSignal((n) => n + 1)}
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
        <div className={styles.headerSide}>
          <div className={styles.saveState} role="status" aria-live="polite">
            {loadError === 'corrupt' ? (
              <span className={styles.saveError}>本地数据损坏，已为你开启新行程</span>
            ) : loadError === 'unsupported' ? (
              <span className={styles.saveError}>本地数据版本不识别，未覆盖原内容</span>
            ) : loadError === 'indexCorrupt' ? (
              <span className={styles.saveError}>行程列表已损坏，各行程数据仍保留，可在行程列表中修复</span>
            ) : loadError === 'migrationFailed' ? (
              <span className={styles.saveError}>旧数据迁移未完成，原数据已保留，请重试</span>
            ) : saveError ? (
              <span className={styles.saveError}>{saveLabel}</span>
            ) : (
              <span>{saveLabel}</span>
            )}
          </div>
          <button
            type="button"
            className={styles.tripSwitcherBtn}
            onClick={openTrips}
            aria-label="行程列表"
            title="打开行程列表"
          >
            行程：{tripNameOf(itinerary)}
          </button>
          <button
            type="button"
            className={styles.festToggleBtn}
            onClick={() => setFestiveOn((v) => !v)}
            aria-pressed={festiveOn}
            title={festiveOn ? '关闭节庆动画' : '开启节庆动画'}
          >
            {festiveOn ? '🎑 节庆动画开' : '节庆动画关'}
          </button>
        </div>
      </header>

      {!isWide ? (
        <nav className={styles.tabs} aria-label="视图切换">
          <button
            type="button"
            className={`${styles.tab} ${view === 'edit' ? styles.active : ''}`}
            onClick={() => setView('edit')}
            aria-pressed={view === 'edit'}
          >
            编辑行程
          </button>
          <button
            type="button"
            className={`${styles.tab} ${view === 'preview' ? styles.active : ''}`}
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

      {/* 行程列表面板（Task 6）：稳定 role/名称，便于 e2e 定位 */}
      <Dialog
        open={tripsOpen}
        onOpenChange={(open) => (open ? setTripsOpen(true) : closeTrips())}
        title="行程列表"
        description="可新建、切换、复制、重命名或删除行程；删除整份行程记录需二次确认，区别于“清空行程内容”。"
      >
        <div className={styles.tripPanel}>
          <div className={styles.tripToolbar}>
            <button type="button" className={styles.tripPrimaryBtn} onClick={handleCreateTrip}>
              新建行程
            </button>
            <button type="button" className={styles.tripBtn} onClick={rebuildIndex}>
              修复行程列表
            </button>
          </div>
          {tripsError ? (
            <div className={styles.tripNotice} role="alert">
              {tripsError}
            </div>
          ) : null}
          {trips.length === 0 ? (
            <p className={styles.tripEmpty}>还没有保存的行程，点击“新建行程”开始。</p>
          ) : (
            <ul className={styles.tripList} aria-label="全部行程">
              {trips.map((item) => {
                const isCurrent = item.id === itinerary.id;
                const name = tripNameOf(item);
                return (
                  <li key={item.id} className={styles.tripRow} data-trip-id={item.id}>
                    <div className={styles.tripRowMain}>
                      <span className={styles.tripName}>{name}</span>
                      {isCurrent ? <span className={styles.tripCurrentTag}>（当前行程）</span> : null}
                    </div>
                    <div className={styles.tripMeta}>
                      出游日期：{item.travelDate ?? '未定'} · 更新于 {formatUpdatedAt(item.updatedAt)}
                    </div>
                    {renamingId === item.id ? (
                      <div className={styles.renameRow}>
                        <label className={styles.renameLabel} htmlFor={`rename-${item.id}`}>
                          新行程名称
                        </label>
                        <input
                          id={`rename-${item.id}`}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(item.id);
                          }}
                        />
                        <button type="button" className={styles.tripBtn} onClick={() => commitRename(item.id)}>
                          保存名称
                        </button>
                        <button type="button" className={styles.tripBtn} onClick={() => setRenamingId(null)}>
                          取消重命名
                        </button>
                      </div>
                    ) : (
                      <div className={styles.tripActions}>
                        <button
                          type="button"
                          className={styles.tripBtn}
                          aria-label={`切换到 ${name}`}
                          onClick={() => handleSwitchTrip(item.id)}
                        >
                          切换
                        </button>
                        <button
                          type="button"
                          className={styles.tripBtn}
                          aria-label={`复制 ${name}`}
                          onClick={() => copyTrip(item.id)}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className={styles.tripBtn}
                          aria-label={`重命名 ${name}`}
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameValue(item.title);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className={`${styles.tripBtn} ${styles.tripDanger}`}
                          aria-label={`删除 ${name}`}
                          onClick={() => setDeleting(item)}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Dialog>

      {/* 删除整份行程记录：二次确认且对象明确（区别于 TripEditor 的“清空内容”） */}
      <ConfirmDialog
        open={deleting !== null}
        title="删除整份行程记录？"
        description={`将删除整份行程记录《${deleting ? tripNameOf(deleting) : ''}》，此操作不可恢复。`}
        confirmText="确认删除"
        danger
        onConfirm={confirmDeleteTrip}
        onCancel={() => setDeleting(null)}
      />

      {/* 节庆动画层（中秋·国庆）：纯视觉覆盖，不拦截交互、不进入导出画面 */}
      <FestivalOverlay enabled={festiveOn} celebrateSignal={celebrateSignal} />
    </div>
  );
}
