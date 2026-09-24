/**
 * 行程编辑纯函数（第 4.2、8.3、8.5 节）。
 * 所有函数不可变更新：返回新行程对象，调用方负责写回状态与存储。
 * 行程状态拥有用户已确认的数据；局部草稿不进入这里。
 */
import type {
  Endpoint,
  EndpointRole,
  Fact,
  FacilityKind,
  FacilityRecord,
  FacilityTarget,
  Itinerary,
  Leg,
  PlaceRef,
  RestNode,
  RouteNode,
  VisitNode,
} from '../../shared/contracts/domain';
import { SCHEMA_VERSION, coordinateSchema, unknownFact } from '../../shared/contracts/domain';
import { newId } from './id';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export function createEmptyItinerary(now: string = new Date().toISOString()): Itinerary {
  return {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    title: '',
    city: '',
    travelDate: null,
    departureLocalTime: null,
    timezone: DEFAULT_TIMEZONE,
    places: {},
    origin: null,
    destination: null,
    nodes: {},
    nodeOrder: [],
    facilities: [],
    legs: {},
    constraints: {
      maxTotalWalkSeconds: null,
      maxContinuousWalkSeconds: null,
      minRestSeconds: null,
      latestEndLocal: null,
      walkingFactor: 1,
      passageRequirements: [],
    },
    updatedAt: now,
  };
}

/** 确认有效修改：递增 revision 并刷新 updatedAt */
function touch(it: Itinerary, now: string = new Date().toISOString()): Itinerary {
  return { ...it, revision: it.revision + 1, updatedAt: now };
}

export function updateBasics(
  it: Itinerary,
  patch: Partial<Pick<Itinerary, 'title' | 'city' | 'travelDate' | 'departureLocalTime'>>,
): Itinerary {
  return touch({ ...it, ...patch });
}

export function createPlace(name: string): PlaceRef {
  return {
    id: newId(),
    name,
    providerPoiId: null,
    location: null,
    coordinateRevision: 0,
    entranceConfirmed: false,
    openingDescription: unknownFact<string>(),
    openingSchedule: unknownFact(),
  };
}

export function upsertPlace(it: Itinerary, place: PlaceRef): Itinerary {
  return touch({ ...it, places: { ...it.places, [place.id]: place } });
}

/** 修改坐标：坐标版本递增，相关路段随重建失效（第 4.3、8.3 节） */
export function updatePlaceCoordinate(
  it: Itinerary,
  placeId: string,
  location: { longitude: number; latitude: number },
  entranceConfirmed?: boolean,
): Itinerary {
  const place = it.places[placeId];
  if (!place) return it;
  const next: PlaceRef = {
    ...place,
    location,
    coordinateRevision: place.coordinateRevision + 1,
    entranceConfirmed: entranceConfirmed ?? place.entranceConfirmed,
  };
  return rebuildLegs(touch({ ...it, places: { ...it.places, [placeId]: next } }));
}

export function confirmEntrance(it: Itinerary, placeId: string, confirmed: boolean): Itinerary {
  const place = it.places[placeId];
  if (!place) return it;
  return rebuildLegs(
    touch({ ...it, places: { ...it.places, [placeId]: { ...place, entranceConfirmed: confirmed } } }),
  );
}

export function setEndpoint(
  it: Itinerary,
  role: EndpointRole,
  placeId: string | null,
): Itinerary {
  if (placeId === null) {
    return rebuildLegs(touch({ ...it, [role]: null }));
  }
  const endpoint: Endpoint = { id: newId(), placeId, role };
  return rebuildLegs(touch({ ...it, [role]: endpoint }));
}

export function addVisitNode(
  it: Itinerary,
  placeId: string,
  init: Partial<Pick<VisitNode, 'required' | 'visitSeconds' | 'insideWalkSeconds' | 'notes'>> = {},
): Itinerary {
  const node: VisitNode = {
    kind: 'visit',
    id: newId(),
    placeId,
    required: init.required ?? true,
    skipped: false,
    visitSeconds: init.visitSeconds ?? null,
    insideWalkSeconds: init.insideWalkSeconds ?? null,
    activityPlan: null,
    notes: init.notes ?? '',
  };
  const nodes = { ...it.nodes, [node.id]: node };
  const nodeOrder = [...it.nodeOrder, node.id];
  return rebuildLegs(touch({ ...it, nodes, nodeOrder }));
}

