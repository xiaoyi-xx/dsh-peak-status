# dsh-peak-status

[English](README.md) | 中文

![peak indicator 预览](assets/peak-indicator.png)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的高峰时段指示灯。在会话头部右上角显示一个融入界面的小胶囊，实时告诉你当前**北京时间**是否处于 DeepSeek API 的**高峰时段**，带秒级时钟、下一转折倒计时和价格提示。

## 高峰时段

DeepSeek 官方峰谷定价（2026-08-17 生效，2026-08-23 起周末调整）：

| 状态 | 时段（北京时间） | 价格 |
| :-- | :-- | :-- |
| 🔴 **高峰** | 工作日 09:00–12:00 和 14:00–18:00 | 高峰价（= 空闲 ×2） |
| 🟢 **空闲** | 其余时间——包括周六、周日全天 | 高峰的一半 |

周末（周六、周日）全天按谷价计费，不设高峰时段。

## 功能

- 状态圆点——**红 = 高峰，绿 = 空闲**，外加实时北京时钟（`HH:MM:SS`，时区 `Asia/Shanghai`，与本机时区无关）
- 倒计时：高峰时显示 `剩 3h 54m · 价格 ×2`，空闲时显示 `距高峰 3h 54m · 半价`
- 点击胶囊展开详情卡：高峰窗口、下一转折（含 `HH:MM:SS` 倒计时）、当前阶段进度条
- 全部使用 Web UI 原生 `--dsw-alias-*` 主题变量，与界面完全融合，没有悬浮贴片
- 持久挂载：重启 dsh web 后依然存在

## 安装

```sh
dsh plugin --profile web add dsh-peak-status
```

也可以直接从 GitHub 安装：

```sh
dsh plugin --profile web add github:xiaoyi-xx/dsh-peak-status
```

然后重启 `dsh web`（或刷新页面），胶囊会出现在会话头部右上角。

## 使用

胶囊每秒自动更新。点击展开/收起详情卡，悬停有快捷提示。高峰/空闲状态严格按上面官方时刻表、以北京时间计算。

如果 DeepSeek 以后调整高峰时段，我们会发布包含新时段的新版本——发现不一致欢迎在仓库提 Issue。

## 许可证

[MIT](LICENSE)
