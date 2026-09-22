/**
 * 开放时间文本的保守解析（R-A2）。
 * 只接受“全周统一 HH:mm-HH:mm”一种形态（可带严格词表内的前缀词）；
 * 其余任何形态一律返回 null（未知不等于没有），不做任何不可靠的语义推断，
 * 不把自由文本自动填入结构化窗口。解析结果仍需用户核对后才可信赖。
 */
import type { OpeningSchedule } from '../../shared/contracts/domain';

/** 允许的前缀词：严格词表，词表外的任何描述（如“周一至周五”）一律不接受 */
const UNIFORM_PREFIXES = ['每日', '每天', '周一至周日', '全年'];

/** 24 小时制时间：小时 0-23（1-2 位），分钟 0-59（必须 2 位） */
const TIME = '([01]?\\d|2[0-3]):([0-5]\\d)';
/** 时段分隔符：半角/全角波浪线或连字符 */
const SEPARATOR = '[-~～]';

const UNIFORM_RE = new RegExp(
  `^\\s*(?:${UNIFORM_PREFIXES.join('|')})?\\s*${TIME}\\s*${SEPARATOR}\\s*${TIME}\\s*$`,
);

export interface UniformOpeningWindow {
  startLocalTime: string; // "HH:mm"（小时补零）
  endLocalTime: string; // "HH:mm"（小时补零）
}

/**
 * 保守解析全周统一开放时段。
 * 接受：`08:00-18:30`、`8:00～18:30`、`08:00~18:30`、`每日 08:00-18:00` 等（两侧空白允许）。
 * 拒绝（返回 null）：分日描述、多时段、24 小时营业、24:00、跨零点（如 22:00-02:00）、
 * 结束不晚于开始、空串及任何词表外文本。
 */
export function parseUniformOpeningText(text: string): UniformOpeningWindow | null {
  const m = UNIFORM_RE.exec(text);
  if (!m) return null;
  const start = normalizeTime(m[1], m[2]);
  const end = normalizeTime(m[3], m[4]);
  if (!start || !end) return null;
  // 跨零点/零长度时段无法用“当日单段窗口”可靠表达，不猜测，返回 null
  if (start >= end) return null;
  return { startLocalTime: start, endLocalTime: end };
}

/** 由保守解析结果生成单段开放时段；解析不出即 null，不编造 */
export function openingScheduleFromText(
  text: string,
  applicableDate: string,
  timezone: string,
): OpeningSchedule | null {
  const parsed = parseUniformOpeningText(text);
  if (!parsed) return null;
  return { applicableDate, timezone, windows: [parsed] };
}

/** 补零为 HH:mm；越界输入返回 null */
function normalizeTime(hourText: string, minuteText: string): string | null {
  const h = Number(hourText);
  const m = Number(minuteText);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