export function addRestNode(
  it: Itinerary,
  placeId: string,
  init: Partial<Pick<RestNode, 'restSeconds' | 'notes'>> = {},
): Itinerary {
  const node: RestNode = {
    kind: 'rest',
    id: newId(),
    placeId,
    skipped: false,
    restSeconds: init.restSeconds ?? null,
    seatFact: unknownFact<boolean>(),
    notes: init.notes ?? '',
  };
  const nodes = { ...it.nodes, [node.id]: node };
  const nodeOrder = [...it.nodeOrder, node.id];
  return rebuildLegs(touch({ ...it, nodes, nodeOrder }));
}

/** 候选事实里的坐标值（可选事实键 location）：缺失或非法一律 null，不猜坐标 */
function factCoordinate(value: unknown): { longitude: number; latitude: number } | null {
  const parsed = coordinateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 设施候选一键加入路线（Task 3 / R-B；R03 厕所/休息点绕行必须计入）：
 * - 处理 kind='rest-candidate' | 'toilet' 的设施记录，其余原样返回（与既有编辑函数同风格，不抛错）；
 * - 新建地点：名称取候选 name 事实（缺失→“未命名歇脚点”/“未命名厕所”），坐标取候选 location 事实（缺失→null），
 *   入口未确认、开放事实走 unknownFact（未知不等于没有）；
 * - 新 rest 节点的 seatFact 整份迁移自候选 seat 事实（来源/核对字段原样保留；无 seat 事实→unknownFact）；
 * - 厕所候选的 open 事实随迁到新节点的 toilet 设施记录，不丢开放核对；
 * - 新节点插入 nodeOrder 中 afterNodeId 之后并移除原候选记录，随后 rebuildLegs：
 *   受影响的新路段回到待补充，不沿用旧时间。绕行两段进入既有汇总与歇脚绕行对照。
 */
export function convertFacilityCandidateToRestNode(
  it: Itinerary,
  facilityId: string,
  afterNodeId: string,
  now: string = new Date().toISOString(),
): { itinerary: Itinerary; nodeId: string | null } {
  const record = it.facilities.find((f) => f.id === facilityId);
  if (!record || (record.kind !== 'rest-candidate' && record.kind !== 'toilet')) {
    return { itinerary: it, nodeId: null };
  }
  const facts = record.facts as Record<string, Fact<unknown> | undefined>;

  const rawName = facts.name?.value;
  const fallbackName = record.kind === 'toilet' ? '未命名厕所' : '未命名歇脚点';
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallbackName;
  const place: PlaceRef = { ...createPlace(name), location: factCoordinate(facts.location?.value) };

  // 座位事实整份迁移：不重建、不覆盖来源与核对字段；厕所无 seat 事实时保持未知（未知≠不可坐）
  const seatFact = (facts.seat as RestNode['seatFact'] | undefined) ?? unknownFact<boolean>();
  const node: RestNode = {
    kind: 'rest',
    id: newId(),
    placeId: place.id,
    skipped: false,
    restSeconds: null,
    seatFact,
    notes: '',
  };

  const nodeOrder = [...it.nodeOrder];
  const idx = nodeOrder.indexOf(afterNodeId);
  if (idx >= 0) nodeOrder.splice(idx + 1, 0, node.id);
  else if (it.origin?.id === afterNodeId) nodeOrder.unshift(node.id);
  else nodeOrder.push(node.id);

  // 厕所开放事实随迁到新节点设施；歇脚候选记录移除后不再保留（座位已在 seatFact）
  let facilities = it.facilities.filter((f) => f.id !== facilityId);
  if (record.kind === 'toilet' && facts.open) {
    const toiletRec: FacilityRecord = {
      id: newId(),
      kind: 'toilet',
      placeId: place.id,
      target: { type: 'node', nodeId: node.id },
      facts: { open: facts.open },
      recordKey: record.recordKey ?? null,
    };
    facilities = [...facilities, toiletRec];
  }

  const next = rebuildLegs(
    touch(
      {
        ...it,
        places: { ...it.places, [place.id]: place },
        nodes: { ...it.nodes, [node.id]: node },
        nodeOrder,
        facilities,
      },
      now,
    ),
  );
  return { itinerary: next, nodeId: node.id };
}

/** 兼容名：歇脚候选转休息点（实现已统一走 convertFacilityCandidateToRestNode） */
export function convertRestCandidateToRestNode(
  it: Itinerary,
  facilityId: string,
  afterNodeId: string,
  now: string = new Date().toISOString(),
): { itinerary: Itinerary; nodeId: string | null } {
  return convertFacilityCandidateToRestNode(it, facilityId, afterNodeId, now);
}

export function updateNode(it: Itinerary, nodeId: string, patch: Partial<RouteNode>): Itinerary {
  const node = it.nodes[nodeId];
  if (!node) return it;
  const nodes = { ...it.nodes, [nodeId]: { ...node, ...patch } as RouteNode };
  // 停留/园内步行/休息时长影响统计口径，不影响路段身份，无需重建
  return touch({ ...it, nodes });
}

/** 上移/下移：显式排序操作，不用数组缺失项表示跳过 */
export function moveNode(it: Itinerary, nodeId: string, dir: -1 | 1): Itinerary {
  const idx = it.nodeOrder.indexOf(nodeId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= it.nodeOrder.length) return it;
  const nodeOrder = [...it.nodeOrder];
  [nodeOrder[idx], nodeOrder[target]] = [nodeOrder[target], nodeOrder[idx]];
  return rebuildLegs(touch({ ...it, nodeOrder }));
}

/** 跳过：保留原资料，只改 skipped；新相邻关系的路段回到待获取（第 8.3 节） */
export function skipNode(it: Itinerary, nodeId: string): Itinerary {
  return setSkipped(it, nodeId, true);
}

export function restoreNode(it: Itinerary, nodeId: string): Itinerary {
  return setSkipped(it, nodeId, false);
}

function setSkipped(it: Itinerary, nodeId: string, skipped: boolean): Itinerary {
  const node = it.nodes[nodeId];
  if (!node || node.skipped === skipped) return it;
  const nodes = { ...it.nodes, [nodeId]: { ...node, skipped } };
  return rebuildLegs(touch({ ...it, nodes }));
}

/** 永久删除节点；其专属路段与设施一并清除 */
export function removeNode(it: Itinerary, nodeId: string): Itinerary {
  const node = it.nodes[nodeId];
  if (!node) return it;
  const nodes = { ...it.nodes };
  delete nodes[nodeId];
  const nodeOrder = it.nodeOrder.filter((id) => id !== nodeId);
  const removedLegIds = new Set(
    Object.values(it.legs)
      .filter((l) => l.fromNodeId === nodeId || l.toNodeId === nodeId)
      .map((l) => l.id),
  );
  const legs: Record<string, Leg> = {};
  for (const [id, leg] of Object.entries(it.legs)) {
    if (!removedLegIds.has(id)) legs[id] = leg;
  }
  const facilities = it.facilities.filter(
    (f) => !(f.target.type === 'node' && f.target.nodeId === nodeId) && !(f.target.type === 'leg' && removedLegIds.has(f.target.legId)),
  );
  return rebuildLegs(touch({ ...it, nodes, nodeOrder, legs, facilities }));
}

export function updateConstraints(
  it: Itinerary,
  patch: Partial<Itinerary['constraints']>,
): Itinerary {
  return touch({ ...it, constraints: { ...it.constraints, ...patch } });
}

/** 顺序中每个 id 的地点引用与坐标版本 */
function resolveSeqRef(it: Itinerary, id: string) {
  if (it.origin?.id === id) {
    const place = it.places[it.origin.placeId];
    return place ? { placeId: place.id, coordinateRevision: place.coordinateRevision } : null;
  }
  if (it.destination?.id === id) {
    const place = it.places[it.destination.placeId];
    return place ? { placeId: place.id, coordinateRevision: place.coordinateRevision } : null;
  }
  const node = it.nodes[id];
  if (!node) return null;
  const place = it.places[node.placeId];
  if (!place) return null;
  return { placeId: place.id, coordinateRevision: place.coordinateRevision };
}

function legKey(l: {
  fromNodeId: string;
  toNodeId: string;
  fromPlaceId: string;
  toPlaceId: string;
  fromCoordinateRevision: number;
  toCoordinateRevision: number;
}): string {
  return [
    l.fromNodeId,
    l.toNodeId,
    l.fromPlaceId,
    l.toPlaceId,
    l.fromCoordinateRevision,
    l.toCoordinateRevision,
  ].join('|');
}

/**
 * 路段重建（第 8.3 节）：
 * - 沿用端点身份、地点引用、坐标版本仍匹配的路段（含已采纳路段）；
 * - 其余转为 missing，不用旧时间顶替新路段；
 * - 已确认同一入口的相邻节点生成 same-entrance 零衔接边，不请求高德；
 * - 坐标版本过期的旧身份清除，其上的设施关联一并移除。
 */
export function rebuildLegs(it: Itinerary): Itinerary {
  const seq = activeIdsWithEndpoints(it);
  const byKey = new Map<string, Leg>();
  for (const leg of Object.values(it.legs)) byKey.set(legKey(leg), leg);

  const usedLegIds = new Set<string>();
  const newLegs: Record<string, Leg> = {};

  for (let i = 0; i < seq.length - 1; i++) {
    const fromRef = resolveSeqRef(it, seq[i]);
    const toRef = resolveSeqRef(it, seq[i + 1]);
    if (!fromRef || !toRef) continue;

    const sameConfirmedEntrance =
      fromRef.placeId === toRef.placeId &&
      it.places[fromRef.placeId]?.entranceConfirmed === true;

    if (sameConfirmedEntrance) {
      // 已确认同一入口的零衔接边由领域层生成；先复用已有同身份零边，避免重复
      const key = legKey({
        fromNodeId: seq[i],
        toNodeId: seq[i + 1],
        fromPlaceId: fromRef.placeId,
        toPlaceId: toRef.placeId,
        fromCoordinateRevision: fromRef.coordinateRevision,
        toCoordinateRevision: toRef.coordinateRevision,
      });
      const existingZero = byKey.get(key);
      if (existingZero && existingZero.durationSource === 'same-entrance') {
        newLegs[existingZero.id] = existingZero;
        usedLegIds.add(existingZero.id);
        continue;
      }
      const zero: Leg = {
        id: newId(),
        fromNodeId: seq[i],
        toNodeId: seq[i + 1],
        fromPlaceId: fromRef.placeId,
        toPlaceId: toRef.placeId,
        fromCoordinateRevision: fromRef.coordinateRevision,
        toCoordinateRevision: toRef.coordinateRevision,
        mode: 'walking',
        distanceMeters: 0,
        rawWalkingSeconds: 0,
        effectiveWalkingSeconds: 0,
        totalTravelSeconds: 0,
        durationSource: 'same-entrance',
        adoptedAt: null,
        fetchedAt: null,
        providerApiVersion: null,
        provider: null,
        state: 'ready',
        failureCode: null,
        reportedFeatures: [],
      };
      newLegs[zero.id] = zero;
      usedLegIds.add(zero.id);
      continue;
    }

    const key = legKey({
      fromNodeId: seq[i],
      toNodeId: seq[i + 1],
      fromPlaceId: fromRef.placeId,
      toPlaceId: toRef.placeId,
      fromCoordinateRevision: fromRef.coordinateRevision,
      toCoordinateRevision: toRef.coordinateRevision,
    });
    const existing = byKey.get(key);
    if (existing) {
      newLegs[existing.id] = existing;
      usedLegIds.add(existing.id);
    } else {
      const leg: Leg = {
        id: newId(),
        fromNodeId: seq[i],
        toNodeId: seq[i + 1],
        fromPlaceId: fromRef.placeId,
        toPlaceId: toRef.placeId,
        fromCoordinateRevision: fromRef.coordinateRevision,
        toCoordinateRevision: toRef.coordinateRevision,
        mode: 'walking',
        distanceMeters: null,
        rawWalkingSeconds: null,
        effectiveWalkingSeconds: null,
        totalTravelSeconds: null,
        durationSource: 'manual',
        adoptedAt: null,
        fetchedAt: null,
        providerApiVersion: null,
        provider: null,
        state: 'missing',
        failureCode: null,
        reportedFeatures: [],
      };
      newLegs[leg.id] = leg;
      usedLegIds.add(leg.id);
    }
  }

  // 未被当前序列使用、但坐标版本仍有效的路段（如跳过节点的邻居路段）予以保留；
  // 坐标版本过期的旧身份清除，并把挂在它们上的设施关联移除（第 4.4 节）。
  const keptLegs: Record<string, Leg> = { ...newLegs };
  const removedLegIds = new Set<string>();
  for (const leg of Object.values(it.legs)) {
    if (usedLegIds.has(leg.id)) continue;
    const fromRef = resolveSeqRef(it, leg.fromNodeId);
    const toRef = resolveSeqRef(it, leg.toNodeId);
    const stillValid =
      fromRef &&
      toRef &&
      fromRef.placeId === leg.fromPlaceId &&
      toRef.placeId === leg.toPlaceId &&
      fromRef.coordinateRevision === leg.fromCoordinateRevision &&
      toRef.coordinateRevision === leg.toCoordinateRevision;
    if (stillValid) {
      keptLegs[leg.id] = leg;
    } else {
      removedLegIds.add(leg.id);
    }
  }

  const facilities = it.facilities.filter(
    (f) => !(f.target.type === 'leg' && removedLegIds.has(f.target.legId)),
  );

  return { ...it, legs: keptLegs, facilities };
}

/** 与 activeSequence 一致但保留端点 id（内部使用） */
function activeIdsWithEndpoints(it: Itinerary): string[] {
  const ids: string[] = [];
  if (it.origin) ids.push(it.origin.id);
  for (const id of it.nodeOrder) {
    const n = it.nodes[id];
    if (n && !n.skipped) ids.push(id);
  }
  if (it.destination) ids.push(it.destination.id);
  return ids;
}

/** 手动填写路段耗时（第 4.5 节）：手动值不乘步速因子 */
export function setManualLegTime(
  it: Itinerary,
  legId: string,
  patch: {
    walkingSeconds: number | null;
    totalSeconds?: number | null;
    mode?: Leg['mode'];
    distanceMeters?: number | null;
  },
): Itinerary {
  const leg = it.legs[legId];
  if (!leg) return it;
  const mode = patch.mode ?? leg.mode;
  const walk = patch.walkingSeconds;
  const total =
    patch.totalSeconds !== undefined
      ? patch.totalSeconds
      : mode === 'walking'
        ? walk
        : leg.totalTravelSeconds;
  if (walk !== null && total !== null && total < walk) {
    // 总耗时不得小于步行部分；调用方应先做表单校验，这里防御性拒绝
    return it;
  }
  const next: Leg = {
    ...leg,
    mode,
    distanceMeters: patch.distanceMeters !== undefined ? patch.distanceMeters : leg.distanceMeters,
    rawWalkingSeconds: walk,
    effectiveWalkingSeconds: walk,
    totalTravelSeconds: total,
    durationSource: 'manual',
    state: walk === null ? 'missing' : 'ready',
    failureCode: null,
  };
  return touch({ ...it, legs: { ...it.legs, [legId]: next } });
}

/**
 * 应用地图矩阵结果（第 4.5 节）：
 * 地图基准值存入 rawWalkingSeconds；effective 按当前因子派生。
 * amap 来源值在会话内保留，便于变更因子后重算而不重复累乘。
 */
export function applyMatrixEdges(
  it: Itinerary,
  edges: Array<{
    fromNodeId: string;
    toNodeId: string;
    fromCoordinateRevision: number;
    toCoordinateRevision: number;
    distanceMeters: number | null;
    rawWalkingSeconds: number | null;
    provider: string;
    providerApiVersion: string | null;
    fetchedAt: string;
    state: 'ready' | 'unreachable';
    /** 地图报告属性（如阶梯）；缺失按空处理，不生成“无阶梯”结论 */
    reportedFeatures?: Array<{ kind: string; note: string }>;
  }>,
): Itinerary {
  const legs = { ...it.legs };
  for (const edge of edges) {
    const leg = Object.values(legs).find(
      (l) =>
        l.fromNodeId === edge.fromNodeId &&
        l.toNodeId === edge.toNodeId &&
        l.fromCoordinateRevision === edge.fromCoordinateRevision &&
        l.toCoordinateRevision === edge.toCoordinateRevision,
    );
    if (!leg) continue;
    if (leg.durationSource === 'adopted') {
      // 已采纳路段作为用户数据保留，不被地图值静默覆盖（第 8.5 节）
      continue;
    }
    if (edge.state === 'unreachable') {
      legs[leg.id] = {
        ...leg,
        state: 'unreachable',
        failureCode: 'ROUTE_UNREACHABLE',
        fetchedAt: edge.fetchedAt,
        provider: edge.provider,
        providerApiVersion: edge.providerApiVersion,
        // 不可达边没有可走路线，也就没有地图报告属性
        reportedFeatures: [],
      };
      continue;
    }
    legs[leg.id] = {
      ...leg,
      state: 'ready',
      failureCode: null,
      mode: 'walking',
      distanceMeters: edge.distanceMeters,
      rawWalkingSeconds: edge.rawWalkingSeconds,
      effectiveWalkingSeconds: deriveEffectiveWalkSeconds(edge.rawWalkingSeconds, it),
      totalTravelSeconds: deriveEffectiveWalkSeconds(edge.rawWalkingSeconds, it),
      durationSource: 'amap',
      fetchedAt: edge.fetchedAt,
      provider: edge.provider,
      providerApiVersion: edge.providerApiVersion,
      reportedFeatures: edge.reportedFeatures ?? [],
    };
  }
  return touch({ ...it, legs });
}

/** 步速因子只作用于地图基准步行时间；手动/采纳值不乘（第 4.5 节） */
export function deriveEffectiveWalkSeconds(
  rawWalkingSeconds: number | null,
  it: Pick<Itinerary, 'constraints'>,
): number | null {
  if (rawWalkingSeconds === null) return null;
  return Math.round(rawWalkingSeconds * it.constraints.walkingFactor);
}

/** 变更步速因子后，对所有 amap 来源路段重派生有效值（会话内不重复请求） */
export function applyWalkingFactor(it: Itinerary, factor: number): Itinerary {
  if (!Number.isFinite(factor) || factor <= 0) return it;
  const legs: Record<string, Leg> = {};
  for (const [id, leg] of Object.entries(it.legs)) {
    if (leg.durationSource === 'amap' && leg.rawWalkingSeconds !== null && leg.state === 'ready') {
      const eff = deriveEffectiveWalkSeconds(leg.rawWalkingSeconds, {
        constraints: { ...it.constraints, walkingFactor: factor },
      });
      legs[id] = { ...leg, effectiveWalkingSeconds: eff, totalTravelSeconds: eff };
    } else {
      legs[id] = leg;
    }
  }
  return touch({
    ...it,
    legs,
    constraints: { ...it.constraints, walkingFactor: factor },
  });
}

/**
 * 采纳全部地图路段时间（第 8.5 节）：
 * 显式操作；采纳后 durationSource=adopted，写入 adoptedAt，随行程持久化，可离线查看。
 */
export function adoptAllMapLegs(it: Itinerary, now: string = new Date().toISOString()): {
  itinerary: Itinerary;
  adoptedCount: number;
} {
  const legs: Record<string, Leg> = {};
  let adoptedCount = 0;
  for (const [id, leg] of Object.entries(it.legs)) {
    if (leg.durationSource === 'amap' && leg.state === 'ready' && leg.effectiveWalkingSeconds !== null) {
      legs[id] = {
        ...leg,
        durationSource: 'adopted',
        adoptedAt: now,
        totalTravelSeconds: leg.effectiveWalkingSeconds,
      };
      adoptedCount++;
    } else {
      legs[id] = leg;
    }
  }
  return { itinerary: touch({ ...it, legs }), adoptedCount };
}

/**
 * 恢复为地图值（第 8.5 节）：该路段回到待获取，需联网重新获取；
 * 不保留已采纳值作为另一份可对照的数据。
 */
export function restoreLegToMapValue(it: Itinerary, legId: string): Itinerary {
  const leg = it.legs[legId];
  if (!leg || leg.durationSource !== 'adopted') return it;
  const next: Leg = {
    ...leg,
    durationSource: 'manual',
    adoptedAt: null,
    rawWalkingSeconds: null,
    effectiveWalkingSeconds: null,
    totalTravelSeconds: null,
    distanceMeters: null,
    provider: null,
    providerApiVersion: null,
    fetchedAt: null,
    state: 'missing',
    failureCode: null,
    // 地图报告属性一并清除，回到待确认
    reportedFeatures: [],
  };
  return touch({ ...it, legs: { ...it.legs, [legId]: next } });
}

/** 设施记录的便捷更新（须已存在） */
export function upsertFacilityFact(
  it: Itinerary,
  facilityId: string,
  factKey: string,
  fact: Fact<unknown>,
): Itinerary {
  const facilities = it.facilities.map((f) =>
    f.id === facilityId ? { ...f, facts: { ...f.facts, [factKey]: fact } } : f,
  );
  return touch({ ...it, facilities });
}

/**
 * 确保 target（place / node / leg）上存在指定种类的设施记录，并写入一个事实（第 4.4 节）。
 * recordKey：地图候选 POI id。同站可有多条同类候选，按 recordKey 区分，不再 kind 唯一覆盖；
 * 缺省 null 表示手动记录（同 target+kind 合并进同一条）。
 */
export function upsertFacilityFactForTarget(
  it: Itinerary,
  target: FacilityTarget,
  kind: FacilityKind,
  factKey: string,
  fact: Fact<unknown>,
  recordKey?: string | null,
): Itinerary {
  const key = recordKey ?? null;
  const existing = it.facilities.find(
    (f) =>
      f.kind === kind &&
      isSameFacilityTarget(f.target, target) &&
      (f.recordKey ?? null) === key,
  );
  if (existing) return upsertFacilityFact(it, existing.id, factKey, fact);
  const record: FacilityRecord = {
    id: newId(),
    kind,
    placeId: placeIdOfFacilityTarget(it, target),
    target,
    facts: { [factKey]: fact },
    recordKey: key,
  };
  return touch({ ...it, facilities: [...it.facilities, record] });
}

function isSameFacilityTarget(a: FacilityTarget, b: FacilityTarget): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'place' && b.type === 'place') return a.placeId === b.placeId;
  if (a.type === 'node' && b.type === 'node') return a.nodeId === b.nodeId;
  if (a.type === 'leg' && b.type === 'leg') return a.legId === b.legId;
  return false;
}

/** 设施记录的地点旁挂：node 挂其地点；路段跨两个地点，不归属单一地点 */
function placeIdOfFacilityTarget(it: Itinerary, target: FacilityTarget): string | null {
  if (target.type === 'place') return target.placeId;
  if (target.type === 'node') return it.nodes[target.nodeId]?.placeId ?? null;
  return null;
}

/** 确保节点上存在指定种类的设施记录，并写入一个事实（第 4.4 节） */
export function upsertNodeFacilityFact(
  it: Itinerary,
  nodeId: string,
  kind: 'toilet' | 'rest-candidate' | 'stairs',
  factKey: string,
  fact: Fact<unknown>,
  recordKey?: string | null,
): Itinerary {
  return upsertFacilityFactForTarget(it, { type: 'node', nodeId }, kind, factKey, fact, recordKey);
}

/** 跳站后是否存在“待补充/待获取”的路段（编辑区提示用） */
export function hasPendingLegs(it: Itinerary): boolean {
  return Object.values(it.legs).some((l) => l.state === 'missing' || l.state === 'stale');
}

/** 供其他领域模块复用：确认有效修改（递增 revision、刷新 updatedAt） */
export { touch as touchItinerary };
