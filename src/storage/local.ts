/**
 * 浏览器本地保存（第 8.4、8.5 节；Task 6 多行程管理，规格 R-A / M-R01）。
 * - 多行程：索引键 easywalk.itinerary-index ＋ 分行程键 easywalk.itinerary.{id}；
 * - 旧版单行程键 easywalk.current-itinerary 仅作一次性迁移来源：先写行程记录与索引、
 *   成功后才删旧键；任一步失败保留旧键并返回可提示错误，旧键与新结构并发存在时不重复迁移、不覆盖；
 * - 持久化白名单：未经采纳的地图值不落盘；reported 设施属性回到待确认；
 * - 存储损坏/禁止写入/容量不足时保留内存内容并显式反馈，未经确认不清空；
 *   索引损坏时各行程数据保留，可 rebuildIndex() 重建，绝不静默清空。
 */
import { z } from 'zod';
import type { Fact, Itinerary, Leg, PlaceRef } from '../../shared/contracts/domain';
import { SCHEMA_VERSION, itinerarySchema } from '../../shared/contracts/domain';
import { newId } from '../domain/id';

/** 旧版单行程键：只读迁移来源，迁移成功后删除 */
export const STORAGE_KEY = 'easywalk.current-itinerary';
/** 行程索引键 */
export const INDEX_KEY = 'easywalk.itinerary-index';
/** 分行程存储键前缀 */
export const ITINERARY_KEY_PREFIX = 'easywalk.itinerary.';

/** 分行程存储键 */
export function itineraryKey(id: string): string {
  return ITINERARY_KEY_PREFIX + id;
}

export type StorageState = 'idle' | 'dirty' | 'saving' | 'saved' | 'saveFailed';

/** 行程索引项（列表面板展示：标题 / 出游日期 / 更新时间） */
export interface TripIndexItem {
  id: string;
  title: string;
  travelDate: string | null;
  updatedAt: string;
}

const tripIndexItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  travelDate: z.string().nullable(),
  updatedAt: z.string(),
});

/**
 * 行程索引结构（就地定义小 schema，不动 shared/contracts/*）：
 * items 为行程列表；currentId 记录当前行程（结构扩展字段，缺省视为取首条）。
 */
const tripIndexSchema = z.object({
  schemaVersion: z.number().int().positive(),
  currentId: z.string().nullable().optional(),
  items: z.array(tripIndexItemSchema),
});
export type TripIndex = z.infer<typeof tripIndexSchema>;

export interface LoadResult {
  ok: boolean;
  itinerary: Itinerary | null;
  /**
   * corrupt=行程数据损坏；unsupported=schemaVersion 未识别；
   * indexCorrupt=行程索引损坏（各行程数据保留，可 rebuildIndex 重建）；
   * migrationFailed=旧单键迁移写入失败（旧数据原样保留，可重试）
   */
  error: 'corrupt' | 'unsupported' | 'indexCorrupt' | 'migrationFailed' | null;
  /** 行程索引列表；索引损坏/版本不识别时为 null（各行程数据仍保留） */
  items: TripIndexItem[] | null;
}

/** 按持久化白名单裁剪行程（第 8.5 节表） */
export function toPersisted(it: Itinerary): Itinerary {
  const legs: Record<string, Leg> = {};
  for (const [id, leg] of Object.entries(it.legs)) {
    // 地图报告属性（如阶梯）不落盘，重载后回到待确认；用户核对结果走 facilityRecord 的 stairs 事实持久化
    if (leg.durationSource === 'amap') {
      // 未采纳的地图值不落盘；重载后回到待获取，失败结论不保留
      legs[id] = {
        ...leg,
        distanceMeters: null,
        rawWalkingSeconds: null,
        effectiveWalkingSeconds: null,
        totalTravelSeconds: null,
        provider: null,
        providerApiVersion: null,
        fetchedAt: null,
        adoptedAt: null,
        state: 'missing',
        failureCode: null,
        reportedFeatures: [],
      };
    } else if (leg.state === 'failed' || leg.state === 'unreachable') {
      legs[id] = {
        ...leg,
        state: 'missing',
        failureCode: null,
        reportedFeatures: [],
      };
    } else {
      legs[id] = { ...leg, reportedFeatures: [] };
    }
  }

  const places: Record<string, PlaceRef> = {};
  for (const [id, place] of Object.entries(it.places)) {
    places[id] = {
      ...place,
      openingDescription: revertReportedFact(place.openingDescription),
      openingSchedule: revertReportedFact(place.openingSchedule),
    };
  }

  const facilities = it.facilities.map((f) => {
    const facts: Record<string, Fact<unknown>> = {};
    for (const [k, v] of Object.entries(f.facts)) {
      facts[k] = revertReportedFact(v as Fact<unknown>);
    }
    return { ...f, facts };
  });

  return { ...it, legs, places, facilities };
}

