# 素材真源

本目录是**素材与设计 token 的真源**。派生文件不得写回本目录:它们属于消费者。

| 类别 | 真源 | 说明 |
| --- | --- | --- |
| 设计 token | `tokens.json` | 颜色、字号、间距、圆角、动效的唯一真值;所有表面的 token 都由它生成 |
| 应用图标(ICON) | `../../netbird-client/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_background.png` 与 `ic_launcher_foreground.png` | **手机端出货的图标就是图标真源**;桌面图标由这两层合成(Android 自适应画布 108dp 的可见区 72dp) |
| 图形标记(MARK) | `dashboard/logo-mark.svg` | 需要矢量的场合使用(如菜单栏模板图) |
| 字标(LOCKUP) | `dashboard/logo-lockup.svg` | 图标 + 产品名;其 wordmark 随系统深浅色,故应用内部不用它做图片 |
| 落地页二维码 | `../client/qr-phone.svg` | 落地页指向 Android 安装包 |

## 规则

1. **一律生成**:图标 `.icns`/`.png`、菜单栏模板图、`brand.js`、`app-icon.svg`、Android 颜色资源、console token、落地页 token 全部由 `scripts/dsh-netbird-brand.mjs`(及 console 的生成脚本)产出,并纳入 `node scripts/dsh-netbird-brand.mjs --check` 漂移门禁。
2. **派生放在消费者一侧**(如 `tools/anywhere-agent/icons/`)。品牌测试断言生成物不在本目录内。
3. **品牌素材不是外壳的创作对象**:只做平台适配(尺寸、圆角、文件格式),不得改配色、不得重画图形。桌面图标必须引用手机图层,且不得自带颜色/描边/图形。
4. **不留无消费者的中间产物**:截图、试验素材不进仓库。

## 遗留(明确记录,尚未收敛)

- `dashboard/favicon.svg`、`favicon.ico`、`apple-icon.png` 是**第二份手绘图标**,与手机图层并非同一套图形(环更细、无辉光)。收敛路径:由手机图层生成 `favicon.png`、`apple-touch-icon.png`,退役这三个手工文件。影响面:落地页与 console 构建(需同改 `scripts/dsh-netbird-console-brand.mjs` 及其门禁),因此单独一步做。
- `dashboard/aw-brand.css`、`aw-brand.js` 是 console 的**生成产物**,历史上就落在素材目录内。同样需改 console 构建后才能搬走。
