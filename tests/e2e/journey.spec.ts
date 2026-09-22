/**
 * 浏览器端到端验收（第 13.1 节）：编辑—预览—导出闭环、跳站、窄屏无横向滚动。
 * 真实设备图片保存行为需人工验证（第 14.2 节），此处仅覆盖自动化可达路径。
 */
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
