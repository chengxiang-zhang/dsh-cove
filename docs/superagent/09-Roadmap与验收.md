# 分期、每期验收命令、七步链对照

> **本文属于《秘书式 super-agent 设计文档体系》**，覆盖全局 §11、§13。索引与权威顺序见 `README.md`。
> Roadmap 只改先后不改设计；每一期都给能跑出数字的命令。

## 11 七步验收链对照

| 步 | 老板的动作 | 对应机制 | 证据 |
|---|---|---|---|
| 1 30 秒内受理，带预计 | 「把 X 的超时改成 Y，并跑对应测试」 | 收集窗 3 秒 → 桌子回合 → `judge(commit)` + `commit` + `say(ack)`；ETA 经 `eta_factor`；20 秒表情兜底 | `sa_outbox.created_at - sa_intake.received_at` |
| 2 之后零进度消息 | 等 | `progress` 报告只进 journal；议程无信号不开口；reply 档每条入站至多一条 | ack 与 deliver 之间 `deliver=1` 的出站计数 = 0 |
| 3 交付 ≤100 词 + 证据 | 等 | §6.3 判定；交付模板由宿主拼"改了哪 / 跑了什么 / 退出码 / 读数" | `words`、`evidence_json`、核对过的 journal `verified=1` |
| 4 「顺便把 Z 也改了」不开新单 | 补一句 | 线程有活承诺 → `judge` 只能 amend 类；`ux_commit_thread_live` 挡第二件；`amend` 写 journal 输入，执行体下一回合吃掉，未消费前不结案 | 本线程承诺数 = 1，amend 处置 = 1 |
| 5 「停」60 秒内真停 | 停 | 快路径 1，不进模型；cancel；60 秒未收到 `turn/end(aborted)` 也强制结案 | release 意图到 `released` 的秒数 |
| 6 重启后「现在有什么在跑」答得上，不重开 | 用户重启服务后问 | I5：对账从账本加 `inspect` 重建；问句走桌子回合，案卷"在办"段来自账本；`origin_event` 唯一使同一消息不能再开 | 重启前后在办集合 diff 为空；承诺数不变 |
| 7 决定有记录、一张单、无第二条回复 | 全程 | 每条入站一个 disposition；`ux_outbox_reply_once`；租约 | `scripts/superagent-check.mjs` 退出码 0 |

## 13 Roadmap 与验收

Roadmap 只排先后；每一期上线的部分都是 §3–§10 的完整实现，不存在简化版。P0 的桌子会话从第一天就机械屏蔽工具，P0 的受理从第一天就带假设与预测列。

开工第 0 天先测四件事，任一不成立就改设计再写：① 飞书事件体在本应用上是否带 `union_id`（实测有一例 `on_584676b5...`〔已证实：brief 事实 17〕，需确认每条都有）；② 桌子会话可见工具清单是否恰好等于秘书工具；③ bash 工具事件里命令与退出码的字段名；④ 空闲执行体会话 `prompt(queue)` 能起新回合。

### P0（第 1–2 周）：账与钟，老板私聊

范围：§5 中 intake、commitments、assumptions、attempts、journal、outbox、lease、deliberations、classes（种子）；桌子屏蔽；快路径 1–4；案卷（在办、等老板、注意力、本批；"老板说过"段读配置里的约束清单）；`judge/commit/amend/release/say`；声明/问规则；执行体与 `report`；结案判定；议程扫描与停滞/打转；预算；启动对账与租约；reply/interrupt 两档；`autoReplyEngine: responder|shadow|superagent` 三档开关与逐消息 CAS 认领（v1 §2.2 的排空规则照用）。

