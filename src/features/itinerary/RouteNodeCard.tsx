/**
 * 景点节点卡（需求 13.7）：序号、名称、停留/园内步行、提醒、操作。
 * 必去/可选/已跳过状态用文字+徽标共同表达，不只靠颜色。
 */
import type { PlaceRef, RouteNode } from '../../../shared/contracts/domain';
import { ceilMinutes } from '../../domain/format';
import styles from './Editor.module.css';

export interface RouteNodeCardProps {
  node: RouteNode;
  place: PlaceRef | undefined;
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

export function RouteNodeCard({
  node,
  place,
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
  return (
    <article className={styles.nodeCard} aria-label={place?.name ?? '节点'}>
      <div className={styles.nodeHead}>
        <span className={styles.nodeTitle}>
          {index !== null ? <span className={styles.nodeIndex}>{index} </span> : null}
          {place?.name ?? '未命地点'}
        </span>
        {isVisit ? (
          <span className={`${styles.badge} ${node.required ? '' : 'brand'}`}>{node.required ? '必去' : '可选 · 累了可跳过'}</span>
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

      {node.notes.trim() ? <div className={styles.nodeNotes}>{node.notes.trim()}</div> : null}

      <div className={styles.nodeActions}>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onEdit}>
          编辑
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onFacility}>
          设施备注
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onMoveUp} disabled={isFirst} aria-label="上移">
          上移
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onMoveDown} disabled={isLast} aria-label="下移">
          下移
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onSkip}>
          跳过此站
        </button>
        <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onDelete}>
          删除
        </button>
      </div>
    </article>
  );
}
