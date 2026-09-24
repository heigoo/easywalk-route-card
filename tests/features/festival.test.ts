/**
 * 节庆动画纯逻辑层验证（中秋·国庆）：
 * 按日种子可复现、节令窗口边界、场景随特性开关裁剪。
 */
import { describe, expect, it } from 'vitest';
import {
  buildScene,
  festiveFeatures,
  isFestive,
  mulberry32,
  seedFromDate,
} from '../../src/features/festival/festival';

const allOn = { moon: true, flags: true, petals: true, fireworks: true };

describe('mulberry32', () => {
  it('同种子序列可复现，且落在 [0,1)', () => {
    const a = mulberry32(20260925);
    const b = mulberry32(20260925);
    for (let i = 0; i < 50; i++) {
      const x = a();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      expect(x).toBe(b());
    }
  });
});

describe('seedFromDate', () => {
  it('同日同种子、隔日不同', () => {
    const d1 = new Date(2026, 8, 25);
    const d2 = new Date(2026, 8, 25, 23, 59);
    const d3 = new Date(2026, 8, 26);
    expect(seedFromDate(d1)).toBe(seedFromDate(d2));
    expect(seedFromDate(d1)).not.toBe(seedFromDate(d3));
    expect(seedFromDate(d1)).toBe(20260925);
  });
});

describe('festiveFeatures 节令窗口', () => {
  it('窗口外全部关闭', () => {
    expect(festiveFeatures(new Date(2026, 7, 31))).toEqual({
      moon: false,
      flags: false,
      petals: false,
      fireworks: false,
    });
    expect(isFestive(new Date(2026, 10, 8))).toBe(false);
  });

  it('9/20 中秋氛围（月＋桂瓣）先于国旗出现', () => {
    const f = festiveFeatures(new Date(2026, 8, 20));
    expect(f.moon).toBe(true);
    expect(f.petals).toBe(true);
    expect(f.flags).toBe(false);
  });

  it('9/25 挂旗、9/28 烟花、10/1 国庆满配', () => {
    expect(festiveFeatures(new Date(2026, 8, 25)).flags).toBe(true);
    expect(festiveFeatures(new Date(2026, 8, 25)).fireworks).toBe(false);
    expect(festiveFeatures(new Date(2026, 8, 28)).fireworks).toBe(true);
    expect(festiveFeatures(new Date(2026, 9, 1))).toEqual(allOn);
  });

  it('10/7 仍在窗口内，10/8 关闭', () => {
    expect(isFestive(new Date(2026, 9, 7))).toBe(true);
    expect(isFestive(new Date(2026, 9, 8))).toBe(false);
  });
});

describe('buildScene', () => {
  it('同种子同场景（逐字段一致）', () => {
    expect(buildScene(20260925, allOn)).toEqual(buildScene(20260925, allOn));
  });

  it('flags 关闭时不生成国旗与旗串', () => {
    const s = buildScene(20260925, { ...allOn, flags: false });
    expect(s.flag).toBeNull();
    expect(s.pennants).toHaveLength(0);
  });

  it('petals 关闭时无桂瓣', () => {
    const s = buildScene(20260925, { ...allOn, petals: false });
    expect(s.petals).toHaveLength(0);
  });

  it('场景坐标全部归一化（0~1）', () => {
    const s = buildScene(20261001, allOn);
    for (const star of s.stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(1);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(0.55);
    }
  });
});
