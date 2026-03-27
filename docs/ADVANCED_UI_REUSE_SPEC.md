# Advanced UI Reuse Spec

适用范围：`advancedPanel` 及其单列 / 双列高级参数区域。  
目标：建立一套**设备无关**、**协议无关**、**能力驱动**的高级面板复用规范，支持“单一品牌 Profile + 协议层 PID/机型能力矩阵 + 前端动态裁剪 UI”的架构。
配套文档：`CAPABILITIES_CONTRACT_SPEC.md` 负责定义协议层运行时 `capabilities` 的输出契约；本文只约束高级面板 UI 的语义规则、裁剪公式与前端落点。

## 维护者入口

| 你现在遇到的情况 | 先看本文哪些章节 | 联动阅读 |
| --- | --- | --- |
| 高级面板为什么没有显示 / 不该显示却显示了 | 第 1、3、4、5、6、9、12、13 节 | `CAPABILITIES_CONTRACT_SPEC.md` |
| 需要新增一个新的 `data-adv-item` | 第 5、8、10、11 节 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` |
| 不确定该用 `features` 还是 `capabilities` 控制显隐 | 第 1、3、4、6、7 节 | `CAPABILITIES_CONTRACT_SPEC.md` |
| 怀疑 `app.js` / `refactor.ui.js` 里写了不该有的品牌分支 | 第 2、9、11、12 节 | `PROTOCOL_MAINTAINER_GUIDE.md` |

## 本文在整套规范中的位置

- 本文只处理高级面板的语义复用、显隐规则、宿主目录和扩展边界。
- 本文不定义协议命令，不定义 transport，也不定义 `capabilities` 的命名合同。
- 如果你已经确认某个能力 key 的 shape 或命名有问题，应跳到 `CAPABILITIES_CONTRACT_SPEC.md`。
- 如果你正在决定是否要扩展 `index.html`、`refactor.ui.js`、`app.js`，要和 `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` 一起看。
- 全套文档的阅读入口见 `PROTOCOL_MAINTAINER_GUIDE.md`。

## 推荐阅读顺序

1. 先读第 1、2、3、4 节，确认高级面板真正受哪些输入驱动，以及谁负责显隐判断。
2. 再读第 5、6、7、8、9 节，理解语义 host、默认 gate、样板 profile、source region 和缓存规则。
3. 最后阅读第 10、11、12、13 节，确认如何扩展、哪些写法禁止出现，以及如何按顺序排查问题。

## 1. 先明确高级面板复用的四个前提

- 协议层负责 **机型 / PID 能力真相**，前端**不维护 PID 能力矩阵副本**。
- 前端 Profile 负责 **品牌级 UI 规则**，不承载具体 PID 差异。
- 高级面板显示逻辑统一由前端可用性引擎计算，不允许在 `app.js` / `refactor.ui.js` 中散落品牌分支控制显示隐藏。
- 动态裁剪的输入固定为两类：
  - `profile.features`：品牌 / 系列静态能力超集
  - `cfg.capabilities` / `hidApi.capabilities`：当前 PID / 机型动态能力子集

## 2. 逐层职责：谁能决定高级面板显隐

- `refactor.core.js`
  - 只放**纯数据规则**与**纯函数**
  - 负责高级面板规则默认表、规则合成、可见性求值
  - 不做 DOM 操作
- `refactor.profiles.js`
  - 只声明品牌 / 设备 profile
  - 通过 `ui.advancedPanels` 提供品牌级高级面板语义规则覆盖
  - 不写 DOM 逻辑，不写 PID 分支
- `refactor.ui.js`
  - 负责高级面板布局、可见性、排序、文案和范围渲染
  - 单列 / 双列统一走同一套高级面板可用性引擎
  - 不写协议逻辑
- `app.js`
  - 负责运行时能力缓存、连接 / 回读后的刷新编排
  - 高级面板刷新统一通过 `DeviceUI.applyAdvancedRuntime(...)`
  - 不直接按品牌 / PID 写高级面板显隐分支

## 3. 统一规则模型：`profile.ui.advancedPanels`

前端统一使用 `profile.ui.advancedPanels` 作为**品牌级高级面板语义规则表**。

```js
ui: {
  advancedPanels: {
    [itemKey]: {
      enabled?: boolean,
      requiresFeatures?: string[],
      requiresCapabilities?: string[],
      order?: number | string | null,
    }
  }
}
```

字段含义：

- `enabled`
  - 显式启停
  - `false` 表示强制隐藏
  - `true` 表示强制允许进入后续 gate 判定
  - `undefined` 表示使用引擎默认逻辑
- `requiresFeatures`
  - 依赖 `profile.features`
  - 必须全部为真才可显示
  - 缺失按不支持处理
- `requiresCapabilities`
  - 依赖协议层 `capabilities`
  - 必须全部为真才可显示
  - **缺失能力键按不支持处理**
- `order`
  - 当前主要用于单列高级面板排序覆盖
  - 未声明时，回退到 `ui.advancedSingleOrders`

## 4. 统一可见性判定公式

统一公式：

`visible = layoutPass && enabledPass && featurePass && capabilityPass`

其中：

- `layoutPass`
  - 当前 host 所在 region 与当前布局匹配
  - `single` 布局只显示 `single`
  - `dual` 布局只显示 `dual-left` / `dual-right`
- `enabledPass`
  - `enabled !== false`
- `featurePass`
  - `requiresFeatures` 全部为真
- `capabilityPass`
  - `requiresCapabilities` 全部为真
  - 若声明了 capability gate，则缺失能力键按 `false` 处理

规则约束：

- `profile.ui.advancedPanels` 是高级面板显隐规则的唯一 profile 入口
- `features.advancedSingleItems` 已移除，单列显隐不再通过白名单回退控制
- 未显式 `enabled: false` 的项，统一继续按 `requiresFeatures` / `requiresCapabilities` 与布局判定

## 5. 高级面板语义 host 目录

高级面板引擎维护一份**语义 host 目录**，按 `data-adv-item` 定位每个顶层面板宿主节点。

当前纳入统一裁剪的顶层面板项：

- 双列：
  - `sleepSeconds`
  - `debounceMs`
  - `sensorAngle`
  - `surfaceFeel`
  - `motionSync`
  - `linearCorrection`
  - `rippleControl`
  - `secondarySurfaceToggle`
  - `keyScanningRate`
  - `surfaceModePrimary`
  - `primaryLedFeature`
  - `dpiLightEffect`
  - `receiverLightEffect`
  - `longRangeMode`
- 单列：
  - `onboardMemory`
  - `lightforceSwitch`
  - `surfaceMode`
  - `bhopToggle`
  - `bhopDelay`
  - `dynamicSensitivityComposite`
  - `smartTrackingComposite`
  - `sensorAngle`
  - `sleepSeconds`
  - `lowPowerThresholdPercent`
  - `hyperpollingIndicator`

说明：

- `smartTrackingLevel` / `smartTrackingLiftDistance` / `smartTrackingLandingDistance` 是 `smartTrackingComposite` 的内部子视图，不作为独立顶层 gate 项
- 目录必须定位**宿主面板节点**，不能只隐藏内部 `input` / `select`

## 6. 默认静态 Gate 映射表

默认规则表中的静态 gate 复用现有 `features.hasXxx` 语义：

- `motionSync -> hasMotionSync`
- `linearCorrection -> hasLinearCorrection`
- `rippleControl -> hasRippleControl`
- `secondarySurfaceToggle -> hasSecondarySurfaceToggle`
- `keyScanningRate -> hasKeyScanRate`
- `surfaceModePrimary -> hasPrimarySurfaceToggle`
- `primaryLedFeature -> hasPrimaryLedFeature`
- `dpiLightEffect -> hasDpiLightCycle`
- `receiverLightEffect -> hasReceiverLightCycle`
- `longRangeMode -> hasLongRange`
- `surfaceFeel -> hasSurfaceFeel`
- `sensorAngle -> hasSensorAngle`
- `onboardMemory -> hasOnboardMemoryMode`
- `lightforceSwitch -> hasLightforceSwitch`
- `surfaceMode -> hasSurfaceMode`
- `bhopToggle` / `bhopDelay -> hasBhopDelay`

## 7. Razer 作为首个能力驱动样板

Razer 不拆分前端 PID profile，仍保持单一 `RazerProfile`。  
PID 差异只来自协议层 `capabilities`。

Razer 当前 profile 中应显式声明：

- `dynamicSensitivityComposite -> requiresCapabilities: ["dynamicSensitivity"]`
- `sensorAngle -> requiresFeatures: ["hasSensorAngle"], requiresCapabilities: ["sensorAngle"]`
- `smartTrackingComposite -> requiresCapabilities: ["smartTracking"]`
- `lowPowerThresholdPercent -> requiresCapabilities: ["lowPowerThresholdPercent"]`
- `hyperpollingIndicator -> requiresCapabilities: ["hyperpollingIndicatorMode"]`
- `sleepSeconds -> enabled: true`

## 8. Source Region 归属规则

- `stdKey` 的 source region 仍由 `profile.ui.advancedSourceRegionByStdKey` 声明
- `app.js` 与 `refactor.ui.js` 只能读取这张映射，不做跨 region fallback
- 高级面板可用性引擎只决定**面板是否显示**，不改变 source ownership

## 9. 运行时能力缓存规则

- `app.js` 必须保留完整 capability bag，不能只缓存 `dpiSlotCount / maxDpi / dpiStep / pollingRates`
- 能力应用入口统一：
  - 连接初期 `hidApi.capabilities`
  - 完整回读 `cfg.capabilities`
- 两个入口都必须触发：
  - `applyCapabilitiesToUi(...)`
  - `DeviceUI.applyAdvancedRuntime(...)`

### 9.1 device-scoped UI surface

- 以下 UI 面必须视为 `device-scoped`：结构、文案、选项、排序、默认值依赖 `adapter.ui`、`adapter.features` 或 `capabilities` 的节点。
- `device-scoped` UI 不能把旧 DOM 当作新设备真相；切设备后允许复用容器节点，但不能复用上一设备的结构与文本结果。
- `build` 与 `apply` 分层必须满足可逆性：
  - 结构层：按当前设备能力重建（或先销毁后重建）。
  - 文案层：先恢复模板默认，再叠加当前设备 `ui meta`。

### 9.2 切设备重建合同

- 切设备时，`app.js` 必须先执行 device-scoped 本地状态重置，再执行结构重建，再执行 runtime 能力回放。
- DPI 编辑器重建判定禁止只看 `dpiSlotCount`；至少要包含 `deviceId + slotCap + hasDpiLods + hasDpiAdvancedAxis` 等结构签名。
- 任何 `adapter.ui` 文案覆盖点都必须支持“无值恢复模板”；禁止“有值才写、无值不还原”。
- 新增品牌或能力时，若出现串线，优先检查重建合同与可逆渲染链路；禁止先补品牌分支。
## 10. 新增高级项时的扩展流程

新增一个高级面板 / 复用项时，按以下顺序执行：

1. 确认是否已有可复用的 `data-adv-item`
2. 如无，先在 `index.html` 增加语义 DOM：
   - `data-adv-region`
   - `data-adv-item`
   - `data-adv-control`
   - `data-std-key`
3. 在 `refactor.ui.js` 的高级面板 host 目录中登记宿主节点
4. 在 `refactor.core.js` 的默认规则表中补充基础 gate
5. 如某品牌需要特殊能力驱动，在 `refactor.profiles.js` 的 `ui.advancedPanels` 中覆盖规则
6. 在 `app.js` 中补齐交互绑定与 `applyConfigToUi()` 回读同步

## 11. 禁止项

- 禁止在前端引入第二份 PID 能力矩阵
- 禁止在 `app.js` / `refactor.ui.js` 中新增品牌或 PID 分支来控制高级面板显示
- 禁止直接按 class / id 代替 `data-adv-*` 作为高级面板行为主入口
- 禁止只隐藏子控件，不隐藏语义宿主面板
- 禁止在 UI 层直接调用协议接口做能力判断

## 12. 问题排查顺序

1. 先确认目标项是否已经有正确的 `data-adv-item` 宿主，且高级面板 host 目录能稳定定位到这个宿主节点。
2. 再确认 `profile.ui.advancedPanels[itemKey]` 是否显式 `enabled: false`，以及是否声明了 `requiresFeatures` / `requiresCapabilities`。
3. 然后检查 `profile.features` 是否满足静态 gate，避免把品牌静态超集误写成动态逻辑。
4. 再检查 `hidApi.capabilities` 与 `cfg.capabilities` 是否输出了对应布尔 key，并确认缺失键不会被误解为支持。
5. 最后检查 `app.js` 是否在连接初期和完整回读后都触发了 `applyCapabilitiesToUi(...)` 与 `DeviceUI.applyAdvancedRuntime(...)`。

## 13. 自检清单

- 是否所有高级面板显隐都统一走 `applyAdvancedRuntime()`
- 是否 `profile.ui.advancedPanels` 只描述品牌级规则，不描述 PID 明细
- 是否 capability gate 的缺失键被当作不支持处理
- 是否 `getCapabilities()` 能读到完整动态能力键
- 是否单列 / 双列都能在布局切换和设备切换后正确恢复显示状态
- 是否 `app.js` 中不再分散写高级面板项的显隐逻辑
- 是否切设备后所有 device-scoped 结构都按新设备重建（而不是复用旧结构）
- 是否所有 device-scoped 文案都先恢复模板，再应用当前设备 meta
- 是否不存在仅用 `slot count` 判定结构重建的局部 heuristic



