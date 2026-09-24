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
    // 周一至周五未覆盖周六（2026-10-03）出游日：未被明确覆盖 → 不写结构化时段
    expect(openingScheduleFromText('周一至周五 08:00-18:00', '2026-10-03', 'Asia/Shanghai')).toBeNull();
    expect(openingScheduleFromText('22:00-02:00', '2026-10-01', 'Asia/Shanghai')).toBeNull();
    expect(openingScheduleFromText('', '2026-10-01', 'Asia/Shanghai')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R-C：分日文法（严格枚举）按出游日期求值
// 参考星期：2026-10-01 周四、2026-10-03 周六、2026-10-04 周日、2026-09-28 周一、2026-09-30 周三
// ---------------------------------------------------------------------------

describe('openingScheduleFromText：分日文法覆盖出游日期 → 正确 windows', () => {
  it('固定区间：周一至周五 覆盖周四出游日 → 单段窗口', () => {
    expect(openingScheduleFromText('周一至周五 08:00-18:00', '2026-10-01', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      windows: [{ startLocalTime: '08:00', endLocalTime: '18:00' }],
    });
  });

  it('单日日期组：周六 覆盖周六出游日', () => {
    expect(openingScheduleFromText('周六 09:00-17:00', '2026-10-03', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-10-03',
      timezone: 'Asia/Shanghai',
      windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
    });
  });

  it('逗号列表（含全角逗号）：周一,周三 仅覆盖周一/周三', () => {
    for (const text of ['周一,周三 08:00-18:00', '周一，周三 08:00-18:00']) {
      for (const date of ['2026-09-28', '2026-09-30']) {
        expect(openingScheduleFromText(text, date, 'Asia/Shanghai')).toEqual({
          applicableDate: date,
          timezone: 'Asia/Shanghai',
          windows: [{ startLocalTime: '08:00', endLocalTime: '18:00' }],
        });
      }
    }
  });

  it('周末＝周六+周日；周六至周日同义', () => {
    for (const text of ['周末 09:00-17:00', '周六至周日 09:00-17:00']) {
      for (const date of ['2026-10-03', '2026-10-04']) {
        expect(openingScheduleFromText(text, date, 'Asia/Shanghai')?.windows).toEqual([
          { startLocalTime: '09:00', endLocalTime: '17:00' },
        ]);
      }
    }
  });

  it('全周词：每天/每日/周一至周日/全年 覆盖任意出游日', () => {
    for (const prefix of ['每天', '每日', '周一至周日', '全年']) {
      expect(
        openingScheduleFromText(`${prefix} 08:00-18:00`, '2026-10-04', 'Asia/Shanghai')?.windows,
      ).toEqual([{ startLocalTime: '08:00', endLocalTime: '18:00' }]);
    }
  });

  it('多时段：同一日期组内多个 window（, 与 、 分隔均支持）', () => {
    for (const text of ['周末 09:00-17:00,20:00-21:30', '周末 09:00-17:00、20:00-21:30']) {
      expect(openingScheduleFromText(text, '2026-10-04', 'Asia/Shanghai')?.windows).toEqual([
        { startLocalTime: '09:00', endLocalTime: '17:00' },
        { startLocalTime: '20:00', endLocalTime: '21:30' },
      ]);
    }
  });

  it('多段并列（; / ； / 换行分隔）按出游日取对应日期组', () => {
    for (const sep of [';', '；', '\n']) {
      const text = `周一至周五 08:00-18:00${sep}周六 09:00-17:00`;
      expect(openingScheduleFromText(text, '2026-10-03', 'Asia/Shanghai')?.windows).toEqual([
        { startLocalTime: '09:00', endLocalTime: '17:00' },
      ]);
      expect(openingScheduleFromText(text, '2026-10-01', 'Asia/Shanghai')?.windows).toEqual([
        { startLocalTime: '08:00', endLocalTime: '18:00' },
      ]);
    }
  });

  it('纯全周单段文本兼容既有解析', () => {
    expect(openingScheduleFromText('08:00-18:30', '2026-10-01', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      windows: [{ startLocalTime: '08:00', endLocalTime: '18:30' }],
    });
  });
});

describe('openingScheduleFromText：休息/不开放 → windows 空数组（明确不开放）', () => {
  it('周六 休息 覆盖周六 → windows: []', () => {
    expect(openingScheduleFromText('周六 休息', '2026-10-03', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-10-03',
      timezone: 'Asia/Shanghai',
      windows: [],
    });
  });

  it('周末 不开放 覆盖周日 → windows: []', () => {
    expect(openingScheduleFromText('周末 不开放', '2026-10-04', 'Asia/Shanghai')?.windows).toEqual([]);
  });

  it('周一至周五开放;周末休息：周日 → 不开放，周四 → 开放时段', () => {
    const text = '周一至周五 08:00-18:00;周末 休息';
    expect(openingScheduleFromText(text, '2026-10-04', 'Asia/Shanghai')?.windows).toEqual([]);
    expect(openingScheduleFromText(text, '2026-10-01', 'Asia/Shanghai')?.windows).toEqual([
      { startLocalTime: '08:00', endLocalTime: '18:00' },
    ]);
  });

  it('每天 不开放：任意出游日 → windows: []', () => {
    expect(openingScheduleFromText('每天 不开放', '2026-10-01', 'Asia/Shanghai')?.windows).toEqual([]);
  });
});

describe('openingScheduleFromText：出游日未被覆盖或日期非法 → null（不编造）', () => {
  it('周一至周五 未覆盖周六出游日 → null', () => {
    expect(openingScheduleFromText('周一至周五 08:00-18:00', '2026-10-03', 'Asia/Shanghai')).toBeNull();
  });

  it('并列段均未覆盖出游日 → null', () => {
    expect(
      openingScheduleFromText('周一至周五 08:00-18:00;周六 09:00-17:00', '2026-10-04', 'Asia/Shanghai'),
    ).toBeNull();
  });

  it('applicableDate 非法或不存在 → null（即使文本可解析）', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', '2026-10-01 ', 'not-a-date', '']) {
      expect(openingScheduleFromText('每天 08:00-18:00', date, 'Asia/Shanghai')).toBeNull();
    }
  });
});

