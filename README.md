# Click Sync

![WebHID](https://img.shields.io/badge/WebHID-enabled-blue)
![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-yellow)

Click Sync 是一个基于 WebHID 的多品牌鼠标网页驱动与调试工作台，当前代码已完成运行时与适配层重构。  
Click Sync is a WebHID-based browser workbench for cross-brand mouse configuration, with a refactored runtime and adapter architecture.

当前实现覆盖品牌：`Logitech`、`Rapoo`、`ATK`、`Chaos`。  
Currently implemented brands: `Logitech`, `Rapoo`, `ATK`, `Chaos`.

<a id="toc"></a>
## 目录 / Table of Contents

1. [背景 / Background](#background)
2. [重构更新要点 / What Changed](#what-changed)
3. [支持设备 / Supported Devices](#supported-devices)
4. [功能矩阵 / Feature Matrix](#feature-matrix)
5. [快速开始 / Quick Start](#quick-start)
6. [使用流程 / Usage Flow](#usage-flow)
7. [架构说明 / Architecture](#architecture)
8. [公开接口契约 / Public API Contracts](#public-api-contracts)
9. [WebHID Workbench / WebHID Workbench](#webhid-workbench)
10. [常见问题 / FAQ](#faq)
11. [资源与链接 / Resources & Links](#resources)
12. [开源协议 / License](#license)
13. [贡献 / Contributing](#contributing)

<a id="background"></a>
## 背景 / Background

本项目是纯前端静态工程（`index.html` + 脚本文件），核心目标是把不同品牌/协议差异抽象到统一语义层，让 UI 以统一方式完成连接、读取、写入和测试。  
This is a static frontend project (`index.html` + scripts). The goal is to hide protocol differences behind a unified semantic layer so the UI can connect/read/write/test consistently.

沿用旧版 README 的定位：这是一个 `ALL IN ONE` 的鼠标网页驱动方案。  
Keeping the original README positioning: this is an `ALL IN ONE` browser mouse-driver solution.

旧版 README 的核心能力描述在当前代码中仍成立：

- WebHID 设备连接与自动识别
- 参数配置：按键映射、DPI、回报率、品牌高级参数
- 测试工具：双击检测、轮询率检测、灵敏度匹配、角度校准
- 页面主模块：`keys`、`dpi`、`basic`、`advanced`、`testtools`

<a id="what-changed"></a>
## 重构更新要点 / What Changed

- 运行时识别改为注册表驱动：`device_runtime.js` 通过 `VID + usagePage/usage` 识别设备，并按当前选择动态加载 `protocol_api_*.js`。
- 适配层统一：`refactor.js` 提供 `window.DeviceAdapters`、`window.DeviceWriter.writePatch`、`window.DeviceReader`，将“标准语义 key”映射到协议层。
- 写入链路重构：`app.js` 使用 `enqueueDevicePatch()` 做 patch 合并与防抖写入，写入前必须通过首轮配置同步门禁（`__writesEnabled`）。
- 写入回显一致性：`app.js` 引入 write-intent 机制（`readStandardValueWithIntent`），避免 UI 在回包延迟阶段闪回旧值。
- 连接握手优化：`connectHid()` 中先挂一次性 `onConfig` 监听，再发 `requestConfig`，降低丢包窗口。
- Logitech 专属高级能力已接入：配置槽、双回报率（有线/无线）、板载内存、Lightforce、Surface、BHOP、DPI LOD 等。
- Logitech keymap 机型变体图已接入：`image/GPW.png` 与 `image/GPW_DEX.png`。
- 本次 README 更新仅是文档重写，不改变运行时代码接口。  
  This README update is documentation-only and does not change runtime APIs.

<a id="supported-devices"></a>
## 支持设备 / Supported Devices

### 运行时识别矩阵 / Runtime Detection Matrix

以下为 `device_runtime.js` 的设备识别规则（运行时层，不等于协议层完整兼容列表）：

| 品牌 / Brand | 运行时识别规则（VID/Usage） / Runtime Fingerprint | 代码位置 / Source |
|---|---|---|
| Rapoo | `vendorId 0x24AE` + `usagePage 0xFF00` + `usage 14/15` | `device_runtime.js` |
| ATK | `vendorId 0x373B` + `usagePage 0xFF02` + `usage 0x0002` | `device_runtime.js` |
| Chaos | `vendorId 0x1915` + `usagePage 65290 (0xFF0A)` 或 `65280 (0xFF00)` | `device_runtime.js` |
| Logitech | `vendorId 0x046D` + `usagePage 0xFF00`，`usage 0x01/0x02`（含无 usage 宽松分支） | `device_runtime.js` |

### 协议层已知机型/白名单 / Protocol-Level Known Models

以下为协议文件中的明确过滤范围或已知 PID 族：

| 品牌 / Brand | 协议范围 / Protocol Scope | 说明 / Notes |
|---|---|---|
| Chaos | `protocol_api_chaos.js` 明确列出 `M1/M1 PRO/M2 PRO/M3 PRO` 的有线、无线 1K、无线 8K PID 族 | 例如 `0x521c/0x520c/0x520b` 到 `0x551c/0x550c/0x550b` |
| Logitech | `protocol_api_logitech.js` 当前 `defaultFilters` 指向 `productId 0xC54D`（含 usage `0x01/0x02` 与兜底） | 运行时可识别更宽 Logitech 设备，但协议兼容取决于 HID++ 特性布局 |
| Rapoo | `protocol_api_rapoo.js` 使用 `vendorId 0x24AE` + `usagePage 0xFF00`（含 usage `14/2` 与兜底） | 与运行时过滤存在“识别更宽/更窄”差异，属正常分层设计 |
| ATK | `protocol_api_atk.js` 使用 `vendorId 0x373B` + `usagePage 0xFF02` + `usage 0x0002` | 与运行时一致 |

### 兼容性说明 / Compatibility Note

- 同品牌不代表所有型号、所有固件版本都完全等价。  
- 运行时“能识别”不等于协议层“全能力可写”。  
- 真实可用能力以 `refactor.js` 的 adapter `features` 与设备回包为准。  
- Same brand does not imply full equivalence across all models/firmware. Runtime detection and protocol capability are intentionally separated.

<a id="feature-matrix"></a>
## 功能矩阵 / Feature Matrix

以下矩阵基于 `refactor.js` 中各品牌 adapter 的 `features/ranges/keyMap/transforms/actions`。

### 核心能力 / Core Capabilities

| 品牌 / Brand | DPI 轴 / DPI Axis | 回报率 / Polling | 配置槽 / Config Slots | DPI LOD | 电量策略 / Battery Strategy |
|---|---|---|---|---|---|
| Logitech | 双轴（高级轴）/ Dual-axis | 双路：有线+无线 / Dual path (wired+wireless) | 支持 / Yes | 支持 / Yes | `supportsBatteryRequest=false`（不走主动轮询） |
| Rapoo | 双轴（高级轴）/ Dual-axis | 单路 / Single path | 不支持 / No | 不支持 / No | `supportsBatteryRequest=false`，默认 `120000ms` |
| ATK | 双轴（高级轴）/ Dual-axis | 单路 / Single path | 不支持 / No | 不支持 / No | 支持主动请求，默认 `60000ms` |
| Chaos | 单轴主路径 / Single-axis main path | 单路 / Single path | 不支持 / No | 不支持 / No | 支持主动请求，默认 `60000ms` |

### 高级能力 / Advanced Capabilities

| 品牌 / Brand | Motion/Linear/Ripple | Key Scan | Wireless Strategy/Comm Protocol | Long Range | 灯效 / Lighting | Onboard | Lightforce | Surface | BHOP | 备注 / Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Logitech | 否 / No | 否 / No | 否 / No | 否 / No | 非 ATK 灯效路径 / non-ATK path | 是 / Yes | 是 / Yes | 是（`auto/on/off`） | 是 / Yes | 高级面板、配置槽、双回报率 |
| Rapoo | 是 / Yes | 是 / Yes | 是 / Yes | 否 / No | 主 LED 与相关项 / primary LED path | 否 / No | 否 / No | 否（非 Logitech surface） | 否 / No | 含通信策略开关 |
| ATK | 是 / Yes | 否 / No | 否 / No | 是 / Yes | ATK 灯效 + DPI 色彩 / ATK lights + DPI colors | 否 / No | 否 / No | 否 / No | 否 / No | 含长距离模式 |
| Chaos | 是 / Yes | 否 / No | 否 / No | 否 / No | 基础 LED 路径 / basic LED path | 否 / No | 否 / No | 双 Surface Toggle（主/次） | 否 / No | 兼容旧字段映射 |

### Logitech Keymap 变体 / Logitech Keymap Variants

- 默认图：`image/GPW.png`
- 机型变体图：`image/GPW_DEX.png`（匹配如 `PRO X 2 DEX`）
- 按钮位点在变体中可独立定义，避免同图映射误差。  
  Variant-specific points are supported to avoid incorrect button overlays across models.

<a id="quick-start"></a>
## 快速开始 / Quick Start

WebHID 需要安全上下文，请使用 `http://localhost` 或 `https`。  
WebHID requires secure context: use `http://localhost` or `https`.

不推荐 `file://` 直接打开页面，WebHID 在多数浏览器下通常不可用。  
`file://` is not recommended; WebHID is usually unavailable there.

1. 进入项目目录。
2. 启动本地静态服务（任选其一）：

```bash
# Python
python -m http.server 8000

# Node.js
npx http-server . -p 8000
```

3. 打开 `http://localhost:8000/index.html`。
4. 使用 Chromium 桌面浏览器（Chrome/Edge）。

<a id="usage-flow"></a>
## 使用流程 / Usage Flow

1. 在 Landing 页面通过用户手势触发连接（首次授权必须用户操作）。  
   First-time authorization must be user-gesture initiated.
2. 运行时连接入口走 `DeviceRuntime.connect(...)`，自动识别设备类型并可触发品牌切换。
3. 连接握手开始时写入门禁关闭（`__writesEnabled=false`）。
4. `app.js` 先挂 `waitForNextConfig(...)` 的一次性监听，再触发 `requestDeviceConfig()`。
5. 收到首轮配置后应用 UI，并开启写入门禁（`__writesEnabled=true`）。
6. UI 修改经 `enqueueDevicePatch()` 合并后进入 `DeviceWriter.writePatch(...)`，避免高频竞态写入。
7. 已授权设备支持自动探测（`autoConnect`），并监听 `navigator.hid` 的 `connect/disconnect` 事件。
8. 主页面模块（延续旧 README 命名）：
   `keys`（按键映射）、`dpi`（DPI 档位与范围）、`basic`（基础性能/回报率）、`advanced`（高级项）、`testtools`（测试工具）。
9. 顶部工具栏支持语言切换、主题切换与配置槽切换（按设备能力显示）。

<a id="architecture"></a>
## 架构说明 / Architecture

### 四层结构 / Four Layers

1. Runtime 层（`device_runtime.js`）  
   设备识别、设备选择、自动连接、动态协议加载（`ensureProtocolLoaded`）。
2. Adapter/Writer/Reader 层（`refactor.js`）  
   语义映射、能力约束、统一读写入口（`DeviceAdapters`/`DeviceWriter`/`DeviceReader`）。
3. Protocol 层（`protocol_api_*.js`）  
   品牌协议实现，负责底层报文和配置回包事件。
4. UI Orchestration 层（`app.js`）  
   连接生命周期、写入队列、回显一致性、状态同步与页面交互。

### 数据流 / Data Flow

- 写入链路 / Write path  
  `UI change` -> `enqueueDevicePatch` -> `DeviceWriter.writePatch` -> `hidApi.setFeature / setBatchFeatures` -> `device`.

- 读取链路 / Read path  
  `device report` -> `hidApi.onConfig / onBattery / onRawReport` -> `DeviceReader.requestConfig/getCachedConfig/readStandardValue` -> `applyConfigToUi`.

### 新增设备接入 Checklist / Add-New-Device Checklist

1. 在 `device_runtime.js` 增加识别规则与过滤器（`DEVICE_REGISTRY`）。
2. 新增 `protocol_api_<brand>.js` 并实现最小兼容接口。
3. 在 `refactor.js` 新增 profile（`ranges/features/keyMap/transforms/actions`）。
4. 保持 UI 走语义 patch，不直接硬编码协议字段。
5. 验证连接、首轮配置同步、写入门禁、断连恢复。
6. 验证 `onConfig/onBattery/onRawReport` 事件回路。
7. 验证高频写入时防抖与 write-intent 回显一致性。
8. 更新 README 对应矩阵与兼容性说明。

<a id="public-api-contracts"></a>
## 公开接口契约 / Public API Contracts

本节描述当前运行时对外契约（文档用途，不改变代码）。  
This section documents current runtime contracts (documentation only).

### `window.DeviceRuntime`

- `getSelectedDevice(): string`
- `setSelectedDevice(device, { reload = true }?)`
- `requestDevice(): Promise<HIDDevice | null>`
- `autoConnect({ preferredType }?): Promise<{ device, candidates, detectedType }>`
- `connect(mode?, opts?): Promise<{ device, candidates, detectedType, preferredType }>`
- `ensureProtocolLoaded(): Promise<{ device, ProtocolApi }>`

### `window.DeviceAdapters`

- `getAdapter(id): Adapter`
- `Adapter` 语义：
  - `features`：能力开关（UI 显隐与策略分支依据）
  - `ranges`：范围配置（DPI/回报率/槽位等）
  - `keyMap`：标准语义键 -> 协议键映射
  - `transforms`：读写转换（标准值 <-> 协议值）
  - `actions`：需要专用方法时的动作映射

### `window.DeviceWriter.writePatch`

- 入参：`{ hidApi, adapter, payload }`
- `payload`：标准语义 patch（如 `pollingHz`, `motionSync`, `onboardMemoryMode`）
- 返回：`{ writtenStdPatch, mappedPatch }`
  - `writtenStdPatch`：成功写入的标准键集合
  - `mappedPatch`：最终映射到协议键并写出的 patch

### `window.DeviceReader`

- `requestConfig({ hidApi })`
- `getCachedConfig({ hidApi })`
- `readStandardValue({ cfg, adapter, key })`

### `window.ProtocolApi` 最小兼容面 / Minimal Compatibility Surface

协议实现应至少提供以下能力：

- `requestConfig()`
- `setFeature(key, value)` 与/或 `setBatchFeatures(payload)`
- `onConfig(cb)`、`onBattery(cb)`、`onRawReport(cb)`

<a id="webhid-workbench"></a>
## WebHID Workbench / WebHID Workbench

仓库中的调试脚本为：`WebHID_Workbench.js`。  
The debug userscript in this repo is `WebHID_Workbench.js`.

### 功能边界 / Scope

- 通过 hook `HIDDevice` 的 `sendReport`、`sendFeatureReport`、`receiveFeatureReport`、`inputreport` 捕获报文。
- 支持快照（增量窗口）、日志导出（JSON）、报文回放（Replay）。
- 提供解析规则入口（`PARSER_RULES`）用于开发调试。
- 面向开发/测试，不是生产运行时主链路。  
  It is for development/testing and is not part of the main production runtime flow.

### 使用方式 / Usage

1. 用 Tampermonkey/Violentmonkey 安装脚本。
2. 导入 `WebHID_Workbench.js`。
3. 在脚本 `@match` 覆盖站点打开页面后使用悬浮调试面板。

### `@match` 目标域（来自当前脚本）/ Target Domains

- `https://hub.rapoo.cn/*`
- `https://hub.atk.pro/*`
- `https://www.rawmtech.com/*`
- `https://www.mchose.com.cn/*`
- `https://hub.miracletek.net/*`
- `https://www.chaos.vin/*`
- `https://chaos.vin/*`

<a id="faq"></a>
## 常见问题 / FAQ

### 1) 点击连接无弹窗 / No device picker popup

- 必须由用户手势触发（点击/按键事件内调用）。
- 必须处于 `https` 或 `http://localhost`。
- 使用 Chromium 桌面浏览器并确认 WebHID 可用。

### 2) 设备可见但项目里不出现 / Device visible in OS but not matched

- 先看是否命中运行时过滤（`VID + usagePage/usage`）。
- 检查设备 `collections` 是否与 `device_runtime.js` 规则一致。
- 若为新型号，需补充 Runtime 识别规则与协议层支持。

### 3) 修改后写入不生效 / Writes not taking effect

- 首轮配置未完成前写入被门禁拦截（`__writesEnabled`）。
- 写入走防抖队列，短时间内会先合并再下发。
- 写入失败会触发一次配置重拉（`write-failure-reconcile`），请查看控制台日志定位。

<a id="resources"></a>
## 资源与链接 / Resources & Links

### 本地资源状态 / Local Assets

- Keymap 资源存在：`image/GPW.png`、`image/GPW_DEX.png`、`image/default.png`
- 旧版 README 的 UI 截图引用已移除（仓库无 `UI/` 目录）
- 文档已清理异常引用标记

### 资源状态表 / Resource Status Table

| 资源 / Resource | 当前状态 / Status | 说明 / Notes |
|---|---|---|
| 旧版 UI 截图引用 | 已移除失效引用 / removed | 仓库无 `UI/` 目录，不再保留误导性引用 |
| Keymap 图片 `image/GPW.png` `image/GPW_DEX.png` | 可用 / available | Logitech 机型变体映射正在使用 |
| `LICENSE` 文件 | 缺失 / missing | 需补充后再声明许可证类型 |
| 体验外链 | 保留 / kept | 本次仅文档更新，不做外链可达性探测 |

### 项目与体验链接 / Project Links

- GitHub: `https://github.com/Nuitfanee/ClickSync`
- 体验地址（保留，不在本次离线文档更新中做可达性探测）  
  Demo links (kept as-is, no reachability check in this doc-only update):
  - `https://nuitfanee.github.io/ClickSync.github.io/`
  - `https://xn--i8s54d9wak75j.xyz/`

<a id="license"></a>
## 开源协议 / License

当前仓库未检测到 `LICENSE` 文件。  
No `LICENSE` file is currently present in this repository.

建议后续补充许可证文件后，再在 README 中声明具体协议类型。  
Please add a license file first, then declare the specific license type in README.

<a id="contributing"></a>
## 贡献 / Contributing

欢迎通过 Issue / PR 参与改进：

1. 新设备接入优先补齐 Runtime 识别 + Adapter 映射 + Protocol API。
2. 缺陷反馈请附：设备型号、VID/PID、浏览器版本、复现步骤。
3. 文档变更请同步更新设备矩阵与功能矩阵，避免“代码事实与 README 偏离”。

维护者 / Maintainer: [@Nuitfanee](https://github.com/Nuitfanee)
