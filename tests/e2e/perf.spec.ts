/**
 * 性能测量用例（Task 7 / R-A6，验收基线＝需求 9.3：本地编辑与预览交互 ≤300ms）。
 * 这是**性能测量工具**，不是功能回归用例：
 * - 构造 6 景点典型行程（起点/终点＋6 景点＋逐段手动步行时间＋一条超长备注，覆盖分页导出场景），
 *   测量两项（多次取样本并给中位数/均值）：
 *   a) 编辑交互响应：节点编辑弹层“确认修改”→ 纸面预览对应内容（该站备注块）更新可见；
 *   b) 导出耗时：点击导出 → “图片已生成”提示出现（6 景点＋一条长备注）。
 * - 计时口径：页面内 performance.now()（起点＝确认/导出按钮 click 派发，终点＝纸面 DOM 出现对应文本），
 *   不含 Playwright 指令往返开销；a 取 5 次、b 取 3 次，全部样本与中位数/均值一并输出。
 * - 不设阈值断言（机器差异易致抖动），数值以用例注解＋控制台输出供优化报告引用。
 * - 为使编辑区与纸面预览同屏可见（编辑→预览需同一屏可观察），两个 project 均锁定 1280×900 视口；
 *   mobile project 仍是移动仿真（触控/UA/像素比），数值不代表真机 CPU 性能。
 */
import { expect, test, type Page } from '@playwright/test';

const EDIT_RUNS = 5;
const EXPORT_RUNS = 3;

async function addVisit(page: Page, name: string, opts: { stay?: string; inside?: string } = {}) {
  await page.getByRole('button', { name: '添加景点' }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  if (opts.stay) await page.getByLabel('预计停留（分钟）').fill(opts.stay);
  if (opts.inside) await page.getByLabel('园内预计步行（分钟）').fill(opts.inside);
  await page.getByRole('button', { name: '添加' }).click();
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { samples, median: Math.round(median * 10) / 10, mean: Math.round(mean * 10) / 10 };
}

/** a) “确认修改”→ 纸面出现对应文本：页面内计时（MutationObserver 判定可见更新） */
async function measureEditResponse(page: Page, marker: string): Promise<number> {
  return page.evaluate(
    (text: string) =>
      new Promise<number>((resolve, reject) => {
        const paper = document.querySelector('[data-testid="route-card-paper"]');
        const btn = document.querySelector<HTMLButtonElement>('[data-testid="node-confirm"]');
        if (!paper || !btn) {
          reject(new Error('未找到纸面或确认按钮'));
          return;
        }
        const start = performance.now();
        let timer = 0;
        const observer = new MutationObserver(() => {
          if ((paper.textContent ?? '').includes(text)) {
            clearTimeout(timer);
            observer.disconnect();
            // 下一帧回调时该文本已进入渲染帧，按“更新可见”口径计时
            requestAnimationFrame(() => resolve(performance.now() - start));
          }
        });
        observer.observe(paper, { subtree: true, childList: true, characterData: true });
        timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('纸面未在时限内出现更新'));
        }, 15_000);
        btn.click();
      }),
    marker,
  );
}

/** b) 点击导出 → “图片已生成”出现：页面内计时；首跑/复跑都以“提示消失后重现”为终点 */
async function measureExport(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          /^导出(图片|草稿)$/.test((b.textContent ?? '').trim()),
        );
        if (!btn) {
          reject(new Error('未找到导出按钮'));
          return;
        }
        const hasText = () => (document.body.textContent ?? '').includes('图片已生成');
        let seenGone = !hasText();
        const start = performance.now();
        let timer = 0;
        const observer = new MutationObserver(() => {
          const now = hasText();
          if (!now) seenGone = true;
          if (seenGone && now) {
            clearTimeout(timer);
            observer.disconnect();
            // 下一帧回调时提示已进入渲染帧，按“更新可见”口径计时
            requestAnimationFrame(() => resolve(performance.now() - start));
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('导出未在时限内完成'));
        }, 120_000);
        btn.click();
      }),
  );
}

test('性能基线：编辑交互响应与导出耗时（测量用例，非功能断言）', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  // ---- 构造 6 景点典型行程 ----
  await page.getByLabel('行程名称').fill('性能基线行程');
  await page.getByLabel('行程名称').blur();
  await page.getByLabel('起点').fill('性能起点站');
  await page.getByLabel('起点').blur();
  await page.getByLabel('终点').fill('性能终点站');
  await page.getByLabel('终点').blur();

  for (let i = 1; i <= 6; i++) {
    await addVisit(page, `基线景点${i}`, { stay: '30', inside: '8' });
  }

  // 逐段手动步行时间（典型行程的已知路段）
  const legButtons = page.getByRole('button', { name: /编辑路段/ });
  await expect(legButtons.first()).toBeVisible();
  const legCount = await legButtons.count();
  for (let i = 0; i < legCount; i++) {
    await legButtons.nth(i).click();
    await page.getByLabel('其中步行（分钟）').fill(String(10 + i));
    await page.getByRole('button', { name: '确认修改' }).click();
  }

  // 长备注挂在景点1（导出分页场景）；编辑交互测量改用景点2，避免覆盖长备注
  const longNote = `示例长备注：从这里开始是一段很长的中文说明，用来验证分页不会截断内容。`.repeat(12);
  const card1 = page.getByRole('article', { name: '基线景点1' });
  await card1.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('备注').fill(longNote);
  await page.getByRole('button', { name: '确认修改' }).click();

  // ---- a) 编辑交互响应（5 次）----
  const editSamples: number[] = [];
  for (let run = 0; run < EDIT_RUNS; run++) {
    const marker = `perf-note-${run}-${Date.now()}`;
    await page.getByRole('article', { name: '基线景点2' }).getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('备注').fill(marker);
    editSamples.push(await measureEditResponse(page, marker));
    await expect(page.getByTestId('route-card-paper').getByText(marker)).toBeVisible();
  }
  const editStats = summarize(editSamples);

  // ---- b) 导出耗时（3 次，6 景点＋长备注）----
  const exportSamples: number[] = [];
  for (let run = 0; run < EXPORT_RUNS; run++) {
    exportSamples.push(await measureExport(page));
    await expect(page.getByText(/图片已生成/)).toBeVisible();
  }
  const exportStats = summarize(exportSamples);

  const report = {
    口径: '页面内 performance.now()；编辑=“确认修改”click→纸面出现对应文本；导出=点击导出→“图片已生成”出现；中位数/均值取全部样本',
    project: testInfo.project.name,
    编辑交互响应ms: editStats,
    导出耗时ms: exportStats,
  };
  // eslint-disable-next-line no-console
  console.log('[perf]', JSON.stringify(report));
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(report) });

  // 测量用例不断言阈值（验收阈值 300ms 由报告核对），此处仅保证测量确实发生
  expect(editSamples).toHaveLength(EDIT_RUNS);
  expect(exportSamples).toHaveLength(EXPORT_RUNS);
});
