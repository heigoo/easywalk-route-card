/**
 * 自动规划 Worker 客户端（第 6 章）。
 * 维护 Worker 实例并按 requestId 关联请求与响应；
 * 取消即 terminate Worker，并以 REQUEST_CANCELLED 拒绝全部未完成请求（第 7.3 节）。
 */
import { PLANNER_PROTOCOL_VERSION } from './planner-types';
import type {
  PlannerInput,
  PlannerRequestMessage,
  PlannerResponseMessage,
  PlannerResult,
} from './planner-types';

export * from './planner-types';
export { plan, listCandidatePairs } from './planner';

/** 与 Worker 通信所需的最小接口，便于测试注入桩 */
export interface PlannerWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<PlannerResponseMessage>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<PlannerResponseMessage>) => void): void;
}

export type PlannerClientErrorCode = 'REQUEST_CANCELLED' | 'VERSION_MISMATCH' | 'PLAN_FAILED';

export class PlannerClientError extends Error {
  readonly code: PlannerClientErrorCode;

  constructor(code: PlannerClientErrorCode, message: string) {
    super(message);
    this.name = 'PlannerClientError';
    this.code = code;
  }
}

export interface PlannerClientOptions {
  /** 自定义 Worker 工厂（测试注入桩）；缺省创建真实 module Worker */
  createWorker?: () => PlannerWorkerLike;
}

export interface PlannerClient {
  run(input: PlannerInput, inputFingerprint: string): Promise<PlannerResult>;
  cancel(): void;
}

let requestSequence = 0;

export function createPlannerClient(options: PlannerClientOptions = {}): PlannerClient {
  const createWorker =
    options.createWorker ??
    ((): PlannerWorkerLike =>
      new Worker(new URL('./planner.worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as PlannerWorkerLike);

  let worker: PlannerWorkerLike | null = null;
  let cancelled = false;
  const pending = new Map<
    string,
    { resolve: (result: PlannerResult) => void; reject: (error: Error) => void }
  >();

  const handleMessage = (event: MessageEvent<PlannerResponseMessage>): void => {
    const message = event.data;
    if (!message || typeof message.requestId !== 'string') return;
    const entry = pending.get(message.requestId);
    if (!entry) return; // 已取消或未知响应：忽略
    pending.delete(message.requestId);
    if ('error' in message) {
      entry.reject(new PlannerClientError(message.error.code, message.error.message));
    } else {
      entry.resolve(message.result);
    }
  };

  const ensureWorker = (): PlannerWorkerLike => {
    if (!worker) {
      worker = createWorker();
      worker.addEventListener('message', handleMessage);
    }
    return worker;
  };

  return {
    run(input: PlannerInput, inputFingerprint: string): Promise<PlannerResult> {
      if (cancelled) {
        return Promise.reject(
          new PlannerClientError('REQUEST_CANCELLED', '规划客户端已取消，无法继续请求'),
        );
      }
      const currentWorker = ensureWorker();
      requestSequence += 1;
      const requestId = `req-${requestSequence}`;
      const message: PlannerRequestMessage = {
        type: 'plan',
        version: PLANNER_PROTOCOL_VERSION,
        requestId,
        inputFingerprint,
        input,
      };
      return new Promise<PlannerResult>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        currentWorker.postMessage(message);
      });
    },

    cancel(): void {
      cancelled = true;
      const currentWorker = worker;
      worker = null;
      if (currentWorker) {
        currentWorker.removeEventListener('message', handleMessage);
        currentWorker.terminate();
      }
      const error = new PlannerClientError('REQUEST_CANCELLED', '用户取消，规划请求已终止');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    },
  };
}
