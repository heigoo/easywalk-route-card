/**
 * 单一行程状态与自动保存（第 3.3、8.4 节）。
 * 行程状态拥有用户已确认的数据；所有修改经 apply() 进入领域模型并即时保存。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Itinerary } from '../../shared/contracts/domain';
import { computeStats, evaluateConstraints } from '../domain/compute';
import { synthesizeCardStatus } from '../domain/status';
import { createEmptyItinerary } from '../domain/itinerary';
import { computeInputFingerprint } from '../domain/fingerprint';
import { buildCardViewModel } from '../features/route-card/buildViewModel';
import { createLocalStore, type ItineraryStore, type StorageState } from '../storage/local';

export interface ItineraryController {
  itinerary: Itinerary;
  /** 确认有效修改：更新领域数据、刷新统计、自动保存（第 8.2 节） */
  apply: (fn: (it: Itinerary) => Itinerary) => void;
  replace: (it: Itinerary) => void;
  saveState: StorageState;
  saveError: string | null;
  loadError: 'corrupt' | 'unsupported' | null;
  resetAll: () => void;
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
      setItinerary(it);
      persist(it);
    },
    [persist],
  );

  const resetAll = useCallback(() => {
    store.clear();
    const fresh = createEmptyItinerary();
    setItinerary(fresh);
    setSaveState('idle');
    setSaveError(null);
  }, [store]);

  return {
    itinerary,
    apply,
    replace,
    saveState,
    saveError,
    loadError: initial.error,
    resetAll,
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
