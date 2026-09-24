# 省脚力路线卡 / EasyWalk Route Card

按《[省脚力路线卡-需求说明书](./省脚力路线卡-需求说明书.md)》与《[省脚力路线卡-详细设计说明书](./省脚力路线卡-详细设计说明书.md)》实现的响应式网页应用：把选好的景点整理成看得懂、可调整、能导出的“省脚力”路线卡。面向最终用户的操作指南见《[省脚力路线卡-用户使用说明书](./省脚力路线卡-用户使用说明书.md)》（含截图与演示动图）。

- 三端共用同一业务代码，按视口宽度适配（手机 / 平板 / 电脑）
- 行程保存在本机浏览器（`localStorage`），无账号与云端同步
- 地图数据由服务端高德 Web 服务适配层提供，浏览器不接触服务端 Key
- 图片导出在本机完成，不上传行程截图

## 能力清单

- **行程编辑与多行程管理（本机）**：添加/排序/跳过/恢复站点、逐段记录步行时间，缺失数据只报已知下界与待补充项；跳站/重排/转休息点后自动补全新缺失路段（失败保持待补充并可手动重试）；支持新建/切换/复制/重命名/删除多份行程，旧单份行程数据首次打开自动迁移，全部保存在本机浏览器（`localStorage`）。
- **大字路线卡与图片导出**：预览与导出共用同一视图模型，逐页 PNG 在本机生成，可离线查看已采纳的路段时间。
- **节庆动画（中秋·国庆）**：9/20～10/7 节令窗口内，界面上叠加种子化生成动画（明月月晕、星斗、薄云、桂瓣、旗串、国旗、烟花），同日同景、隔日更新；导出成功时烟花庆祝。纯视觉覆盖层（不拦截交互、不进入导出画面），尊重系统“减少动态效果”设置，顶栏可随时开关。
- **附近设施候选检索**：站内按类别（厕所/歇脚处）与半径检索附近候选（按站点坐标直线附近，不是沿步行路线），逐属性确认后才写入；同站多条候选按 POI 区分，不再 kind 唯一覆盖；直线距离仅标注“直线距离，非步行路程”，不参与任何计算。
- **设施事实覆盖保护**：厕所开放、歇脚点座位、台阶有无逐属性核对并保留来源（高德地图搜索/POI id/获取与核对时间）；“确认修改”只写本次实际改动，同值不重写；“已核对”退回“待确认”须点名属性二次确认；没查到不等于“没有”。
- **厕所/歇脚候选一键加入路线**：候选确认后可一键插入路线成为途经点/休息点（开放与座位事实随迁移保留，候选坐标随写入带出）；厕所绕行步行计入总量并走歇脚绕行对照，默认途经、不计坐休分界；坐标缺失时明确提示“位置待确认，暂不能自动获取步行数据”。
- **阶梯提示与核对**：地图报告阶梯时路段行提示“重载后地图提示会消失、核对结果才保留”，可一键记录台阶核对。
- **绕行步行对比**：休息点行显示“歇脚绕行：比直达多走约 X 分钟”（会话内直达对照，注明按当前步行倍数口径）；对比数据缺失或失败时显示“绕行对比待补充”，不用直线距离估算。
- **连续步行超限的休息补救**：自动规划在连续步行超限时，有限枚举在路径相邻边上插入“已确认可坐且有坐标”的歇脚候选（挂靠站相邻边优先，长连续段也可插入）；矩阵取数核心边优先、插入边限量，降低 partial；不自动插入未核实座位，无候选时明确提示调整休息或手动插入，而不是只砍可选景点。
- **园内分段（可选）**：景点可录入园内步行/坐休交错的分段时间轴，用于切分最长连续步行；默认仍用合计，不强迫填时间轴。
- **开放时间保守解析**：全周统一与分日/多时段文本走严格文法解析（含星期X、工作日、24小时/全天的严格同义词表），结果参与等待开门/闭门冲突计算；解析不了的文本只保留原文并标“待核对”，不编造时段。
- **入口未确认提示**：有坐标但入口未确认的地点参与计算时，在卡片状态与规划结果中提示“可能按坐标中心估算”，不阻断矩阵、不假精确。
- **地图数据与规划**：地点搜索、步行矩阵与自动规划经服务端高德适配层；地图估算仅会话内有效，显式采纳后才落盘并保留来源与时间。

