/**
 * 规划条件与结果面板（UI-05；第 9.6、14.5 节）。
 * - 只接收条件、请求状态、候选与版本；不直接覆写当前行程（通过 onApply 回调）；
 * - 未设置的条件显示“未限制”，不预设通用老人体力值；
 * - 展示实际阶段，不伪造百分比；
 * - 结果因行程修改而过期时不允许应用；
 * - 已知违反硬性限制的方案不作为满足条件的推荐，只允许“作为草稿应用”。
 */
import { useState } from 'react';
import type { Itinerary } from '../../../shared/contracts/domain';
import { ceilMinutes } from '../../domain/format';
import type { PlannerCandidate } from '../../workers';
import type { UsePlanningResult } from './usePlanning';
import { applyWalkingFactor } from '../../domain/itinerary';
import { parseMinutesInput } from '../../components/fields';
import styles from './Planning.module.css';
import editor from '../itinerary/Editor.module.css';

export interface PlanningPanelProps {
  itinerary: Itinerary;
  planning: UsePlanningResult;
  onApply: (fn: (it: Itinerary) => Itinerary) => void;
}

export function PlanningPanel({ itinerary, planning, onApply }: PlanningPanelProps) {
  const { constraints } = itinerary;
  const nameOf = (id: string): string => {
    if (itinerary.origin?.id === id) return itinerary.places[itinerary.origin.placeId]?.name ?? '起点';
    if (itinerary.destination?.id === id) return itinerary.places[itinerary.destination.placeId]?.name ?? '终点';
    const n = itinerary.nodes[id];
    return n ? (itinerary.places[n.placeId]?.name ?? '未命地点') : '';
  };

  return (
    <section className={styles.section} aria-label="规划条件与自动规划">
      <h2 className={styles.title}>规划条件与自动规划</h2>

      <>
          <div className={styles.grid}>
            <ConstraintField
              id="c-total"
              label="总步行上限"
              valueSeconds={constraints.maxTotalWalkSeconds}
              onCommit={(seconds) => onApply((it) => ({ ...it, constraints: { ...it.constraints, maxTotalWalkSeconds: seconds } }))}
            />
            <ConstraintField
              id="c-continuous"
              label="连续步行上限"
              valueSeconds={constraints.maxContinuousWalkSeconds}
              onCommit={(seconds) => onApply((it) => ({ ...it, constraints: { ...it.constraints, maxContinuousWalkSeconds: seconds } }))}
            />
            <ConstraintField
              id="c-rest"
              label="最低坐休时长"
              valueSeconds={constraints.minRestSeconds}
              onCommit={(seconds) => onApply((it) => ({ ...it, constraints: { ...it.constraints, minRestSeconds: seconds } }))}
            />
            <div className={editor.field}>
              <label htmlFor="c-latest">最晚结束（当地时刻）</label>
              <input
                id="c-latest"
                type="datetime-local"
                value={constraints.latestEndLocal ?? ''}
                onChange={(e) =>
                  onApply((it) => ({
                    ...it,
                    constraints: { ...it.constraints, latestEndLocal: e.target.value || null },
                  }))
                }
              />
            </div>
            <div className={editor.field}>
              <label htmlFor="c-factor">步行时间调整（倍数）</label>
              <input
                id="c-factor"
                type="number"
                min="0.1"
                step="0.1"
                value={String(constraints.walkingFactor)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onApply((it) => applyWalkingFactor(it, v));
                }}
              />
              <span className={styles.hint}>只调整地图估算，不代表体力评估；手动填写与已采纳的时间不适用</span>
            </div>
          </div>

          <div className={styles.runRow}>
            <button
              type="button"
              className={`${editor.btn} ${editor.primary}`}
              disabled={planning.busy}
              onClick={() => void planning.run()}
            >
              {planning.busy ? '计算中…' : '计算路线'}
            </button>
            {planning.busy ? (
              <button type="button" className={editor.btn} onClick={planning.cancel}>
                取消
              </button>
            ) : null}
            {planning.stageText ? (
              <span className={styles.stage} aria-live="polite">
                {planning.stageText}
              </span>
            ) : null}
          </div>

          {planning.stale ? (
            <p className={styles.warning} role="note">
              行程已修改，请按新条件重新计算。
            </p>
          ) : null}

          {planning.error ? (
            <p className={styles.error} role="alert">
              {plannerErrorMessage(planning.error.code, planning.error.message)}
              {planning.error.retryable ? (
                <button type="button" className={`${editor.btn} ${editor.small}`} style={{ marginLeft: 'var(--sp-3)' }} onClick={() => void planning.run()}>
                  重试
                </button>
              ) : null}
            </p>
          ) : null}

          {planning.missingDataNotes.map((note) => (
            <p key={note} className={styles.hint} role="note">
              {note}
            </p>
          ))}

          {planning.result ? (
            <ResultList
              result={planning.result}
              nameOf={nameOf}
              canApply={planning.canApply}
              onApplyCandidate={planning.applyCandidate}
            />
          ) : null}
      </>
    </section>
  );
}