/** reported（地图返回未核实）的原值不持久化，重载后回到待确认 */
function revertReportedFact<T>(fact: Fact<T>): Fact<T> {
  if (fact.reviewState === 'reported' || fact.sourceType === 'amap') {
    return {
      ...fact,
      value: null,
      sourceType: 'unknown',
      reviewState: 'unknown',
      sourceName: null,
      sourceReference: null,
      fetchedAt: null,
    };
  }
  return fact;
}

/** 备份解析结果：invalidJson=不是合法 JSON；unsupported=schemaVersion 未识别；invalidShape=内容不完整 */
export type ParseBackupResult =
  | { ok: true; itinerary: Itinerary }
  | { ok: false; error: 'invalidJson' | 'unsupported' | 'invalidShape' };

/** 导出备份文本：走持久化白名单（未采纳地图值不导出），输出已含 schemaVersion（单行程 JSON，语义不变） */
export function serializeItineraryBackup(it: Itinerary): string {
  return JSON.stringify(toPersisted(it), null, 2);
}

/** 导入备份文本：任一步失败都拒绝，由调用方保持当前行程不变（单行程备份，导入替换当前行程，语义不变） */
export function parseItineraryBackup(text: string): ParseBackupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalidJson' };
  }
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { ok: false, error: 'unsupported' };
  }
  const result = itinerarySchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: 'invalidShape' };
  }
  return { ok: true, itinerary: result.data };
}

export type SaveResult = { ok: boolean; error: string | null };
/** 行程列表操作结果：成功时回传最新索引列表 */
export type TripOpResult = { ok: true; items: TripIndexItem[] } | { ok: false; error: string };
export type SwitchTripResult =
  | { ok: true; itinerary: Itinerary; items: TripIndexItem[] }
  | { ok: false; error: string };
export type ListTripsResult =
  | { ok: true; items: TripIndexItem[] }
  | { ok: false; error: 'indexCorrupt' | 'unsupported' | 'io' };
export type RebuildIndexResult =
  | { ok: true; items: TripIndexItem[]; skippedIds: string[] }
  | { ok: false; error: string };

export interface ItineraryStore {
  /** 启动载入：必要时先迁移旧单键，再读索引与当前（currentId，缺省首条）行程 */
  load(): LoadResult;
  /** 按 id 只读载入行程记录 */
  loadTrip(id: string): LoadResult;
  /** 读行程索引列表 */
  listTrips(): ListTripsResult;
  /** 保存行程记录（走持久化白名单）并同步索引项；保存的行程即当前行程 */
  save(it: Itinerary): SaveResult;
  /** 切换当前行程：记录 currentId 并读出该行程 */
  switchTo(id: string): SwitchTripResult;
  /** 复制行程记录（新 id、内容字段级一致）；副本不改变当前行程 */
  copyTrip(id: string, source?: Itinerary): TripOpResult;
  /** 重命名行程记录（即时生效）；当前行程由调用方走 apply 时无需调用 */
  renameTrip(id: string, title: string): TripOpResult;
  /** 删除整份行程记录（记录键＋索引项），区别于清空内容 */
  deleteTrip(id: string): TripOpResult;
  /** 索引损坏后的重建入口：扫描 easywalk.itinerary.* 键重建列表，读不出的记录键保留并列出 */
  rebuildIndex(): RebuildIndexResult;
}

