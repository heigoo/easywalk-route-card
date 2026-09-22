/**
 * 矩阵任务的请求预算控制（设计文档第 7.4 节）。
 * 默认：最大并发 2、总发送速率不超过 1 次/秒、一次矩阵任务最多 96 次上游尝试（含重试）、
 * 整体期限 120 秒；预算用尽返回 partial，不伪造完整结果。
 *
 * 说明：预算按矩阵任务对上游的调用次数计数；调用内部对网络类故障的有限重试
 * 属单次请求层面（第 7.3 节），由 client.ts 在预算之外独立完成。
 */

export interface BudgetConfig {
  /** 最大尝试次数（含重试） */
  maxAttempts: number;
  /** 整体期限（毫秒），自创建时起算 */
  deadlineMs: number;
  /** 最大并发（单实例同时请求数上限） */
  maxConcurrent: number;
  /** 相邻两次发起的最小间隔（毫秒），控制总发送速率 */
  minIntervalMs: number;
  /** 可注入的时钟（测试用） */
  now?: () => number;
}

export interface Budget {
  /**
   * 非阻塞地获取一个调用额度与并发槽。
   * 预算用尽/到期/并发已满/速率受限均返回 false；
   * 用 canStart() 区分“预算已尽”（false）与“暂时繁忙”（true，可稍后重试）。
   */
  tryAcquire(): boolean;
  /** 释放一个并发槽（不返还已消耗的尝试次数） */
  release(): void;
  /** 是否仍有剩余尝试且未到期（不考虑并发与速率） */
  canStart(): boolean;
}

/** 第 7.4 节默认值 */
export const MATRIX_BUDGET_DEFAULTS: Omit<BudgetConfig, 'now'> = {
  maxAttempts: 96,
  deadlineMs: 120_000,
  maxConcurrent: 2,
  minIntervalMs: 1000,
};

export function createBudget(config: BudgetConfig): Budget {
  const now = config.now ?? (() => Date.now());
  const deadlineAt = now() + config.deadlineMs;
  let attemptsUsed = 0;
  let inFlight = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY;

  return {
    tryAcquire(): boolean {
      if (attemptsUsed >= config.maxAttempts) return false;
      if (now() >= deadlineAt) return false;
      if (inFlight >= config.maxConcurrent) return false;
      if (now() - lastStartAt < config.minIntervalMs) return false;
      attemptsUsed += 1;
      inFlight += 1;
      lastStartAt = now();
      return true;
    },
    release(): void {
      if (inFlight > 0) inFlight -= 1;
    },
    canStart(): boolean {
      return attemptsUsed < config.maxAttempts && now() < deadlineAt;
    },
  };
}