## 快速开始

```bash
npm install
npm run dev            # 前端开发服务器（默认 5173，/api 代理到 8787）
npm run server:dev     # 高德适配服务（可选，未配置 Key 时手动功能照常可用）
```

未配置 `AMAP_WEB_SERVICE_KEY` 时：地点搜索、路段时间获取与自动规划返回 `AMAP_NOT_CONFIGURED` 并说明原因，手动填写、预览与导出继续可用。

```bash
cp .env.example .env   # 填入真实 Key（.env 已被 Git 忽略，切勿提交）
```

## 校验与测试

```bash
npm run typecheck                  # TypeScript 严格校验
npm test                           # Vitest：领域、组件、服务端契约、规划（279 项：274 通过 / 5 skipped，后者为 amap-live 默认跳过）
npx vitest run tests/server        # 高德适配契约测试（64 项，全部使用伪造 fetch，不访问网络）
npx vitest run tests/workers       # 规划算法与 Worker 协议（21 项）
npm run test:e2e                   # Playwright：桌面 + 移动视口（22 项，11 × 2 project，含 1 条 perf 测量用例）
npm run build                      # 生产构建（含独立 planner.worker 分包）
```

## 目录结构与模块职责

对应详细设计第 3.2 节模块清单：

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 应用壳与视图切换 | `src/app/` | 三端布局、编辑/预览切换、浏览器返回、状态编排 |
| 行程编辑 | `src/features/itinerary/` | 新增/重排/跳过/恢复、局部草稿面板、路段编辑 |
| 设施编辑 | `src/features/facilities/` | 逐属性事实与核对状态，不一键确认全部 |
| 地点搜索 | `src/features/places/` | 地图候选确认后才写入行程，入口默认待确认 |
| 规划面板 | `src/features/planning/` | 约束输入、请求关联、候选差异、应用方案 |
| 大字卡 | `src/features/route-card/` | CardViewModel 与只读纸面渲染 |
| 图片导出 | `src/features/export/` | 分页测量、文本行拆分、逐页 PNG、逐页保存 |
| 领域模型与计算 | `src/domain/` | 校验、统计、连续步行、状态合成、候选应用 |
| 规划 Worker | `src/workers/` | 有界搜索、候选、冲突、搜索完整度 |
| 本地存储 | `src/storage/` | 保存与恢复；持久化白名单；损坏数据不静默清空 |
| API 客户端 | `src/services/` | 取消、请求关联与响应解析 |
| 服务端路由 | `server/routes/` | 入参校验、统一错误契约、请求预算与并发控制 |
| 高德适配 | `server/amap/` | 附加 Key、访问上游、归一化、隐藏敏感信息 |
| 请求契约 | `shared/contracts/` | 字段类型、枚举与边界约束（前后端共享 Zod） |

## 关键实现口径