/** 存储后端：localStorage 天然满足；测试可注入内存实现 */
export type LocalBackend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** 单键读取结果：corrupt 含读取异常/JSON 或结构不合法；unsupported=schemaVersion 未识别 */
type RawRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unsupported' }
  | { kind: 'io'; message: string };

/** 行程记录读取结果（读取异常并入 corrupt，与既有语义一致） */
type RecordRead<T> = Exclude<RawRead<T>, { kind: 'io' }>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function itemFrom(it: Itinerary): TripIndexItem {
  return { id: it.id, title: it.title, travelDate: it.travelDate, updatedAt: it.updatedAt };
}

/** 索引项 upsert：已存在保持原位，新项插到列表前（最近产生在前） */
function upsertItem(items: TripIndexItem[], item: TripIndexItem): TripIndexItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx < 0) return [item, ...items];
  const next = [...items];
  next[idx] = item;
  return next;
}

function readItineraryAt(backend: LocalBackend, key: string): RecordRead<Itinerary> {
  let raw: string | null = null;
  try {
    raw = backend.getItem(key);
  } catch {
    return { kind: 'corrupt' };
  }
  if (raw === null) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { kind: 'unsupported' };
  }
  const result = itinerarySchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'corrupt' };
  }
  return { kind: 'ok', value: result.data };
}

function readIndex(backend: LocalBackend): RawRead<TripIndex> {
  let raw: string | null = null;
  try {
    raw = backend.getItem(INDEX_KEY);
  } catch (e) {
    return { kind: 'io', message: errorMessage(e) };
  }
  if (raw === null) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { kind: 'unsupported' };
  }
  const result = tripIndexSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'corrupt' };
  }
  return { kind: 'ok', value: result.data };
}

/** 扫描 easywalk.itinerary.* 键：有效记录生成索引项，读不出的记录键保留并列入 skippedIds */
function scanItineraryRecords(
  backend: LocalBackend,
): { ok: true; items: TripIndexItem[]; skippedIds: string[] } | { ok: false; error: 'io' } {
  const keys: string[] = [];
  try {
    for (let i = 0; i < backend.length; i++) {
      const k = backend.key(i);
      if (k && k.startsWith(ITINERARY_KEY_PREFIX)) keys.push(k);
    }
  } catch {
    // M15：枚举失败不得写成空索引
    return { ok: false, error: 'io' };
  }
  const items: TripIndexItem[] = [];
  const skippedIds: string[] = [];
  for (const key of keys) {
    const rec = readItineraryAt(backend, key);
    if (rec.kind === 'ok') items.push(itemFrom(rec.value));
    else skippedIds.push(key.slice(ITINERARY_KEY_PREFIX.length));
  }
  // 最近更新在前，同时间按 id 排序保证确定性
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  skippedIds.sort();
  return { ok: true, items, skippedIds };
}

/**
 * 列表项解析：索引可用时以其顺序为准；索引缺失/损坏时以行程记录扫描为准，
 * 任何情况下不静默丢列表项（启动时已就索引损坏显式提示）。
 */
function resolveItems(backend: LocalBackend): TripIndexItem[] {
  const idx = readIndex(backend);
  if (idx.kind === 'ok') return idx.value.items;
  const scan = scanItineraryRecords(backend);
  return scan.ok ? scan.items : [];
}

function readCurrentId(backend: LocalBackend): string | null {
  const idx = readIndex(backend);
  return idx.kind === 'ok' ? idx.value.currentId ?? null : null;
}

function writeIndex(backend: LocalBackend, items: TripIndexItem[], currentId: string | null): void {
  backend.setItem(INDEX_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, currentId, items }));
}

type MigrateResult =
  | { kind: 'none' }
  | { kind: 'done' }
  | { kind: 'failed'; error: 'corrupt' | 'unsupported' | 'migrationFailed' };

