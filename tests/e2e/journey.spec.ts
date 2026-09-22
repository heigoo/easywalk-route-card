/**
 * 浏览器端到端验收（第 13.1 节）：编辑—预览—导出闭环、跳站、窄屏无横向滚动，
 * 以及附近候选采纳→卡片提醒、备份导出/导入往返、阶梯提示与一键核对。
 * 真实设备图片保存行为需人工验证（第 14.2 节），读屏体验同样需人工验证；此处仅覆盖自动化可达路径。
 */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

async function addVisit(page: import('@playwright/test').Page, name: string, opts: { stay?: string; inside?: string; optional?: boolean } = {}) {
  await page.getByRole('button', { name: '添加景点' }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  if (opts.optional) await page.getByLabel('可选', { exact: true }).check();
  if (opts.stay) await page.getByLabel('预计停留（分钟）').fill(opts.stay);
  if (opts.inside) await page.getByLabel('园内预计步行（分钟）').fill(opts.inside);
  await page.getByRole('button', { name: '添加' }).click();
}

/** 窄屏需切换到预览视图；≥1024px 双列布局预览已在右列（需求 13.8） */
async function gotoPreview(page: import('@playwright/test').Page) {
  const tab = page.getByRole('button', { name: '大字预览' });
  if (await tab.isVisible().catch(() => false)) await tab.click();
}

test('编辑—填写路段—预览—导出闭环', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('行程名称').fill('E2E 示例行程');
  await page.getByLabel('起点').fill('示例酒店');
  await page.getByLabel('终点').fill('示例车站');
  await page.getByLabel('起点').blur();

  await addVisit(page, '示例景点甲', { stay: '30', inside: '8' });

  // 填写 起点→景点 路段
  await page.getByRole('button', { name: /编辑路段/ }).first().click();
  await page.getByLabel('其中步行（分钟）').fill('12');
  await page.getByRole('button', { name: '确认修改' }).click();

  // 预览：纸面摘要与逐站路段可见（桌面双列下需限定在纸面内）
  await gotoPreview(page);
  const paper = page.getByTestId('route-card-paper');
  await expect(paper).toBeVisible();
  await expect(paper.getByText('预计总步行')).toBeVisible();
  await expect(paper.getByText('步行约 12 分钟')).toBeVisible();

  // 导出草稿/图片：生成完成提示与逐页保存入口
  await page.getByRole('button', { name: /导出(图片|草稿)/ }).click();
  await expect(page.getByText(/图片已生成/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /保存第 1 张/ })).toBeVisible();
});

test('跳过可选景点后新路段回到待获取，不显示旧合计', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('起点').fill('示例酒店');
  await page.getByLabel('起点').blur();
  await addVisit(page, '可选景点乙', { optional: true, stay: '20', inside: '0' });
  await addVisit(page, '必去景点丙', { stay: '30', inside: '0' });

  // 填写两段
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /编辑路段/ }).first().click();
    await page.getByLabel('其中步行（分钟）').fill('10');
    await page.getByRole('button', { name: '确认修改' }).click();
  }

  // 跳过可选景点
  const card = page.getByRole('article', { name: '可选景点乙' });
  await card.getByRole('button', { name: '跳过此站' }).click();

  // 新直达路段待补充；汇总不显示完整总量
  await expect(page.getByText('步行时间待补充').first()).toBeVisible();
});

test('P1 规划入口可展开、未设置条件显示未限制、地图不可用时给出说明', async ({ page }) => {
  // 用契约级模拟数据（AMAP_NOT_CONFIGURED）验证可理解提示，不依赖真实 Key 或网络
  await page.route('**/api/places/search**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'AMAP_NOT_CONFIGURED',
        message: '服务端未配置高德 Web 服务 Key',
        retryable: false,
        fieldErrors: [],
        requestId: 'e2e-req-1',
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '展开' }).click();
  await expect(page.getByRole('heading', { name: '规划条件与自动规划' })).toBeVisible();
  // 未设置的条件不预设“老年人标准值”（需求 6.1）
  await expect(page.getByLabel('总步行上限（分钟）')).toHaveAttribute('placeholder', '未限制');

  await page.getByLabel('地点关键词').fill('示例公园');
  await page.getByLabel('搜索城市').fill('示例市');
  await page.getByRole('button', { name: '搜索地点' }).click();
  await expect(page.getByText(/地图服务未配置/)).toBeVisible({ timeout: 15_000 });
  // 手动功能不受影响（T12）
  await page.getByRole('button', { name: '添加景点' }).click();
  await expect(page.getByLabel('名称', { exact: true })).toBeVisible();
});

