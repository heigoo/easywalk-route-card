/**
 * 浏览器本地保存（第 8.4、8.5 节）。
 * - 单份当前行程，键 easywalk.current-itinerary，结构含 schemaVersion；
 * - 持久化白名单：未经采纳的地图值不落盘；reported 设施属性回到待确认；
 * - 存储损坏/禁止写入/容量不足时保留内存内容并显式反馈，未经确认不清空。
 */
import type { Fact, Itinerary, Leg, PlaceRef } from '../../shared/contracts/domain';
import { SCHEMA_VERSION, itinerarySchema } from '../../shared/contracts/domain';

export const STORAGE_KEY = 'easywalk.current-itinerary';

export type StorageState = 'idle' | 'dirty' | 'saving' | 'saved' | 'saveFailed';

export interface LoadResult {
  ok: boolean;
  itinerary: Itinerary | null;
  /** corrupt=数据损坏；unsupported=schemaVersion 未识别 */
  error: 'corrupt' | 'unsupported' | null;
}

/** 按持久化白名单裁剪行程（第 8.5 节表） */
export function toPersisted(it: Itinerary): Itinerary {
  const legs: Record<string, Leg> = {};
  for (const [id, leg] of Object.entries(it.legs)) {
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
      };
    } else if (leg.state === 'failed' || leg.state === 'unreachable') {
      legs[id] = {
        ...leg,
        state: 'missing',
        failureCode: null,
      };
    } else {
      legs[id] = leg;
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

export interface ItineraryStore {
  load(): LoadResult;
  save(it: Itinerary): { ok: boolean; error: string | null };
  clear(): void;
}

export function createLocalStore(backend: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ItineraryStore {
  return {
    load(): LoadResult {
      let raw: string | null = null;
      try {
        raw = backend.getItem(STORAGE_KEY);
      } catch {
        return { ok: false, itinerary: null, error: 'corrupt' };
      }
      if (raw === null) return { ok: true, itinerary: null, error: null };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, itinerary: null, error: 'corrupt' };
      }
      const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
      if (version !== SCHEMA_VERSION) {
        return { ok: false, itinerary: null, error: 'unsupported' };
      }
      const result = itinerarySchema.safeParse(parsed);
      if (!result.success) {
        return { ok: false, itinerary: null, error: 'corrupt' };
      }
      return { ok: true, itinerary: result.data, error: null };
    },

    save(it: Itinerary): { ok: boolean; error: string | null } {
      try {
        backend.setItem(STORAGE_KEY, JSON.stringify(toPersisted(it)));
        return { ok: true, error: null };
      } catch (e) {
        // 容量不足/禁止写入：保留内存内容，由界面提示
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    clear(): void {
      try {
        backend.removeItem(STORAGE_KEY);
      } catch {
        // 忽略清理失败；未经用户确认不静默清空由上层控制
      }
    },
  };
}
