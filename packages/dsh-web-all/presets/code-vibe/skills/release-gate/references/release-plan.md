# 发布方案模板（`.sdd/release/<id>.env`）

> `release_check.py` 读这份文件；缺键或多写一个拼错的键都按 FAIL 处理（脚本只认下列键）。
> 值可以含空格（`VERSION_CMD=printf 'v1.2.3\n'`）；`#` 行与空行忽略。

## 必填键

| 键 | 含义 | 例 |
|---|---|---|
| `TARGET` | 固定 `production`；其它值不进入发布轨 | `production` |
| `ENV` | 目标环境的人读名字 | `prod-cn` |
| `ARTIFACT` | 要上的制品；带 `@sha256:` 时校验 64 位小写十六进制 | `registry.example.com/app@sha256:9f2c…` |
| `VERSION_CMD` | 只读命令：打印目标环境当前版本 | `kubectl -n prod get deploy app -o jsonpath='{.spec.template.spec.containers[0].image}'` |
| `VERSION_EXPECT` | 上面命令输出里必须出现的子串 | `@sha256:9f2c…` |
| `SMOKE_CMD` | 只读命令：跑一条真实产品路径 | `curl -fsS -H "Authorization: Bearer $TOKEN" https://app.example.com/api/orders?limit=1` |
| `SMOKE_PROOF` | 冒烟输出必须包含的**产品级**标记，≥4 字符，不能是 `ok/200/pass/true/health` | `"orders":` |
| `ROLLBACK` | 回滚点（上一个 tag / sha / 备份 id） | `sha-4c1d2e9` |
| `ROLLBACK_CHECK_CMD` | 只读命令：证明回滚点真实存在 | `git cat-file -e sha-4c1d2e9^{commit}` |
| `ALERT_CMD` | 只读命令：读回告警通道（规则在册 / 静默窗口 / 最近触发） | `curl -fsS http://alertmanager/api/v2/alerts` |

## 示例（一次真实发布）

```sh
TARGET=production
ENV=prod-cn
ARTIFACT=registry.example.com/orders@sha256:9f2c1c0f0d7a4f7c1b2a3d4e5f60718293a4b5c6d7e8f9012345678abcdef01
VERSION_CMD=kubectl -n prod get deploy orders -o jsonpath='{.spec.template.spec.containers[0].image}'
VERSION_EXPECT=@sha256:9f2c1c0f0d7a4f7c1b2a3d4e5f60718293a4b5c6d7e8f9012345678abcdef01
SMOKE_CMD=curl -fsS -H "Authorization: Bearer $PROD_TOKEN" https://app.example.com/api/orders?limit=1
SMOKE_PROOF="orders":
ROLLBACK=sha-4c1d2e9
ROLLBACK_CHECK_CMD=git -C . cat-file -e sha-4c1d2e9^{commit}
ALERT_CMD=curl -fsS http://alertmanager.example.com/api/v2/alerts
```

## 脚本产出

- `<ws>/.sdd/release/<id>/<check>.log`：每条命令的 stdout+stderr+exit code；
- `<ws>/.sdd/release/<id>/status.tsv`：`check<TAB>verdict<TAB>detail` 九行，每次运行重写；
- 退出码：全 PASS 才是 0。`--run` 之前 `version/smoke/rollback/alert` 显示 `UNRUN`，摘要 `release_check: n/9 PASS`，退出码 1。

## 判定表

| check | PASS 条件 |
|---|---|
| `plan` | 文件存在，十个必填键都非空 |
| `change-set` | 是 git 仓、工作树干净；detail 记 HEAD 与分支 |
| `e2e` | `e2e/steps.md` 含 ≥2 条编号步骤 + `run.log` 非空 + ≥1 张图 |
| `authorized` | 授权文件存在，`by`/`ts`/`quote` 齐全，且 mtime 不早于发布方案 |
| `artifact` | 非空；带 `@sha256:` 时摘要格式合法 |
| `version` | `VERSION_CMD` exit 0 且输出含 `VERSION_EXPECT` |
| `smoke` | `SMOKE_CMD` exit 0 且输出含 `SMOKE_PROOF`（产品级标记，挡 `/health` 冒充） |
| `rollback` | `ROLLBACK` 非空且 `ROLLBACK_CHECK_CMD` exit 0 |
| `alert` | `ALERT_CMD` exit 0 且有输出 |

## 常见误用

- **把健康检查当冒烟**：`SMOKE_CMD=curl /health` + `SMOKE_PROOF=ok` 会被脚本直接判 FAIL；换真实用户路径。
- **先写授权后写方案**：`authorized` 只认「方案存在之后」的授权；顺序反了要重跑 `journey.sh --authorize-deploy`。
- **拿 `--run` 之外的表去宣称上线**：`UNRUN` 不算证据，脚本退出码 1，粘贴表时必须连退出码一起报。
- **把 dev 环境的 E2E 当生产验收**：`e2e` 只证明用户可见面在 dev 通过；生产是否生效只认 `version` + `smoke`。