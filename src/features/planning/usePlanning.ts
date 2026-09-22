/**
 * 规划与地图数据的状态编排（第 8.2、14.5 节）。
 * - 请求开始记录 requestId 与 fingerprint；响应必须同时匹配当前请求与输入才能进入可应用状态；
 * - 新请求或取消后，旧响应只可被丢弃，不得覆盖当前结果；
 * - 数据请求状态（idle/loading/partial/success/failed/cancelled）与路线内容状态分离（第 8.1 节）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Itinerary } from '../../../shared/contracts/domain';
import { activeSequence } from '../../../shared/contracts/domain';
import { computeInputFingerprint } from '../../domain/fingerprint';
import { applyPlannerCandidate, edgeKey, type MatrixEdgeValue } from '../../domain/planning';
import { ApiRequestError, fetchWalkingMatrix, type MatrixNodeInput } from '../../services/api';
import { createPlannerClient, type PlannerCandidate, type PlannerResult } from '../../workers';
import { listCandidatePairs } from '../../workers/planner';

export type RequestPhase = 'idle' | 'loading' | 'partial' | 'success' | 'failed' | 'cancelled';

export interface PlanningState {
  phase: RequestPhase;
  /** 与实际进度一致的阶段说明，不伪造百分比（第 7.4 节） */
  stageText: string;
  error: { code: string; message: string; retryable: boolean } | null;
  result: PlannerResult | null;
  /**
   * 计算该结果时的行程输入指纹（第 8.2 节）。
   * 规划结果内部指纹还包含地图边数据，故此处单独记录行程指纹用于过期判断。
   */
  requestFingerprint: string | null;
  coverage: 'complete' | 'partial' | 'failed' | null;
  edgeValues: MatrixEdgeValue[];
  missingDataNotes: string[];
}

const INITIAL: PlanningState = {
  phase: 'idle',
  stageText: '',
  error: null,
  result: null,
  requestFingerprint: null,
  coverage: null,
  edgeValues: [],
  missingDataNotes: [],
};

export interface UsePlanningResult extends PlanningState {
  busy: boolean;
  /** 结果是否因行程修改而过期（第 14.5 节第 3 条） */
  stale: boolean;
  canApply: (candidate: PlannerCandidate) => boolean;
  run: () => Promise<void>;
  cancel: () => void;
  applyCandidate: (candidate: PlannerCandidate) => void;
  clear: () => void;
}