| 主题 | 实现位置 |
| --- | --- |
| 统一样例：总步行 43 分钟 / 全程 100 分钟 / 连续最多 28 分钟 | `src/domain/compute.ts`、`tests/domain/compute.test.ts` |
| 缺失数据只报已知下界与待补充项，不把部分合计当完整总量 | `src/domain/compute.ts`（第 5.3 节） |
| 未知休息按“可能分界”切分连续步行下界，不错误断言超限 | `classifyRest` + 区间累计 |
| 跳站/重排/改坐标后路段失效与复用 | `src/domain/itinerary.ts` `rebuildLegs` |
| 跳站后自动补全新缺失路段（R07 V1.1） | `src/domain/pendingLegs.ts`、`src/features/planning/useMissingLegs.ts` |
| 厕所/歇脚候选入路线与同站多候选 | `convertFacilityCandidateToRestNode`、`upsertFacilityFactForTarget`（recordKey） |
| 连续步行超限有限插入已确认歇脚 | `src/domain/insertRest.ts`、`src/workers/planner.ts` `tryInsertRests` |
| 厕所途经不计坐休分界 | `convertFacilityCandidateToRestNode`（seat=false）；卡片/编辑区同口径「途经」 |
| 矩阵 pair 预算与插入边限量 | `MAX_MATRIX_PAIRS`、`MAX_INSERT_MATRIX_PAIRS` |
| 开放时间严格文法与同义词表（星期X/工作日/24小时） | `src/domain/opening.ts` |
| 入口未确认提示（不阻断矩阵） | `src/domain/status.ts` `unconfirmedEntrancePlaceNames` |
| 地图值的采纳与离线可见（未采纳值不落盘） | `adoptAllMapLegs`、`src/storage/local.ts` `toPersisted` |
| 地图估算不覆盖手动/已采纳/同一入口腿（C3） | `isUserOwnedLeg` + `applyMatrixEdges` / `applySessionEdges` |
| 开放时间：多时段空档等待、明确不开放、超闭门均显式提示 | `compute.ts` `evaluateOpening` + `openWaits` / `closingConflicts` |
| 已核实坐休＝座位已确认的独立休息点（与分界资格解耦） | `compute.ts` `plannedRestCount` |
| 卡片状态合成：blocked / violated / draft / complete | `src/domain/status.ts` |
| 预览与导出共用同一 `CardViewModel` 实例 | `buildCardViewModel` + `RouteCard` |
| 固定 360px 逻辑宽度、960px 分页预算、3 倍像素密度 | `src/features/export/paginate.ts`、`measure.ts` |
| 文本按行拆分（Range + getClientRects），不裁切不缩字号 | `splitTextAtHeight` |
| 请求关联与版本校验，旧响应不得覆盖新结果 | `src/features/planning/usePlanning.ts` |

## 设计验收用例对照（详细设计 13.2 节）

| 用例 | 覆盖位置 |
| --- | --- |
| T01–T04 统计口径、缺失下界、未知休息、已知超限 | `tests/domain/compute.test.ts` |
| T05 跳站后不得复用旧时间 | `tests/domain/compute.test.ts` |
| T06–T07 路段身份、反向不复用、步速因子 | `tests/domain/itinerary.test.ts` |
| T08–T09 搜索边界、锚点、缺失候选排序 | `tests/workers/planner.test.ts` |
| T10 HTTP 200 但业务失败 | `tests/server/amap.test.ts` |
| T11 乱序响应与输入过期 | `tests/features/planning.test.tsx`（指纹过期与丢弃） |
| T12 无 Key 时手动功能完整 | `tests/features/planning.test.tsx`、`tests/e2e/journey.spec.ts` |
| T13 局部取消不修改原数据 | `tests/app/App.test.tsx` |
| T14 导出使用单一快照 | `src/features/export/ExportPanel.tsx`（点击时冻结 VM） |
| T15 多页内容、来源与草稿提示完整 | `tests/e2e/journey.spec.ts`（长内容分页） |
| T18 仓库与请求不含真实 Key | `.gitignore`、`.env.example`、服务端错误体归一化 |
| T19 预算耗尽返回 partial | `tests/server/api.test.ts` |
| T20 错误正文不含凭据 | `tests/server/*`（断言响应与日志字段） |
| T21 320/360px 视口与纸面缩放 | `tests/e2e/journey.spec.ts` |
| T22 采纳后离线查看与导出 | `tests/domain/itinerary.test.ts`、`tests/storage/local.test.ts` |
| 代码审查修复回归（C1–C4、M5–M9/M17、导出规格、隐私载荷） | `tests/domain/review-fixes.test.ts` |

## 真实环境核验记录（2026-09-22）

按详细设计第 13.1 节“接入阶段真实核验”，用真实账号对上游接口做了最小量核验，结论均由真实响应得出。

### 第一次：JS API 平台 Key → 未通过

| 核验项 | 真实结果 |
| --- | --- |
| `/v5/place/text`、`/v5/place/around`、`/v5/direction/walking` | `10009 USERKEY_PLAT_NOMATCH` |
| `/v3/place/text`（旧版对照，排除接口版本因素） | `10009 USERKEY_PLAT_NOMATCH` |
| 浏览器加载高德 JS API（`webapi.amap.com/maps?v=2.0`） | 加载成功，`window.AMap` 可用 |
| 浏览器端 JS API 调用服务（`AMap.Walking`） | `INVALID_USER_SCODE`（需安全密钥） |

