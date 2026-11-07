---
name: release-gate
description: Use before a change goes live — 能上线了吗 / 上线前检查 / 可以发了吗 / 发布前还有什么问题, a wish declares dev-effective or production-delivered, or a change mutates production. Owns the P0–P6 release track and the release_check.py PASS/FAIL verdict; launch readiness is never prose.
---

# Release Gate（发布轨）

> 发布是交付的一段，不是事后审计。**「能不能上线」的答案是一张 `release_check.py` 的表，不是一段散文。**
> 2026-11-08 来源：用户问「具备全量上线条件了吗」，回答是「生产还在跑旧代码、没有回滚演练、告警没在生产验证过」——这些不是上线条件问题，是本预设没有发布轨。

## 1. 先分清：真 blocker 还是我们自己的欠账

| 看起来像 blocker | 实际 | 本回合动作 |
|---|---|---|
| 生产还在跑旧代码 | 发布没执行 | push → 构建 → 部署 → 冒烟，同一会话做完 |
| 没有回滚点 | 没写回滚方案 | 写 `ROLLBACK` 并跑 `ROLLBACK_CHECK_CMD` 证明它存在 |
| 告警没在生产验证过 | 没跑只读查询 | 跑一次告警通道 readback |
| 没有生产测试账号 | 没找 | 先耗尽仓库 / `.env*` / 历史会话 / memoir；确无才是用户输入 |
| 没有 E2E | 没做浏览器走查 | 跑 `.sdd/acceptance/<id>/e2e/`，见 §4 |
| 配置模板与 live 不一致 | 没同步 | 先同步模板再 reload，禁止只写 reload |

**只有两类真 blocker**：① 用户自己的生产授权（一次，P4）；② 只有用户才有的输入（账号、密钥、业务取舍）。其余都是没做完的活——先做完，再回答问题。

## 2. 发布轨 P0–P6

| 步 | 动作 | 落盘产物 |
|---|---|---|
| P0 冻结 | 变更集提交并 push；工作树干净；记 HEAD SHA 与分支 | `git status --porcelain` 为空 |
| P1 制品 | 构建 / 打镜像 / 打包，记 digest | `ARTIFACT`（`tag@sha256:…`） |
| P2 发布方案 | 怎么发：执行序、影响面、非代码面（migrate / 主机依赖 / 反代·进程模板 / 新 env 合同） | `<ws>/.sdd/release/<id>.env` |
| P3 验证方案 | 怎么证伪：版本 readback、产品冒烟、数据一致性、告警、回滚点检查 | 同上（`*_CMD` / `*_EXPECT`） |
| P4 授权 | 把 P2+P3 贴给用户，同一回合要那一次授权；记原话 | `.sdd/acceptance/<id>.deploy-authorized` |
| P5 执行 | 按 P2 执行；每步留 log | `.sdd/release/<id>/*.log` |
| P6 冒烟 | 在目标环境跑产品路径冒烟（不是 `/health`） | `release_check.py <ws> <id> --run` 全 PASS |

`/health`、进程 active、首页 200、nginx 200 只算 P5 过程信号，永远不是 P6；API 200 也不升级 `production-delivered`。

## 3. 那一次授权怎么问

```
发布方案：<P2 一句话：顺序 + 影响面 + 非代码面>
验证方案：<P3 一句话：版本 readback + 产品冒烟 + 回滚点 + 告警>
回滚点：<ROLLBACK>
要你决定：现在授权执行这次生产发布（回「可以上」即执行；也可以指定窗口）
```

拿到授权后：`journey.sh --authorize-deploy --by <用户> --quote "<原话>"` → 执行 → `release_check.py <ws> <id> --run`。
**授权与执行必须同一会话**：只问不做、或做完不跑 P6，都算没交付。未拿到授权时只能停在 P3，并一句话说明「等你授权即可执行」。

## 4. 浏览器端到端（E2E）不是截图

`.sdd/acceptance/<id>/e2e/` 三件套缺一不可，`release_check.py` 与 `check_spec --phase close` 都会拦：

1. `steps.md`：至少两条编号步骤（打开哪个 URL、点哪个控件、期望看到什么）；
2. `run.log`：真实浏览器通道的逐步输出（Playwright / 浏览器 MCP / 宿主 E2E 目标均可），不是手写摘要；
3. 至少一张截图（`png/jpg/jpeg/webp`，落在 `.sdd/acceptance/<id>/` 下）。

**首屏截图、`curl /health`、单元测试绿、接口 JSON 都不是 E2E。** 有 UI 的交付没有这三件套，不得说 `验收完成` / `dev-effective`。

## 5. 判据

- `release_check.py` 不全 PASS ⇒ 只能报 `code-ready` / `dev-effective`，贴未过项 + 下一动作；禁止 `production-delivered`。
- 交付目标在计划期写清：`docs/wish/<id>/delivery.md` 一行 `Target: code-ready | dev-effective | production-delivered` + 目标环境 + 回滚点。目标为 production 而 `.sdd/release/<id>.env` 不存在 ⇒ 第一个 FAIL。
- 版本 readback、产品冒烟、回滚点、E2E 四项任一未跑，就不能用「已验证」概括；结论必须点名跑了什么、缺了什么。
- 模板与 worked example：`references/release-plan.md`。