describe('openingScheduleFromText：混合非法形态整体拒绝（任一子段不可解析 → 整体 null）', () => {
  it.each([
    ['跨零点段混入分日文本', '周一至周五 08:00-18:00;周六 22:00-02:00'],
    ['多时段中一段跨零点', '周六 09:00-17:00,22:00-01:00'],
    ['24:00 不是合法时刻', '周一至周五 08:00-24:00'],
    ['乱序（结束早于开始）', '周一 18:00-08:00'],
    ['零长度时段', '周一 08:00-08:00'],
    ['词表外前缀', '每周一至周五 08:00-18:00'],
    ['词表外日期组', '周一至周五 09:00-17:00;节假日 09:00-10:00'],
    ['未列区间', '周二至周四 08:00-18:00'],
    ['词表外状态词', '周一 不营业'],
    ['节假日仍不在词表', '节假日 09:00-10:00'],
    ['日期组后无状态也无时段', '周一至周五'],
    ['附加说明混入', '周一至周五 08:00-18:00 仅供参考'],
    ['重复覆盖同一天（跨日期组）', '每天 08:00-18:00;周六 09:00-10:00'],
    ['重复覆盖同一天（开放+休息）', '周一至周五 08:00-18:00;周三 休息'],
    ['重复覆盖同一天（列表内重复）', '周一,周一 08:00-18:00'],
    ['裸时段混入分日文本（前置）', '08:00-18:00;周六 09:00-17:00'],
    ['裸时段混入分日文本（后置）', '周六 09:00-17:00;20:00-21:00'],
    ['无日期组的多时段裸文本', '8:00-12:00,13:30-17:30'],
    ['空子段（多余分隔符）', '周一至周五 08:00-18:00;'],
  ])('%s：%s → null', (_label, text) => {
    expect(openingScheduleFromText(text, '2026-10-01', 'Asia/Shanghai')).toBeNull();
  });
});

describe('openingScheduleFromText：词表扩展（星期X / 工作日 / 24小时·全天）', () => {
  it('星期X 归一为周X：星期一 覆盖周一出游日', () => {
    expect(openingScheduleFromText('星期一 08:00-18:00', '2026-09-28', 'Asia/Shanghai')).toEqual({
      applicableDate: '2026-09-28',
      timezone: 'Asia/Shanghai',
      windows: [{ startLocalTime: '08:00', endLocalTime: '18:00' }],
    });
  });

  it('星期天/星期日 归一为周日', () => {
    for (const text of ['星期天 09:00-17:00', '星期日 09:00-17:00']) {
      expect(openingScheduleFromText(text, '2026-10-04', 'Asia/Shanghai')?.windows).toEqual([
        { startLocalTime: '09:00', endLocalTime: '17:00' },
      ]);
    }
  });

  it('工作日＝周一至周五：覆盖周四、不覆盖周六', () => {
    expect(openingScheduleFromText('工作日 08:00-18:00', '2026-10-01', 'Asia/Shanghai')?.windows).toEqual([
      { startLocalTime: '08:00', endLocalTime: '18:00' },
    ]);
    expect(openingScheduleFromText('工作日 08:00-18:00', '2026-10-03', 'Asia/Shanghai')).toBeNull();
  });

  it('24 小时/全天（含营业/开放）→ 00:00-23:59，覆盖任意出游日', () => {
    for (const text of ['24小时', '24 小时', '24小时营业', '24小时开放', '全天', '全天开放', '全天营业']) {
      expect(openingScheduleFromText(text, '2026-10-01', 'Asia/Shanghai')).toEqual({
        applicableDate: '2026-10-01',
        timezone: 'Asia/Shanghai',
        windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
      });
    }
  });

  it('日期组 + 24 小时：工作日全天、周末休息', () => {
    const text = '工作日 24小时;周末 休息';
    expect(openingScheduleFromText(text, '2026-10-01', 'Asia/Shanghai')?.windows).toEqual([
      { startLocalTime: '00:00', endLocalTime: '23:59' },
    ]);
    expect(openingScheduleFromText(text, '2026-10-03', 'Asia/Shanghai')?.windows).toEqual([]);
  });

  it('每日 24小时 前缀形态可解析；24:00 仍非法', () => {
    expect(openingScheduleFromText('每日 24小时', '2026-10-02', 'Asia/Shanghai')?.windows).toEqual([
      { startLocalTime: '00:00', endLocalTime: '23:59' },
    ]);
    expect(openingScheduleFromText('周一至周五 08:00-24:00', '2026-10-01', 'Asia/Shanghai')).toBeNull();
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
