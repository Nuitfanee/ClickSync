# Click Sync

![WebHID](https://img.shields.io/badge/WebHID-enabled-blue)
![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-yellow)

Click Sync 是一个基于 WebHID 的多品牌鼠标网页驱动控制台，目标是把不同品牌的配置能力统一到一个浏览器应用里完成，不需要安装本地驱动程序。

当前代码中已接入品牌：`Razer(雷蛇)`、`Logitech(罗技)`、`Rapoo(雷柏)`、`ATK`、`Ninjutso`、`Chaos`。

---

## 项目特点

- 单页前端应用，纯静态资源，无构建依赖
- 基于标准键（`stdKey`）做统一读写，减少品牌分支
- 运行时自动识别设备并按品牌动态加载协议脚本
- 支持配置回读、增量写入、写入防抖与失败回读纠偏
- 内置测试工具页（双击检测、轮询率检测、灵敏度匹配、角度校准）

---

## 界面预览

![Click Sync UI](assets/images/UI1.png)
![Click Sync UI](assets/images/UI2.png)
![Click Sync UI](assets/images/UI3.png)
![Click Sync UI](assets/images/UI4.png)
![Click Sync UI](assets/images/UI5.png)

---

## 支持设备与识别规则（源码现状）

设备识别逻辑位于 `src/core/device_runtime.js`，通过 `vendorId/productId` 与 `usagePage/usage` 组合匹配。

| 设备类型 | 主要识别条件 |
|---|---|
| Razer(雷蛇) | `vendorId=0x1532` 且 `productId` 在支持列表内（`0x00C0`-`0x00C5`） |
| Logitech(罗技) | `vendorId=0x046D` 且存在 `usagePage=0xFF00`（`usage=0x01/0x02` 或 vendor collection） |
| Rapoo(雷柏) | `vendorId=0x24AE` 且存在 `usagePage=0xFF00`，`usage=14/15` |
| ATK | `vendorId in {0x373B,0x3710}` 且存在 `usagePage=0xFF02`,`usage=0x0002` |
| Ninjutso | `vendorId=0x093A`,`productId=0xEB02`，且 `productName` 必须为 `ninjutso sora v3`（不区分大小写） |
| Chaos | `vendorId=0x1915` 且存在 `usagePage=0xFF0A` 或 `0xFF00` |

Razer(雷蛇) 当前协议内置型号（`src/protocols/protocol_api_razer.js`）：

- Razer Viper V3 Pro (Wired/Wireless)
- Razer DeathAdder V3 Pro (Wired Alt/Wireless Alt)
- Razer DeathAdder V3 HyperSpeed (Wired/Wireless)

Chaos 协议内置型号映射（`src/protocols/protocol_api_chaos.js`）：

- CHAOS M1 / M1 PRO / M2 PRO / M3 PRO（有线、无线 1K、无线 8K 变体）

---

## 功能概览

以下功能由 `src/refactor/refactor.core.js` + `src/refactor/refactor.profiles.js` 的标准键与能力开关驱动，UI 会按设备能力自动显示/隐藏。

### 通用功能

- 按键映射（按钮动作配置）
- DPI 档位、当前档位、X/Y 轴 DPI（设备支持时）
- 回报率（Polling Rate）
- 睡眠时间、去抖时间
- 性能模式（如 `low/hp/sport/oc`）
- 角度、传感器相关参数（设备支持时）
- 电量与固件信息回显（按协议能力提供）

### 典型设备差异能力（按当前 profile）

- Razer(雷蛇)：
  - Dynamic Sensitivity
  - Smart Tracking（模式、等级、Lift/Landing 距离）
  - Hyperpolling Indicator（部分型号）
  - 低电阈值参数
- Logitech(罗技)：
  - 配置槽位（Profile Slot）切换
  - 有线/无线独立回报率
  - 板载内存模式（Onboard Memory）
  - LIGHTFORCE 开关模式、Surface Mode、BHOP Delay
- ATK：
  - Long Range Mode
  - DPI 灯效循环、接收器灯效循环、DPI 颜色
- Ninjutso：
  - Burst / Hyper Click / LED Master
  - MARA/Static 灯效、静态灯光颜色
  - LED 亮度/速度相关参数

说明：实际可写能力最终由设备固件与协议层返回为准。

---

## 页面结构

主功能页面（`index.html`）：

- `#keys`：按键设置
- `#dpi`：DPI 设置
- `#basic`：基础性能
- `#advanced`：高级参数
- `#testtools`：测试工具

测试工具子页（`src/tools/*.js`）：

- 双击检测（`pageMain`）
- 鼠标角度校准（`pageRot`）
- 轮询率检测（`pagePoll`）
- 灵敏度匹配（`pageMatch`）

---

## 浏览器要求

- 推荐：桌面端 Chromium 内核浏览器（Chrome / Edge 等）
- 必须处于安全上下文：`https://` 或 `http://localhost`
- `file://` 直接打开通常无法使用 WebHID
- 首次连接必须由用户手势触发，并在浏览器弹窗中授权设备

---

## 快速开始

本项目是纯前端静态站点，直接启动本地静态服务即可。

```bash
# 方式 1：Python
python -m http.server 8000

# 方式 2：Node.js（需已安装 node）
npx http-server . -p 8000
```

访问：

- `http://localhost:8000/index.html`

---

## 使用流程

1. 打开页面后，在 Landing 区触发连接（用户手势）。
2. 在浏览器 `navigator.hid.requestDevice()` 弹窗中选择设备并授权。
3. 连接成功后进入配置页，按需调整 DPI/按键/高级参数。
4. 需要断开时使用侧边栏断开按钮。

自动连接说明：

- 页面会尝试复用 `navigator.hid.getDevices()` 中已授权设备。
- 检测到设备类型与当前选择不一致时，会自动切换设备类型并重载对应协议脚本。

---

## 架构说明（开发者）

### 模块分层

- `src/core/device_runtime.js`
  - 设备识别、授权请求、候选设备筛选
  - 协议脚本动态加载（`protocol_api_*.js`）
- `src/core/app.js`
  - 启动流程、握手、连接重试、断连处理
  - UI 事件绑定、写入队列、防抖与写意图保护
- `src/refactor/refactor.core.js`
  - AppConfig 公共范围、标准键工具、Reader/Writer 基础能力
- `src/refactor/refactor.profiles.js`
  - 各品牌 profile（`keyMap/transforms/actions/features/ui`）
- `src/refactor/refactor.ui.js`
  - 纯渲染层：布局、可见性、顺序、文案与选项更新
- `src/protocols/protocol_api_*.js`
  - 品牌协议实现（传输、编解码、读写能力）

### 运行时链路（简化）

1. `DeviceRuntime.whenProtocolReady()` 加载当前设备协议脚本
2. `DeviceRuntime.connect()/autoConnect()` 获取连接候选
3. `hidApi.bootstrapSession()` 握手并读取初始配置
4. `applyConfigToUi(cfg)` 统一回显
5. UI 变更统一进入 `enqueueDevicePatch()`，再由 `DeviceWriter` 下发协议写入

---

## 新增设备接入步骤

建议按以下顺序扩展，避免在 `app.js` 写品牌分支：

1. 在 `src/refactor/refactor.core.js` 增加 `AppConfig.ranges.<device>`
2. 在 `src/refactor/refactor.profiles.js` 新增 profile 并注册到 `DEVICE_PROFILES`
3. 在 `src/core/device_runtime.js`：
   - 增加识别 matcher 与 requestDevice filters
   - 在 `ensureProtocolLoaded()` 增加协议脚本映射
4. 新增 `src/protocols/protocol_api_<device>.js`，并导出 `window.ProtocolApi`
5. 若有新控件，补充 `index.html` 语义节点与 `data-adv-* / data-std-key`
6. 在 `app.js` 仅按标准键绑定事件，不引入品牌分支

---

## 开发调试工具：WebHID Workbench

仓库提供 Userscript：`tools/WebHID_Workbench.js`，用于协议研究与报文分析。

主要能力：

- Hook WebHID 调用（`sendReport/sendFeatureReport/receiveFeatureReport/inputreport`）
- 抓取报文快照（delta window）
- 导出 JSON（含设备 `vid/pid` 与报文）
- 对已抓取 OUT 报文按时序回放

脚本 `@match` 默认包含：

- `https://hub.rapoo.cn/*`
- `https://hub.atk.pro/*`
- `https://www.rawmtech.com/*`
- `https://www.mchose.com.cn/*`
- `https://hub.miracletek.net/*`
- `https://www.chaos.vin/*`
- `https://chaos.vin/*`

---

## 已知限制（当前代码）

- WebHID 依赖浏览器与系统权限，不支持所有浏览器/平台。
- 不同设备固件能力差异较大，UI 会按 profile 与回读能力裁剪。
- Ninjutso 识别对 `productName` 有严格匹配要求（`ninjutso sora v3`）。
- 语言与主题切换按钮在当前实现中已固定（语言固定 `zh`，主题固定 `light`）。
- 仓库当前未提供完整自动化测试流水线（以手动连接与实机验证为主）。

---

## 贡献

欢迎提交 Issue / PR。

建议在反馈中提供：

- 品牌与型号
- `vendorId/productId`
- 浏览器版本
- 固件版本
- 复现步骤与控制台日志

---

## 维护者

- [@Nuitfanee](https://github.com/Nuitfanee)

---

## 许可证

本项目采用 `GNU General Public License v2.0`，详见 [LICENSE](LICENSE)。