/**
 * 旧单键迁移（无索引且旧键存在时一次性执行）：
 * 原子顺序＝先写行程记录＋索引、成功后才删旧键；任一步写失败保留旧键并返回可提示错误；
 * 旧键与新结构并发存在时不重复迁移、不覆盖；字段级无损（仍走持久化白名单）。
 */
function migrateLegacySingleTrip(backend: LocalBackend): MigrateResult {
  let raw: string | null = null;
  try {
    raw = backend.getItem(STORAGE_KEY);
  } catch {
    return { kind: 'failed', error: 'corrupt' };
  }
  if (raw === null) return { kind: 'none' };
  let indexRaw: string | null = null;
  try {
    indexRaw = backend.getItem(INDEX_KEY);
  } catch {
    return { kind: 'failed', error: 'migrationFailed' };
  }
  // 旧键与新结构并发存在：不重复迁移、不覆盖
  if (indexRaw !== null) return { kind: 'none' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'failed', error: 'corrupt' };
  }
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { kind: 'failed', error: 'unsupported' };
  }
  const result = itinerarySchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'failed', error: 'corrupt' };
  }
  const it = result.data;
  try {
    // 先写新结构（行程记录＋索引），成功后才删旧键
    backend.setItem(itineraryKey(it.id), JSON.stringify(toPersisted(it)));
    writeIndex(backend, [itemFrom(it)], it.id);
  } catch {
    // 任一步写失败：旧键原样保留，返回可提示错误（可重试）
    return { kind: 'failed', error: 'migrationFailed' };
  }
  try {
    backend.removeItem(STORAGE_KEY);
  } catch {
    // 删旧键失败仅留残键：新结构已完整写入，此后不再迁移、不覆盖，内容无损失
  }
  return { kind: 'done' };
}

