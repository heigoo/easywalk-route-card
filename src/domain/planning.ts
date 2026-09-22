/**
 * 规划候选的应用（第 6.5、8.2、8.3 节）。
 * 候选只提供顺序与所采用的边；应用时：
 * - 按候选顺序重排活动节点，未被候选保留的节点（省略的可选景点、已跳过节点）追加在后并保留资料；
 * - 重建路段身份（端点变化的路段回到待获取，不沿用旧时间）；
 * - 把候选采用的边按会话内地图值写入对应路段（未采纳值不落盘，第 8.5 节）。
 * 注意：本函数不修改跳过状态、不删除节点；应用前须由调用方校验输入指纹一致。
 */
import type { Itinerary, Leg } from '../../shared/contracts/domain';
import { deriveEffectiveWalkSeconds, rebuildLegs, touchItinerary } from './itinerary';

/** 会话内可用的地图边值（来自本次矩阵响应） */
export interface MatrixEdgeValue {
  fromNodeId: string;
  toNodeId: string;
  distanceMeters: number | null;
  rawWalkingSeconds: number | null;
  provider: string;
  providerApiVersion: string | null;
  fetchedAt: string;
  state: 'ready' | 'unreachable';
}

export interface ApplicableCandidate {
  nodeOrder: string[];
  adoptedLegKeys: string[];
}

export function edgeKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}|${toNodeId}`;
}

export function applyPlannerCandidate(
  it: Itinerary,
  candidate: ApplicableCandidate,
  edgeValues: MatrixEdgeValue[],
): Itinerary {
  const inCandidate = new Set(candidate.nodeOrder);
  // 候选未包含的节点：省略的可选景点与已跳过节点，保持原有相对顺序追加在后
  const leftovers = it.nodeOrder.filter((id) => !inCandidate.has(id));
  const reorderedNodes = candidate.nodeOrder.filter((id) => Boolean(it.nodes[id]));
  const nodeOrder = [...reorderedNodes, ...leftovers];

  let next: Itinerary = rebuildLegs({ ...it, nodeOrder });
  next = applySessionEdges(next, candidate.adoptedLegKeys, edgeValues);
  return touchItinerary(next);
}

/** 只对候选采用的边写入会话内地图值；已采纳路段不被覆盖（第 8.5 节） */
function applySessionEdges(
  it: Itinerary,
  adoptedLegKeys: string[],
  edgeValues: MatrixEdgeValue[],
): Itinerary {
  const keys = new Set(adoptedLegKeys);
  const byKey = new Map(edgeValues.map((e) => [edgeKey(e.fromNodeId, e.toNodeId), e]));
  const legs: Record<string, Leg> = {};
  for (const [id, leg] of Object.entries(it.legs)) {
    const key = edgeKey(leg.fromNodeId, leg.toNodeId);
    const edge = byKey.get(key);
    if (!keys.has(key) || !edge || leg.durationSource === 'adopted' || leg.durationSource === 'same-entrance') {
      legs[id] = leg;
      continue;
    }
    if (edge.state === 'unreachable') {
      legs[id] = {
        ...leg,
        state: 'unreachable',
        failureCode: 'ROUTE_UNREACHABLE',
        fetchedAt: edge.fetchedAt,
        provider: edge.provider,
        providerApiVersion: edge.providerApiVersion,
      };
      continue;
    }
    const effective = deriveEffectiveWalkSeconds(edge.rawWalkingSeconds, it);
    legs[id] = {
      ...leg,
      state: 'ready',
      failureCode: null,
      mode: 'walking',
      distanceMeters: edge.distanceMeters,
      rawWalkingSeconds: edge.rawWalkingSeconds,
      effectiveWalkingSeconds: effective,
      totalTravelSeconds: effective,
      durationSource: 'amap',
      fetchedAt: edge.fetchedAt,
      provider: edge.provider,
      providerApiVersion: edge.providerApiVersion,
    };
  }
  return { ...it, legs };
}