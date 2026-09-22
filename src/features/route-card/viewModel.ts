/**
 * CardViewModel：领域计算与纸面渲染之间的唯一接口（第 10.2 节）。
 * 纯数据：只含字符串、数字、布尔、枚举与数组；不含 DOM、函数或领域对象引用。
 * 网页预览与图片导出必须消费同一实例。
 */

export type BlockKind = 'header' | 'summary' | 'node' | 'leg' | 'note' | 'notice' | 'skipped' | 'source';
export type BreakMode = 'atomic' | 'text';

interface BlockBase {
  id: string;
  kind: BlockKind;
  /** atomic 整块不可拆；text 超过整页高度时按文本行拆分 */
  breakMode: BreakMode;
  /** 为真时不得与紧随其后的块分到不同页 */
  stickWithNext: boolean;
  /** 分组标题，仅分组首块出现 */
  sectionTitleText: string | null;
}

export interface HeaderBlock extends BlockBase {
  kind: 'header';
  titleText: string;
  subtitleText: string | null;
  dateText: string | null;
  generatedAtText: string;
}

export type SummaryKey = 'totalWalk' | 'totalDuration' | 'longestWalk' | 'restCount';
export type SummaryValueState = 'known' | 'partial' | 'unknown' | 'violated';
export interface SummaryItem {
  key: SummaryKey;
  labelText: string;
  valueText: string;
  unitText: string;
  state: SummaryValueState;
  noteText: string | null;
}
export interface SummaryBlock extends BlockBase {
  kind: 'summary';
  items: SummaryItem[];
}

export type NodeRole = 'origin' | 'visit' | 'rest' | 'destination';
export interface NodeBadge {
  text: string;
  tone: 'neutral' | 'brand' | 'warning';
}
export interface NodeNotice {
  text: string;
  severity: 'info' | 'warning' | 'error';
}
export interface NodeBlock extends BlockBase {
  kind: 'node';
  role: NodeRole;
  /** 仅景点有值 */
  indexText: string | null;
  titleText: string;
  metaLines: string[];
  badges: NodeBadge[];
  notices: NodeNotice[];
}

export interface LegBlock extends BlockBase {
  kind: 'leg';
  mainText: string;
  secondaryText: string | null;
  state: 'ready' | 'missing' | 'stale';
}

export interface NoteBlock extends BlockBase {
  kind: 'note';
  ownerNodeId: string;
  text: string;
}

export interface NoticeBlock extends BlockBase {
  kind: 'notice';
  text: string;
  severity: 'info' | 'warning' | 'error';
  anchorBlockId: string | null;
}

export interface SkippedItem {
  titleText: string;
  noteText: string | null;
}
export interface SkippedBlock extends BlockBase {
  kind: 'skipped';
  items: SkippedItem[];
}

export interface SourceItem {
  labelText: string;
  valueText: string;
}
export interface SourceBlock extends BlockBase {
  kind: 'source';
  items: SourceItem[];
  checkText: string;
}

export type CardBlock =
  | HeaderBlock
  | SummaryBlock
  | NodeBlock
  | LegBlock
  | NoteBlock
  | NoticeBlock
  | SkippedBlock
  | SourceBlock;

export interface CardMeta {
  titleText: string;
  subtitleText: string | null;
  dateText: string | null;
  generatedAt: string;
  generatedAtText: string;
}

export type CardStatusKind = 'complete' | 'draft' | 'violated' | 'blocked';
export interface CardStatusNotice {
  text: string;
  severity: 'info' | 'warning' | 'error';
  anchorBlockId: string | null;
}
export interface CardStatusVm {
  kind: CardStatusKind;
  notices: CardStatusNotice[];
}

/** 顶层视图模型 */
export interface CardViewModel {
  version: 1;
  meta: CardMeta;
  status: CardStatusVm;
  blocks: CardBlock[];
  /** 页脚模板；导出时按页回填页码 */
  footText: string;
}
