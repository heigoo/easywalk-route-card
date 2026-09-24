/**
 * 景点节点卡（需求 13.7）：序号、名称、停留/园内步行、提醒、操作。
 * 必去/可选/已跳过状态用文字+徽标共同表达，不只靠颜色。
 * 设施摘要（Task 3）：显示已记录的厕所/歇脚点候选（名称＋属性状态），措辞含“候选”。
 * 歇脚点候选可一键转为休息点（Task 3 / R-B）：转换入口随候选记录走，记录迁移后自动消失。
 */
import type { Fact, FacilityRecord, PlaceRef, RouteNode } from '../../../shared/contracts/domain';
import { ceilMinutes } from '../../domain/format';
import styles from './Editor.module.css';

export interface RouteNodeCardProps {
  node: RouteNode;
  place: PlaceRef | undefined;
  /** 该节点已记录的设施记录（厕所/歇脚点候选摘要用） */
  facilities?: FacilityRecord[];
  /** 歇脚点候选一键转休息点（Task 3 / R-B）；未提供时不显示转换入口 */
  onConvertRestCandidate?: (facilityId: string) => void;
  index: number | null;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onFacility: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSkip: () => void;
  onDelete: () => void;
}

/** 单条设施记录 → “名称＋属性状态”摘要；无名且属性未核对的不显示（未知不等于没有） */
function facilitySummary(f: FacilityRecord): string | null {
  const facts = f.facts as Record<string, Fact<unknown> | undefined>;
  const rawName = facts.name?.value;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
  if (f.kind === 'rest-candidate') {
    const seat = facts.seat;
    const checked = seat?.reviewState === 'userChecked';
    if (!name && !checked) return null;
    const status = !checked
      ? '座位待确认'
      : seat?.value === true
        ? '你已核对：可坐'
        : seat?.value === false
          ? '你已核对：不可坐'
          : '你已核对';
    return name ? `歇脚点候选：${name}（${status}）` : `歇脚点候选（${status}）`;
  }
  if (f.kind === 'toilet') {
    const open = facts.open;
    const checked = open?.reviewState === 'userChecked';
    if (!name && !checked) return null;
    const status = !checked
      ? '待确认'
      : open?.value
        ? `你已核对：${String(open.value)}`
        : '你已核对';
    return name ? `厕所：${name}（${status}）` : `厕所（${status}）`;
  }
  return null;
}

/** 设施摘要条目：歇脚点候选恒显示（可一键转休息点）；无名且未核对时显式“待补充/待确认” */
function facilityItem(f: FacilityRecord): string | null {
  const summary = facilitySummary(f);
  if (summary !== null) return summary;
  if (f.kind === 'rest-candidate') return '歇脚点候选（名称待补充，座位待确认）';
  return null;
}

/** 转换后的显示名：名称缺失→“未命名歇脚点”（与领域层转换口径一致） */
function candidateDisplayName(f: FacilityRecord): string {
  const rawName = (f.facts as Record<string, Fact<unknown> | undefined>).name?.value;
  return typeof rawName === 'string' && rawName.trim() ? rawName.trim() : '未命名歇脚点';
}

export function RouteNodeCard({
  node,
  place,
  facilities = [],
  onConvertRestCandidate,
  index,
  isFirst,
  isLast,
  onEdit,
  onFacility,
  onMoveUp,
  onMoveDown,
  onSkip,
  onDelete,
}: RouteNodeCardProps) {
  const isVisit = node.kind === 'visit';
  const facilityItems = facilities
    .map((f) => ({ f, text: facilityItem(f) }))
    .filter((x): x is { f: FacilityRecord; text: string } => x.text !== null);
  return (
    <article className={styles.nodeCard} aria-label={place?.name ?? '节点'}>
      <div className={styles.nodeHead}>
        <span className={styles.nodeTitle}>
          {index !== null ? <span className={styles.nodeIndex}>{index} </span> : null}
          {place?.name ?? '未命地点'}
        </span>
        {isVisit ? (
          <span className={`${styles.badge} ${node.required ? '' : styles.brand}`}>{node.required ? '必去' : '可选 · 累了可跳过'}</span>
        ) : (
          <span className={styles.badge}>休息点</span>
        )}
      </div>

      <div className={styles.nodeMeta}>
        {isVisit ? (
          <>
            <span>停留 {node.visitSeconds === null ? '待确认' : `${ceilMinutes(node.visitSeconds)} 分钟`}</span>
            <span>园内步行 {node.insideWalkSeconds === null ? '待确认' : `${ceilMinutes(node.insideWalkSeconds)} 分钟`}</span>
          </>
        ) : (
          <span>坐下歇 {node.restSeconds === null ? '待确认' : `${ceilMinutes(node.restSeconds)} 分钟`}</span>
        )}
        {node.kind === 'rest' && node.seatFact.value !== true ? <span>座位待确认</span> : null}
      </div>

      {facilityItems.length > 0 ? (
        <ul className={styles.facilitySummary} aria-label="设施摘要">
          {facilityItems.map(({ f, text }) => (
            <li key={f.id}>
              <span>{text}</span>
              {f.kind === 'rest-candidate' && onConvertRestCandidate ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.small}`}
                  aria-label={`转为休息点：${candidateDisplayName(f)}`}
                  onClick={() => onConvertRestCandidate(f.id)}
                >
                  转为休息点
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {node.notes.trim() ? <div className={styles.nodeNotes}>{node.notes.trim()}</div> : null}

      <div className={styles.nodeActions}>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onEdit}>
          编辑
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onFacility}>
          设施备注
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onSkip}>
          跳过此站
        </button>
        {/* 次要与危险操作收纳（认知负荷）：排序与删除不占常驻视线，仍全键盘可达 */}
        <details className={styles.moreActions}>
          <summary className={`${styles.btn} ${styles.small}`}>更多操作</summary>
          <div className={styles.moreActionsRow}>
            <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onMoveUp} disabled={isFirst} aria-label="上移">
              上移
            </button>
            <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onMoveDown} disabled={isLast} aria-label="下移">
              下移
            </button>
            <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onDelete}>
              删除
            </button>
          </div>
        </details>
      </div>
    </article>
  );
}
