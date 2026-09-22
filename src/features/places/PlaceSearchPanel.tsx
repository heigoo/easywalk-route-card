/**
 * 地点搜索（P1；第 7.2、14.4 节）。
 * - 搜索结果必须显示城市/区县与地址，用户主动确认后才写入行程；
 * - 未确认地图候选时不自动采用列表第一项；
 * - 入口默认待确认，坐标确认前不参与自动规划；
 * - 地图不可用时说明原因，手动整理继续可用（T12）。
 */
import { useState } from 'react';
import type { PlaceSearchItem } from '../../../shared/contracts/api';
import { ApiRequestError, searchPlaces } from '../../services/api';
import styles from './Places.module.css';
import editor from '../itinerary/Editor.module.css';

export interface PlaceSearchPanelProps {
  city: string;
  onPick: (place: PlaceSearchItem, role: 'visit' | 'origin' | 'destination') => void;
}

export function PlaceSearchPanel({ city, onPick }: PlaceSearchPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [cityText, setCityText] = useState(city);
  const [items, setItems] = useState<PlaceSearchItem[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; retryable: boolean } | null>(null);
  const [searched, setSearched] = useState(false);

  const doSearch = async (targetPage: number) => {
    if (!keyword.trim() || !cityText.trim()) {
      setError({ code: 'INVALID_INPUT', message: '请填写关键词与城市', retryable: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await searchPlaces(keyword.trim(), cityText.trim(), targetPage);
      setItems(data.items);
      setNextPage(data.nextPage);
      setPage(targetPage);
      setSearched(true);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError({ code: e.code, message: e.message, retryable: e.retryable });
      } else {
        setError({ code: 'UPSTREAM_DATA_INVALID', message: '搜索失败，请稍后重试', retryable: true });
      }
      setItems([]);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="搜索地点">
      <div className={styles.row}>
        <div className={editor.field} style={{ flex: '1 1 180px' }}>
          <label htmlFor="place-keyword">地点关键词</label>
          <input
            id="place-keyword"
            type="text"
            value={keyword}
            placeholder="例如：公园东门"
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className={editor.field} style={{ flex: '0 1 140px' }}>
          <label htmlFor="place-city">搜索城市</label>
          <input id="place-city" type="text" value={cityText} onChange={(e) => setCityText(e.target.value)} />
        </div>
        <button
          type="button"
          className={`${editor.btn} ${editor.primary}`}
          disabled={busy}
          onClick={() => void doSearch(1)}
        >
          {busy ? '搜索中…' : '搜索地点'}
        </button>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error.code === 'AMAP_NOT_CONFIGURED'
            ? '地图服务未配置（服务端缺少 Web 服务 Key），可继续手动填写；需要自动获取路段时间时请联系管理员配置。'
            : error.message}
          {error.retryable ? (
            <button type="button" className={`${editor.btn} ${editor.small}`} style={{ marginLeft: 'var(--sp-3)' }} onClick={() => void doSearch(page)}>
              重试
            </button>
          ) : null}
        </p>
      ) : null}

      {searched && items.length === 0 && !error ? (
        <p className={styles.hint}>没有搜索结果，可返回手动整理；缺少坐标时该路段不能自动计算。</p>
      ) : null}

      {items.length > 0 ? (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.name}>{item.name}</span>
                <span className={styles.meta}>{[item.district, item.address].filter(Boolean).join(' · ')}</span>
              </div>
              <span className={styles.meta}>
                {item.location ? '已带坐标（入口待确认）' : '无坐标，不能自动计算该路段'}
              </span>
              <div className={styles.itemActions}>
                <button type="button" className={`${editor.btn} ${editor.small}`} onClick={() => onPick(item, 'visit')}>
                  设为景点
                </button>
                <button type="button" className={`${editor.btn} ${editor.small}`} onClick={() => onPick(item, 'origin')}>
                  设为起点
                </button>
                <button type="button" className={`${editor.btn} ${editor.small}`} onClick={() => onPick(item, 'destination')}>
                  设为终点
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {nextPage !== null ? (
        <button type="button" className={`${editor.btn} ${editor.small}`} disabled={busy} onClick={() => void doSearch(nextPage)}>
          下一页
        </button>
      ) : null}

      <p className={styles.hint}>
        只会把关键词与城市发送给地图服务；行程备注、姓名与标题不会随检索发送。
      </p>
    </section>
  );
}