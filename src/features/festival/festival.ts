/**
 * 节庆动画纯逻辑层（中秋·国庆）：节日窗口判定、按日种子、种子化场景生成。
 * 不依赖 DOM / React，全部纯函数 + 显式入参，便于单测。
 *
 * 算法哲学「月华旗潮」：节庆不是贴图，而是一个被种子约束、按日展开的
 * 生成场景——月相辉光的呼吸、旗面布浪的相位、桂瓣飘落的轨迹、烟花粒子的
 * 绽放，全部由同一个日内种子推导的参数场驱动；每一帧都是确定性随机与
 * 周期函数的合奏，同一天看到同一场月色，隔日则万象更新。
 */

/** 可复现伪随机（mulberry32）：同一 seed 永远给出同一序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按日种子：YYYYMMDD 数值，同日同景、隔日更新 */
export function seedFromDate(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export interface FestiveFeatures {
  /** 明月与月晕（中秋） */
  moon: boolean;
  /** 旗串与国旗（国庆） */
  flags: boolean;
  /** 桂花瓣飘落（中秋） */
  petals: boolean;
  /** 烟花（国庆满配；节庆窗口内偶发） */
  fireworks: boolean;
}

/**
 * 节庆窗口：9 月 20 日～10 月 7 日。
 * 9/20 起中秋氛围（月、桂瓣）；9/25 起挂旗；9/28 起偶发烟花；10/1 起烟花满配。
 */
export function festiveFeatures(date: Date): FestiveFeatures {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const inWindow = (m === 9 && d >= 20) || (m === 10 && d <= 7);
  if (!inWindow) return { moon: false, flags: false, petals: false, fireworks: false };
  return {
    moon: true,
    petals: true,
    flags: (m === 9 && d >= 25) || m === 10,
    fireworks: m === 10 || (m === 9 && d >= 28),
  };
}

export function isFestive(date: Date): boolean {
  const f = festiveFeatures(date);
  return f.moon || f.flags;
}

/** 生成场景中的一枚星 */
export interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
}

/** 一枚飘落的桂瓣（归一化坐标，0~1） */
export interface Petal {
  x0: number;
  fall: number;
  sway: number;
  size: number;
  rot: number;
  phase: number;
}

/** 旗串上的一面三角旗 */
export interface Pennant {
  x: number;
  phase: number;
  gold: boolean;
}

export interface FestivalScene {
  moon: { x: number; y: number; r: number; phase: number };
  stars: Star[];
  petals: Petal[];
  pennants: Pennant[];
  clouds: { y: number; speed: number; len: number; alpha: number }[];
  flag: { poleX: number; topY: number; w: number; h: number; phase: number } | null;
}

/**
 * 由种子生成归一化场景（坐标 0~1，与画布尺寸无关，便于响应式与单测断言）。
 * flags 关闭时不生成国旗；petals 关闭时花瓣集为空。
 */
export function buildScene(seed: number, features: FestiveFeatures): FestivalScene {
  const rnd = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < 60; i++) {
    stars.push({
      x: rnd(),
      y: rnd() * 0.55, // 星只布在上半部“夜空”
      r: 0.6 + rnd() * 1.4,
      phase: rnd() * Math.PI * 2,
    });
  }
  const petals: Petal[] = [];
  if (features.petals) {
    for (let i = 0; i < 26; i++) {
      petals.push({
        x0: rnd(),
        fall: 0.02 + rnd() * 0.05,
        sway: 0.01 + rnd() * 0.03,
        size: 2.5 + rnd() * 3,
        rot: rnd() * Math.PI,
        phase: rnd() * Math.PI * 2,
      });
    }
  }
  const pennants: Pennant[] = [];
  if (features.flags) {
    const count = 16;
    for (let i = 0; i < count; i++) {
      pennants.push({
        x: (i + 0.5) / count,
        phase: (i / count) * Math.PI * 2,
        gold: i % 3 === 2,
      });
    }
  }
  const clouds: FestivalScene['clouds'] = [];
  for (let i = 0; i < 3; i++) {
    clouds.push({
      y: 0.06 + rnd() * 0.16,
      speed: 0.004 + rnd() * 0.008,
      len: 0.12 + rnd() * 0.16,
      alpha: 0.05 + rnd() * 0.06,
    });
  }
  return {
    // 月悬右上，呼吸相位随种子漂移
    moon: { x: 0.78, y: 0.16, r: 0.055 + rnd() * 0.02, phase: rnd() * Math.PI * 2 },
    stars,
    petals,
    pennants,
    clouds,
    flag: features.flags ? { poleX: 0.05, topY: 0.1, w: 0.12, h: 0.075, phase: rnd() * Math.PI * 2 } : null,
  };
}
