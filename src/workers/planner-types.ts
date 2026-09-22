/**
 * 自动规划算法核心与 Worker 的消息契约（详细设计说明书第 6 章）。
 * 纯数据类型，不依赖 DOM / Node，可在 Worker 与测试环境同构使用。
 */
import type { Itinerary } from '../../shared/contracts/domain';

/** 边键格式：${fromNodeId}|${toNodeId}（第 6.2.4 节） */
export type PlannerEdgeKey = string;

/** 规划输入：行程快照 + 调用方已填入的地图矩阵边（第 6.2.5 节） */
export interface PlannerInput {
  itinerary: Itinerary;
  /**
   * 已知有向边步行秒数（调用方已应用步速因子）：
   * number = 已知步行秒数；null = 明确不可达；缺失 = 未知（未查询/失败，不等于不可达，第 6.6 节）。
   */
  edges: Record<PlannerEdgeKey, number | null>;
}

/** 一个候选方案（第 6.4、6.5 节） */
export interface PlannerCandidate {
  /** 完整节点序列：起点＋各区间（锚点与景点）＋终点（第 6.4.2 节） */
  nodeOrder: string[];
  /** 已采纳路段键（${from}|${to}），含同一入口零衔接边（第 7.2 节） */
  adoptedLegKeys: string[];
  /** 总步行秒数；存在未知步行时为 null（口径同 src/domain/compute.ts 第 5.2 节） */
  totalWalkSeconds: number | null;
  /** 最长连续步行秒数；存在未知步行区间时为 null（第 5.3 节） */
  longestContinuousWalkSeconds: number | null;
  /** 总行程用时（含等待开门与停留/休息）；存在未知时长时为 null */
  totalDurationSeconds: number | null;
  /** 保留的可选景点（原始顺序） */
  keptOptional: string[];
  /** 省略的可选景点（原始顺序） */
  droppedOptional: string[];
  /** 已确定违反硬性限制的说明（文案与 evaluateConstraints 一致，第 5.3 节） */
  violations: string[];
  /** 待核验原因（字段缺失/未查询等，第 6.6 节） */
  unknownFields: string[];
  /** 可核验＝全部输入已知且无未知字段（第 6.4.6 节） */
  verifiable: boolean;
}

/** 搜索空间统计（第 6.3、6.4.5 节） */
export interface PlannerSearchSpace {
  /** 枚举过的组合数（不含被“至少保留一个景点”规则排除的空行程） */
  enumerated: number;
  /** 已知违反硬限被提前剪枝的分支数（第 6.4.5 节；未知数据不按零成本剪枝） */
  pruned: number;
  /** 请求预算超出标记：纯计算阶段恒为 false，预算由调用方在请求阶段控制（第 6.6 节） */
  budgetExceeded: boolean;
}

export interface PlannerResult {
  resultId: string;
  inputFingerprint: string;
  candidates: PlannerCandidate[];
  primary: PlannerCandidate | null;
  alternatives: PlannerCandidate[];
  searchSpace: PlannerSearchSpace;
  /** 数据不完整/不可达等全局提示（第 6.6 节）；数据缺失时不给“所有方案均不可行”的确定结论 */
  conflicts: string[];
  generatedAt: string;
}

/** Worker 消息协议版本：不匹配时按错误回复（第 6 章） */
export const PLANNER_PROTOCOL_VERSION = 1;

export type PlannerErrorCode = 'VERSION_MISMATCH' | 'PLAN_FAILED' | 'REQUEST_CANCELLED';

export interface PlannerError {
  code: PlannerErrorCode;
  message: string;
}

/** 请求消息：{type, version, requestId, inputFingerprint, input} */
export interface PlannerRequestMessage {
  type: 'plan';
  version: number;
  requestId: string;
  inputFingerprint: string;
  input: PlannerInput;
}

/** 成功响应：回传 requestId、inputFingerprint 与 result */
export interface PlannerSuccessMessage {
  requestId: string;
  inputFingerprint: string;
  result: PlannerResult;
}

/** 失败响应：版本不匹配或计算异常 */
export interface PlannerFailureMessage {
  requestId: string;
  inputFingerprint: string;
  error: PlannerError;
}

export type PlannerResponseMessage = PlannerSuccessMessage | PlannerFailureMessage;
