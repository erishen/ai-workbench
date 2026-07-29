# ai-workbench 项目评估（2026-07-29）

> 评估范围：`work/research/ai-workbench`（Electron + React 桌面 AI 工作台，PSE 工作流引擎 + 工作流设计器）
> 背景：本轮用户将方向校准为「只做自主型智能体（Planner 驱动），编排型设计器降为可选高级入口」。

## 一、总体结论

- **方向已校准**：聚焦自主型（留白 → Planner 自动拆解 → Specialist/Evaluator → Final），编排型设计器保留为可选高级入口、不主推。
- **架构基础扎实**：主进程分层清晰、命令守卫安全到位、PSE「证据驱动验证」是真实差异化亮点。
- **最大短板是工程纪律**：零自动化测试 + 全部改动未提交 + 无 CI。
- **成熟度**：可用原型 / demo 级（闭环能跑通），**未达生产级**。

一句话：**代码"长得像能用的产品"，但还差「提交 + 测试 + 端到端验证跑通」三道工程关卡才真正落地。**

## 二、维度评分

| 维度 | 评级 | 说明 |
|------|------|------|
| 产品定位与方向 | 🟢 清晰 | 自主 vs 编排二分已想透，决策果断 |
| 架构与代码质量 | 🟢 良好 | 分层合理，拆分到位，规则数组化 |
| 功能完成度 | 🟢 闭环可用 | 自主型主线闭环完整；编排型功能齐全但非主线 |
| 工程健康度 | 🔴 薄弱 | 零测试、全未提交、无 CI |
| 运行期稳定性 | 🟡 待验证 | 模型通道（deepseek-v4-flash 非标名 / agnes 网关中断）未实测跑通 |
| 文档 | 🟡 可能滞后 | README 中英拆分有，新增能力未确认同步 |

## 三、亮点（值得保留）

1. **PSE 证据驱动验证**：Planner / Specialist / Evaluator（两阶段独立取证）/ Reviewer（第二闸门）。Evaluator **不采信执行者自述**、靠命令取证判 PASS/PARTIAL/FAIL，比裸 AutoGPT 式自主体可靠——这是项目核心差异化。
2. **命令守卫 `executor.js`**：只读白名单 + `process.kill(-pid)` 进程组中止，安全设计到位（修过 sed/awk 绕过、空 AbortSignal 杀不掉等债）。
3. **`capabilities.js` 注入 Planner**：`command -v` 只读探测本机工具链（node/php/java…），避免 Planner 规划出本机执行不了的任务——自主型可靠性的好设计。
4. **模块拆分**：原 1060 行 `workflow.js` 拆为 `workflow` / `workflow-parse`（纯函数）/ `prompts`（提示词），职责清晰；规则数组化（`SPECIALIST_RULES` + 自动编号）消除手写编号错乱。
5. **运行日志 `runlog.js`**：每次运行结构化归档（计划/步骤/verdict/证据/报告），可追溯。

## 四、问题与风险

1. ⚠️ **全部改动未提交**：`git status` 显示 11 个已修改（M）+ 5 个未跟踪（??），横跨主进程（executor/workflow/prompts/workflow-parse/capabilities/runlog/llm/electron）+ 前端。`/tmp/workflow.backup.js` 是旧备份。磁盘故障或误操作即整轮工作丢失，且无法 review / 回滚。
2. ⚠️ **零自动化测试**：唯一业务测试是 CRA 占位 `src/App.test.js`。`workflow-parse`（normalizePhases/normalizeSteps/extractJson）与 `executor`（守卫判定）都是纯逻辑、本应易测，却零覆盖——之前的拆分/结构级打通全靠 `node --check` + 肉眼，风险高。
3. **模型通道脆弱**：`deepseek-v4-flash` 非官方标准名（官方 `deepseek-chat`/`deepseek-reasoner`，易 404/400）；agnes 长流曾被网关中断。自主型强依赖稳定模型通道，未实测跑通。
4. **方向沉没成本（低-中）**：前几轮大量投入编排型设计器（图形化画布/阶段序列/依赖/重试/默认模板），现降为可选、暂不在主路径。代码保留、损失可控，但若长期不做需决定是否清理。
5. **开发反馈割裂**：主进程改动需重启 `pnpm dev`，仅前端走 HMR——改引擎时反馈循环慢。
6. **文档可能滞后**：设计器、能力注入、运行日志等新增未确认同步进 README。

## 五、建议（按优先级）

- **P0 — 立即 git 提交**：分 2–3 个逻辑 commit（`refactor: PSE 引擎分层与结构级打通` / `feat: 工作流设计器图形化编排` / `feat: 能力探测与运行日志`），先固化成果、解锁回滚。
- **P1 — 补纯函数单测**：`workflow-parse` + `executor` 守卫判定，低成本高 ROI，给后续重构上保险。
- **P1 — 端到端验证自主型**：本机 `pnpm dev` 给一个真实任务，确认 Planner→…→Final 顺跑；修模型名 / 网关问题。
- **P2 — 冻结编排型为「实验性可选」**：标注清楚，聚焦自主型打磨（Planner 拆解质量、Evaluator 取证严谨度、重试策略调优）。
- **P2 — 长期迁 Vite**：CRA 已维护模式，未来可迁 Vite，但非急。

## 六、对当前决策的回应

「只做自主型、编排型先不做」是**正确收敛**：过去在编排型设计器上投入较多，但自主型才是当前主线，且 `capabilities` 注入、Evaluator 取证等已让自主型有真实可靠性优势。设计器代码保留为可选入口，既不浪费投入，也不干扰主线。下一步不应再扩编排型，而要把自主型「跑顺、测稳、提交掉」。