结论：该 Key 为 **JS API（Web端）** 平台，不能用于服务端 REST 接入；用于浏览器端还需配套 `securityJsCode`。与详细设计 7.6 节“两种平台 Key 不可混用”一致。

### 第二次：Web 服务（REST）平台 Key → 全部通过

| 核验项 | 真实结果 |
| --- | --- |
| `/v5/place/text`（关键词“天安门”、region=北京） | `10000 OK`，10 条 POI，区县/地址/坐标齐全，`business` 扩展返回营业描述 |
| `/v5/place/around`（固定关键词“公共厕所”、半径 500 米） | `10000 OK`，10 条真实候选，含坐标与距离 |
| `/v5/direction/walking`（双向各一次） | `10000 OK`，距离与 `cost.duration` 均可解析为整数秒 |
| `POST /api/routes/walking-matrix`（3 节点 4 条有向边） | `queryCoverage: complete`，4 条边全部 ready，无失败 |
| 调用速率 | 相邻上游调用间隔约 1.03 秒，符合“不超过每秒 1 次”的预算控制 |
| 凭据保护 | 响应体与服务端日志均不含 Key、不含 `key=` 查询参数 |

**关键实证**：同一对地点双向步行差异显著（天安门→广场 2399 米/1919 秒，反向 678 米/542 秒），验证了详细设计 4.5 节“有向边 A→B 不得复用 B→A”的必要性。

### 端到端真实链路（浏览器 + 本站服务端 + 真实高德）

| 环节 | 真实结果 |
| --- | --- |
| 地点搜索并确认 | 返回 10 条真实候选，用户主动选择后写入行程 |
| 计算路线（真实步行数据 + 本地规划） | 主要建议、数据完整；预计步行 65 分钟、最长连续 65 分钟、全程约 95 分钟 |
| 应用方案 | 路段填入会话内地图值（“步行约 42 分钟”“步行约 14 分钟”），并出现“采纳全部路段时间”提示 |
| 导出图片 | 生成 1 张，逐页保存入口可用 |

数据自洽性核对：路段 2490 秒 → 约 42 分钟、794 秒 → 约 14 分钟（分钟向上取整）；景点停留 40 分钟已含园内步行，未重复相加；全程 95 分钟＝路段 94.7 分钟合计，与需求 10.3 节口径一致。

### 复现方式

```bash
# 适配层核验：契约与错误归一化（4 次上游调用，默认跳过）
AMAP_LIVE=1 npx vitest run tests/integration

# 正式核验：要求成功路径必须通过
AMAP_LIVE=1 AMAP_LIVE_STRICT=1 npx vitest run tests/integration

# 低层诊断：直连上游，只输出归一化结论（3 次调用）
node scripts/verify-amap.mjs
```

## 未支持项与待核实事项

以下内容不属于本次实现范围，或必须由真实环境验证，本仓库不将其表述为已验证事实：

1. **高德账号配额与服务端限制**：接口契约与成功路径已用真实账号核验通过；账号的日配额、QPS 上限与商业使用许可仍需按控制台实际显示确认，公开部署前应据此调整 `server/amap/budget.ts` 中的预算参数。
2. **真实设备导出验证**：自动化仅覆盖桌面 Chromium 与移动视口模拟；iOS Safari、iPadOS Safari、微信内嵌浏览器的图片生成与落盘行为必须人工验证，代码不承诺“已保存到相册”。
3. **读屏与 200% 缩放实测**（D12、D03）：已按可访问性要求实现焦点管理、标签关联与键盘操作，但未做读屏软件实测。
4. **周边设施候选 UI 的真实设备体验**：服务端 `/api/places/nearby` 与界面入口（设施备注内“搜索附近”检索厕所/歇脚处候选、逐属性确认写入、候选一键转休息点）均已接入并有自动化覆盖；真实设备上的检索与操作体验仍需人工核实。
5. **跨设备同步、账号、云端分享、P2 自然语言入口**：按设计文档明确不在范围内。
6. **地图数据许可与留存期限**：未采纳的地图值不落盘；许可核实后可按详细设计 8.5 节的简化路径省略采纳步骤。

所有示例地点、时长与备注均为虚构测试数据，不表示真实景点或已验证的出游路线。

## 许可证

本项目以 [MIT License](./LICENSE) 开源。