/**
 * 开放时间文本的保守解析（R-A2 / R-C）。
 * R-A2：只接受“全周统一 HH:mm-HH:mm”一种形态（parseUniformOpeningText，行为保持不变）；
 * R-C：openingScheduleFromText 额外支持严格分日文法——
 * “日期组 + （休息/不开放 | 时段列表）”子句以 `;`/`；`/换行并列，日期组词表严格枚举，未列即拒。
 * 含任一无法解析的形态（跨零点、24:00、乱序、词表外描述、同一天被重复覆盖、
 * 裸时段混入分日文本等）→ 整体返回 null（宁缺勿假，禁止“半真”数据）。
 * 出游日期未被文本明确覆盖（明确开放或明确“休息/不开放”）→ 不写结构化时段，只留原文。
 * 解析结果仍需用户核对后才可信赖。
 *
 * 词表扩展（仍保守）：
 * - 「星期X / 星期天」归一为「周X」；「工作日」归一为「周一至周五」；
 * - 「24 小时 / 全天（开放/营业）」表达为当日 00:00-23:59（不跨零点、不用 24:00）。
 */
import type { OpeningSchedule } from '../../shared/contracts/domain';

/** 允许的前缀词：严格词表，词表外的任何描述（如“每周一至周日”）一律不接受 */
const UNIFORM_PREFIXES = ['每日', '每天', '周一至周日', '全年'];

/** 全天/24 小时：按 00:00-23:59 表达（不用 24:00，不跨零点） */
const ALL_DAY_WINDOW = { startLocalTime: '00:00', endLocalTime: '23:59' } as const;
const ALL_DAY_TOKEN_RE = /^(?:24\s*小时(?:营业|开放)?|全天(?:开放|营业)?)$/;

/** 同义写法归一：星期X→周X（星期天/日→周日）、工作日→周一至周五 */
function normalizeDayAliases(text: string): string {
  return text
    .replace(/星期天/g, '周日')
    .replace(/星期日/g, '周日')
    .replace(/星期([一二三四五六])/g, '周$1')
    .replace(/工作日/g, '周一至周五');
}

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

/**
 * 由文本生成指定出游日期的开放时段（R-A2 单段 + R-C 分日文法）。
 * - 纯全周单段文本继续走原逻辑解析（兼容既有行为）；
 *   分日文本按 applicableDate 是星期几求值：明确开放 → 其 windows（可多段），
 *   明确“休息/不开放” → windows 为空数组（明确当天不开放）。
 * - 出游日期未被任何日期组覆盖 → null（不写结构化时段，只留原文）。
 * - applicableDate 非法（非 YYYY-MM-DD 或不存在的日期）、
 *   或任一子段/子形态不可解析 → 整体 null（解析不出就不写、不编造）。
 */
export function openingScheduleFromText(
  text: string,
  applicableDate: string,
  timezone: string,
): OpeningSchedule | null {
  const weekday = weekdayOfDate(applicableDate);
  if (weekday === null) return null;
  const normalized = normalizeDayAliases(text);
  // 裸「24 小时 / 全天」：整周全天（可带全周/工作日前缀）
  if (isAllDayText(normalized)) {
    return { applicableDate, timezone, windows: [{ ...ALL_DAY_WINDOW }] };
  }
  const uniform = parseUniformOpeningText(normalized);
  if (uniform) return { applicableDate, timezone, windows: [uniform] };
  const byWeekday = parseDayClauses(normalized);
  if (!byWeekday) return null;
  const windows = byWeekday.get(weekday);
  // 出游日期未被文本明确覆盖：不写结构化时段
  if (!windows) return null;
  return { applicableDate, timezone, windows };
}

/** 整段文本是否为「全天/24 小时」形态（可带全周或工作日日期组前缀） */
function isAllDayText(text: string): boolean {
  const t = text.trim();
  if (ALL_DAY_TOKEN_RE.test(t)) return true;
  return /^(每天|每日|周一至周日|全年|工作日|周一至周五)\s+(24\s*小时(?:营业|开放)?|全天(?:开放|营业)?)$/.test(t);
}

/** 单日词“周X”（星期X 已归一为周X） */
const DAY_TOKEN = '周[一二三四五六日]';
/**
 * 日期组：严格枚举（全周词/固定区间/周末/单日/逗号列表），未列即拒。
 * 例：`每天`、`每日`、`周一至周日`、`全年`、`周一至周五`、`周六至周日`、`周末`、`周六`、`周一,周三`。
 */