test('窄屏预览：浏览器返回键回到编辑视图并保留草稿（第 9.3、13.4 节）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await addVisit(page, '返回键示例景点', { stay: '30', inside: '5' });
  await page.getByRole('button', { name: '大字预览' }).click();
  await expect(page.getByTestId('route-card-paper')).toBeVisible();

  await page.goBack();
  // 回到编辑视图（景点卡只在编辑视图出现）且草稿仍在
  await expect(page.getByRole('article', { name: '返回键示例景点' })).toBeVisible();
});

test('长内容分页导出：生成多页且保留完整备注（D13、T15）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByLabel('起点').fill('示例酒店');
  await page.getByLabel('终点').fill('示例车站');
  await page.getByLabel('起点').blur();

  for (let i = 1; i <= 6; i++) {
    await addVisit(page, `示例景点${i}`, { stay: '30', inside: '8' });
  }

  // 超长中文备注：必须按文本行拆分并跨页保留，不裁切、不缩小字号
  const longNote = `示例长备注：从这里开始是一段很长的中文说明，用来验证分页不会截断内容。`.repeat(12);
  const card = page.getByRole('article', { name: '示例景点1' });
  await card.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('备注').fill(longNote);
  await page.getByRole('button', { name: '确认修改' }).click();

  await page.getByRole('button', { name: /导出(图片|草稿)/ }).click();
  await expect(page.getByText(/图片已生成，共 \d+ 张/)).toBeVisible({ timeout: 90_000 });

  const saveButtons = page.getByRole('button', { name: /保存第 \d+ 张/ });
  await expect(saveButtons.first()).toBeVisible();
  expect(await saveButtons.count()).toBeGreaterThan(1);
});

test('320px 视口无横向滚动，纸面等比缩小', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await addVisit(page, '窄屏景点', { stay: '30', inside: '5' });
  await page.getByRole('button', { name: '大字预览' }).click();
  const scrollOk = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(scrollOk).toBeTruthy();
});

test('360px 视口纸面 1:1 显示', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto('/');
  await addVisit(page, '标准景点', { stay: '30', inside: '5' });
  await page.getByRole('button', { name: '大字预览' }).click();
  const paper = page.getByTestId('route-card-paper');
  await expect(paper).toBeVisible();
  const box = await paper.boundingBox();
  expect(Math.round(box!.width)).toBe(360);
});

