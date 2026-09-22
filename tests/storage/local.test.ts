/**
 * 本地保存与持久化白名单（第 8.4、8.5 节；T22 离线口径）。
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../shared/contracts/domain';
import {
  addVisitNode,
  adoptAllMapLegs,
  applyMatrixEdges,
  createEmptyItinerary,
  setEndpoint,
  upsertPlace,
} from '../../src/domain/itinerary';
import {
  createLocalStore,
  parseItineraryBackup,
  serializeItineraryBackup,
  toPersisted,
  STORAGE_KEY,
} from '../../src/storage/local';
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

function sampleWithAmapLeg(reportedFeatures: Array<{ kind: string; note: string }> = []) {
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
      reportedFeatures,
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

  it('地图报告属性（如阶梯）随会话进入 Leg，但不落盘，重载回到待确认（R-A3）', () => {
    const it = sampleWithAmapLeg([{ kind: 'stairs', note: '高德标注阶梯' }]);
    const leg = Object.values(it.legs)[0];
    expect(leg.reportedFeatures).toEqual([{ kind: 'stairs', note: '高德标注阶梯' }]);
    const persisted = toPersisted(it);
    expect(Object.values(persisted.legs)[0].reportedFeatures).toEqual([]);
  });
});

describe('备份导出与导入（第 8.5 节）', () => {
  it('导出→导入 roundtrip：数据一致（走持久化白名单）', () => {
    const it = sampleWithAmapLeg([{ kind: 'stairs', note: '高德标注阶梯' }]);
    const parsed = parseItineraryBackup(serializeItineraryBackup(it));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.itinerary).toEqual(toPersisted(it));
  });

  it('导出内容符合白名单：未采纳 amap 路段时长与地图报告值不随导出', () => {
    const text = serializeItineraryBackup(sampleWithAmapLeg([{ kind: 'stairs', note: '高德标注阶梯' }]));
    const raw = JSON.parse(text) as {
      schemaVersion: number;
      legs: Record<string, { rawWalkingSeconds: number | null; effectiveWalkingSeconds: number | null; state: string; reportedFeatures: unknown[] }>;
    };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    const leg = Object.values(raw.legs)[0];
    expect(leg.rawWalkingSeconds).toBeNull();
    expect(leg.effectiveWalkingSeconds).toBeNull();
    expect(leg.state).toBe('missing');
    expect(leg.reportedFeatures).toEqual([]);
  });

  it('旧数据缺失 reportedFeatures 仍可解析并补默认空数组（契约 additive）', () => {
    const legacy = JSON.parse(serializeItineraryBackup(sampleWithAmapLeg())) as {
      legs: Record<string, Record<string, unknown>>;
    };
    const legacyLeg = Object.values(legacy.legs)[0];
    delete legacyLeg.reportedFeatures;
    const parsed = parseItineraryBackup(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.values(parsed.itinerary.legs)[0].reportedFeatures).toEqual([]);
  });

  it('parseItineraryBackup：非法 JSON → invalidJson', () => {
    expect(parseItineraryBackup('{这不是 JSON')).toEqual({ ok: false, error: 'invalidJson' });
  });

  it('parseItineraryBackup：未识别 schemaVersion → unsupported', () => {
    expect(parseItineraryBackup(JSON.stringify({ schemaVersion: 999, id: 'x' }))).toEqual({
      ok: false,
      error: 'unsupported',
    });
  });

  it('parseItineraryBackup：结构不合法 → invalidShape', () => {
    expect(parseItineraryBackup(JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'x' }))).toEqual({
      ok: false,
      error: 'invalidShape',
    });
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
