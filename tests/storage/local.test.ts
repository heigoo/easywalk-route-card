/**
 * 本地保存与持久化白名单（第 8.4、8.5 节；T22 离线口径）。
 * Task 6：多行程索引、旧单键迁移、索引重建（R-A / M-R01）。
 * 末尾为 Task 4 / R-D：绕行对照边仅会话内使用、绝不落盘的断言。
 */
import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../shared/contracts/domain';
import {
  addRestNode,
  addVisitNode,
  adoptAllMapLegs,
  applyMatrixEdges,
  createEmptyItinerary,
  setEndpoint,
  setManualLegTime,
  upsertPlace,
} from '../../src/domain/itinerary';
import {
  clearDetourCompares,
  detourRequestFor,
  fetchDetourCompare,
  rememberDetourCompare,
  sessionDetourCompares,
} from '../../src/features/planning/useDetourCompare';
import {
  createLocalStore,
  parseItineraryBackup,
  serializeItineraryBackup,
  toPersisted,
  itineraryKey,
  INDEX_KEY,
  STORAGE_KEY,
} from '../../src/storage/local';
import { makePlace } from '../helpers';

function memoryBackend() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
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
    expect(backend.map.has(itineraryKey(it.id))).toBe(true);
    expect(backend.map.has(INDEX_KEY)).toBe(true);
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
      key: () => null,
      length: 0,
    };
    const store = createLocalStore(failing);
    const result = store.save(sampleWithAmapLeg());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('QuotaExceeded');
  });
});

// ---------------------------------------------------------------------------
// Task 6（R-A / M-R01）：多行程存储、旧单键迁移与索引重建
// ---------------------------------------------------------------------------

