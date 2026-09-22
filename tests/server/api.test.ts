// @vitest-environment node
/**
 * 路由级测试：通过 buildServer().inject() 验证三个 API 路由（第 7.2 节）。
 * 使用伪造的高德客户端，不访问真实网络、不使用真实 Key。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index';
import type { AmapClient, WalkingQuery } from '../../server/amap/client';
import { AmapError } from '../../server/amap/errors';
import type { PlaceSearchItem } from '../../shared/contracts/api';

function makeFakeClient() {
  return {
    textSearch: vi.fn(async (): Promise<{ items: PlaceSearchItem[]; nextPage: number | null }> => ({
      items: [],
      nextPage: null,
    })),
    around: vi.fn(async (): Promise<{ items: PlaceSearchItem[]; nextPage: number | null }> => ({
      items: [],
      nextPage: null,
    })),
    walking: vi.fn(async (_query: WalkingQuery) => ({
      distanceMeters: 600,
      rawWalkingSeconds: 300,
      reportedFeatures: [] as Array<{ kind: string; note: string }>,
    })),
  } satisfies AmapClient;
}

type FakeClient = ReturnType<typeof makeFakeClient>;

async function makeApp(client: FakeClient, overrides: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const app: FastifyInstance = await buildServer({
    getAmapKey: () => 'test-key',
    amapClient: client,
    budgetDefaults: { minIntervalMs: 0 }, // 加速测试；预算行为在单元测试中覆盖
    ...overrides,
  });
  return app;
}

interface MatrixNodeSpec {
  id: string;
  placeId?: string;
  longitude?: number;
  latitude?: number;
  coordinateRevision?: number;
}

function matrixNode(spec: MatrixNodeSpec) {
  return {
    id: spec.id,
    placeId: spec.placeId ?? `place-${spec.id}`,
    longitude: spec.longitude ?? 116.39,
    latitude: spec.latitude ?? 39.91,
    coordinateRevision: spec.coordinateRevision ?? 1,
  };
}

function matrixBody(
  nodes: MatrixNodeSpec[],
  pairs: Array<[string, string]>,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestId: 'req-matrix-1',
    inputFingerprint: 'fp-1',
    nodes: nodes.map(matrixNode),
    pairs: pairs.map(([fromId, toId]) => ({ fromId, toId })),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/places/search（第 7.2 节）', () => {
  it('成功返回 items 与 nextPage，响应带 requestId', async () => {
    const client = makeFakeClient();
    client.textSearch.mockResolvedValue({
      items: [
        {
          id: 'P1',
          name: '示例公园',
          district: '示例区',
          address: '示例路1号',
          location: { longitude: 116.397128, latitude: 39.916527 },
          entranceStatus: 'pending',
        },
      ],
      nextPage: 2,
    });
    const app = await makeApp(client);

    const response = await app.inject({
      method: 'GET',
      url: '/api/places/search?keyword=%E5%85%AC%E5%9B%AD&city=%E5%8C%97%E4%BA%AC%E5%B8%82&page=1',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(typeof payload.requestId).toBe('string');
    expect(payload.warnings).toEqual([]);
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0].entranceStatus).toBe('pending');
    expect(payload.data.nextPage).toBe(2);
    expect(client.textSearch).toHaveBeenCalledWith({ keyword: '公园', city: '北京市', page: 1 });
  });

  it('缺 keyword → 400 INVALID_INPUT，fieldErrors 指向具体字段', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({ method: 'GET', url: '/api/places/search?city=%E5%8C%97%E4%BA%AC&page=1' });

    expect(response.statusCode).toBe(400);
    const payload = response.json();
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.retryable).toBe(false);
    expect(payload.fieldErrors.some((e: { field: string }) => e.field === 'keyword')).toBe(true);
  });

  it('page 非数字 → 400 且指向 page', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({ method: 'GET', url: '/api/places/search?keyword=x&city=y&page=abc' });

    expect(response.statusCode).toBe(400);
    const payload = response.json();
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.fieldErrors.some((e: { field: string }) => e.field === 'page')).toBe(true);
  });

  it('关键词超长 → 400', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({
      method: 'GET',
      url: `/api/places/search?keyword=${'x'.repeat(61)}&city=y&page=1`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });
});

describe('GET /api/places/nearby（第 7.2 节）', () => {
  it('半径缺省 500，category 白名单校验通过并传给客户端', async () => {
    const client = makeFakeClient();
    const app = await makeApp(client);

    const response = await app.inject({
      method: 'GET',
      url: '/api/places/nearby?longitude=116.39&latitude=39.91&category=TOILET',
    });

    expect(response.statusCode).toBe(200);
    expect(client.around).toHaveBeenCalledWith({
      longitude: 116.39,
      latitude: 39.91,
      category: 'TOILET',
      radiusMeters: 500,
      page: 1,
    });
  });

  it('半径超 2000 上限 → 400', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({
      method: 'GET',
      url: '/api/places/nearby?longitude=116.39&latitude=39.91&category=TOILET&radiusMeters=2001',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });

  it('category 不在白名单 → 400', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({
      method: 'GET',
      url: '/api/places/nearby?longitude=116.39&latitude=39.91&category=RESTAURANT',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });

  it('坐标非法 → 400', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({
      method: 'GET',
      url: '/api/places/nearby?longitude=999&latitude=39.91&category=TOILET',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('未配置 Key（第 7.3 节 AMAP_NOT_CONFIGURED）', () => {
  it('search 返回 AMAP_NOT_CONFIGURED 错误体', async () => {
    const app = await makeApp(makeFakeClient(), { getAmapKey: () => null });

    const response = await app.inject({ method: 'GET', url: '/api/places/search?keyword=x&city=y&page=1' });

    expect(response.json().code).toBe('AMAP_NOT_CONFIGURED');
    expect(response.json().retryable).toBe(false);
  });

  it('矩阵请求回传 body 中的 requestId 便于关联', async () => {
    const app = await makeApp(makeFakeClient(), { getAmapKey: () => null });
    const body = matrixBody([{ id: 'a' }, { id: 'b' }], [['a', 'b']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.json().code).toBe('AMAP_NOT_CONFIGURED');
    expect(response.json().requestId).toBe('req-matrix-1');
  });
});

describe('POST /api/routes/walking-matrix（第 7.2 节）', () => {
  it('全部成功 → complete，回传 requestId 与 inputFingerprint，边带坐标版本与来源', async () => {
    const client = makeFakeClient();
    client.walking.mockImplementation(async () => ({
      distanceMeters: 600,
      rawWalkingSeconds: 300,
      reportedFeatures: [{ kind: 'stairs', note: '高德标注阶梯' }],
    }));
    const app = await makeApp(client);
    const body = matrixBody(
      [
        { id: 'a', coordinateRevision: 3 },
        { id: 'b', coordinateRevision: 5 },
        { id: 'c', coordinateRevision: 7 },
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
      ],
    );

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.requestId).toBe('req-matrix-1');
    expect(payload.data.inputFingerprint).toBe('fp-1');
    expect(payload.data.queryCoverage).toBe('complete');
    expect(payload.data.failures).toEqual([]);
    expect(payload.data.edges).toHaveLength(3);
    expect(client.walking).toHaveBeenCalledTimes(3);

    const edgeAB = payload.data.edges.find((e: { fromId: string; toId: string }) => e.fromId === 'a' && e.toId === 'b');
    expect(edgeAB).toMatchObject({
      fromCoordinateRevision: 3,
      toCoordinateRevision: 5,
      state: 'ready',
      distanceMeters: 600,
      rawWalkingSeconds: 300,
      provider: 'amap',
      providerApiVersion: 'v5',
      reportedFeatures: [{ kind: 'stairs', note: '高德标注阶梯' }],
    });
    expect(typeof edgeAB.fetchedAt).toBe('string');
    expect(typeof payload.data.fetchedAt).toBe('string');
  });

  it('部分失败 → partial，失败边进入 failures 且带 code/retryable', async () => {
    const client = makeFakeClient();
    client.walking.mockImplementation(async ({ origin }) => {
      if (origin.longitude === 116.39 && origin.latitude === 39.91) {
        throw new AmapError('AMAP_QUOTA_EXCEEDED', '配额超限');
      }
      return { distanceMeters: 100, rawWalkingSeconds: 60, reportedFeatures: [] };
    });
    const app = await makeApp(client);
    const body = matrixBody(
      [{ id: 'a' }, { id: 'b' }, { id: 'c', longitude: 116.4 }],
      [
        ['a', 'b'],
        ['c', 'b'],
      ],
    );

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    const payload = response.json();
    expect(payload.data.queryCoverage).toBe('partial');
    expect(payload.data.edges).toHaveLength(1);
    expect(payload.data.failures).toEqual([
      { fromId: 'a', toId: 'b', code: 'AMAP_QUOTA_EXCEEDED', retryable: false },
    ]);
  });

  it('上游明确不可达 → unreachable 边仍算 complete 明确结果，不进 failures', async () => {
    const client = makeFakeClient();
    client.walking.mockImplementation(async () => {
      throw new AmapError('ROUTE_UNREACHABLE', '无可用步行路径');
    });
    const app = await makeApp(client);
    const body = matrixBody([{ id: 'a' }, { id: 'b' }], [['a', 'b']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    const payload = response.json();
    expect(payload.data.queryCoverage).toBe('complete');
    expect(payload.data.failures).toEqual([]);
    expect(payload.data.edges).toHaveLength(1);
    expect(payload.data.edges[0]).toMatchObject({
      state: 'unreachable',
      distanceMeters: null,
      rawWalkingSeconds: null,
    });
  });

  it('预算耗尽 → partial，未查询边记 REQUEST_CANCELLED，不伪造完整结果', async () => {
    const client = makeFakeClient();
    const app = await makeApp(client, {
      budgetDefaults: { maxAttempts: 1, deadlineMs: 60_000, maxConcurrent: 1, minIntervalMs: 0 },
    });
    const body = matrixBody(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
      ],
    );

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    const payload = response.json();
    expect(client.walking).toHaveBeenCalledTimes(1); // 只发起了 1 次上游调用
    expect(payload.data.queryCoverage).toBe('partial');
    expect(payload.data.edges).toHaveLength(1);
    expect(payload.data.failures).toHaveLength(2);
    expect(payload.data.failures).toEqual([
      { fromId: 'b', toId: 'c', code: 'REQUEST_CANCELLED', retryable: false },
      { fromId: 'a', toId: 'c', code: 'REQUEST_CANCELLED', retryable: false },
    ]);
  });

  it('重复边去重：只查询一次，只产出一条边', async () => {
    const client = makeFakeClient();
    const app = await makeApp(client);
    const body = matrixBody([{ id: 'a' }, { id: 'b' }], [['a', 'b'], ['a', 'b']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    const payload = response.json();
    expect(client.walking).toHaveBeenCalledTimes(1);
    expect(payload.data.edges).toHaveLength(1);
    expect(payload.data.queryCoverage).toBe('complete');
  });

  it('节点 id 重复 → 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeFakeClient());
    const body = matrixBody([{ id: 'a' }, { id: 'a' }], [['a', 'b']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });

  it('pairs 引用不存在的节点 → 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeFakeClient());
    const body = matrixBody([{ id: 'a' }, { id: 'b' }], [['a', 'ghost']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });

  it('自环（fromId === toId）→ 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeFakeClient());
    const body = matrixBody([{ id: 'a' }, { id: 'b' }], [['a', 'a']]);

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.statusCode).toBe(400);
    const payload = response.json();
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.fieldErrors.length).toBeGreaterThan(0);
  });

  it('正文超过 64 KiB → 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeFakeClient());
    const body = matrixBody(
      [{ id: 'a', placeId: 'x'.repeat(70_000) }, { id: 'b' }],
      [['a', 'b']],
    );

    const response = await app.inject({ method: 'POST', url: '/api/routes/walking-matrix', payload: body });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });

  it('正文非合法 JSON → 400 INVALID_INPUT', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes/walking-matrix',
      payload: '{not-json',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_INPUT');
  });
});

describe('其他', () => {
  it('GET /api/health 返回 200', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('未知路径 → 404 统一错误体', async () => {
    const app = await makeApp(makeFakeClient());

    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('INVALID_INPUT');
  });
});
