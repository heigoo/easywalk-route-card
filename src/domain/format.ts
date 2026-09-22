/**
 * 面向用户的文本格式化（第 4.1 节）：
 * - 界面分钟向上取整并标“约”；
 * - 合计先汇总原值再取整，不把显示文本再次相加；
 * - 未知为 null，不写 0。
 */

/** 秒 → 展示分钟（向上取整）。null → null（未知） */
export function ceilMinutes(seconds: number | null): number | null {
  if (seconds === null) return null;
  return Math.ceil(seconds / 60);
}

/** “约 X 分钟”；未知返回 fallback（默认“待确认”） */
export function approxMinutesText(seconds: number | null, fallback = '待确认'): string {
  const m = ceilMinutes(seconds);
  return m === null ? fallback : `约 ${m} 分钟`;
}

/** 秒数文本，用于卡片摘要值（不含“约”，由 label 承担） */
export function minutesValueText(seconds: number | null): string {
  const m = ceilMinutes(seconds);
  return m === null ? '待确认' : String(m);
}

/** UTC 时间戳 → Asia/Shanghai 展示文本（Intl 带时区，不依赖浏览器本地时区） */
export function formatShanghaiDateTime(utcIso: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 行程日期文本；未填写返回 null（不显示精确到达时刻） */
export function travelDateText(travelDate: string | null): string | null {
  if (!travelDate) return null;
  return travelDate;
}

/** 文件名安全清理（第 10.4 节）：不含 Key、完整地址或无关个人信息 */
export function safeFileName(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'easywalk';
}
