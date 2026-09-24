/**
 * 高德 Key 真实核验脚本（详细设计第 13.1 节“接入阶段真实核验”）。
 *
 * 用途：在确认 Key 平台与授权后，用少量公开地点检查接口契约。
 * 边界：
 * - 不写入任何凭据；Key 从 .env 或环境变量读取；
 * - 调用次数刻意压到最低（默认 4 次），避免消耗账号配额；
 * - 只打印归一化结论与必要的结构信息，不回显带 Key 的完整请求地址；
 * - 结论必须由真实响应得出，不做“模拟成功”。
 *
 * 用法：node scripts/verify-amap.mjs [--full]
 *   --full 额外执行一次步行矩阵（3 节点、2 条边）
 */
import { readFileSync } from 'node:fs';

const HOST = 'https://restapi.amap.com';

function loadKey() {
  if (process.env.AMAP_WEB_SERVICE_KEY) return process.env.AMAP_WEB_SERVICE_KEY.trim().replace(/^["']|["']$/g, '');
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('AMAP_WEB_SERVICE_KEY='));
    if (!line) return '';
    const raw = line.slice(line.indexOf('=') + 1).trim();
    return raw.replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

const KEY = loadKey();
if (!KEY) {
  console.error('未找到 AMAP_WEB_SERVICE_KEY（请配置 .env 或环境变量）');
  process.exit(2);
}

/** 只显示脱敏后的调用描述，不包含 Key */
function describe(path, params) {
  const safe = { ...params };
  delete safe.key;
  return `${path} ${JSON.stringify(safe)}`;
}

async function call(path, params) {
  const url = new URL(path, HOST);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, String(v));
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json();
    return { http: res.status, body, ms: Date.now() - started };
  } catch (e) {
    return { http: 0, body: null, ms: Date.now() - started, error: e.name === 'AbortError' ? 'TIMEOUT' : String(e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 高德业务成功判定：status=1 且 infocode=10000（第 7.5 节） */
function businessOk(body) {
  return body?.status === '1' && body?.infocode === '10000';
}

function parseLocation(text) {
  if (typeof text !== 'string' || !text.includes(',')) return null;
  const [lng, lat] = text.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { longitude: Number(lng.toFixed(6)), latitude: Number(lat.toFixed(6)) };
}

const results = [];
const full = process.argv.includes('--full');

// ---- 1. 地点文本搜索：公共地点，检查 POI 结构与分页字段 ----
{
  const params = { keywords: '天安门', region: '北京', page_size: 10, page_num: 1, show_fields: 'business' };
  const r = await call('/v5/place/text', params);
  const pois = Array.isArray(r.body?.pois) ? r.body.pois : [];
  const first = pois[0] ?? null;
  results.push({
    step: '地点文本搜索 /v5/place/text',
    request: describe('/v5/place/text', params),
    http: r.http,
    businessOk: businessOk(r.body),
    infocode: r.body?.infocode ?? null,
    info: r.body?.info ?? r.error ?? null,
    poiCount: pois.length,
    sample: first
      ? {
          id: typeof first.id === 'string' ? `${first.id.slice(0, 6)}…` : null,
          name: first.name ?? null,
          hasLocation: parseLocation(first.location) !== null,
          typecode: first.typecode ?? null,
          hasBusinessExtended: Boolean(first.business),
          businessOpentimeToday: first.business?.opentime_today ?? null,
        }
      : null,
    ms: r.ms,
  });
}

// ---- 2. 周边检索（厕所关键词）：检查 category 白名单与 radius 行为 ----
{
  const params = { location: '116.397428,39.90923', keywords: '公共厕所', radius: 500, page_size: 10, page_num: 1 };
  const r = await call('/v5/place/around', params);
  const pois = Array.isArray(r.body?.pois) ? r.body.pois : [];
  results.push({
    step: '周边检索 /v5/place/around',
    request: describe('/v5/place/around', params),
    http: r.http,
    businessOk: businessOk(r.body),
    infocode: r.body?.infocode ?? null,
    info: r.body?.info ?? r.error ?? null,
    poiCount: pois.length,
    sample: pois[0]
      ? { name: pois[0].name ?? null, hasDistance: typeof pois[0].distance === 'string', hasLocation: parseLocation(pois[0].location) !== null }
      : null,
    ms: r.ms,
  });
}

// ---- 3. 两点步行：检查 cost.duration 结构与单位 ----
{
  const params = { origin: '116.397428,39.90923', destination: '116.410244,39.916294', show_fields: 'cost' };
  const r = await call('/v5/direction/walking', params);
  const paths = r.body?.route?.paths;
  const first = Array.isArray(paths) ? paths[0] : null;
  results.push({
    step: '两点步行 /v5/direction/walking',
    request: describe('/v5/direction/walking', params),
    http: r.http,
    businessOk: businessOk(r.body),
    infocode: r.body?.infocode ?? null,
    info: r.body?.info ?? r.error ?? null,
    pathCount: Array.isArray(paths) ? paths.length : 0,
    sample: first
      ? {
          distanceMeters: typeof first.distance === 'string' ? Number(first.distance) : null,
          costDurationSeconds: first.cost?.duration ?? null,
          stepCount: Array.isArray(first.steps) ? first.steps.length : 0,
          walkTypeValues: Array.isArray(first.steps)
            ? [...new Set(first.steps.map((s) => s.walk_type).filter(Boolean))]
            : [],
        }
      : null,
    ms: r.ms,
  });
}

// ---- 4.（可选）步行矩阵：3 节点、2 条边，验证批量与预算控制 ----
if (full) {
  const edges = [
    { origin: '116.397428,39.90923', destination: '116.410244,39.916294' },
    { origin: '116.410244,39.916294', destination: '116.397428,39.90923' },
  ];
  const per = [];
  for (const e of edges) {
    const r = await call('/v5/direction/walking', { ...e, show_fields: 'cost' });
    per.push({
      direction: `${e.origin} → ${e.destination}`,
      businessOk: businessOk(r.body),
      duration: r.body?.route?.paths?.[0]?.cost?.duration ?? null,
      distance: r.body?.route?.paths?.[0]?.distance ?? null,
      ms: r.ms,
    });
    await new Promise((res) => setTimeout(res, 1100)); // 应用侧速率不超过每秒 1 次（第 7.4 节）
  }
  results.push({ step: '矩阵抽样（2 条有向边，含速率限制）', edges: per });
}

console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), gateway: HOST, results }, null, 2));

const failed = results.some((r) => r.businessOk === false || r.error);
if (failed) {
  console.error('核验未全部通过（见上方 businessOk / error 字段）');
  process.exit(1);
}