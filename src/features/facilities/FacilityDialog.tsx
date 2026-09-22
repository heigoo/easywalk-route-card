/**
 * 设施备注（需求 R03、第 4.4 节）：
 * 厕所开放、台阶有无逐属性记录；默认“待确认”，不提供一键全部核验；
 * 用户核对时记录核对日期；没查到不能标成“无”。
 */
import { useEffect, useState } from 'react';
import type { Fact, Itinerary, RouteNode } from '../../../shared/contracts/domain';
import { Dialog } from '../../components/Dialog';
// 表单控件样式与编辑区共用同一套语义令牌（需求 13.6、13.7）
import editor from '../itinerary/Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

export interface FacilityDialogProps {
  open: boolean;
  node: RouteNode | null;
  itinerary: Itinerary;
  onClose: () => void;
  /** 由调用方应用 upsertNodeFacilityFact */
  onSave: (nodeId: string, kind: 'toilet' | 'stairs', factKey: string, fact: Fact<unknown>) => void;
}

function getFact(it: Itinerary, nodeId: string, kind: 'toilet' | 'stairs', key: string): Fact<unknown> | null {
  const rec = it.facilities.find(
    (f) => f.kind === kind && f.target.type === 'node' && f.target.nodeId === nodeId,
  );
  return (rec?.facts[key] as Fact<unknown> | undefined) ?? null;
}

export function FacilityDialog({ open, node, itinerary, onClose, onSave }: FacilityDialogProps) {
  const [toiletState, setToiletState] = useState<'unknown' | 'checked'>('unknown');
  const [toiletText, setToiletText] = useState('');
  const [stairsState, setStairsState] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [stairsNote, setStairsNote] = useState('');

  useEffect(() => {
    if (!open || !node) return;
    const toilet = getFact(itinerary, node.id, 'toilet', 'open');
    setToiletState(toilet && toilet.reviewState === 'userChecked' && toilet.value !== null ? 'checked' : 'unknown');
    setToiletText(toilet?.value ? String(toilet.value) : '');
    const stairs = getFact(itinerary, node.id, 'stairs', 'exists');
    setStairsState(
      stairs?.value === true ? 'yes' : stairs?.value === false ? 'no' : 'unknown',
    );
    setStairsNote(stairs?.note ?? '');
  }, [open, node, itinerary]);

  if (!node) return null;

  const confirm = () => {
    const now = new Date().toISOString();
    const toiletFact: Fact<unknown> =
      toiletState === 'checked'
        ? {
            value: toiletText.trim() || null,
            sourceType: 'user',
            sourceName: null,
            sourceReference: null,
            fetchedAt: null,
            reviewState: 'userChecked',
            checkedAt: now,
            applicableDate: itinerary.travelDate,
            note: null,
          }
        : {
            value: null,
            sourceType: 'unknown',
            sourceName: null,
            sourceReference: null,
            fetchedAt: null,
            reviewState: 'unknown',
            checkedAt: null,
            applicableDate: null,
            note: null,
          };
    onSave(node.id, 'toilet', 'open', toiletFact);

    const stairsFact: Fact<unknown> =
      stairsState === 'unknown'
        ? {
            value: null,
            sourceType: 'unknown',
            sourceName: null,
            sourceReference: null,
            fetchedAt: null,
            reviewState: 'unknown',
            checkedAt: null,
            applicableDate: null,
            note: null,
          }
        : {
            value: stairsState === 'yes',
            sourceType: 'user',
            sourceName: null,
            sourceReference: null,
            fetchedAt: null,
            reviewState: 'userChecked',
            checkedAt: now,
            applicableDate: itinerary.travelDate,
            note: stairsNote.trim() || null,
          };
    onSave(node.id, 'stairs', 'exists', stairsFact);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title="设施备注（逐属性核对）">
      <div className={editor.field}>
        <label htmlFor="toilet-state">厕所开放情况</label>
        <select id="toilet-state" value={toiletState} onChange={(e) => setToiletState(e.target.value as typeof toiletState)}>
          <option value="unknown">待确认</option>
          <option value="checked">已核对</option>
        </select>
      </div>
      {toiletState === 'checked' ? (
        <div className={editor.field}>
          <label htmlFor="toilet-text">开放时段说明</label>
          <input id="toilet-text" type="text" value={toiletText} onChange={(e) => setToiletText(e.target.value)} placeholder="例如：8:00-18:00" />
        </div>
      ) : null}

      <div className={editor.field}>
        <label htmlFor="stairs-state">台阶情况</label>
        <select id="stairs-state" value={stairsState} onChange={(e) => setStairsState(e.target.value as typeof stairsState)}>
          <option value="unknown">待确认</option>
          <option value="yes">有台阶</option>
          <option value="no">无台阶（已核对）</option>
        </select>
      </div>
      {stairsState === 'yes' ? (
        <div className={editor.field}>
          <label htmlFor="stairs-note">替代通行说明</label>
          <input id="stairs-note" type="text" value={stairsNote} onChange={(e) => setStairsNote(e.target.value)} placeholder="例如：西侧有无障碍坡道" />
        </div>
      ) : null}

      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-small)' }}>
        核对仅表示你本次确认的实际情况，不代表永久有效；地图返回的信息会标注来源与获取时间。
      </p>

      <div className={dialogStyles.actions}>
        <button type="button" className={editor.btn} onClick={onClose}>
          取消
        </button>
        <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={confirm}>
          确认修改
        </button>
      </div>
    </Dialog>
  );
}
