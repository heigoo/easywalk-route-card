/**
 * 开放时间文本保守解析（R-A2）：只接受全周统一 HH:mm-HH:mm；
 * 其余形态一律返回 null（未知不等于没有，不猜测、不编造）。
 * 末尾附 placeFromSearch 的开放时间事实写入用例（2.1）。
 */
import { describe, expect, it } from 'vitest';
import { openingScheduleFromText, parseUniformOpeningText } from '../../src/domain/opening';
import { placeFromSearch } from '../../src/features/places/placeFromSearch';
import type { PlaceSearchItem } from '../../shared/contracts/api';

describe('parseUniformOpeningText：合法形态', () => {
  it('基本形态 08:00-18:30', () => {
    expect(parseUniformOpeningText('08:00-18:30')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
  });

  it('分隔符允许 ~ 与全角 ～', () => {
    expect(parseUniformOpeningText('08:00~18:30')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
    expect(parseUniformOpeningText('8:00～18:30')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
  });

  it('小时 1-2 位均可，输出统一补零为 HH:mm', () => {
    expect(parseUniformOpeningText('8:00-18:30')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
    expect(parseUniformOpeningText('0:00-23:59')).toEqual({
      startLocalTime: '00:00',
      endLocalTime: '23:59',
    });
  });

  it('两侧空白与分隔符旁空白允许', () => {
    expect(parseUniformOpeningText('  08:00 - 18:30  ')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
  });

  it('严格词表内前缀词允许：每日/每天/周一至周日/全年', () => {
    for (const prefix of ['每日', '每天', '周一至周日', '全年']) {
      expect(parseUniformOpeningText(`${prefix} 08:00-18:00`)).toEqual({
        startLocalTime: '08:00',
        endLocalTime: '18:00',
      });
    }
    expect(parseUniformOpeningText('全年08:00~18:30')).toEqual({
      startLocalTime: '08:00',
      endLocalTime: '18:30',
    });
  });
});

describe('parseUniformOpeningText：非法形态逐一返回 null', () => {
  it.each([
    ['分日描述', '周一至周五 08:00-18:00'],
    ['分日描述（词表外前缀）', '每周一至周日 08:00-18:00'],
    ['分日描述（仅周末）', '仅周末开放'],
    ['多时段', '8:00-12:00,13:30-17:30'],
    ['自然语言营业说明', '24 小时营业'],
    ['24:00 不是合法时刻', '24:00-06:00'],
    ['24:00 作为结束也不合法', '23:59-24:00'],
    ['分钟越界', '08:60-18:00'],
    ['小时越界', '25:00-26:00'],
    ['跨零点（结束早于开始）', '22:00-02:00'],
    ['结束早于开始', '18:00-08:00'],
    ['零长度时段', '08:00-08:00'],
    ['全角冒号', '08：00-18:30'],
    ['双连字符', '08:00--18:30'],
    ['缺少结束时间', '08:00'],
    ['只有前缀词', '每日'],
    ['尾部句读', '08:00-18:30。'],
    ['时段后带附加说明', '08:00-18:30 仅供参考'],
    ['时段前带自然语言', '上午 8:00-12:00'],
    ['纯文本', '电话咨询'],
  ])('%s：%s → null', (_label, text) => {
    expect(parseUniformOpeningText(text)).toBeNull();
  });

  it('空串与纯空白返回 null', () => {
    expect(parseUniformOpeningText('')).toBeNull();
    expect(parseUniformOpeningText('   ')).toBeNull();
  });
});

describe('openingScheduleFromText：单段窗口或 null', () => {
  it('合法文本 → windows 单段，带适用日期与时区', () => {
    expect(openingScheduleFromText('每日 08:00-18:30', '2026-10-01', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      windows: [{ startLocalTime: '08:00', endLocalTime: '18:30' }],
    });
  });

  it('非法文本与空串一律 null，不编造窗口', () => {
    expect(openingScheduleFromText('周一至周五 08:00-18:00', '2026-10-01', 'Asia/Shanghai')).toBeNull();
    expect(openingScheduleFromText('22:00-02:00', '2026-10-01', 'Asia/Shanghai')).toBeNull();
    expect(openingScheduleFromText('', '2026-10-01', 'Asia/Shanghai')).toBeNull();
  });
});

describe('placeFromSearch：开放时间文本写入地图参考事实（2.1）', () => {
  const base: PlaceSearchItem = {
    id: 'POI-1',
    name: '示例景点（测试数据）',
    district: '示例区',
    address: '示例路 1 号',
    location: { longitude: 116.4, latitude: 39.91 },
    entranceStatus: 'pending',
  };

  it('有文本 → openingDescription 为 amap/reported 地图参考事实（不解析、不落盘）', () => {
    const place = placeFromSearch({ ...base, openingHoursText: '08:00-18:30' }, '2026-09-22T00:00:00.000Z');
    expect(place.openingDescription).toEqual({
      value: '08:00-18:30',
      sourceType: 'amap',
      sourceName: '高德地图搜索',
      sourceReference: null,
      fetchedAt: '2026-09-22T00:00:00.000Z',
      reviewState: 'reported',
      checkedAt: null,
      applicableDate: null,
      note: '地图参考，待核对，不代表此刻开放',
    });
    // 文本不自动变成结构化窗口（第 4.2 节：自由文本未核实前不能自动填入）
    expect(place.openingSchedule.value).toBeNull();
  });

  it('文本缺失或空白 → 显式未知（unknownFact），不当作“没有开放时间”', () => {
    for (const openingHoursText of [null, undefined, '']) {
      const place = placeFromSearch({ ...base, openingHoursText });
      expect(place.openingDescription.value).toBeNull();
      expect(place.openingDescription.reviewState).toBe('unknown');
    }
  });
});
