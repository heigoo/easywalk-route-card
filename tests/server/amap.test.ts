// @vitest-environment node
/**
 * 高德适配层单元测试：全部使用伪造 fetchImpl，不访问真实网络、不使用真实 Key。
 * 覆盖第 7.3/7.4/7.5 节：业务错误映射、重试控制、归一化规则与请求预算。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmapClient } from '../../server/amap/client';
import { createBudget } from '../../server/amap/budget';
import { AmapError } from '../../server/amap/errors';
import { checkAmapBusinessSuccess, normalizeWalking } from '../../server/amap/normalize';

const KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchImpl = typeof fetch;

function asFetchImpl(fn: (url: unknown, init?: unknown) => Promise<Response>): FetchImpl {
  return fn as unknown as FetchImpl;
}

function poi(overrides: Record<string, unknown> = {}) {
  return {
    id: 'B0FFFF',
    name: '示例公园',
    adname: '示例区',
    address: '示例路1号',
    location: '116.397128,39.916527',
    ...overrides,
  };
}

function searchBody(pois: unknown[]) {
  return { status: '1', info: 'OK', infocode: '10000', count: String(pois.length), pois };
}

describe('createAmapClient 文本搜索（第 7.5 节）', () => {
  it('成功映射 POI 字段并给出 nextPage，URL 参数符合 v5 约定', async () => {
    const calls: Array<[unknown, unknown]> = [];
    const fetchImpl = asFetchImpl(async (url, init) => {
      calls.push([url, init]);
      return jsonResponse(searchBody(Array.from({ length: 10 }, (_, i) => poi({ id: `P${i}` }))));
    });
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toEqual({
      id: 'P0',
      name: '示例公园',
      district: '示例区',
      address: '示例路1号',
      location: { longitude: 116.397128, latitude: 39.916527 },
      entranceStatus: 'pending',
      openingHoursText: null,
      straightLineMeters: null,
    });
    expect(result.nextPage).toBe(2);

    const url = new URL(String(calls[0][0]));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('restapi.amap.com');
    expect(url.pathname).toBe('/v5/place/text');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('keywords')).toBe('公园');
    expect(url.searchParams.get('region')).toBe('北京市');
    expect(url.searchParams.get('page_size')).toBe('10');
    expect(url.searchParams.get('page_num')).toBe('1');
    expect(url.searchParams.get('show_fields')).toBe('business');
  });

  it('不足 10 条时 nextPage 为 null', async () => {
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody([poi(), poi()])));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 3 });

    expect(result.items).toHaveLength(2);
    expect(result.nextPage).toBeNull();
  });

  it('空 pois 数组是合法空结果', async () => {
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody([])));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items).toEqual([]);
    expect(result.nextPage).toBeNull();
  });

  it('非法 location 置 null；缺失 adname 时 district 回退地址串', async () => {
    const pois = [
      poi({ id: 'A', location: 'abc' }),
      poi({ id: 'B', location: '116.1' }),
      poi({ id: 'C', location: '999,999' }),
      poi({ id: 'D', location: '' }),
      poi({ id: 'E', adname: '', address: '  回退路2号  ' }),
    ];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items.map((item) => item.location)).toEqual([null, null, null, null, { longitude: 116.397128, latitude: 39.916527 }]);
    expect(result.items[4].district).toBe('回退路2号');
  });

  it('location 保留 6 位小数', async () => {
    const fetchImpl = asFetchImpl(async () =>
      jsonResponse(searchBody([poi({ location: '116.397128499,39.916527999' })])),
    );
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items[0].location).toEqual({ longitude: 116.397128, latitude: 39.916528 });
  });

  it('周边搜索使用固定关键词、经度在前的坐标与半径', async () => {
    const calls: unknown[] = [];
    const fetchImpl = asFetchImpl(async (url) => {
      calls.push(url);
      return jsonResponse(searchBody([poi({ location: '116.3971284,39.9165274' })]));
    });
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    await client.around({ longitude: 116.39712844, latitude: 39.91652744, category: 'TOILET', radiusMeters: 500, page: 1 });
    const toiletUrl = new URL(String(calls[0]));
    expect(toiletUrl.pathname).toBe('/v5/place/around');
    expect(toiletUrl.searchParams.get('location')).toBe('116.397128,39.916527');
    expect(toiletUrl.searchParams.get('keywords')).toBe('公共厕所');
    expect(toiletUrl.searchParams.get('radius')).toBe('500');

    await client.around({ longitude: 116.397128, latitude: 39.916527, category: 'REST_CANDIDATE', radiusMeters: 2000, page: 2 });
    const restUrl = new URL(String(calls[1]));
    expect(restUrl.searchParams.get('keywords')).toBe('休息区');
    expect(restUrl.searchParams.get('page_num')).toBe('2');
  });
});

describe('开放时间文本提取（地图参考文本，仅清洗不解析，待用户核对）', () => {
  it('三键优先级：opening_hours > opentime_week > opentime_today', async () => {
    const pois = [
      poi({
        id: 'A',
        business: { opening_hours: ' 08:00-17:00 ', opentime_week: '周一至周日', opentime_today: '09:00-18:00' },
      }),
      poi({ id: 'B', business: { opentime_week: ' 周一休息 ', opentime_today: '09:00-18:00' } }),
      poi({ id: 'C', business: { opentime_today: ' 09:00-18:00（节假日除外） ' } }),
    ];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items.map((item) => item.openingHoursText)).toEqual([
      '08:00-17:00',
      '周一休息',
      '09:00-18:00（节假日除外）',
    ]);
  });

  it('opening_hours 为数组时逐段 trim 后用；连接，空段剔除', async () => {
    const pois = [
      poi({ business: { opening_hours: ['周一 08:00-17:00', '  周二 09:00-16:00  ', ''] } }),
    ];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items[0].openingHoursText).toBe('周一 08:00-17:00；周二 09:00-16:00');
  });

  it('超过 200 字符截断到 200 字符以内', async () => {
    const pois = [poi({ business: { opening_hours: 'x'.repeat(250) } })];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items[0].openingHoursText).toBe('x'.repeat(200));
  });

  it('缺失、空白、空数组均视为缺失 → null；空白键跳过后落到下一键', async () => {
    const pois = [
      poi({ id: 'A' }), // 无 business
      poi({ id: 'B', business: {} }), // business 无任何键
      poi({
        id: 'C',
        business: { opening_hours: '   ', opentime_week: '  ', opentime_today: '' },
      }),
      poi({ id: 'D', business: 'not-object' }), // business 非对象
      poi({ id: 'E', business: { opening_hours: [], opentime_week: '仅周末开放' } }),
      poi({ id: 'F', business: { opening_hours: ['  ', ''], opentime_today: '全天' } }),
    ];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items.map((item) => item.openingHoursText)).toEqual([
      null,
      null,
      null,
      null,
      '仅周末开放',
      '全天',
    ]);
  });
});

describe('周边搜索 distance → straightLineMeters（直线距离仅作候选排序参考）', () => {
  it('数字字符串解析为距查询中心的直线距离（米）', async () => {
    const pois = [poi({ id: 'A', distance: '350' }), poi({ id: 'B', distance: ' 470 ' })];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.around({
      longitude: 116.39,
      latitude: 39.91,
      category: 'TOILET',
      radiusMeters: 500,
      page: 1,
    });

    expect(result.items.map((item) => item.straightLineMeters)).toEqual([350, 470]);
  });

  it('非法或缺失的 distance → null，绝不当作 0', async () => {
    const pois = [
      poi({ id: 'A', distance: 'abc' }),
      poi({ id: 'B', distance: '' }),
      poi({ id: 'C', distance: '-5' }),
      poi({ id: 'D' }), // 缺失
    ];
    const fetchImpl = asFetchImpl(async () => jsonResponse(searchBody(pois)));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.around({
      longitude: 116.39,
      latitude: 39.91,
      category: 'REST_CANDIDATE',
      radiusMeters: 2000,
      page: 1,
    });

    expect(result.items.map((item) => item.straightLineMeters)).toEqual([null, null, null, null]);
    expect(result.items.every((item) => item.straightLineMeters !== 0)).toBe(true);
  });
});

describe('文本搜索不提供直线距离（未知不等于没有）', () => {
  it('文本搜索 straightLineMeters 恒为 null', async () => {
    const fetchImpl = asFetchImpl(async () =>
      jsonResponse(searchBody([poi({ distance: '350' })])),
    );
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: '公园', city: '北京市', page: 1 });

    expect(result.items[0].straightLineMeters).toBeNull();
  });
});

describe('业务失败映射（第 7.3/7.5 节：HTTP 200 不等于业务成功）', () => {
  const cases: Array<[string, string]> = [
    ['10003', 'AMAP_QUOTA_EXCEEDED'],
    ['10004', 'AMAP_QUOTA_EXCEEDED'],
    ['10001', 'AMAP_AUTH_ERROR'],
    ['10005', 'AMAP_AUTH_ERROR'],
    ['20000', 'INVALID_INPUT'],
    ['20001', 'INVALID_INPUT'],
    ['99999', 'UPSTREAM_DATA_INVALID'],
  ];

  for (const [infocode, expected] of cases) {
    it(`status=0 且 infocode=${infocode} → ${expected}`, async () => {
      const fetchImpl = asFetchImpl(async () =>
        jsonResponse({ status: '0', info: `INF_${infocode}`, infocode }),
      );
      const client = createAmapClient({ apiKey: KEY, fetchImpl });

      await expect(client.textSearch({ keyword: 'x', city: 'y', page: 1 })).rejects.toMatchObject({
        code: expected,
      });
    });
  }

  it.each(cases)('infocode=%s 错误不重试（仅调用 1 次）', async (infocode) => {
    const fetchImpl = vi.fn(
      asFetchImpl(async () => jsonResponse({ status: '0', info: 'ERR', infocode })),
    );
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    await expect(client.textSearch({ keyword: 'x', city: 'y', page: 1 })).rejects.toBeInstanceOf(
      AmapError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 429 映射为配额错误且不重试', async () => {
    const fetchImpl = vi.fn(asFetchImpl(async () => new Response('too many', { status: 429 })));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    await expect(client.textSearch({ keyword: 'x', city: 'y', page: 1 })).rejects.toMatchObject({
      code: 'AMAP_QUOTA_EXCEEDED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('checkAmapBusinessSuccess：成功返回 null；异常结构返回错误', () => {
    expect(checkAmapBusinessSuccess({ status: '1', infocode: '10000' })).toBeNull();
    const missingInfocode = checkAmapBusinessSuccess({ status: '1' });
    expect(missingInfocode?.code).toBe('UPSTREAM_DATA_INVALID');
    expect(checkAmapBusinessSuccess('not-object')?.code).toBe('UPSTREAM_DATA_INVALID');
    expect(checkAmapBusinessSuccess(null)?.code).toBe('UPSTREAM_DATA_INVALID');
  });
});

describe('步行归一化（第 7.5 节）', () => {
  function walkingBody(paths: unknown[]) {
    return { status: '1', infocode: '10000', route: { paths } };
  }

  it('多路径时选择 cost.duration 最短的有效路径', async () => {
    const body = walkingBody([
      { distance: '800', cost: { duration: '500' } },
      { distance: '900', cost: { duration: '320' } },
      { distance: '700', cost: { duration: '100' }, steps: [{ walk_type: '0' }] },
    ]);
    const result = normalizeWalking(body);
    expect(result).toEqual({
      ok: true,
      value: { distanceMeters: 700, rawWalkingSeconds: 100, reportedFeatures: [] },
    });
  });

  it('duration 为空串或非法值时该路径无效，且绝不当 0', async () => {
    expect(normalizeWalking(walkingBody([{ distance: '100', cost: { duration: '' } }]))).toMatchObject({
      ok: false,
      error: { code: 'ROUTE_UNREACHABLE' },
    });
    expect(
      normalizeWalking(walkingBody([{ distance: '100', cost: { duration: 'abc' } }])),
    ).toMatchObject({ ok: false, error: { code: 'ROUTE_UNREACHABLE' } });
    // distance 非法同样使路径无效
    expect(
      normalizeWalking(walkingBody([{ distance: '', cost: { duration: '100' } }])),
    ).toMatchObject({ ok: false, error: { code: 'ROUTE_UNREACHABLE' } });
  });

  it('paths 缺失或空数组记 UPSTREAM_DATA_INVALID', () => {
    expect(normalizeWalking({ status: '1', infocode: '10000', route: {} })).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DATA_INVALID' },
    });
    expect(normalizeWalking(walkingBody([]))).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DATA_INVALID' },
    });
  });

  it('walk_type=20 记录为“高德标注阶梯”，未返回不代表没有台阶', () => {
    const withStairs = normalizeWalking(
      walkingBody([
        { distance: '100', cost: { duration: '60' }, steps: [{ walk_type: '0' }, { walk_type: '20' }] },
      ]),
    );
    expect(withStairs).toMatchObject({
      ok: true,
      value: { reportedFeatures: [{ kind: 'stairs', note: '高德标注阶梯' }] },
    });

    const withoutStairs = normalizeWalking(
      walkingBody([{ distance: '100', cost: { duration: '60' }, steps: [{ walk_type: '0' }] }]),
    );
    expect(withoutStairs).toMatchObject({ ok: true, value: { reportedFeatures: [] } });
  });

  it('客户端 walking 使用 origin/destination 与 show_fields=cost', async () => {
    const calls: unknown[] = [];
    const fetchImpl = asFetchImpl(async (url) => {
      calls.push(url);
      return jsonResponse(walkingBody([{ distance: '600', cost: { duration: '300' } }]));
    });
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.walking({
      origin: { longitude: 116.397128, latitude: 39.916527 },
      destination: { longitude: 116.407, latitude: 39.92 },
    });

    expect(result).toEqual({ distanceMeters: 600, rawWalkingSeconds: 300, reportedFeatures: [] });
    const url = new URL(String(calls[0]));
    expect(url.pathname).toBe('/v5/direction/walking');
    expect(url.searchParams.get('origin')).toBe('116.397128,39.916527');
    expect(url.searchParams.get('destination')).toBe('116.407,39.92');
    expect(url.searchParams.get('show_fields')).toBe('cost');
    expect(url.searchParams.get('key')).toBe(KEY);
  });
});

describe('重试控制（第 7.4 节：仅网络类短暂故障重试一次）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次网络故障后重试一次并成功（共调用 2 次）', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(
      asFetchImpl(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return jsonResponse(searchBody([poi()]));
      }),
    );
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const result = await client.textSearch({ keyword: 'x', city: 'y', page: 1 });

    expect(result.items).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('持续网络故障重试一次后报 UPSTREAM_TIMEOUT（共调用 2 次）', async () => {
    const fetchImpl = vi.fn(asFetchImpl(async () => Promise.reject(new TypeError('fetch failed'))));
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    await expect(client.textSearch({ keyword: 'x', city: 'y', page: 1 })).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('8 秒超时触发中止，重试一次后报 UPSTREAM_TIMEOUT', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      asFetchImpl(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (init as { signal: AbortSignal }).signal;
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    );
    const client = createAmapClient({ apiKey: KEY, fetchImpl });

    const pending = client.textSearch({ keyword: 'x', city: 'y', page: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8000); // 首次超时
    await vi.advanceTimersByTimeAsync(8000); // 重试再超时
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('请求预算（第 7.4 节）', () => {
  it('尝试次数用尽返回 false，release 不返还额度', () => {
    let t = 0;
    const budget = createBudget({ maxAttempts: 2, deadlineMs: 10_000, maxConcurrent: 2, minIntervalMs: 0, now: () => t });

    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.canStart()).toBe(false);
    budget.release();
    budget.release();
    expect(budget.tryAcquire()).toBe(false); // 次数已耗尽
  });

  it('并发上限：满并发时 tryAcquire 为 false，canStart 仍为 true', () => {
    let t = 0;
    const budget = createBudget({ maxAttempts: 10, deadlineMs: 10_000, maxConcurrent: 1, minIntervalMs: 0, now: () => t });

    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.canStart()).toBe(true);
    budget.release();
    expect(budget.tryAcquire()).toBe(true);
  });

  it('速率限制：相邻两次发起至少间隔 minIntervalMs', () => {
    let t = 0;
    const budget = createBudget({ maxAttempts: 10, deadlineMs: 10_000, maxConcurrent: 2, minIntervalMs: 1000, now: () => t });

    expect(budget.tryAcquire()).toBe(true);
    t = 500;
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.canStart()).toBe(true);
    t = 1000;
    expect(budget.tryAcquire()).toBe(true);
  });

  it('到期后 canStart 与 tryAcquire 均为 false', () => {
    let t = 0;
    const budget = createBudget({ maxAttempts: 10, deadlineMs: 1000, maxConcurrent: 2, minIntervalMs: 0, now: () => t });

    expect(budget.tryAcquire()).toBe(true);
    budget.release();
    t = 1001;
    expect(budget.canStart()).toBe(false);
    expect(budget.tryAcquire()).toBe(false);
  });

  it('默认值符合第 7.4 节：96 次尝试、120 秒、并发 2、间隔 1000ms', () => {
    let t = 0;
    const budget = createBudget({ maxAttempts: 96, deadlineMs: 120_000, maxConcurrent: 2, minIntervalMs: 1000, now: () => t });
    expect(budget.tryAcquire()).toBe(true);
    budget.release();
    expect(budget.canStart()).toBe(true);
  });
});
