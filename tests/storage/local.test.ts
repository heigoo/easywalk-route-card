/**
 * 本地保存与持久化白名单（第 8.4、8.5 节；T22 离线口径）。
 */
import { describe, expect, it } from 'vitest';
import {
  addVisitNode,
  adoptAllMapLegs,
  applyMatrixEdges,
  createEmptyItinerary,
  setEndpoint,
  upsertPlace,
} from '../../src/domain/itinerary';
import { createLocalStore, toPersisted, STORAGE_KEY } from '../../src/storage/local';
import { makePlace } from '../helpers';

function memoryBackend() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

function sampleWithAmapLeg() {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pB = makePlace('示例景点B', 116.406, 39.914);
  for (const p of [pO, pB]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pB.id);
  it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: 5 * 60 });
  const bId = it.nodeOrder[0];
  it = applyMatrixEdges(it, [
    {
      fromNodeId: it.origin!.id,
      toNodeId: bId,
      fromCoordinateRevision: 0,
      toCoordinateRevision: 0,
      distanceMeters: 900,
      rawWalkingSeconds: 600,
      provider: 'amap',
      providerApiVersion: 'v5',
      fetchedAt: '2026-09-22T01:00:00.000Z',
      state: 'ready',
    },
  ]);
  return it;
}

describe('持久化白名单（第 8.5 节）', () => {
  it('未采纳的 amap 路段不落盘，重载后回到待获取', () => {
    const it = sampleWithAmapLeg();
    const persisted = toPersisted(it);
    const leg = Object.values(persisted.legs)[0];
    expect(leg.state).toBe('missing');
    expect(leg.rawWalkingSeconds).toBeNull();
    expect(leg.effectiveWalkingSeconds).toBeNull();
    expect(leg.providerApiVersion).toBeNull();
  });

  it('已采纳路段随行程保存，可离线查看', () => {
    const it = sampleWithAmapLeg();
    const { itinerary } = adoptAllMapLegs(it, '2026-09-22T02:00:00.000Z');
    const persisted = toPersisted(itinerary);
    const leg = Object.values(persisted.legs)[0];
    expect(leg.durationSource).toBe('adopted');
    expect(leg.effectiveWalkingSeconds).toBe(600);
    expect(leg.adoptedAt).toBe('2026-09-22T02:00:00.000Z');
    expect(leg.state).toBe('ready');
  });

  it('reported 设施属性不持久化，重载后回到待确认', () => {
    const it = sampleWithAmapLeg();
    const withFacility = {
      ...it,
      facilities: [
        {
          id: 'f1',
          kind: 'toilet' as const,
          placeId: null,
          target: { type: 'place' as const, placeId: it.nodeOrder[0] },
          facts: {
            open: {
              value: '08:00-18:00',
              sourceType: 'amap' as const,
              sourceName: '高德地图',
              sourceReference: null,
              fetchedAt: '2026-09-22T01:00:00.000Z',
              reviewState: 'reported' as const,
              checkedAt: null,
              applicableDate: null,
              note: null,
            },
          },
        },
      ],
    };
    const persisted = toPersisted(withFacility);
    const fact = persisted.facilities[0].facts.open as { value: unknown; reviewState: string };
    expect(fact.value).toBeNull();
    expect(fact.reviewState).toBe('unknown');
  });
});

describe('本地存储读写（第 8.4 节）', () => {
  it('保存后可恢复同一行程', () => {
    const backend = memoryBackend();
    const store = createLocalStore(backend);
    const it = sampleWithAmapLeg();
    expect(store.save(it).ok).toBe(true);
    expect(backend.map.has(STORAGE_KEY)).toBe(true);
    const loaded = store.load();
    expect(loaded.ok).toBe(true);
    expect(loaded.itinerary!.id).toBe(it.id);
    expect(loaded.itinerary!.nodeOrder).toEqual(it.nodeOrder);
  });

  it('数据损坏时不静默清空，显式报 corrupt', () => {
    const backend = memoryBackend();
    backend.map.set(STORAGE_KEY, '{not json');
    const store = createLocalStore(backend);
    const loaded = store.load();
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toBe('corrupt');
    expect(loaded.itinerary).toBeNull();
  });

  it('未识别的 schemaVersion 不静默覆盖', () => {
    const backend = memoryBackend();
    backend.map.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 999, id: 'x' }));
    const store = createLocalStore(backend);
    const loaded = store.load();
    expect(loaded.error).toBe('unsupported');
  });

  it('写入失败时保留内存内容并返回错误', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    const store = createLocalStore(failing);
    const result = store.save(sampleWithAmapLeg());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('QuotaExceeded');
  });
});
