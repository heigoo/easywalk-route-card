/**
 * 地图搜索候选 → 领域 PlaceRef（第 4.3 节）。
 * 用户主动选择才写入行程；入口状态默认待确认，坐标来自检索结果。
 */
import type { OpeningSchedule, PlaceRef } from '../../../shared/contracts/domain';
import { unknownFact } from '../../../shared/contracts/domain';
import type { PlaceSearchItem } from '../../../shared/contracts/api';
import { newId } from '../../domain/id';

export function placeFromSearch(item: PlaceSearchItem): PlaceRef {
  return {
    id: newId(),
    name: item.name,
    providerPoiId: item.id,
    location: item.location,
    coordinateRevision: 0,
    // 地点名不等于入口已确认（第 4.3 节）
    entranceConfirmed: false,
    openingDescription: unknownFact<string>(),
    openingSchedule: unknownFact<OpeningSchedule>(),
  };
}