test('附近候选逐属性确认写入后，纸面出现厕所/歇脚点候选提醒（R-A1、M-R03）', async ({ page }) => {
  // 地点搜索返回带坐标与开放时间文本的 POI（顺带覆盖开放时间“地图参考（待核对）”，R-A2）
  await page.route('**/api/places/search**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requestId: 'e2e-req-search',
        warnings: [],
        data: {
          items: [
            {
              id: 'poi-park-1',
              name: '示例公园东门',
              district: '示例区',
              address: '示例路 100 号',
              location: { longitude: 121.4737, latitude: 31.2304 },
              entranceStatus: 'pending',
              openingHoursText: '08:30-17:30',
              straightLineMeters: null,
            },
          ],
          nextPage: null,
        },
      }),
    }),
  );
  // 附近检索返回 2 条候选（含名称/地址/直线距离/开放时间文本）
  await page.route('**/api/places/nearby**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requestId: 'e2e-req-nearby',
        warnings: [],
        data: {
          items: [
            {
              id: 'poi-toilet-1',
              name: '地图候选厕所甲',
              district: '示例区',
              address: '公园东路 1 号',
              location: null,
              entranceStatus: 'pending',
              openingHoursText: '00:00-24:00',
              straightLineMeters: 120,
            },
            {
              id: 'poi-rest-1',
              name: '地图候选长椅区',
              district: '示例区',
              address: '湖边长廊西侧',
              location: null,
              entranceStatus: 'pending',
              openingHoursText: null,
              straightLineMeters: 80,
            },
          ],
          nextPage: null,
          source: 'amap',
          fetchedAt: '2026-09-22T02:00:00.000Z',
        },
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '展开' }).click();
  await page.getByLabel('地点关键词').fill('示例公园');
  await page.getByLabel('搜索城市').fill('示例市');
  await page.getByRole('button', { name: '搜索地点' }).click();
  await page.getByRole('button', { name: '设为景点' }).click();

  const card = page.getByRole('article', { name: '示例公园东门' });
  await card.getByRole('button', { name: '设施备注' }).click();

  // 搜索附近：候选可见，直线距离带“非步行路程”标注
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('地图候选厕所甲')).toBeVisible();
  await expect(page.getByText('示例区 · 公园东路 1 号')).toBeVisible();
  await expect(page.getByText('直线约 120 米')).toBeVisible();
  await expect(page.getByText('直线约 80 米')).toBeVisible();
  await expect(page.getByText('直线距离，非步行路程').first()).toBeVisible();

  // 记录厕所候选到此站：逐属性确认后才写入
  const toiletItem = page.getByRole('listitem').filter({ hasText: '地图候选厕所甲' });
  await toiletItem.getByRole('button', { name: '记录到此站' }).click();
  const confirmArea = page.getByRole('group', { name: '逐属性确认' });
  await confirmArea.getByLabel('开放情况', { exact: true }).selectOption('checked');
  await confirmArea.getByLabel('开放时段说明', { exact: true }).fill('8:00-18:00');
  await confirmArea.getByRole('button', { name: '确认写入' }).click();
  await expect(toiletItem.getByText('已记录')).toBeVisible();

  // 记录歇脚点候选到此站：可坐三态中确认“可坐”
  await page.getByLabel('类别', { exact: true }).selectOption('REST_CANDIDATE');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const restItem = page.getByRole('listitem').filter({ hasText: '地图候选长椅区' });
  await restItem.getByRole('button', { name: '记录到此站' }).click();
  await confirmArea.getByLabel('是否可坐', { exact: true }).selectOption('yes');
  await confirmArea.getByRole('button', { name: '确认写入' }).click();
  await expect(restItem.getByText('已记录')).toBeVisible();
  await page.getByRole('button', { name: '确认修改' }).click();

  // 开放时间“地图参考（待核对）”在节点编辑可见（R-A2）
  await card.getByRole('button', { name: '编辑' }).click();
  await expect(page.getByText('地图参考（待核对）', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '写入并标记核对' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();

  // 纸面预览出现提醒（措辞含“候选”，座位/开放按已核对口径）
  await gotoPreview(page);
  const paper = page.getByTestId('route-card-paper');
  await expect(paper.getByText('厕所：地图候选厕所甲（你已核对：8:00-18:00）')).toBeVisible();
  await expect(paper.getByText('歇脚点候选：地图候选长椅区（你已核对：可坐）')).toBeVisible();
});

test('导出备份与导入备份往返恢复原内容（R-A4）', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('行程名称').fill('备份行程甲');
  await page.getByLabel('行程名称').blur();
  await page.getByLabel('出游日期').fill('2026-10-01');
  await addVisit(page, '备份景点乙', { stay: '30', inside: '5' });

  const card = page.getByRole('article', { name: '备份景点乙' });
  await card.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('备注').fill('保留的备注内容-XYZ');
  await page.getByRole('button', { name: '确认修改' }).click();

  // 导出备份：下载文件（含行程名称与出游日期）落到测试临时目录
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('省脚力路线卡-备份行程甲-2026-10-01.json');
  mkdirSync(testInfo.outputPath(''), { recursive: true });
  const backupPath = testInfo.outputPath('backup.json');
  await download.saveAs(backupPath);

  // 改掉行程内容
  await page.getByLabel('行程名称').fill('备份行程乙');
  await page.getByLabel('行程名称').blur();
  await card.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('备注').fill('改动后的备注');
  await page.getByRole('button', { name: '确认修改' }).click();
  await expect(card.getByText('改动后的备注')).toBeVisible();
  await expect(card.getByText('保留的备注内容-XYZ')).toHaveCount(0);

  // 导入备份：二次确认后覆盖当前行程
  await page.locator('input[type="file"]').setInputFiles(backupPath);
  await expect(page.getByRole('button', { name: '确认导入' })).toBeVisible();
  await page.getByRole('button', { name: '确认导入' }).click();

  // 关键字段恢复
  await expect(page.getByLabel('行程名称')).toHaveValue('备份行程甲');
  await expect(card.getByText('保留的备注内容-XYZ')).toBeVisible();
  await expect(card.getByText('改动后的备注')).toHaveCount(0);
});

