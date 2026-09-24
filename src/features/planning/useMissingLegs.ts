/**
 * 跳站/重排/转休息点后的缺失路段自动补全（R07 V1.1）。
 * - 只对当前有效序列上新增/仍缺失且两端坐标齐全的有向边发矩阵请求；
 * - 请求关联：requestId + 边集合指纹，乱序/过期响应不覆盖新结果（第 8.2 节）；
 * - 不覆盖未变路段（applyMatrixEdges 按路段身份匹配，已采纳值不被静默覆盖）；
 * - 失败保持 missing 并保留持久提示，由用户手动“补全步行数据”重试。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Itinerary } from '../../../shared/contracts/domain';
import { computeInputFingerprint } from '../../domain/fingerprint';
import {
  collectPendingLegs,
  markLegsFetchFailed,
  markLegsFetching,
  type PendingLegsReport,
} from '../../domain/pendingLegs';
import { applyMatrixEdges } from '../../domain/itinerary';
import { ApiRequestError, fetchWalkingMatrix, type MatrixNodeInput } from '../../services/api';

export interface MissingLegsState {
  /** 有效序列上待补充（missing|stale）的路段数 */
  pendingCount: number;
  /** 其中可自动/手动补全的路段数 */
  fetchableCount: number;
  /** 缺坐标地点名 */
  missingPlaceNames: string[];
  busy: boolean;
  /** 上次补全失败的持久提示；成功或无需补全时为 null */
  error: { code: string; message: string; retryable: boolean } | null;
  /** 手动触发补全（自动失败后重试、或打开编辑区时补齐） */
  refetch: () => void;
}

function requestSignature(edges: PendingLegsReport['fetchable']): string {
  return edges
    .map((e) => `${e.legId}:${e.fromCoordinateRevision}:${e.toCoordinateRevision}`)
    .sort()
    .join(',');
}

export function useMissingLegs(
  itinerary: Itinerary,
  onApply: (fn: (it: Itinerary) => Itinerary) => void,
): MissingLegsState {
  const report = useMemo(() => collectPendingLegs(itinerary), [itinerary]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MissingLegsState['error']>(null);
  const requestIdRef = useRef(0);
  const inFlightKeyRef = useRef<string | null>(null);
  /** 已自动尝试过的边集合：失败后不自动轰炸，等手动重试或集合变化 */
  const attemptedKeyRef = useRef<string | null>(null);

  const runFetch = useCallback(
    async (edges: PendingLegsReport['fetchable'], opts: { manual: boolean }) => {
      if (edges.length === 0) return;
      const key = requestSignature(edges);
      if (inFlightKeyRef.current === key) return;
      if (!opts.manual && attemptedKeyRef.current === key) return;

      const myRequest = requestIdRef.current + 1;
      requestIdRef.current = myRequest;
      inFlightKeyRef.current = key;
      attemptedKeyRef.current = key;
      setBusy(true);
      if (opts.manual) setError(null);

      const legIds = edges.map((e) => e.legId);
      onApply((it) => markLegsFetching(it, legIds));

      const nodeById = new Map<string, MatrixNodeInput>();
      for (const e of edges) {
        if (!nodeById.has(e.fromNodeId)) {
          nodeById.set(e.fromNodeId, {
            id: e.fromNodeId,
            placeId: e.fromPlaceId,
            longitude: e.fromLocation.longitude,
            latitude: e.fromLocation.latitude,
            coordinateRevision: e.fromCoordinateRevision,
          });
        }
        if (!nodeById.has(e.toNodeId)) {
          nodeById.set(e.toNodeId, {
            id: e.toNodeId,
            placeId: e.toPlaceId,
            longitude: e.toLocation.longitude,
            latitude: e.toLocation.latitude,
            coordinateRevision: e.toCoordinateRevision,
          });
        }
      }

      try {
        const matrix = await fetchWalkingMatrix({
          requestId: `pending-legs-${myRequest}`,
          inputFingerprint: `${computeInputFingerprint(itinerary)}|${key}`,
          nodes: [...nodeById.values()],
          pairs: edges.map((e) => ({ fromId: e.fromNodeId, toId: e.toNodeId })),
        });
        if (requestIdRef.current !== myRequest) return;

        if (!matrix || !Array.isArray(matrix.edges)) {
          onApply((it) => markLegsFetchFailed(it, legIds));
          setError({
            code: 'PENDING_LEGS_FAILED',
            message: '步行数据响应不完整，路段仍待补充',
            retryable: true,
          });
          return;
        }

        onApply((it) =>
          applyMatrixEdges(
            it,
            matrix.edges.map((e) => ({
              fromNodeId: e.fromId,
              toNodeId: e.toId,
              fromCoordinateRevision: e.fromCoordinateRevision,
              toCoordinateRevision: e.toCoordinateRevision,
              distanceMeters: e.distanceMeters,
              rawWalkingSeconds: e.rawWalkingSeconds,
              provider: e.provider,
              providerApiVersion: e.providerApiVersion,
              fetchedAt: e.fetchedAt,
              state: e.state,
              reportedFeatures: e.reportedFeatures,
            })),
          ),
        );

        if (matrix.failures.length > 0) {
          const failedIds = edges
            .filter((e) => matrix.failures.some((f) => f.fromId === e.fromNodeId && f.toId === e.toNodeId))
            .map((e) => e.legId);
          if (failedIds.length > 0) onApply((it) => markLegsFetchFailed(it, failedIds));
          setError({
            code: 'PARTIAL_PENDING_LEGS',
            message: `有 ${failedIds.length} 段步行数据获取失败，已保持待补充，可手动重试`,
            retryable: true,
          });
        } else if (matrix.queryCoverage !== 'complete') {
          setError({
            code: 'PARTIAL_PENDING_LEGS',
            message: '步行数据不完整，相关路段仍待补充，可手动重试',
            retryable: true,
          });
        } else {
          setError(null);
        }
      } catch (e) {
        if (requestIdRef.current !== myRequest) return;
        onApply((it) => markLegsFetchFailed(it, legIds));
        if (e instanceof ApiRequestError) {
          setError({
            code: e.code,
            message: e.code === 'AMAP_NOT_CONFIGURED' ? e.message : `${e.message}，路段仍待补充`,
            retryable: e.retryable || e.code !== 'AMAP_NOT_CONFIGURED',
          });
        } else {
          const message = e instanceof Error ? e.message : '获取步行数据失败';
          const cancelled = /CANCELLED/.test(message);
          if (!cancelled) {
            setError({ code: 'PENDING_LEGS_FAILED', message: `${message}，路段仍待补充`, retryable: true });
          }
        }
      } finally {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = null;
        if (requestIdRef.current === myRequest) setBusy(false);
      }
    },
    [itinerary, onApply],
  );

  const fetchKey = requestSignature(report.fetchable);

  // 新增缺失边（跳站/重排/转休息点/改坐标）后自动补全；同一集合失败不自动重试
  useEffect(() => {
    if (report.fetchable.length === 0) {
      attemptedKeyRef.current = null;
      return;
    }
    void runFetch(report.fetchable, { manual: false });
  }, [fetchKey, report.fetchable, runFetch]);

  const refetch = useCallback(() => {
    const current = collectPendingLegs(itinerary);
    if (current.fetchable.length === 0) return;
    attemptedKeyRef.current = null;
    void runFetch(current.fetchable, { manual: true });
  }, [itinerary, runFetch]);

  return {
    pendingCount: report.pendingCount,
    fetchableCount: report.fetchable.length,
    missingPlaceNames: report.missingPlaceNames,
    busy,
    error,
    refetch,
  };
}
