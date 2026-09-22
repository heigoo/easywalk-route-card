import type { Itinerary } from '../../shared/contracts/domain';
import { activeSequence } from '../../shared/contracts/domain';

/**
 * 规划输入指纹（第 4.1、8.2 节）。
 * 由有效输入形成；只有标题等不影响路线的字段变化不改变指纹。
 * 使用 FNV-1a 稳定哈希，前后端同构可用（不依赖 Node crypto）。
 */
export function computeInputFingerprint(it: Itinerary): string {
  const seq = activeSequence(it);
  const relevant = {
    titleIgnored: undefined,
    seq,
    nodes: seq.map((id) => {
      const n = it.nodes[id];
      if (!n) return null;
      const place = it.places[n.placeId];
      return {
        id: n.id,
        kind: n.kind,
        placeId: n.placeId,
        coordRev: place?.coordinateRevision ?? null,
        loc: place?.location ?? null,
        entrance: place?.entranceConfirmed ?? null,
        skipped: n.skipped,
        visitSeconds: n.kind === 'visit' ? n.visitSeconds : null,
        insideWalkSeconds: n.kind === 'visit' ? n.insideWalkSeconds : null,
        restSeconds: n.kind === 'rest' ? n.restSeconds : null,
        required: n.kind === 'visit' ? n.required : null,
      };
    }),
    constraints: it.constraints,
    travelDate: it.travelDate,
    departureLocalTime: it.departureLocalTime,
    timezone: it.timezone,
    city: it.city,
  };
  return fnv1a(stableStringify(relevant));
}

/** 确定性 JSON 序列化：对象键排序，保证同构输入得到同一指纹 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp-${hash.toString(16).padStart(8, '0')}`;
}