test('阶梯提示展示与一键核对后事实保留（R-A3）', async ({ page }) => {
  // 地点搜索：3 个带坐标的 POI（起点/景点/终点）
  await page.route('**/api/places/search**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requestId: 'e2e-req-search-2',
        warnings: [],
        data: {
          items: [
            {
              id: 'poi-st-1',
              name: '阶梯起点站',
              district: '示例区',
              address: '甲路 1 号',
              location: { longitude: 121.4, latitude: 31.2 },
              entranceStatus: 'pending',
              openingHoursText: null,
              straightLineMeters: null,
            },
            {
              id: 'poi-garden-1',
              name: '阶梯园',
              district: '示例区',
              address: '乙路 2 号',
              location: { longitude: 121.41, latitude: 31.21 },
              entranceStatus: 'pending',
              openingHoursText: null,
              straightLineMeters: null,
            },
            {
              id: 'poi-ed-1',
              name: '阶梯终点站',
              district: '示例区',
              address: '丙路 3 号',
              location: { longitude: 121.42, latitude: 31.22 },
              entranceStatus: 'pending',
              openingHoursText: null,
              straightLineMeters: null,
            },
          ],
          nextPage: null,
        },
      }),
    }),
  );
  // 步行矩阵：按请求 pairs 回填 ready 边，并带地图报告属性（阶梯）
  await page.route('**/api/routes/walking-matrix**', (route) => {
    const body = route.request().postDataJSON() as {
      nodes: Array<{ id: string }>;
      pairs: Array<{ fromId: string; toId: string }>;
    };
    const edges = body.pairs.map((p) => ({
      fromId: p.fromId,
      toId: p.toId,
      fromCoordinateRevision: 0,
      toCoordinateRevision: 0,
      state: 'ready',
      distanceMeters: 450,
      rawWalkingSeconds: 360,
      provider: 'amap',
      providerApiVersion: '1.0',
      fetchedAt: '2026-09-22T02:00:00.000Z',
      reportedFeatures: [{ kind: 'stairs', note: '高德标注阶梯' }],
    }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requestId: 'e2e-req-matrix',
        warnings: [],
        data: { edges, failures: [], queryCoverage: 'complete', fetchedAt: '2026-09-22T02:00:00.000Z' },
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '展开' }).click();
  await page.getByLabel('地点关键词').fill('阶梯');
  await page.getByLabel('搜索城市').fill('示例市');
  await page.getByRole('button', { name: '搜索地点' }).click();
  await page.getByRole('listitem').filter({ hasText: '阶梯起点站' }).getByRole('button', { name: '设为起点' }).click();
  await page.getByRole('listitem').filter({ hasText: '阶梯园' }).getByRole('button', { name: '设为景点' }).click();
  await page.getByRole('listitem').filter({ hasText: '阶梯终点站' }).getByRole('button', { name: '设为终点' }).click();

  // 景点补全停留/园内步行后走规划流程（mock 矩阵→应用方案→路段写入会话地图值）
  await page.getByRole('article', { name: '阶梯园' }).getByRole('button', { name: '编辑' }).click();
  await page.getByLabel(/预计停留/).fill('30');
  await page.getByLabel('园内预计步行（分钟）').fill('10');
  await page.getByRole('button', { name: '确认修改' }).click();

  await page.getByRole('button', { name: '计算路线' }).click();
  await expect(page.getByText('主要建议')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '应用此方案' }).click();

  // 路段行出现阶梯提示与核对入口（Task 11 修复后“最后一站→终点”段也渲染路段行，两段均有提示）
  await expect(page.getByText('高德标注本段可能有阶梯（待核对）')).toHaveCount(2);

  // 一键核对：预填台阶项，确认后写入事实
  await page.getByRole('button', { name: '记录台阶核对' }).first().click();
  await page.getByLabel('台阶情况').selectOption('yes');
  await page.getByLabel('替代通行说明').fill('西侧有无障碍坡道');
  await page.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByText('高德标注本段可能有阶梯（待核对）').first()).toBeVisible();

  // 重开弹层回读：事实保留
  await page.getByRole('button', { name: '记录台阶核对' }).first().click();
  await expect(page.getByLabel('台阶情况')).toHaveValue('yes');
  await expect(page.getByLabel('替代通行说明')).toHaveValue('西侧有无障碍坡道');
  await page.getByRole('button', { name: '取消' }).click();
});
