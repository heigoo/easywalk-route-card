/**
 * 节庆动画层「月华旗潮」（中秋·国庆）。
 * 纯视觉覆盖层：fixed 铺满视口、pointer-events:none，压在编辑/预览之上、
 * 低于底部操作条(30)与弹窗(40/41)，不拦截任何交互，不进入导出画面。
 * 取色全部来自 tokens.css 的 --fest-* 令牌；prefers-reduced-motion 时只绘静态一帧。
 */
import { useEffect, useRef } from 'react';
import { buildScene, festiveFeatures, seedFromDate, type FestivalScene } from './festival';
import styles from './Festival.module.css';

export interface FestivalOverlayProps {
  /** 是否显示节庆动画 */
  enabled: boolean;
  /** 每次递增触发一轮烟花庆祝（如导出成功） */
  celebrateSignal?: number;
  /** 覆盖“当前日期”（预览/测试用）；缺省取系统时间 */
  now?: Date;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export function FestivalOverlay({ enabled, celebrateSignal = 0, now }: FestivalOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<Spark[]>([]);
  const celebrateRef = useRef(celebrateSignal);

  // 烟花：celebrateSignal 递增即绽放（导出成功等流程节点）
  useEffect(() => {
    if (celebrateSignal > celebrateRef.current) {
      const canvas = canvasRef.current;
      if (canvas && enabled) burstFireworks(canvas.width, canvas.height, sparksRef.current);
    }
    celebrateRef.current = celebrateSignal;
  }, [celebrateSignal, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 令牌取色（组件不散写颜色）
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const colorMoon = token('--fest-moon', 'hsl(45 90% 88%)');
    const colorGlow = token('--fest-moon-glow', 'hsl(42 95% 72%)');
    const colorFlag = token('--fest-flag', 'hsl(356 72% 46%)');
    const colorGold = token('--fest-gold', 'hsl(43 92% 54%)');
    const colorPetal = token('--fest-petal', 'hsl(36 70% 72%)');
    const colorStar = token('--fest-star', 'hsl(220 60% 88%)');

    const features = festiveFeatures(now ?? new Date());
    const scene: FestivalScene = buildScene(seedFromDate(now ?? new Date()), features);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let running = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (t: number) => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      ctx.clearRect(0, 0, W, H);

      // 星：上半部夜空闪烁
      for (const s of scene.stars) {
        const tw = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.8 + s.phase));
        ctx.globalAlpha = tw;
        ctx.fillStyle = colorStar;
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 月：辉光呼吸 + 月面 + 环形山
      const m = scene.moon;
      const mx = m.x * W;
      const my = m.y * H;
      const mr = m.r * Math.min(W, H) * 1.6;
      const breath = 1 + 0.06 * Math.sin(t * 0.7 + m.phase);
      const glow = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 2.6 * breath);
      glow.addColorStop(0, colorGlow);
      glow.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(mx, my, mr * 2.6 * breath, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = colorMoon;
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = colorGlow;
      for (const c of CRATERS) {
        ctx.beginPath();
        ctx.arc(mx + c[0] * mr, my + c[1] * mr, c[2] * mr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 薄云：横越月面的丝缕
      for (const c of scene.clouds) {
        const cx = ((t * c.speed + c.y) % 1.2 - 0.1) * W;
        ctx.globalAlpha = c.alpha;
        ctx.fillStyle = colorMoon;
        ctx.beginPath();
        ctx.ellipse(cx, (c.y + 0.04) * H, c.len * W, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 桂瓣：斜落 + 摇摆
      ctx.fillStyle = colorPetal;
      for (const p of scene.petals) {
        const y = ((p.fall * t + p.phase / (Math.PI * 2)) % 1.05) * H;
        const x = (p.x0 + p.sway * Math.sin(t * 1.1 + p.phase)) * W;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot + Math.sin(t + p.phase) * 0.6);
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // 旗串：横幅 + 摆动三角旗（红金相间）
      if (scene.pennants.length > 0) {
        const p0 = { x: 0, y: 30 };
        const p1 = { x: W / 2, y: 86 };
        const p2 = { x: W, y: 30 };
        ctx.strokeStyle = colorGold;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
        ctx.stroke();
        for (const pn of scene.pennants) {
          const u = pn.x;
          const bx = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x;
          const by = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y;
          const sway = Math.sin(t * 1.6 + pn.phase) * 0.18;
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(sway);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = pn.gold ? colorGold : colorFlag;
          ctx.beginPath();
          ctx.moveTo(-9, 0);
          ctx.lineTo(9, 0);
          ctx.lineTo(0, 24);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // 国旗：左上旗杆 + 布浪红旗 + 五星
      if (scene.flag) {
        drawFlag(ctx, scene.flag, t, W, H, colorFlag, colorGold);
      }

      // 烟花粒子
      const sparks = sparksRef.current;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life += 1 / 60;
        if (s.life >= s.maxLife) {
          sparks.splice(i, 1);
          continue;
        }
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.04; // 重力
        s.vx *= 0.985;
        s.vy *= 0.985;
        ctx.globalAlpha = Math.max(0, 1 - s.life / s.maxLife);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const loop = (ms: number) => {
      if (!running) return;
      draw(ms / 1000);
      raf = requestAnimationFrame(loop);
    };

    if (reduceMotion) {
      draw(0); // 静态一帧，不做动画
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [enabled, now]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className={styles.overlay} aria-hidden="true" data-testid="festival-overlay" />;
}

/** 月面环形山（相对月心的归一化偏移 x, y, r）——固定微布局，随种子仅整体呼吸 */
const CRATERS: [number, number, number][] = [
  [-0.3, -0.25, 0.18],
  [0.25, 0.1, 0.24],
  [-0.05, 0.45, 0.14],
  [0.45, -0.4, 0.1],
];

/** 国旗布浪绘制：竖切片正弦位移模拟飘扬，五星随浪起伏 */
function drawFlag(
  ctx: CanvasRenderingContext2D,
  flag: NonNullable<FestivalScene['flag']>,
  t: number,
  W: number,
  H: number,
  colorFlag: string,
  colorGold: string,
) {
  const x0 = flag.poleX * W;
  const y0 = flag.topY * H;
  const fw = flag.w * W;
  const fh = flag.h * H;
  // 旗杆
  ctx.strokeStyle = colorGold;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 6);
  ctx.lineTo(x0, y0 + fh * 1.9);
  ctx.stroke();

  // 旗面：24 条竖切片，越靠旗尾波幅越大
  const slices = 24;
  const sw = fw / slices;
  ctx.fillStyle = colorFlag;
  for (let i = 0; i < slices; i++) {
    const k = i / slices;
    const dy = Math.sin(t * 3 + flag.phase - k * 4) * fh * 0.09 * k;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(x0 + i * sw, y0 + dy, sw + 1, fh * (1 - 0.04 * k));
  }

  // 五星：一大四小，随所在切片的波幅起伏
  const starDy = (u: number) => Math.sin(t * 3 + flag.phase - u * 4) * fh * 0.09 * u;
  ctx.fillStyle = colorGold;
  ctx.globalAlpha = 0.95;
  drawStar(ctx, x0 + fw * 0.16, y0 + fh * 0.3 + starDy(0.16), fh * 0.13, -Math.PI / 2);
  const smalls: [number, number][] = [
    [0.3, 0.12],
    [0.36, 0.24],
    [0.36, 0.4],
    [0.3, 0.52],
  ];
  for (const [u, v] of smalls) {
    drawStar(ctx, x0 + fw * u, y0 + fh * v + starDy(u), fh * 0.05, -Math.PI / 2);
  }
  ctx.globalAlpha = 1;
}

/** 五角星路径 */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.4;
    const a = rot + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** 流程庆祝烟花：三簇错落绽放（金/红/星光三色令牌） */
function burstFireworks(w: number, h: number, sparks: Spark[]) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const colors = ['hsl(43 92% 54%)', 'hsl(356 72% 54%)', 'hsl(45 90% 82%)'];
  const sites = [
    { x: 0.28, y: 0.3, delay: 0 },
    { x: 0.62, y: 0.22, delay: 0.12 },
    { x: 0.45, y: 0.38, delay: 0.24 },
  ];
  for (const site of sites) {
    window.setTimeout(() => {
      const cx = site.x * w;
      const cy = site.y * h;
      const color = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < 42; i++) {
        const a = (i / 42) * Math.PI * 2;
        const sp = (1.6 + Math.random() * 1.6) * dpr;
        sparks.push({
          x: cx,
          y: cy,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          maxLife: 1 + Math.random() * 0.5,
          color,
          size: 1.6 * dpr,
        });
      }
    }, site.delay * 1000);
  }
}