describe('多行程存储与旧单键迁移（Task 6）', () => {
  it('旧单键自动迁为列表首条：字段级无损往返', () => {
    const backend = memoryBackend();
    const source = { ...sampleWithAmapLeg(), title: '旧单键行程', travelDate: '2026-10-01' };
    // 旧版保存：直接落持久化白名单后的单行程 JSON
    const legacy = toPersisted(source);
    backend.map.set(STORAGE_KEY, JSON.stringify(legacy));
    const store = createLocalStore(backend);
    const loaded = store.load();
    expect(loaded.ok).toBe(true);
    expect(loaded.error).toBeNull();
    // 字段级无损
    expect(loaded.itinerary).toEqual(legacy);
    // 迁为列表首条（索引项与记录字段一致）
    expect(loaded.items).toEqual([
      { id: legacy.id, title: '旧单键行程', travelDate: '2026-10-01', updatedAt: legacy.updatedAt },
    ]);
    // 新结构落盘；成功后才删旧键
    expect(backend.map.has(itineraryKey(legacy.id))).toBe(true);
    expect(backend.map.has(INDEX_KEY)).toBe(true);
    expect(backend.map.has(STORAGE_KEY)).toBe(false);
    // 按 id 读回一致
    expect(store.loadTrip(legacy.id).itinerary).toEqual(legacy);
  });

  it('迁移原子：索引写入失败时旧键仍在并返回可提示错误', () => {
    const map = new Map<string, string>();
    const backend = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // 第二步（索引写入）失败
        if (k === INDEX_KEY) throw new Error('QuotaExceeded');
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
      map,
    };
    const source = { ...sampleWithAmapLeg(), title: '迁移失败行程' };
    const legacyRaw = JSON.stringify(toPersisted(source));
    map.set(STORAGE_KEY, legacyRaw);
    const store = createLocalStore(backend);
    const loaded = store.load();
    // 可提示的错误，且不静默清空
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toBe('migrationFailed');
    expect(loaded.itinerary).toBeNull();
    // 旧键原样保留
    expect(map.get(STORAGE_KEY)).toBe(legacyRaw);
  });

  it('旧单键与索引并发存在：不重复迁移、不覆盖', () => {
    const backend = memoryBackend();
    const legacySource = { ...sampleWithAmapLeg(), title: '旧键内容' };
    const legacyRaw = JSON.stringify(toPersisted(legacySource));
    backend.map.set(STORAGE_KEY, legacyRaw);
    // 新结构已有另一条行程
    const other = { ...sampleWithAmapLeg(), title: '新结构行程' };
    backend.map.set(itineraryKey(other.id), JSON.stringify(toPersisted(other)));
    backend.map.set(
      INDEX_KEY,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        currentId: other.id,
        items: [{ id: other.id, title: '新结构行程', travelDate: null, updatedAt: other.updatedAt }],
      }),
    );
    const store = createLocalStore(backend);
    const loaded = store.load();
    expect(loaded.ok).toBe(true);
    // 走索引中的行程，不被旧键覆盖
    expect(loaded.itinerary!.id).toBe(other.id);
    expect(loaded.itinerary!.title).toBe('新结构行程');
    expect(loaded.items).toHaveLength(1);
    // 不重复迁移：旧键原样保留
    expect(backend.map.get(STORAGE_KEY)).toBe(legacyRaw);
  });

  it('索引损坏：各行程数据保留，rebuildIndex() 可重建', () => {
    const backend = memoryBackend();
    const a = { ...sampleWithAmapLeg(), title: '甲行程', updatedAt: '2026-09-01T00:00:00.000Z' };
    const b = { ...sampleWithAmapLeg(), title: '乙行程', updatedAt: '2026-09-02T00:00:00.000Z' };
    backend.map.set(itineraryKey(a.id), JSON.stringify(toPersisted(a)));
    backend.map.set(itineraryKey(b.id), JSON.stringify(toPersisted(b)));
    backend.map.set(itineraryKey('broken-one'), '{not json');
    backend.map.set(INDEX_KEY, '{索引损坏');
    const store = createLocalStore(backend);
    const loaded = store.load();
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toBe('indexCorrupt');
    expect(loaded.items).toBeNull();
    // 各行程数据保留，绝不静默清空
    expect(backend.map.has(itineraryKey(a.id))).toBe(true);
    expect(backend.map.has(itineraryKey(b.id))).toBe(true);

    const rebuilt = store.rebuildIndex();
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(rebuilt.items.map((i) => i.id)).toEqual([b.id, a.id]); // 最近更新在前
      expect(rebuilt.items.map((i) => i.title)).toEqual(['乙行程', '甲行程']);
      // 读不出的记录只跳过、原键保留
      expect(rebuilt.skippedIds).toEqual(['broken-one']);
    }
    expect(backend.map.has(itineraryKey('broken-one'))).toBe(true);
    // 重建后可正常载入
    const again = store.load();
    expect(again.ok).toBe(true);
    expect(again.error).toBeNull();
    expect(again.itinerary!.id).toBe(b.id);
  });

  it('按 id 读写与删除行程记录', () => {
    const backend = memoryBackend();
    const store = createLocalStore(backend);
    const a = { ...sampleWithAmapLeg(), title: '行程A' };
    const b = { ...sampleWithAmapLeg(), title: '行程B' };
    expect(store.save(a).ok).toBe(true);
    expect(store.save(b).ok).toBe(true);
    expect(store.loadTrip(a.id).itinerary!.title).toBe('行程A');
    expect(store.loadTrip(b.id).itinerary!.title).toBe('行程B');
    // 最后保存的即当前行程
    expect(store.load().itinerary!.id).toBe(b.id);

    const del = store.deleteTrip(a.id);
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.items.map((i) => i.id)).toEqual([b.id]);
    expect(backend.map.has(itineraryKey(a.id))).toBe(false);
    const gone = store.loadTrip(a.id);
    expect(gone.ok).toBe(true);
    expect(gone.itinerary).toBeNull();

    // 删除当前行程后指向剩余行程；删完进入无行程状态
    expect(store.deleteTrip(b.id).ok).toBe(true);
    const empty = store.load();
    expect(empty.ok).toBe(true);
    expect(empty.itinerary).toBeNull();
    expect(empty.items).toEqual([]);
    expect(backend.map.has(itineraryKey(b.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 4 / R-D：绕行对照边仅会话内使用，绝不写入行程结构、绝不落盘
// ---------------------------------------------------------------------------

describe('绕行对照边不落盘（Task 4 / R-D）', () => {
  it('直达对照边只存会话缓存：toPersisted 与备份导出均不含对照边', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pairs: Array<{ fromId: string; toId: string }> };
      return {
        ok: true,
        json: async () => ({
          requestId: 'detour-1',
          data: {
            edges: body.pairs.map((p) => ({
              fromId: p.fromId,
              toId: p.toId,
              fromCoordinateRevision: 0,
              toCoordinateRevision: 0,
              state: 'ready' as const,
              distanceMeters: 1200,
              rawWalkingSeconds: 900,
              provider: 'amap',
              providerApiVersion: 'v5',
              fetchedAt: '2026-09-22T05:00:00.000Z',
              reportedFeatures: [],
            })),
            failures: [],
            queryCoverage: 'complete' as const,
            fetchedAt: '2026-09-22T05:00:00.000Z',
          },
          warnings: [],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      // 起点→休息点→终点；(起点→终点) 即绕行对照边（真实两段为起点→休息点、休息点→终点）
      let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
      const pO = makePlace('示例起点', 116.397, 39.908);
      const pR = makePlace('示例休息点', 116.4, 39.91);
      const pB = makePlace('示例终点', 116.406, 39.914);
      for (const p of [pO, pR, pB]) it = upsertPlace(it, p);
      // 先建休息点再设端点：不遗留“保留但未引用”的旧直连段
      it = addRestNode(it, pR.id, { restSeconds: 10 * 60 });
      const rId = it.nodeOrder[0];
      it = setEndpoint(it, 'origin', pO.id);
      it = setEndpoint(it, 'destination', pB.id);
      const legBetween = (from: string, to: string) =>
        Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
      it = setManualLegTime(it, legBetween(it.origin!.id, rId).id, { walkingSeconds: 8 * 60 });
      it = setManualLegTime(it, legBetween(rId, it.destination!.id).id, { walkingSeconds: 10 * 60 });

      // 会话内取得“起点→终点”直达对照边
      const req = detourRequestFor(it, rId)!;
      expect(req.pairs).toEqual([{ fromId: it.origin!.id, toId: it.destination!.id }]);
      rememberDetourCompare(req.key, await fetchDetourCompare(req, 'fp'));
      expect(sessionDetourCompares()[req.key].status).toBe('ready');

      // 对照边不进持久化：行程仍只有两段真实路段，无“起点→终点”直达边
      const persisted = toPersisted(it);
      expect(Object.keys(persisted.legs)).toHaveLength(2);
      expect(
        Object.values(persisted.legs).some(
          (l) => l.fromNodeId === it.origin!.id && l.toNodeId === it.destination!.id,
        ),
      ).toBe(false);
      const raw = JSON.parse(serializeItineraryBackup(it)) as {
        legs: Record<string, { fromNodeId: string; toNodeId: string }>;
      };
      expect(Object.keys(raw.legs)).toHaveLength(2);
      expect(
        Object.values(raw.legs).some(
          (l) => l.fromNodeId === it.origin!.id && l.toNodeId === it.destination!.id,
        ),
      ).toBe(false);
    } finally {
      clearDetourCompares();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
