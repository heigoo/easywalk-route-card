/**
 * 行程状态与自动保存（第 3.3、8.4 节；Task 6 多行程管理，规格 R-A / M-R01）。
 * 当前行程拥有用户已确认的数据；所有修改经 apply() 进入领域模型并即时保存到当前行程记录。
 * 多行程：列表 / 新建 / 切换 / 复制 / 重命名 / 删除整份行程记录 / 索引重建（纯本机，不引入账号与云端）。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Itinerary } from '../../shared/contracts/domain';
import { computeStats, evaluateConstraints } from '../domain/compute';
import { synthesizeCardStatus } from '../domain/status';
import { createEmptyItinerary, updateBasics } from '../domain/itinerary';
import { computeInputFingerprint } from '../domain/fingerprint';
import { buildCardViewModel } from '../features/route-card/buildViewModel';
import {
  createLocalStore,
  type ItineraryStore,
  type LoadResult,
  type StorageState,
  type TripIndexItem,
} from '../storage/local';

export interface ItineraryController {
  itinerary: Itinerary;
  /** 确认有效修改：更新领域数据、刷新统计、自动保存当前行程（第 8.2 节） */
  apply: (fn: (it: Itinerary) => Itinerary) => void;
  /** 备份导入：整体替换当前行程内容（记录槽位不变，语义仍是“导入替换当前行程”） */
  replace: (it: Itinerary) => void;
  saveState: StorageState;
  saveError: string | null;
  /**
   * corrupt=数据损坏；unsupported=schemaVersion 未识别；
   * indexCorrupt=行程索引损坏（各行程数据保留，可重建）；migrationFailed=旧数据迁移失败（原数据保留）
   */
  loadError: LoadResult['error'];
  /** 清空当前行程内容（区别于删除整份行程记录） */
  resetAll: () => void;
  /** 行程索引列表（面板打开前用 refreshTrips 刷新） */
  trips: TripIndexItem[];
  /** 行程列表相关提示（操作失败 / 重建时跳过的记录） */
  tripsError: string | null;
  refreshTrips: () => void;
  /** 新建行程并切换过去；返回是否成功（面板据此收起） */
  createTrip: () => boolean;
  /** 切换当前行程：先保存当前再切换，保存失败不切换（不丢未保存内容） */
  switchTrip: (id: string) => boolean;
  /** 复制行程（含全部内容的副本、新 id），不改变当前行程 */
  copyTrip: (id: string) => boolean;
  /** 重命名行程（即时生效，无需二次确认） */
  renameTrip: (id: string, title: string) => boolean;
  /** 删除整份行程记录（破坏性操作，调用方须先做二次确认） */
  deleteTrip: (id: string) => boolean;
  /** 重建行程索引（索引损坏后的恢复入口，不清空任何行程数据） */
  rebuildIndex: () => boolean;
}

