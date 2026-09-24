/**
 * 测试辅助：构造领域对象。
 * 地点均为虚构示例名（需求第 11 章：示例数据须显著标注，不冒充真实线路）。
 */
import type { Itinerary, PlaceRef } from '../shared/contracts/domain';
import { SCHEMA_VERSION } from '../shared/contracts/domain';
import { newId } from '../src/domain/id';
import {
  addRestNode,
  addVisitNode,
  createEmptyItinerary,
  setEndpoint,
  setManualLegTime,
  updateNode,
  upsertPlace,
} from '../src/domain/itinerary';

/** 测试便捷封装：setManualLegTime 失败时原样返回（用例内应自行保证输入合法） */
export function setManualLeg(
  it: Itinerary,
  legId: string,
  patch: { walkingSeconds: number | null; totalSeconds?: number | null; mode?: 'walking' | 'manual-transfer'; distanceMeters?: number | null },
): Itinerary {
  const r = setManualLegTime(it, legId, patch);
  return r.ok ? r.itinerary : it;
}

export function makePlace(name: string, lng: number, lat: number, entranceConfirmed = true): PlaceRef {
  return {
    id: newId(),
    name,
    providerPoiId: null,
    location: { longitude: lng, latitude: lat },
    coordinateRevision: 0,
    entranceConfirmed,
    openingDescription: {
      value: null, sourceType: 'unknown', sourceName: null, sourceReference: null,
      fetchedAt: null, reviewState: 'unknown', checkedAt: null, applicableDate: null, note: null,
    },
    openingSchedule: {
      value: null, sourceType: 'unknown', sourceName: null, sourceReference: null,
      fetchedAt: null, reviewState: 'unknown', checkedAt: null, applicableDate: null, note: null,
    },
  };
}

export function makeItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    title: '示例行程（测试数据）',
    city: '示例市',
    travelDate: '2026-10-01',
    departureLocalTime: '09:00',
    timezone: 'Asia/Shanghai',
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
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** 需求 10.3 统一样例（地点与数字均为示例） */
export const SAMPLE = {
  originToA: 12 * 60,
  aStay: 30 * 60,
  aInside: 8 * 60,
  aToRest: 8 * 60,
  rest: 10 * 60,
  restToB: 10 * 60,
  bStay: 30 * 60,
  bInside: 5 * 60,
  totalWalk: 43 * 60,
  totalDuration: 100 * 60,
  longest: 28 * 60,
  knownWithoutAInside: 35 * 60,
};

/** 统一样例行程：起点→A→休息点→B(景点兼终点，同一入口零衔接) */
export function buildUnifiedSample(): Itinerary {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.400, 39.910);
  const pR = makePlace('示例休息点', 116.403, 39.912);
  const pB = makePlace('示例景点B', 116.406, 39.914);
  for (const p of [pO, pA, pR, pB]) it = upsertPlace(it, p);

  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pB.id);

  it = addVisitNode(it, pA.id, { required: true, visitSeconds: SAMPLE.aStay, insideWalkSeconds: SAMPLE.aInside });
  const aId = it.nodeOrder[it.nodeOrder.length - 1];
  it = addRestNode(it, pR.id, {});
  const rId = it.nodeOrder[it.nodeOrder.length - 1];
  it = updateNode(it, rId, {
    restSeconds: SAMPLE.rest,
    seatFact: {
      value: true, sourceType: 'user', sourceName: null, sourceReference: null,
      fetchedAt: null, reviewState: 'userChecked', checkedAt: '2026-09-22T00:00:00.000Z',
      applicableDate: null, note: null,
    },
  });
  it = addVisitNode(it, pB.id, { required: true, visitSeconds: SAMPLE.bStay, insideWalkSeconds: SAMPLE.bInside });
  const bId = it.nodeOrder[it.nodeOrder.length - 1];

  const legBetween = (from: string, to: string) =>
    Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;

  const oId = it.origin!.id;
  it = setManualLeg(it, legBetween(oId, aId).id, { walkingSeconds: SAMPLE.originToA });
  it = setManualLeg(it, legBetween(aId, rId).id, { walkingSeconds: SAMPLE.aToRest });
  it = setManualLeg(it, legBetween(rId, bId).id, { walkingSeconds: SAMPLE.restToB });
  // bId → destination 为同一已确认入口的零衔接边，无需填写
  return it;
}
