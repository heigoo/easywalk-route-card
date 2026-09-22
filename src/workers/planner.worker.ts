/**
 * 自动规划 Web Worker（第 6 章）：只做消息接线，全部计算在纯函数 plan() 中完成。
 *
 * 协议：
 * - 请求 {type:'plan', version, requestId, inputFingerprint, input}
 * - 成功回传 {requestId, inputFingerprint, result}
 * - 版本不匹配或计算异常回传 {requestId, inputFingerprint, error}
 *
 * 不在这里发任何网络请求；edges 由调用方从地图矩阵结果填入。
 */
import { plan } from './planner';
import {
  PLANNER_PROTOCOL_VERSION,
  type PlannerRequestMessage,
  type PlannerResponseMessage,
} from './planner-types';

/** 处理一条规划请求（纯函数，便于在 Node 环境测试消息协议） */
export function handlePlannerMessage(message: PlannerRequestMessage): PlannerResponseMessage {
  const requestId = message?.requestId ?? '';
  const inputFingerprint = message?.inputFingerprint ?? '';
  const base = { requestId, inputFingerprint };
  if (typeof message?.version !== 'number') {
    return { ...base, error: { code: 'PLAN_FAILED', message: '请求消息缺少协议版本' } };
  }
  if (message.version !== PLANNER_PROTOCOL_VERSION) {
    return {
      ...base,
      error: {
        code: 'VERSION_MISMATCH',
        message: `协议版本不匹配：期望 ${PLANNER_PROTOCOL_VERSION}，收到 ${message.version}`,
      },
    };
  }
  try {
    const result = plan(message.input);
    return { ...base, result };
  } catch (error) {
    return {
      ...base,
      error: {
        code: 'PLAN_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Worker 线程接线：非 Worker 环境（如 Node 测试）下自动跳过
if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function' &&
  typeof window === 'undefined'
) {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<PlannerRequestMessage>) => void) | null;
    postMessage(message: PlannerResponseMessage): void;
  };
  scope.onmessage = (event) => {
    scope.postMessage(handlePlannerMessage(event.data));
  };
}
