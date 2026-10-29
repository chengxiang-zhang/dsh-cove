# Motion（封闭集）

> 默认静止。动效只服务状态变化、连续性或确认反馈。

## 时长

| Token | 建议 | 用途 |
|-------|------|------|
| `--dur-quick` | 120ms | hover / press |
| `--dur-base` | 200ms | 面板开合、淡入 |
| `--dur-slow` | 320ms | 罕见的大布局过渡 |

禁止组件内散落 `300ms`/`400ms` 魔法数；统一走 token。
`transition` 须列出属性（如 `opacity, transform`），禁止 `transition: all`。

## 缓动

| Token | 用途 |
|-------|------|
| `--ease-snap` | 按下/hover |
| `--ease-soft` | 模态/toast |
| `--ease-layout` | 宽高类布局（能避免则避免动画宽高） |

只动画 `transform` / `opacity`（及 compositor 友好属性）。

## Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-quick: 1ms;
    --dur-base: 1ms;
    --dur-slow: 1ms;
  }
}
```

## Surface 差量 · 频率门

| | product | consumer |
|--|---------|----------|
| **日频操作**（Cmd+K、行展开、Tab、筛选、行内保存） | **默认可无动画**；要动则 ≤ `--dur-quick` | 短反馈可有 |
| 低频确认（Modal 开合、成功） | `--dur-base` 可接受 | 同左 |
| growth 落地 | — | 允许有意义入场；禁自动跑马灯/假打字/装饰脉冲 |
| 发光/脉冲状态点 | **禁止** | **禁止** |

## 同屏预算

同一 viewport **同时可见的动画 ≤ 3**（含入场、装饰、循环）。超出 → 删装饰，保留状态反馈。
只动画 `transform` / `opacity`；滚动驱动优先 CSS 时间线，避免 JS 狂抖。
旋钮 `motion`（见 [../craft-knobs.md](../craft-knobs.md)）低分时进一步砍入场。
