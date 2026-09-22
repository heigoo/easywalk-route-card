/**
 * 归一化错误（设计文档第 7.3 节）。
 * 统一错误契约只携带错误码、可读信息、是否可重试与字段定位；
 * 不带上游堆栈、完整上游地址或 Key。
 */
import type { FailureCode } from '../../shared/contracts/domain';

/**
 * 错误码 → 是否可在同一任务内自动重试（按第 7.3 节“行为”列）：
 * - INVALID_INPUT / AMAP_AUTH_ERROR / ROUTE_UNREACHABLE / UPSTREAM_DATA_INVALID：重试结果相同或无意义；
 * - AMAP_QUOTA_EXCEEDED：按限制停止或延后，不继续刷接口；
 * - UPSTREAM_TIMEOUT：第 7.3 节“预算内有限重试”属单次请求层面，由 client.ts 重试一次消化，
 *   矩阵/失败记录层面不再自动重试（用户可随时手动重新发起新请求）；
 * - AMAP_NOT_CONFIGURED / REQUEST_CANCELLED：配置或取消状态，重试无意义。
 */
export const ERROR_RETRYABLE: Record<FailureCode, boolean> = {
  INVALID_INPUT: false,
  AMAP_NOT_CONFIGURED: false,
  AMAP_AUTH_ERROR: false,
  AMAP_QUOTA_EXCEEDED: false,
  UPSTREAM_TIMEOUT: false,
  ROUTE_UNREACHABLE: false,
  UPSTREAM_DATA_INVALID: false,
  REQUEST_CANCELLED: false,
};

export class AmapError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  /** 单次请求层面的网络类短暂故障（第 7.4 节：仅对这类故障重试一次） */
  readonly transient: boolean;

  constructor(code: FailureCode, message: string, options?: { transient?: boolean }) {
    super(message);
    this.name = 'AmapError';
    this.code = code;
    this.retryable = ERROR_RETRYABLE[code];
    this.transient = options?.transient ?? false;
  }
}

export function isAmapError(error: unknown): error is AmapError {
  return error instanceof AmapError;
}

/**
 * 高德业务 infocode → 本站错误码（第 7.3/7.5 节）：
 * 10003 为日配额超限、10004 为访问过频（QPS）；其余 1xxxx 鉴权类；
 * 高德 2xxxx 为参数/协议类；其余未知错误一律 UPSTREAM_DATA_INVALID，不当网络故障重试。
 */
export function amapInfocodeToFailureCode(infocode: unknown): FailureCode {
  const code =
    typeof infocode === 'string' || typeof infocode === 'number' ? String(infocode).trim() : '';
  if (code === '10003' || code === '10004') return 'AMAP_QUOTA_EXCEEDED';
  if (/^1\d{4}$/.test(code)) return 'AMAP_AUTH_ERROR';
  if (/^2\d{4}$/.test(code)) return 'INVALID_INPUT';
  return 'UPSTREAM_DATA_INVALID';
}