export function useItinerary(
  store: ItineraryStore = createLocalStore(window.localStorage),
): ItineraryController {
  const [initial] = useState(() => store.load());
  const [itinerary, setItinerary] = useState<Itinerary>(
    () => initial.itinerary ?? createEmptyItinerary(),
  );
  const [saveState, setSaveState] = useState<StorageState>(initial.itinerary ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadResult['error']>(initial.error);
  const [trips, setTrips] = useState<TripIndexItem[]>(initial.items ?? []);
  const [tripsError, setTripsError] = useState<string | null>(null);

  const persist = useCallback(
    (next: Itinerary) => {
      const result = store.save(next);
      if (result.ok) {
        setSaveState('saved');
        setSaveError(null);
      } else {
        // 保存失败：保留内存内容，明确提示（第 8.4 节）
        setSaveState('saveFailed');
        setSaveError(result.error);
      }
    },
    [store],
  );

  const apply = useCallback(
    (fn: (it: Itinerary) => Itinerary) => {
      setItinerary((prev) => {
        const next = fn(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const replace = useCallback(
    (it: Itinerary) => {
      // 备份导入语义不变：整体替换当前行程内容；记录槽位（id）保持当前行程，
      // 避免导入文件 id 与其它行程冲突时覆盖别的行程数据
      const next = { ...it, id: itinerary.id };
      setItinerary(next);
      persist(next);
    },
    [itinerary.id, persist],
  );

  /**
   * 清空当前行程内容（既有 resetAll 语义，区别于行程面板“删除整份行程记录”）：
   * 当前行程记录回到空行程，记录槽位保留，磁盘与内存一致（重载不复活旧内容）。
   */
  const resetAll = useCallback(() => {
    const fresh = { ...createEmptyItinerary(), id: itinerary.id };
    setItinerary(fresh);
    persist(fresh);
  }, [itinerary.id, persist]);

  const refreshTrips = useCallback(() => {
    const result = store.listTrips();
    if (result.ok) {
      setTrips(result.items);
    } else {
      setTripsError(
        result.error === 'indexCorrupt'
          ? '行程索引损坏，各行程数据仍保留，可点击“重建行程索引”恢复'
          : result.error === 'unsupported'
            ? '行程索引版本不识别，未覆盖原内容'
            : '无法读取本机存储中的行程列表',
      );
    }
  }, [store]);

  /**
   * 切换/新建前保存当前行程（不丢未保存内容）。
   * 自动保存下仅上次保存失败时才可能有未保存内容，重试失败则中止后续操作并提示。
   */
  const flushCurrent = useCallback((): boolean => {
    if (saveState !== 'saveFailed') return true;
    const result = store.save(itinerary);
    if (!result.ok) {
      setSaveState('saveFailed');
      setSaveError(result.error);
      setTripsError('当前行程暂时无法保存，已保留未保存内容，本次操作未执行');
      return false;
    }
    setSaveState('saved');
    setSaveError(null);
    return true;
  }, [saveState, store, itinerary]);

  const createTrip = useCallback((): boolean => {
    if (!flushCurrent()) return false;
    const fresh = createEmptyItinerary();
    const result = store.save(fresh);
    if (!result.ok) {
      setSaveState('saveFailed');
      setSaveError(result.error);
      return false;
    }
    setItinerary(fresh);
    setSaveState('saved');
    setSaveError(null);
    setTripsError(null);
    refreshTrips();
    return true;
  }, [flushCurrent, store, refreshTrips]);

  const switchTrip = useCallback(
    (id: string): boolean => {
      if (id === itinerary.id) return true;
      // 先保存当前再切换；保存失败不切换（不丢未保存内容）
      if (!flushCurrent()) return false;
      const result = store.switchTo(id);
      if (!result.ok) {
        setTripsError(`切换失败：${result.error}`);
        return false;
      }
      setItinerary(result.itinerary);
      setSaveState('saved');
      setSaveError(null);
      setTrips(result.items);
      setTripsError(null);
      return true;
    },
    [flushCurrent, itinerary.id, store],
  );

  const copyTrip = useCallback(
    (id: string): boolean => {
      // 复制当前行程时以内存内容为准（含尚未落盘的编辑），副本新 id、内容一致
      const result = store.copyTrip(id, id === itinerary.id ? itinerary : undefined);
      if (!result.ok) {
        setTripsError(`复制失败：${result.error}`);
        return false;
      }
      setTrips(result.items);
      setTripsError(null);
      return true;
    },
    [store, itinerary],
  );

  const renameTrip = useCallback(
    (id: string, title: string): boolean => {
      if (id === itinerary.id) {
        // 当前行程：与编辑器“行程名称”同口径（updateBasics＋自动保存），即时生效。
        // 这里同步保存后再刷新列表（apply 的持久化发生在状态更新器内，晚于随后的读取）
        const next = updateBasics(itinerary, { title });
        setItinerary(next);
        persist(next);
        refreshTrips();
        return true;
      }
      const result = store.renameTrip(id, title);
      if (!result.ok) {
        setTripsError(`重命名失败：${result.error}`);
        return false;
      }
      setTrips(result.items);
      setTripsError(null);
      return true;
    },
    [itinerary, persist, refreshTrips, store],
  );

  const deleteTrip = useCallback(
    (id: string): boolean => {
      const result = store.deleteTrip(id);
      if (!result.ok) {
        setTripsError(`删除失败：${result.error}`);
        return false;
      }
      setTrips(result.items);
      setTripsError(null);
      if (id === itinerary.id) {
        // 删除当前行程后自动切到另一条；没有其它行程则进入空行程编辑（新建入口保留）
        const next = result.items[0] ?? null;
        const loaded = next ? store.loadTrip(next.id) : null;
        if (loaded && loaded.ok && loaded.itinerary) {
          setItinerary(loaded.itinerary);
          setSaveState('saved');
          setSaveError(null);
        } else {
          setItinerary(createEmptyItinerary());
          setSaveState('idle');
          setSaveError(null);
        }
      }
      return true;
    },
    [store, itinerary.id],
  );

  const rebuildIndex = useCallback((): boolean => {
    const result = store.rebuildIndex();
    if (!result.ok) {
      setTripsError(`重建索引失败：${result.error}`);
      return false;
    }
    setTrips(result.items);
    setTripsError(
      result.skippedIds.length > 0
        ? `已重建索引，但有 ${result.skippedIds.length} 条行程数据无法读取，其原数据仍保留在本机`
        : null,
    );
    // 重建成功后清除“索引损坏”提示；其它载入错误语义保持不变
    setLoadError((prev) => (prev === 'indexCorrupt' ? null : prev));
    return true;
  }, [store]);

  return {
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
  };
}

/** 派生的统计、判定、卡片状态与视图模型（第 8.2 节状态转换） */
export function useItineraryDerived(itinerary: Itinerary) {
  const stats = useMemo(() => computeStats(itinerary), [itinerary]);
  const verdicts = useMemo(() => evaluateConstraints(itinerary, stats), [itinerary, stats]);
  const cardStatus = useMemo(
    () => synthesizeCardStatus(itinerary, stats, verdicts),
    [itinerary, stats, verdicts],
  );
  const fingerprint = useMemo(() => computeInputFingerprint(itinerary), [itinerary]);
  const cardViewModel = useMemo(
    () => buildCardViewModel({ itinerary, stats, verdicts, status: cardStatus }),
    [itinerary, stats, verdicts, cardStatus],
  );
  return { stats, verdicts, cardStatus, fingerprint, cardViewModel };
}

/** 导出快照：冻结当前已应用行程的 VM 实例（第 10.1 节第 2 步） */
export function useSnapshotRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
