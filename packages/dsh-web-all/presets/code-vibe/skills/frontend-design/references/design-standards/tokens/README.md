# Tokens — 覆盖规则

插件预置的**封闭尺度与语义色角色**默认值。有 UI 时与 surface 册一并服从。

## 覆盖顺序

```text
宿主 AGENTS.md / docs/product/{PRODUCT,DESIGN}.md / 已声明设计 token / 组件库主题
  ≫ 本版 Spec 显式差量
    ≫ 本目录默认（scale.md / color-roles.md / motion.md）
```

- 宿主已有完整 DS（antd / Geist / shadcn theme 等）→ **禁止平行发明第二套数值**；只保留本目录的**角色名与禁令**，数值以宿主为准。
- 宿主无 DS → 使用本目录默认表施工。
- 禁止在组件里写魔法 px / 任意 hex（须来自 token 或宿主变量）。
  **Wireless：** 散落魔法长度 = bug → 见 [scale.md](./scale.md) §Wireless。

## 册

| 文件 | 内容 |
|------|------|
| [scale.md](./scale.md) | space / type / height / radius / icon 封闭阶梯 + wireless |
| [color-roles.md](./color-roles.md) | 语义色角色 + 无宿主默认 hex |
| [motion.md](./motion.md) | 时长 / 缓动 / 频率门 / 同屏≤3 |

加载合同 → [../README.md](../README.md)。