```bash
DB=~/.dsh/lark-inbox/inbox.sqlite
# 1 受理秒数（最近一件）
sqlite3 $DB "SELECT (o.created_at-i.received_at)/1000.0 FROM sa_outbox o JOIN sa_commitments c ON o.commitment_id=c.commitment_id JOIN sa_intake i ON c.origin_event=i.event_id WHERE o.moment='ack' ORDER BY o.created_at DESC LIMIT 1;"   # <=30
# 2 ack 与 deliver 之间对外消息数
sqlite3 $DB "WITH c AS (SELECT commitment_id, desk_id FROM sa_commitments ORDER BY created_at DESC LIMIT 1), a AS (SELECT created_at t FROM sa_outbox, c WHERE moment='ack' AND sa_outbox.commitment_id=c.commitment_id), d AS (SELECT coalesce(min(created_at),9e15) t FROM sa_outbox, c WHERE moment='deliver' AND sa_outbox.commitment_id=c.commitment_id) SELECT count(*) FROM sa_outbox o, c, a, d WHERE o.chat_id=(SELECT chat_id FROM sa_desks WHERE desk_id=c.desk_id) AND o.deliver=1 AND o.created_at>a.t AND o.created_at<d.t;"   # 0
# 3 交付词数、状态、核对过的证据条数
sqlite3 $DB "SELECT o.words, c.state, (SELECT count(*) FROM sa_journal j WHERE j.commitment_id=c.commitment_id AND j.verified=1) FROM sa_outbox o JOIN sa_commitments c USING(commitment_id) WHERE o.moment='deliver' ORDER BY o.created_at DESC LIMIT 1;"   # <=100|fulfilled|>=1
# 4 本线程承诺数与 amend 处置数
sqlite3 $DB "WITH t AS (SELECT thread_key FROM sa_commitments ORDER BY created_at DESC LIMIT 1) SELECT (SELECT count(*) FROM sa_commitments, t WHERE sa_commitments.thread_key=t.thread_key AND parent_id IS NULL), (SELECT count(*) FROM sa_intake, t WHERE sa_intake.thread_key=t.thread_key AND disposition='amend');"   # 1|>=1
# 5 停的秒数
sqlite3 $DB "SELECT (c.closed_at-i.received_at)/1000.0 FROM sa_intake i JOIN sa_commitments c ON i.about=c.commitment_id WHERE i.disposition='release' ORDER BY i.received_at DESC LIMIT 1;"   # <=60
# 6 重启前后各跑一次，diff 为空；每件至多一条 orphan 通知
sqlite3 $DB "SELECT commitment_id, state FROM sa_commitments WHERE state IN ('proposed','open','at_risk') ORDER BY 1;" > /tmp/sa-live-$(date +%s).txt
sqlite3 $DB "SELECT commitment_id, count(*) FROM sa_outbox WHERE idem_key LIKE 'orphan:%' GROUP BY 1 HAVING count(*)>1;"   # 空
# 7 不变量 I1-I4
sqlite3 $DB "SELECT count(*) FROM sa_commitments WHERE state IN ('proposed','open','at_risk') AND kind<>'goal' AND next_look_at > strftime('%s','now')*1000+86400000;"   # 0
sqlite3 $DB "SELECT count(*) FROM inbox_events e LEFT JOIN sa_intake i USING(event_id) WHERE e.owner='superagent' AND (i.state IS NULL OR i.state<>'disposed') AND e.received_at < strftime('%s','now')*1000-600000;"   # 0
sqlite3 $DB "SELECT count(*) FROM sa_attempts a JOIN sa_commitments c USING(commitment_id) WHERE a.state='running' AND c.state NOT IN ('open','at_risk');"   # 0
sqlite3 $DB "SELECT count(*) FROM reply_job_messages m JOIN sa_intake i ON m.message_id=i.message_id;"   # 0：同一入站没有两个回复方
node scripts/superagent-check.mjs --db $DB --since-hours 2   # 退出码 0=全过 1=失败 3=无数据
# 预测列从第一天就有数
sqlite3 $DB "SELECT count(*), sum(pred_eta_min IS NOT NULL) FROM sa_intake WHERE disposition='commit';"   # 两数相等
pnpm --filter @dsh-cove/dsh-web-all test -- superagent && node scripts/lark-autoreply-check.mjs   # 旧 47 项不回归
```

### P1（第 3–4 周）：校准、简报、异议、记忆

范围：`sa_memory` 全部五类与用说分离（此期受众只有老板，say 规则已生效）；`remember/look/pushback`；每日校准任务与 `eta_factor/preferred_executor/ask_mode/pushback_mode`；brief 档与每日简报；案卷判例段与老板说过段改读 memory。