function ConstraintField({
  id,
  label,
  valueSeconds,
  onCommit,
}: {
  id: string;
  label: string;
  valueSeconds: number | null;
  onCommit: (seconds: number | null) => void;
}) {
  const [text, setText] = useState(valueSeconds === null ? '' : String(valueSeconds / 60));
  const commit = () => {
    const parsed = parseMinutesInput(text);
    if (!parsed.ok) return;
    if (parsed.seconds !== valueSeconds) onCommit(parsed.seconds);
  };
  return (
    <div className={editor.field}>
      <label htmlFor={id}>{label}（分钟）</label>
      <input
        id={id}
        inputMode="numeric"
        value={text}
        placeholder="未限制"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function ResultList({
  result,
  nameOf,
  canApply,
  onApplyCandidate,
}: {
  result: NonNullable<UsePlanningResult['result']>;
  nameOf: (id: string) => string;
  canApply: (c: PlannerCandidate) => boolean;
  onApplyCandidate: (c: PlannerCandidate) => void;
}) {
  const { primary, alternatives, candidates, conflicts, searchSpace } = result;
  const draftCandidates = candidates.filter((c) => !canApply(c)).slice(0, 2);

  if (!primary && alternatives.length === 0 && draftCandidates.length === 0) {
    return (
      <div className={styles.empty}>
        <p style={{ margin: 0 }}>当前候选中未找到符合这些条件的路线。</p>
        {conflicts.map((c) => (
          <p key={c} className={styles.hint}>
            {c}
          </p>
        ))}
        <p className={styles.hint}>可尝试：少去一个可选景点、调整结束时间或补充接驳；系统不会自动放宽你的上限。</p>
      </div>
    );
  }

  return (
    <div className={styles.results}>
      {searchSpace.budgetExceeded ? (
        <p className={styles.warning}>请求预算已用尽，比较范围受限；已获取的结果仍可使用。</p>
      ) : null}
      {conflicts.map((c) => (
        <p key={c} className={styles.hint}>
          {c}
        </p>
      ))}

      {primary ? (
        <CandidateCard candidate={primary} label="主要建议" nameOf={nameOf} canApply={canApply(primary)} onApply={onApplyCandidate} />
      ) : (
        <p className={styles.warning} role="note">
          当前没有可核验满足全部条件的方案；以下为待核验候选，已知部分与未知原因一并标出。
        </p>
      )}
      {alternatives.map((c, i) => (
        <CandidateCard key={i} candidate={c} label={`备选 ${i + 1}`} nameOf={nameOf} canApply={canApply(c)} onApply={onApplyCandidate} />
      ))}

      {draftCandidates.length > 0 ? (
        <details className={styles.details} open={!primary}>
          <summary>待核验或已超限的方案（{draftCandidates.length}）</summary>
          {draftCandidates.map((c, i) => (
            <CandidateCard key={i} candidate={c} label="作为草稿应用" nameOf={nameOf} canApply={false} onApply={onApplyCandidate} />
          ))}
        </details>
      ) : null}

      <p className={styles.hint}>
        比较范围限于当前节点与休息锚点之间；未设置的条件视为未限制。
      </p>
    </div>
  );
}

function CandidateCard({
  candidate,
  label,
  nameOf,
  canApply,
  onApply,
}: {
  candidate: PlannerCandidate;
  label: string;
  nameOf: (id: string) => string;
  canApply: boolean;
  onApply: (c: PlannerCandidate) => void;
}) {
  const seq = candidate.nodeOrder.filter((id) => nameOf(id) !== '');
  return (
    <article className={styles.candidate}>
      <div className={styles.candidateHead}>
        <span className={styles.candidateLabel}>{label}</span>
        <span className={styles.badge}>{candidate.verifiable ? '数据完整' : '待核验'}</span>
        {candidate.violations.length > 0 ? <span className={`${styles.badge} ${styles.badgeWarn}`}>已超限</span> : null}
      </div>

      <div className={styles.candidateMeta}>
        <span>预计步行 {candidate.totalWalkSeconds === null ? '待确认' : `${ceilMinutes(candidate.totalWalkSeconds)} 分钟`}</span>
        <span>
          最长连续{' '}
          {candidate.longestContinuousWalkSeconds === null ? '待确认' : `${ceilMinutes(candidate.longestContinuousWalkSeconds)} 分钟`}
        </span>
        <span>全程约 {candidate.totalDurationSeconds === null ? '待确认' : `${ceilMinutes(candidate.totalDurationSeconds)} 分钟`}</span>
      </div>

      <div className={styles.candidateMeta}>
        <span>保留可选景点 {candidate.keptOptional.length} 个</span>
        {candidate.droppedOptional.length > 0 ? (
          <span>省略：{candidate.droppedOptional.map(nameOf).join('、')}</span>
        ) : null}
      </div>

      <ol className={styles.order}>
        {seq.map((id) => (
          <li key={id}>{nameOf(id)}</li>
        ))}
      </ol>

      {candidate.violations.map((v) => (
        <p key={v} className={styles.error}>
          {v}
        </p>
      ))}
      {candidate.unknownFields.length > 0 ? (
        <p className={styles.hint}>待核验项：{candidate.unknownFields.slice(0, 3).join('；')}</p>
      ) : null}

      <button
        type="button"
        className={`${editor.btn} ${canApply ? editor.primary : editor.small}`}
        onClick={() => onApply(candidate)}
      >
        {canApply ? '应用此方案' : '作为草稿应用'}
      </button>
    </article>
  );
}

/** 归一化错误码 → 用户可理解的说明（第 14.7 节） */
function plannerErrorMessage(code: string, message: string): string {
  switch (code) {
    case 'AMAP_NOT_CONFIGURED':
      return '地图服务未配置，无法自动获取步行数据；手动填写与导出继续可用。';
    case 'AMAP_AUTH_ERROR':
      return '地图服务凭据无效或权限不足，请检查服务端配置后重试。';
    case 'AMAP_QUOTA_EXCEEDED':
      return '地图服务配额或频率受限，请稍后再试。';
    case 'UPSTREAM_TIMEOUT':
      return '步行数据暂时获取失败，原行程未改变；可重试或手动编辑。';
    case 'ROUTE_UNREACHABLE':
      return '部分路段没有可用的步行路线，请检查地点或改用接驳。';
    case 'UPSTREAM_DATA_INVALID':
      return '地图返回的数据异常，已按缺失处理，原行程未改变。';
    case 'INVALID_INPUT':
      return message;
    default:
      return message || '规划失败，可重试或手动编辑。';
  }
}