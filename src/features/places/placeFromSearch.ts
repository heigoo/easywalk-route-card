/**
 * 地图搜索候选 → 领域 PlaceRef（第 4.3 节）。
 * 用户主动选择才写入行程；入口状态默认待确认，坐标来自检索结果。
 * 开放时间文本只作地图参考（reported）：会话内显示“地图参考（待核对）”，
 * 按持久化白名单重载后回到待确认；不在此处做任何语义解析。
 */
import type { Fact, OpeningSchedule, PlaceRef } from '../../../shared/contracts/domain';
import { unknownFact } from '../../../shared/contracts/domain';
import type { PlaceSearchItem } from '../../../shared/contracts/api';
import { newId } from '../../domain/id';

export function placeFromSearch(item: PlaceSearchItem, now: string = new Date().toISOString()): PlaceRef {
  const text = item.openingHoursText ?? null;
  const openingDescription: Fact<string> =
    text !== null && text.trim() !== ''
      ? {
          value: text,
          sourceType: 'amap',
          sourceName: '高德地图搜索',
          sourceReference: null,
          fetchedAt: now,
          reviewState: 'reported',
          checkedAt: null,
          applicableDate: null,
          note: '地图参考，待核对，不代表此刻开放',
        }
      : unknownFact<string>();
  return {
    id: newId(),
    name: item.name,
    providerPoiId: item.id,
    location: item.location,
    coordinateRevision: 0,
    // 地点名不等于入口已确认（第 4.3 节）
    entranceConfirmed: false,
    openingDescription,
    openingSchedule: unknownFact<OpeningSchedule>(),
  };
}
