# window-capture-wgc

`window-capture-wgc` 是 `opapp-desktop` 当前用于验证 `Windows.Graphics.Capture`
窗口抓取链路的最小 .NET helper。

## 候选 SDK

- 第三方 SDK：`Vortice.Direct3D11`
- 平台 API：`Windows.Graphics.Capture` + `WinRT.Runtime`

这里真正需要做“引入评估”的第三方部分是 `Vortice.Direct3D11`。它负责把
DXGI / D3D11 设备桥接到 `Windows.Graphics.Capture` 的 WinRT 帧池消费路径；
`Windows.Graphics.Capture` 本身仍然是 Windows 平台 API，不属于第三方 SDK。

## 当前接入 Spike

- 命令入口：
  `npm run capture:windows:window -- --process-name=HeavenBurnsRed --region=window`
- JS 侧入口：
  `D:\code\opappdev\opapp-desktop\tooling\scripts\windows-capture-window.mjs`
- .NET helper：
  `D:\code\opappdev\opapp-desktop\tooling\dotnet\window-capture-wgc\Program.cs`

当前链路中，`region=window` 与 `region=client` 默认走
`Windows.Graphics.Capture`：

- `region=window`：直接输出完整窗口捕获内容
- `region=client`：先捕获完整窗口内容，再按 `windowRect -> clientRect`
  的相对位置映射裁掉非客户区
- `region=monitor`：仍保留 `CopyFromScreen` 路径

## Windows 维护状态快照

以下结论以 `2026-03-28` 为准：

- GitHub `amerkoleci/Vortice.Windows` 的 `main` 分支提交历史显示，最近提交日期
  为 `2026-03-04`（`Add .net8.0 support to Vortice.Dxc, bump version to 3.8.3`），
  此前还有 `2026-01-05` 的稳定版提交（`Bring back .net8.0 support, bump version to 3.8.2`）。
- 同一仓库首页当前展示 `921` 次提交，README 声明库目标框架已覆盖现代 .NET
  Windows 开发栈（当前页面展示 `net9.0` / `net10.0`）。
- NuGet `Vortice.Direct3D11` 当前稳定版为 `3.8.3`，页面显示 `Last updated 3/4/2026`；
  本 helper 原先使用的 `3.6.2` 为 `2024-10-09` 的稳定版。
- GitHub Releases 页仍停留在 `Release 1.9.143 Latest Sep 8, 2021`，因此不能把
  release tab 作为是否仍在维护的主信号；更可靠的是 commit 与 NuGet 版本节奏。

## 采纳结论

- 结论：采纳 `Vortice.Direct3D11`，并将当前 helper 升级并固定到稳定版 `3.8.3`。
- 采纳范围：只覆盖 `window-capture-wgc` 这条窗口截图 helper 链路，不默认外推为
  整个 Windows host 的通用图形 SDK 选型。
- 采纳理由：
  - 当前 spike 已能稳定拿到 `Windows.Graphics.Capture` 帧并输出图片。
  - 近一年内仍有持续提交和稳定版 NuGet 更新，维护信号明显强于“只剩旧 release tag”的项目。
  - 它只补齐 D3D11 / DXGI 互操作，不强迫宿主提前引入更大的 UI 或应用框架依赖。
- 保留风险：
  - helper 仍是外部 `dotnet run` 形态，首次运行有 restore / build 成本。
  - 如果未来要把截图能力并入正式 host bridge，需要再评估“继续保留 helper”
    还是“把同样的 WGC 实现内建进宿主”。
  - `client-area` 裁剪当前依赖 `windowRect` 与 WGC 返回尺寸之间的比例映射；
    后续若遇到特殊窗口边框或缩放异常，需要补更多实机样本验证映射稳定性。

## 外部参考

- GitHub: https://github.com/amerkoleci/Vortice.Windows
- GitHub commits: https://github.com/amerkoleci/Vortice.Windows/commits/main
- NuGet: https://www.nuget.org/packages/Vortice.Direct3D11/