const DAY_GROUP = `(每天|每日|周一至周日|全年|周一至周五|周六至周日|周末|${DAY_TOKEN}(?:\\s*[,，]\\s*${DAY_TOKEN})*)`;
/** 子句：日期组 +（空/休息/不开放/时段列表）；捕获 1=日期组、2=状态或时段部分 */
const CLAUSE_RE = new RegExp(`^\\s*${DAY_GROUP}\\s*(.*?)\\s*$`);
/** 单个时段（与 R-A2 的时间规则完全一致） */
const WINDOW_RE = new RegExp(`^\\s*${TIME}\\s*${SEPARATOR}\\s*${TIME}\\s*$`);
/** 同一日期组内多时段分隔符：半角逗号或顿号 */
const WINDOW_SPLIT = /[,、]/;
/** 多段并列分隔符：分号（半角/全角）或换行 */
const CLAUSE_SPLIT = /[;；\n]/;

/** 中文星期 → getUTCDay 口径（0=周日 … 6=周六） */
const WEEKDAY_INDEX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0 };

/**
 * 分日文法整体解析：子句并列 → 每个星期几的开放时段（休息/不开放 → 空数组）。
 * 任一子段不可解析、或同一天被两个日期组/同一列表重复覆盖 → 整体 null（不猜测）。
 */
function parseDayClauses(text: string): Map<number, UniformOpeningWindow[]> | null {
  const clauses = text
    .trim()
    .replace(/\r\n?/g, '\n')
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim());
  const byWeekday = new Map<number, UniformOpeningWindow[]>();
  for (const clause of clauses) {
    // 空子段（多余的分隔符/空行）不猜测其含义，整体拒绝
    if (clause === '') return null;
    const m = CLAUSE_RE.exec(clause);
    if (!m) return null;
    const days = weekdaysOfGroup(m[1]);
    if (!days) return null;
    const rest = m[2];
    let windows: UniformOpeningWindow[];
    if (rest === '休息' || rest === '不开放') {
      // 明确不开放：该日时段为空数组（“明确覆盖”仍然成立）
      windows = [];
    } else if (ALL_DAY_TOKEN_RE.test(rest.trim())) {
      // 「24 小时 / 全天」按 00:00-23:59 表达
      windows = [{ ...ALL_DAY_WINDOW }];
    } else {
      const parsed = parseWindowList(rest);
      if (!parsed) return null;
      windows = parsed;
    }
    for (const day of days) {
      // 同一天被重复/重叠定义（含列表内重复）：无法确定谁生效，整体拒绝
      if (byWeekday.has(day)) return null;
      byWeekday.set(day, [...windows]);
    }
  }
  return byWeekday;
}

/** 日期组 → 覆盖的星期几集合；词表外写法返回 null */
function weekdaysOfGroup(group: string): number[] | null {
  switch (group) {
    case '每天':
    case '每日':
    case '周一至周日':
    case '全年':
      return [0, 1, 2, 3, 4, 5, 6];
    case '周一至周五':
      return [1, 2, 3, 4, 5];
    case '周六至周日':
    case '周末':
      return [6, 0];
    default: {
      // 单日或逗号列表（可含全角逗号）
      const days: number[] = [];
      for (const item of group.split(/[,，]/)) {
        const m = /^周([一二三四五六日])$/.exec(item.trim());
        if (!m) return null;
        days.push(WEEKDAY_INDEX[m[1]]);
      }
      return days.length > 0 ? days : null;
    }
  }
}

/** 时段列表：多个 HH:mm-HH:mm 以 `,`/`、` 分隔；任一段非法即整体 null；支持单段「24 小时/全天」 */
function parseWindowList(text: string): UniformOpeningWindow[] | null {
  if (ALL_DAY_TOKEN_RE.test(text.trim())) return [{ ...ALL_DAY_WINDOW }];
  const windows: UniformOpeningWindow[] = [];
  for (const part of text.split(WINDOW_SPLIT)) {
    const m = WINDOW_RE.exec(part.trim());
    if (!m) return null;
    const start = normalizeTime(m[1], m[2]);
    const end = normalizeTime(m[3], m[4]);
    if (!start || !end) return null;
    // 跨零点/零长度时段与既有规则一致：不可解析
    if (start >= end) return null;
    windows.push({ startLocalTime: start, endLocalTime: end });
  }
  return windows.length > 0 ? windows : null;
}

/**
 * 校验适用日期并求出其星期几（getUTCDay 口径，星期几与时区无关）。
 * 非 YYYY-MM-DD 或不存在的日期（如 2026-02-30）返回 null。
 */
function weekdayOfDate(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getUTCDay();
}

/** 补零为 HH:mm；越界输入返回 null */
function normalizeTime(hourText: string, minuteText: string): string | null {
  const h = Number(hourText);
  const m = Number(minuteText);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
