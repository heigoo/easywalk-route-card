# AGENTS.md — AI 编码代理工作指南

本文件面向在本仓库内工作的 AI 编码代理（Trae / Claude / Codex 等），说明项目背景、命令、分层约定与不可违反的实现口径。需求与设计以两份说明书为准：

- 《[省脚力路线卡-需求说明书](./省脚力路线卡-需求说明书.md)》
- 《[省脚力路线卡-详细设计说明书](./省脚力路线卡-详细设计说明书.md)》
- 进度与验收对照见《[README](./README.md)》

## 项目速览

省脚力路线卡（EasyWalk Route Card）：把选好的景点整理成大字版、可调整、可导出图片的步行路线卡。

- 前端：React 18 + TypeScript（strict）+ Vite，单套业务代码按视口宽度适配手机/平板/桌面
- 服务端：Fastify 高德 Web 服务适配层（`server/`），浏览器不接触服务端 Key
- 契约：`shared/contracts/` 前后端共享 Zod schema
- 存储：仅 `localStorage`（`src/storage/`），无账号、无云端同步
- 图片导出在本机完成（`html-to-image`），不上传行程截图
- 规划搜索跑在 Web Worker（`src/workers/`），避免阻塞 UI

## 常用命令

```bash
npm install
npm run dev            # 前端开发服务器（5173，/api 代理到 8787）
npm run server:dev     # 高德适配服务（8787，未配置 Key 时手动功能照常可用）
npm run typecheck      # TypeScript 严格校验（tsc -b --noEmit）
npm test               # Vitest 全量单测/组件/契约测试
npx vitest run tests/server    # 仅服务端契约测试（伪造 fetch，不联网）
npx vitest run tests/workers   # 仅规划算法与 Worker 协议
npm run test:e2e       # Playwright（桌面 + 移动视口，需先 build 或起 dev server）
npm run build          # 生产构建（含独立 planner.worker 分包）
```

真实高德核验（默认跳过，属人工核验路径，不要在常规改动中运行）：

```bash
AMAP_LIVE=1 npx vitest run tests/integration
node scripts/verify-amap.mjs
```

改完代码至少跑 `npm run typecheck` 与 `npm test`；动到导出、布局或视口行为时补跑 `npm run test:e2e`。

## 目录与分层

| 目录 | 职责 | 允许依赖 |
| --- | --- | --- |
| `shared/contracts/` | 请求/响应类型、枚举、边界约束（Zod） | 无 |
| `src/domain/` | 纯领域逻辑：校验、统计、连续步行、状态合成、候选应用 | `shared/contracts` |
| `src/workers/` | 有界搜索、候选生成、冲突检测、搜索完整度 | `src/domain` |
| `src/services/` | API 客户端：取消、请求关联、响应解析 | `shared/contracts` |
| `src/storage/` | `localStorage` 保存/恢复、持久化白名单 | `src/domain` |
| `src/features/` | 各功能 UI 与视图模型 | 上述各层 |
| `src/app/` | 应用壳、布局、视图切换、状态编排 | 上述各层 |
| `server/` | Fastify 路由、入参校验、错误契约、预算与并发 | `shared/contracts`、`server/amap` |
| `server/amap/` | 附加 Key、访问上游、归一化、隐藏敏感信息 | 无 |
| `api/` | 部署平台的 API 入口包装 | `server/` |

规则：

- 领域层不 import React、不碰 DOM、不发网络请求；纯函数 + 显式入参，便于单测。
- 前端不直接访问高德；一切地图能力走 `/api/...`，服务端做入参校验与预算控制。
- 请求/响应字段类型只在 `shared/contracts/` 定义，前后端不得各写一份。
- 状态只在 `src/app/` 与各 feature 的 hook 中编排，展示组件保持只读（`RouteCard` 只消费 `CardViewModel`）。

## 不可违反的实现口径

这些是需求/设计的验收基线，改动时必须保持：

1. **缺失数据只报已知下界与待补充项**：部分合计不得当作完整总量；未知休息按“可能分界”切分连续步行下界，不得断言超限（`src/domain/compute.ts`）。
2. **有向边不复用**：A→B 与 B→A 是两条边，跳站/重排/改坐标后旧路段时间失效（`src/domain/itinerary.ts` `rebuildLegs`）。
3. **地图值显式采纳才落盘**：未采纳的估算只在会话内可见，`toPersisted` 保持白名单；采纳后离线可查看可导出。
4. **事实覆盖保护**（设施/开放时间）：逐属性确认，只写本次实际改动，同值不重写；“已核对”退回“待确认”需二次确认；没查到 ≠ 没有。
5. **开放时间保守解析**：严格文法解析，解析不了只留原文并标“待核对”，不得编造时段。
6. **直线距离不参与计算**：仅标注“直线距离，非步行路程”。
7. **预览与导出同一视图模型**：`buildCardViewModel` 单一事实源；导出点击时冻结快照。
8. **导出规格**：固定 360px 逻辑宽度、960px 分页预算、3 倍像素密度；文本按行拆分（Range + getClientRects），不裁切、不缩字号。
9. **请求关联与版本校验**：乱序/过期响应不得覆盖新结果（`src/features/planning/usePlanning.ts`）。
10. **卡片状态合成**：`blocked / violated / draft / complete` 四态语义固定（`src/domain/status.ts`）。
11. **无 Key 降级**：未配置 `AMAP_WEB_SERVICE_KEY` 时返回 `AMAP_NOT_CONFIGURED` 并说明原因，手动填写、预览、导出必须继续可用。

## 安全红线

- **严禁把真实高德 Key 写入任何提交内容**（源码、测试、示例、日志、错误正文）。只通过 `.env` 提供，`.env` 已被 Git 忽略；模板见 `.env.example`。
- Key 只在服务端读取，响应体与日志不得含 Key 或 `key=` 查询参数（`tests/server/*` 有断言，别改坏）。
- JS API 平台 Key 与 Web 服务（REST）平台 Key 不可混用，服务端只用后者。

## 测试约定

- 测试放在 `tests/`，按源码目录镜像分组：`tests/domain/`、`tests/server/`、`tests/features/`、`tests/workers/`、`tests/storage/`、`tests/app/`、`tests/e2e/`。
- Vitest 环境为 jsdom（`vitest.config.ts`），`tests/e2e/**` 只由 Playwright 运行。
- 服务端测试用伪造 `fetch`，**不得访问真实网络**；真实调用只在 `tests/integration/`（`AMAP_LIVE=1` 才跑）。
- 领域口径变更必须补单测，优先复用 README「设计验收用例对照」中的用例编号（T01–T22）。
- 不要为了通过测试而放宽断言；口径变化要同步改需求/设计对照说明。

## 文档同步

- 需求/设计说明书是权威口径；实现与文档冲突时先确认再改，不要静默偏离。
- 有意的行为变更需更新 README 的「能力清单」「关键实现口径」或验收对照表。
- 未经真实环境核验的结论不得写成“已验证”；参考 README「未支持项与待核实事项」的表述风格。