export function createLocalStore(backend: LocalBackend): ItineraryStore {
  return {
    load(): LoadResult {
      const migrated = migrateLegacySingleTrip(backend);
      if (migrated.kind === 'failed') {
        return { ok: false, itinerary: null, error: migrated.error, items: [] };
      }
      const idx = readIndex(backend);
      if (idx.kind === 'missing') return { ok: true, itinerary: null, error: null, items: [] };
      if (idx.kind === 'corrupt' || idx.kind === 'io') {
        return { ok: false, itinerary: null, error: 'indexCorrupt', items: null };
      }
      if (idx.kind === 'unsupported') {
        return { ok: false, itinerary: null, error: 'unsupported', items: null };
      }
      const items = idx.value.items;
      const wanted = idx.value.currentId ?? null;
      const currentId = wanted && items.some((i) => i.id === wanted) ? wanted : items[0]?.id ?? null;
      if (!currentId) return { ok: true, itinerary: null, error: null, items };
      const rec = readItineraryAt(backend, itineraryKey(currentId));
      if (rec.kind === 'missing') return { ok: true, itinerary: null, error: null, items };
      if (rec.kind === 'corrupt') return { ok: false, itinerary: null, error: 'corrupt', items };
      if (rec.kind === 'unsupported') return { ok: false, itinerary: null, error: 'unsupported', items };
      return { ok: true, itinerary: rec.value, error: null, items };
    },

    loadTrip(id: string): LoadResult {
      const rec = readItineraryAt(backend, itineraryKey(id));
      if (rec.kind === 'missing') return { ok: true, itinerary: null, error: null, items: null };
      if (rec.kind === 'corrupt') return { ok: false, itinerary: null, error: 'corrupt', items: null };
      if (rec.kind === 'unsupported') return { ok: false, itinerary: null, error: 'unsupported', items: null };
      return { ok: true, itinerary: rec.value, error: null, items: null };
    },

    listTrips(): ListTripsResult {
      const idx = readIndex(backend);
      if (idx.kind === 'missing') return { ok: true, items: [] };
      if (idx.kind === 'ok') return { ok: true, items: idx.value.items };
      if (idx.kind === 'unsupported') return { ok: false, error: 'unsupported' };
      if (idx.kind === 'io') return { ok: false, error: 'io' };
      return { ok: false, error: 'indexCorrupt' };
    },

    save(it: Itinerary): SaveResult {
      try {
        backend.setItem(itineraryKey(it.id), JSON.stringify(toPersisted(it)));
      } catch (e) {
        // 容量不足/禁止写入：保留内存内容，由界面提示
        return { ok: false, error: errorMessage(e) };
      }
      // 同步索引元数据；保存的行程即当前行程
      try {
        const items = upsertItem(resolveItems(backend), itemFrom(it));
        writeIndex(backend, items, it.id);
        return { ok: true, error: null };
      } catch (e) {
        // 索引写入失败只影响列表元数据（行程内容已保存），由界面提示
        return { ok: false, error: errorMessage(e) };
      }
    },

    switchTo(id: string): SwitchTripResult {
      const rec = readItineraryAt(backend, itineraryKey(id));
      if (rec.kind === 'missing') return { ok: false, error: '找不到该行程记录' };
      if (rec.kind === 'corrupt') return { ok: false, error: '该行程数据损坏，无法打开（原数据保留）' };
      if (rec.kind === 'unsupported') return { ok: false, error: '该行程数据版本不识别，未覆盖原内容' };
      try {
        const items = upsertItem(resolveItems(backend), itemFrom(rec.value));
        writeIndex(backend, items, id);
        return { ok: true, itinerary: rec.value, items };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },

    copyTrip(id: string, source?: Itinerary): TripOpResult {
      let base: Itinerary | null = source ?? null;
      if (!base) {
        const rec = readItineraryAt(backend, itineraryKey(id));
        if (rec.kind !== 'ok') return { ok: false, error: '找不到要复制的行程记录（原数据保留）' };
        base = rec.value;
      }
      // 副本含全部内容，仅 id 更新（其余字段级一致，白名单随保存统一生效）
      const copy: Itinerary = { ...toPersisted(base), id: newId() };
      try {
        backend.setItem(itineraryKey(copy.id), JSON.stringify(copy));
        const items = upsertItem(resolveItems(backend), itemFrom(copy));
        // 副本不改变当前行程
        writeIndex(backend, items, readCurrentId(backend));
        return { ok: true, items };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },

    renameTrip(id: string, title: string): TripOpResult {
      const rec = readItineraryAt(backend, itineraryKey(id));
      if (rec.kind !== 'ok') return { ok: false, error: '找不到要重命名的行程记录（原数据保留）' };
      // 与领域 updateBasics 同口径：revision+1、updatedAt 刷新（当前行程由调用方走 apply）
      const next: Itinerary = { ...rec.value, title, revision: rec.value.revision + 1, updatedAt: new Date().toISOString() };
      try {
        backend.setItem(itineraryKey(id), JSON.stringify(toPersisted(next)));
        const items = upsertItem(resolveItems(backend), itemFrom(next));
        writeIndex(backend, items, readCurrentId(backend));
        return { ok: true, items };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },

    deleteTrip(id: string): TripOpResult {
      try {
        // 先删记录再改索引：删除的行程不会因索引失败而“复活”
        backend.removeItem(itineraryKey(id));
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      try {
        const prevCurrent = readCurrentId(backend);
        const items = resolveItems(backend).filter((i) => i.id !== id);
        // 删除当前行程后指向剩余首条；否则当前行程不变
        const currentId = prevCurrent === id || prevCurrent === null ? items[0]?.id ?? null : prevCurrent;
        writeIndex(backend, items, currentId);
        return { ok: true, items };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },

    rebuildIndex(): RebuildIndexResult {
      const scan = scanItineraryRecords(backend);
      // M15：枚举失败拒绝写索引，绝不静默清空
      if (!scan.ok) {
        return { ok: false, error: '无法枚举本机存储中的行程记录，索引未改写' };
      }
      const { items, skippedIds } = scan;
      try {
        const prevCurrent = readCurrentId(backend);
        const currentId = prevCurrent && items.some((i) => i.id === prevCurrent) ? prevCurrent : items[0]?.id ?? null;
        writeIndex(backend, items, currentId);
        return { ok: true, items, skippedIds };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },
  };
}
