/**
 * 可插入路线的歇脚候选（连续步行超限时的有限补救，R03/T08）。
 * - 仅收录「已确认可坐 + 有坐标」的 rest-candidate；未核实座位不自动插入；
 * - 虚拟节点 id = rest-cand:{facilityId}，供规划边键与矩阵请求使用，应用时再物化为 rest 节点。
 */
import type { Fact, Gcj02Coordinate, Itinerary } from '../../shared/contracts/domain';
import { coordinateSchema } from '../../shared/contracts/domain';

export const INSERT_REST_PREFIX = 'rest-cand:';

export interface InsertableRestCandidate {
  virtualId: string;
  facilityId: string;
  name: string;
  location: Gcj02Coordinate;
  /** 候选所挂的站点（插入边仅考虑与该站相邻的有效路段） */
  hostNodeId: string;
  seatFact: Fact<boolean>;
}

export function insertRestVirtualId(facilityId: string): string {
  return INSERT_REST_PREFIX + facilityId;
}

export function parseInsertRestVirtualId(id: string): string | null {
  return id.startsWith(INSERT_REST_PREFIX) ? id.slice(INSERT_REST_PREFIX.length) : null;
}

function factCoordinate(value: unknown): Gcj02Coordinate | null {
  const parsed = coordinateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 已确认可坐且有坐标的歇脚候选（坐标缺失不能自动取路段时间，不进插入枚举） */
export function listInsertableRestCandidates(it: Itinerary): InsertableRestCandidate[] {
  const out: InsertableRestCandidate[] = [];
  for (const f of it.facilities) {
    if (f.kind !== 'rest-candidate' || f.target.type !== 'node') continue;
    const host = it.nodes[f.target.nodeId];
    if (!host || host.skipped) continue;
    const facts = f.facts as Record<string, Fact<unknown> | undefined>;
    const seat = facts.seat as Fact<boolean> | undefined;
    if (!seat || seat.value !== true || seat.reviewState !== 'userChecked') continue;
    const location = factCoordinate(facts.location?.value);
    if (!location) continue;
    const rawName = facts.name?.value;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : '未命名歇脚点';
    out.push({
      virtualId: insertRestVirtualId(f.id),
      facilityId: f.id,
      name,
      location,
      hostNodeId: host.id,
      seatFact: seat,
    });
  }
  return out;
}