```bash
sqlite3 $DB "SELECT class_id, samples, round(eta_factor,2), ask_mode, pushback_mode, preferred_executor FROM sa_classes WHERE samples>0 ORDER BY samples DESC;"
sqlite3 $DB "SELECT count(*) FROM sa_commitments WHERE eta_factor IS NOT NULL AND eta_factor<>1.0;"   # 有类达到 5 样本后 >0
sqlite3 $DB "SELECT date(created_at/1000,'unixepoch','localtime') d, count(*) FROM sa_outbox WHERE tier='interrupt' AND state='sent' GROUP BY d HAVING count(*)>3;"   # 空
sqlite3 $DB "SELECT date(created_at/1000,'unixepoch','localtime') d, count(*) FROM sa_outbox WHERE moment='brief' GROUP BY d HAVING count(*)>1;"   # 空
sqlite3 $DB "SELECT count(*) FROM sa_journal WHERE kind='pushback' AND json_array_length(json_extract(body_json,'$.grounds'))=0;"   # 0
sqlite3 $DB "SELECT topic, kind, count(*) FROM sa_memory WHERE state='active' GROUP BY 1,2 HAVING count(*)>1;"   # 空
# ETA 误差中位数近似（按周）：P1 起每周记一次，第 2 月应低于第 1 月
sqlite3 $DB "SELECT strftime('%W',closed_at/1000,'unixepoch') w, count(*), round(avg(abs(actual_min - eta_model_min*coalesce(eta_factor,1))*1.0/actual_min),2) FROM sa_commitments WHERE actual_min>0 GROUP BY w;"
```

### P2（第 5–6 周）：盯会话、自动度、目标

范围：`watch` 承诺与探针（先测远端只读接口，无则走 oneshot 只读执行体）；`steer_foreign` 能力；`sa_autonomy` 升降与一句话回滚；`goal` 与 `propose`；`remind`（老板对别人的承诺）；秘书自身空跑统计。

```bash
sqlite3 $DB "SELECT commitment_id, target, (SELECT count(*) FROM sa_journal j WHERE j.commitment_id=c.commitment_id AND kind='look') looks FROM sa_commitments c WHERE kind='watch';"
sqlite3 $DB "SELECT class_id, capability, strength, streak, promotions, demotions FROM sa_autonomy;"
sqlite3 $DB "SELECT count(*) FROM sa_autonomy WHERE strength='auto' AND capability IN ('change_prod','publish','commit_promise');"   # 0（CHECK 已保证，再查一次）
sqlite3 $DB "SELECT trigger_kind, count(*), round(avg(ops=0),2) FROM sa_deliberations WHERE started_at > strftime('%s','now')*1000-86400000 GROUP BY 1;"   # agenda 的空回合比例 <0.3
```

### P3（第 7–10 周）：替老板对别人

范围：`sa_parties` 的同事与群成员；群桌子与受众快照；三态授权（v1 §8.2 的表保留：同事 read allow、写 draft、生产/发布/许诺 deny）；两个回执；承诺词检测（v1 §8.4 的词表保留）；身份前缀（R16）；记忆扩权走简报；金丝雀；跨机第二声音探测。

```bash
sqlite3 $DB "SELECT count(*) FROM sa_commitments c WHERE c.on_behalf_of IS NOT NULL AND c.state IN ('fulfilled','unverified','broken','released') AND (SELECT count(DISTINCT audience) FROM sa_outbox o WHERE o.commitment_id=c.commitment_id AND moment='deliver')<>2;"   # 0
sqlite3 $DB "SELECT count(*) FROM sa_outbox o JOIN sa_desks d ON o.chat_id=d.chat_id WHERE d.chat_type='group' AND o.body LIKE '%CANARY-%';"   # 0
node scripts/superagent-check.mjs --db $DB --promise-scan   # 他人方向出站命中承诺词 0
sqlite3 $DB "SELECT count(*) FROM sa_intake i JOIN sa_parties p ON i.sender=p.party_id WHERE p.kind IN ('member','external') AND i.disposition='commit';"   # 0
```