export function usePlanning(
  itinerary: Itinerary,
  onApply: (fn: (it: Itinerary) => Itinerary) => void,
): UsePlanningResult {
  const [state, setState] = useState<PlanningState>(INITIAL);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const clientRef = useRef<ReturnType<typeof createPlannerClient> | null>(null);
  const fingerprint = useMemo(() => computeInputFingerprint(itinerary), [itinerary]);

  if (!clientRef.current && typeof Worker !== 'undefined') {
    clientRef.current = createPlannerClient();
  }

  useEffect(
    () => () => {
      abortRef.current?.abort();
      clientRef.current?.cancel();
      clientRef.current = null;
    },
    [],
  );

  /** 组装矩阵请求节点（仅确认坐标的节点；缺坐标的计入缺失说明） */
  const buildRequest = useCallback(() => {
    const seq = activeSequence(itinerary);
    const nodes: MatrixNodeInput[] = [];
    const missing: string[] = [];
    for (const id of seq) {
      const placeId =
        itinerary.origin?.id === id
          ? itinerary.origin.placeId
          : itinerary.destination?.id === id
            ? itinerary.destination.placeId
            : itinerary.nodes[id]?.placeId;
      const place = placeId ? itinerary.places[placeId] : undefined;
      if (!place?.location) {
        missing.push(place?.name ?? '有地点缺少坐标');
        continue;
      }
      nodes.push({
        id,
        placeId: place.id,
        longitude: place.location.longitude,
        latitude: place.location.latitude,
        coordinateRevision: place.coordinateRevision,
      });
    }
    const pairs = listCandidatePairs(itinerary)
      .map((p) => ({ fromId: p.from, toId: p.to }))
      .filter((p) => nodes.some((n) => n.id === p.fromId) && nodes.some((n) => n.id === p.toId));
    return { nodes, pairs, missing };
  }, [itinerary]);

  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clientRef.current?.cancel();
    clientRef.current = null;
    setState((prev) => (prev.phase === 'loading' ? { ...prev, phase: 'cancelled', stageText: '已取消，原行程未改变' } : prev));
  }, []);

  const run = useCallback(async () => {
    const myRequest = requestIdRef.current + 1;
    requestIdRef.current = myRequest;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const { nodes, pairs, missing } = buildRequest();
    if (nodes.length < 2 || pairs.length === 0) {
      setState({
        ...INITIAL,
        phase: 'failed',
        stageText: '',
        error: {
          code: 'INVALID_INPUT',
          message: missing.length > 0 ? `${missing.join('、')}，请先确认地点坐标` : '至少需要两个已确认坐标的地点',
          retryable: false,
        },
      });
      return;
    }

    setState({
      ...INITIAL,
      phase: 'loading',
      stageText: '正在获取步行数据…',
      requestFingerprint: null,
    });

    try {
      const matrix = await fetchWalkingMatrix(
        { requestId: `mx-${myRequest}`, inputFingerprint: fingerprint, nodes, pairs },
        controller.signal,
      );
      if (requestIdRef.current !== myRequest) return; // 旧响应丢弃（第 8.2 节）

      const edgeValues: MatrixEdgeValue[] = matrix.edges.map((e) => ({
        fromNodeId: e.fromId,
        toNodeId: e.toId,
        distanceMeters: e.distanceMeters,
        rawWalkingSeconds: e.rawWalkingSeconds,
        provider: e.provider,
        providerApiVersion: e.providerApiVersion,
        fetchedAt: e.fetchedAt,
        state: e.state,
        // 地图报告属性（如阶梯）随会话地图值保留，供路段提示与核对入口使用
        reportedFeatures: e.reportedFeatures,
      }));

      const edges: Record<string, number | null> = {};
      for (const e of matrix.edges) {
        edges[edgeKey(e.fromId, e.toId)] = e.state === 'unreachable' ? null : e.rawWalkingSeconds;
      }
      // 明确不可达的边写入 null；未查询/失败的边保持缺失（第 6.6 节）
      const notes: string[] = [];
      if (missing.length > 0) notes.push(`${missing.join('、')}，未纳入本次计算`);
      if (matrix.failures.length > 0) {
        notes.push(`${matrix.failures.length} 段路线数据获取失败，相关方案标为待核验`);
      }
      if (matrix.queryCoverage === 'partial') {
        notes.push('搜索数据不完整，比较范围受限');
      }

      setState((prev) => ({
        ...prev,
        phase: matrix.queryCoverage === 'complete' ? 'loading' : 'partial',
        stageText: '正在比较路线…',
        coverage: matrix.queryCoverage,
        edgeValues,
        missingDataNotes: notes,
      }));

      const client = clientRef.current;
      if (!client) {
        setState((prev) => ({ ...prev, phase: 'failed', error: { code: 'PLAN_FAILED', message: '当前环境不支持后台计算', retryable: false } }));
        return;
      }
      const result = await client.run({ itinerary, edges }, fingerprint);
      if (requestIdRef.current !== myRequest) return;

      setState((prev) => ({
        ...prev,
        phase: 'success',
        stageText: '',
        result,
        // 记录本次计算所用的行程指纹；行程变动后即判为过期，不允许应用
        requestFingerprint: fingerprint,
      }));
    } catch (e) {
      if (requestIdRef.current !== myRequest) return;
      if (e instanceof ApiRequestError) {
        setState((prev) => ({
          ...prev,
          phase: e.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed',
          stageText: e.code === 'REQUEST_CANCELLED' ? '已取消，原行程未改变' : '',
          error: { code: e.code, message: e.message, retryable: e.retryable },
        }));
        return;
      }
      const message = e instanceof Error ? e.message : '规划失败';
      const cancelled = /CANCELLED/.test(message);
      setState((prev) => ({
        ...prev,
        phase: cancelled ? 'cancelled' : 'failed',
        stageText: cancelled ? '已取消，原行程未改变' : '',
        error: cancelled ? null : { code: 'PLAN_FAILED', message, retryable: true },
      }));
    }
  }, [buildRequest, fingerprint, itinerary]);

  const stale = state.requestFingerprint !== null && state.requestFingerprint !== fingerprint;

  const canApply = useCallback(
    (candidate: PlannerCandidate) =>
      // 仅可核验且无已知冲突的候选可作为正式方案；待核验候选只能“作为草稿应用”（第 6.4.6 节）
      !stale && state.result !== null && state.phase !== 'loading' && candidate.verifiable && candidate.violations.length === 0,
    [stale, state.phase, state.result],
  );

  const applyCandidate = useCallback(
    (candidate: PlannerCandidate) => {
      // 应用前再次检查指纹（第 8.2 节）；过期则要求重算
      if (stale) return;
      const edges = state.edgeValues;
      onApply((it) => applyPlannerCandidate(it, candidate, edges));
      setState((prev) => ({ ...prev, result: null, requestFingerprint: null, phase: 'idle', stageText: '' }));
    },
    [onApply, stale, state.edgeValues],
  );

  const clear = useCallback(() => setState(INITIAL), []);

  return {
    ...state,
    busy: state.phase === 'loading',
    stale,
    canApply,
    run,
    cancel,
    applyCandidate,
    clear,
  };
}