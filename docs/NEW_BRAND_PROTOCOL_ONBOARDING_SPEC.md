# New Brand Protocol Onboarding Spec

适用范围：为当前项目新增一个全新的品牌协议接入。  
目标：提供一套**工程化、可维护、可验证**的新品牌接入标准流程，覆盖 `protocol_api_*`、`device_runtime.js`、`refactor.core.js`、`refactor.profiles.js`、`refactor.ui.js`、`app.js` 之间的协作边界，确保新品牌可被当前前端引擎正确消费。

关联文档：
- `PROTOCOL_API_DESIGN_SPEC.md`：定义 `protocol_api_*` 文件的协议设计标准
- `CAPABILITIES_CONTRACT_SPEC.md`：定义运行时 `capabilities` 的输出契约
- `ADVANCED_UI_REUSE_SPEC.md`：定义高级面板的语义规则、可见性公式与 UI 复用边界

## 维护者入口

| 你现在最关心的问题 | 先看本文哪些章节 | 联动阅读 |
| --- | --- | --- |
| 新增一个品牌到底要改哪些文件 | 第 1、3、4 节 | `PROTOCOL_API_DESIGN_SPEC.md` |
| 想知道哪些地方原则上不该改 | 第 2、9、10、11、12、13、14 节 | `PROTOCOL_MAINTAINER_GUIDE.md` |
| 想判断现有面板能不能复用 | 第 8 节 | `ADVANCED_UI_REUSE_SPEC.md` |
| 想准备联调和交付验收 | 第 16、17 节 | `CAPABILITIES_CONTRACT_SPEC.md` |
| 想搞清楚 profile、协议、UI 的分工 | 第 1、3、5、7 节 | `PROTOCOL_API_DESIGN_SPEC.md` |

## 本文在整套规范中的位置

- 这是新增品牌时的主流程文档，最适合作为第一份阅读材料。
- 本文回答“要不要改某个文件、先改哪里、后改哪里、怎么验收”。
- 协议内部设计细节交给 `PROTOCOL_API_DESIGN_SPEC.md`。
- 动态能力字段的 shape、命名和缺失规则交给 `CAPABILITIES_CONTRACT_SPEC.md`。
- 高级面板语义复用、显隐公式和 host 目录交给 `ADVANCED_UI_REUSE_SPEC.md`。
- 全套文档的任务式导航入口见 `PROTOCOL_MAINTAINER_GUIDE.md`。

## 推荐阅读顺序

1. 先读第 1、2、3 节，建立整体架构、黄金原则和文件职责边界。
2. 再读第 4、5、6、7 节，按顺序完成接入并补齐 ranges / profile / 数据流。
3. 随后按第 8 节逐面板核对 UI 复用与功能上限。
4. 最后阅读第 9 到 17 节，确认哪些文件不用改、哪些情况必须改，以及如何完成验收。

## 1. 先建立全局接入链路图

新品牌接入当前项目时，实际生效链路固定如下：

1. `src/core/device_runtime.js`
   - 识别 HID 设备属于哪个品牌
   - 动态加载对应 `src/protocols/protocol_api_<brand>.js`
2. `src/protocols/protocol_api_<brand>.js`
   - 提供 `ProtocolApi.MouseMouseHidApi`
   - 负责连接、读回、写入、能力快照和事件发射
3. `src/refactor/refactor.core.js`
   - 提供共享 `AppConfig.ranges`、标准键、读写链路、公共规则
4. `src/refactor/refactor.profiles.js`
   - 为该品牌声明 profile：`ranges / keyMap / transforms / actions / features / ui`
5. `src/refactor/refactor.ui.js`
   - 根据 profile 元数据渲染布局、可见性、排序、文案和选项
6. `src/core/app.js`
   - 绑定 DOM 事件
   - 调用 `DeviceWriter.writePatch()` 写入
   - 调用 `applyConfigToUi(cfg)` 回显配置
   - 调用 `applyCapabilityStateToRuntime(cap)` 刷新能力驱动 UI

必须始终牢记：

- **设备识别**在 `device_runtime.js`
- **协议实现**在 `protocol_api_*`
- **品牌差异配置**在 `refactor.profiles.js`
- **共享标准与 ranges**在 `refactor.core.js`
- **布局和可见性**在 `refactor.ui.js`
- **DOM 绑定与读回渲染**在 `app.js`

不要把这些职责打乱。

## 2. 接入黄金原则

- 优先把品牌差异表达为 **profile 元数据 + 协议层能力快照**，不要表达为 `app.js` 分支。
- 优先复用现有标准键、现有语义面板、现有控制类型。
- 只有在现有语义和现有 DOM 无法表达时，才新增 stdKey / 新面板 / 新控件。
- 协议层永远不直接操作 DOM。
- UI 层永远不直接调用 `protocol_api_*`。
- 前端不维护品牌 PID 能力矩阵；PID/机型差异必须先在协议层收敛为 `capabilities`。
- 新品牌 profile 应尽量只写“差异”，不要复制大段公共默认值。

## 3. 逐文件定位职责与必须修改点

### 3.1 `src/core/device_runtime.js`

职责：识别硬件、生成请求过滤器、动态加载协议脚本。

新增品牌时通常必须修改：

- `VALID`
  - 新增品牌 id，例如 `newbrand`
- `PROTOCOL_SCRIPT_BY_DEVICE`
  - 注册 `./src/protocols/protocol_api_newbrand.js`
- 设备识别函数
  - 新增 `_isNewBrandDevice(d)` 或等效 matcher
- `DEVICE_REGISTRY`
  - 新增 `{ type, label, match, filters }`
- 必要时 `_inferTypeByVidPid` 等后备判断逻辑

注意事项：

- 品牌 id 必须与 `DEVICE_PROFILES`、脚本名、UI 主题 id 保持一致
- request filters 必须足够精确，避免选到同 VID 下的错误接口
- 若品牌存在多个 usagePage/usage 变体，先在 runtime 识别层收敛，不要把选择压力留给 UI

### 3.2 `src/protocols/protocol_api_<brand>.js`

职责：协议、读写、能力、快照、事件。

新增品牌时必须提供：

- `ProtocolApi.MouseMouseHidApi`
- `ProtocolApi.resolveMouseDisplayName(...)`
- `ProtocolApi.<BRAND>_HID`
- 推荐同时提供 `ProtocolApi.MOUSE_HID = ProtocolApi.<BRAND>_HID`
- `hidApi.capabilities` 早期能力入口
- `cfg.capabilities` 最终能力包

完整协议文件设计标准见：`PROTOCOL_API_DESIGN_SPEC.md`

### 3.3 `src/refactor/refactor.core.js`

职责：共享 ranges、标准键、通用 transform、公共规则、DeviceReader/Writer。

新增品牌时通常需要修改：

- `AppConfig.ranges.<brand>`
  - 补齐当前品牌的可选值域、数值范围、文本元数据
- 仅当新字段具有跨品牌共性时，才扩充：
  - `KEYMAP_COMMON`
  - `TRANSFORMS_COMMON`
  - 公共工具函数

强约束：

- 不要把只属于单品牌的字段硬塞进 `KEYMAP_COMMON`
- 不要把只属于单品牌的写入逻辑放进 `DeviceWriter.writePatch()`

### 3.4 `src/refactor/refactor.profiles.js`

职责：描述该品牌如何把“标准 UI 语义”映射到“协议层字段/动作”。

新增品牌时通常必须新增一个 `composeDeviceProfile({...})`：

- `id`
- `ui`
- `ranges`
- `keyMap`
- `transforms`
- `actions`
- `dpiSnapper`
- `features`

并注册到 `DEVICE_PROFILES`。

### 3.5 `src/refactor/refactor.ui.js`

职责：读取 profile 元数据，驱动布局、排序、可见性、文案、选项。

新增品牌时**不一定需要修改**。只有以下情况才需要动它：

- 需要新增新的语义面板项 `data-adv-item`
- 需要新增新的宿主节点定位规则
- 需要新增新的品牌无关渲染元数据规则
- 需要新增新的控制类型

强约束：

- 不要在这里新增 `if (deviceId === "newbrand")`
- 不要在这里调用协议方法判断功能支持性

### 3.6 `src/core/app.js`

职责：DOM 事件绑定、设备写队列、读回回显、能力驱动运行时刷新。

新增品牌时**不一定需要修改**。只有以下情况才需要动它：

- 该品牌复用了现有面板，但需要绑定一个全新的 stdKey，而当前 `app.js` 尚无对应事件处理
- `applyConfigToUi()` 尚无该 stdKey 的读回 setter
- 该功能属于新的复合面板，现有同步逻辑无法覆盖

强约束：

- 不要在 `app.js` 增加品牌分支来控制某品牌显示/隐藏某功能
- 不要在事件处理器中直接调用 `protocol_api_*`
- 写入应继续统一走 `enqueueDevicePatch()` -> `DeviceWriter.writePatch()`

## 4. 按顺序完成新品牌标准接入

推荐按以下顺序落地，避免反复返工：

### 步骤 1：确定品牌运行时 id

先确定一个全局唯一、全小写的品牌 id，例如：

- `razer`
- `logitech`
- `newbrand`

这个 id 必须在以下位置统一：

- `device_runtime.js` 的 `VALID`
- `PROTOCOL_SCRIPT_BY_DEVICE`
- `DEVICE_REGISTRY.type`
- `refactor.profiles.js` 的 `profile.id`
- 协议脚本文件名 `protocol_api_<id>.js`

### 步骤 2：实现协议文件骨架

按 `PROTOCOL_API_DESIGN_SPEC.md` 实现 `protocol_api_<brand>.js`：

- 错误模型
- 设备识别常量
- PID/机型矩阵（如有）
- transport
- codec
- transformers
- planner
- facade
- ProtocolApi exports

### 步骤 3：实现 `capabilities` 合同

按 `CAPABILITIES_CONTRACT_SPEC.md` 输出：

- `hidApi.capabilities`
- `cfg.capabilities`

并确保：

- shape 稳定
- key 为扁平顶层字段
- gate 字段全部布尔化
- 基础字段完整：`dpiSlotCount / maxDpi / dpiStep / pollingRates`

### 步骤 4：补齐 `AppConfig.ranges.<brand>`

在 `refactor.core.js` 中新增：

- `power`
- `sensor`
- `dpi`
- `polling`
- `texts`

并尽量与现有品牌保持相同结构。

### 步骤 5：新增品牌 profile

在 `refactor.profiles.js` 中新增 `composeDeviceProfile({...})` 并注册。

profile 的职责是把“品牌能力”翻译成前端通用语言，而不是重复协议逻辑。

### 步骤 6：验证是否可完全复用现有 UI

先判断：

- 是否可复用现有按键映射面板
- 是否可复用现有 DPI 面板
- 是否可复用现有基础性能面板
- 是否可复用现有高级面板语义项

若都能复用，**不要动** `index.html` / `refactor.ui.js` / `app.js`。

### 步骤 7：仅在必要时扩展 stdKey / DOM / UI

当现有语义无法表达新功能时，严格按此顺序扩展：

1. `index.html`：加语义 DOM
2. `refactor.core.js`：加共享 stdKey / transform（若 truly common）
3. `refactor.profiles.js`：加 keyMap / transforms / actions / features / ui
4. `app.js`：加写入绑定 + `applyConfigToUi()` 读回
5. `refactor.ui.js`：加新语义宿主、布局、排序或元数据渲染

### 步骤 8：做分层验收

至少分 4 层检查：

- 设备是否被 `device_runtime.js` 正确识别和装载协议
- `bootstrapSession()` 是否成功返回完整 `cfg`
- profile 映射后是否可正确读写 stdKey
- UI 是否按 `features + capabilities` 正确裁剪和回显

## 5. 理解当前项目中的标准数据流

### 5.1 配置读取流

当前项目读取流固定为：

1. 协议层发出 `cfg`
2. `app.js` 调用 `applyConfigToUi(cfg)`
3. `applyConfigToUi(cfg)` 内部调用 `readStandardValueWithIntent(cfg, stdKey)`
4. `readStandardValueWithIntent()` 最终调用 `DeviceReader.readStandardValue({ cfg, adapter, key })`
5. `DeviceReader.readStandardValue()` 依次走：
   - `adapter.keyMap[stdKey]`
   - `cfg.deviceState/state` 与顶层 `cfg` 回退
   - `adapter.transforms[stdKey].read(...)`

这意味着：

- 新品牌必须保证 profile 的 `keyMap` 和 `transforms.read` 能把协议配置翻译成标准值
- 若读回值缺失或 transform 返回 `undefined`，UI 可能保持旧值

### 5.2 配置写入流

当前项目写入流固定为：

1. DOM 事件调用 `enqueueDevicePatch({ stdKey: value })`
2. `DeviceWriter.writePatch({ hidApi, adapter, payload })`
3. 对每个 stdKey 依次执行：
   - `transform.write(value, ctx)`
   - `adapter.actions[stdKey]`（若声明）
   - `adapter.keyMap[stdKey] + hidApi.setFeature(...)` 回退

这意味着：

- 一般功能优先靠 `keyMap + transforms`
- 只有 `setFeature` 无法表达的写入，才放到 `actions`
- 如果协议支持批量业务写入，建议 profile actions 统一调用 `hidApi.setBatchFeatures(...)`

## 6. `AppConfig.ranges.<brand>` 标准模板

当前项目 `refactor.core.js` 中的品牌 ranges 结构，建议按以下模板实现：

```js
ranges: {
  <brand>: {
    power: {
      sleepSeconds: [...],
      debounceMs: [...],
      lowPowerThresholdPercent: { min, max, step },
    },
    sensor: {
      angleDeg: { min, max, step, hint, name?, sub?, unit? },
      feel: { min, max, step, hint?, name?, sub?, unit? } | null,
      smartTrackingLevel: { min, max, step, hint? },
      smartTrackingLiftDistance: { min, max, step, hint? },
      smartTrackingLandingDistance: { min, max, step, hint? },
    },
    dynamicSensitivity: {
      modes: [...],
    },
    dpi: {
      step,
      stepSegments?,
      policy?,
    },
    polling: {
      basicHz?,
      advHz?,
      wiredHz?,
      wirelessHz?,
    },
    texts: {
      landingTitle?,
      landingCaption?,
      lod?,
      led?,
      perfMode?,
      lights?,
      lightCycles?,
      advancedCycleStateMeta?,
      smartTrackingLevelLabels?,
      smartTrackingLevelHint?,
      lowPowerThresholdLockedHint?,
      advancedSectionHeaders?,
    },
  }
}
```

原则：

- `ranges` 负责“值域”和“范围提示”
- `ui` 负责“文案、顺序、布局、元数据”
- `features` 负责“静态支持开关”

## 7. `refactor.profiles.js` 品牌 profile 标准模板

新增品牌 profile 时，建议按以下顺序思考：

### 7.1 `ranges`

- 通常指向 `window.AppConfig?.ranges?.<brand>`
- 若该品牌要覆盖共享 ranges 的局部字段，也可在 profile 内二次合并

### 7.2 `keyMap`

职责：stdKey -> 协议字段名或字段别名数组。

适用场景：

- 协议配置字段与标准键存在一一映射
- 同品牌有兼容老字段名

示例思路：

- `pollingHz -> ["pollingHz", "polling_rate"]`
- `configSlotCount -> ["enabledProfileSlotCount", "profileSlotStates"]`

注意事项：

- 若某 stdKey 对该品牌不支持，请显式写 `null`
- 若某 stdKey 需要协议方法而非字段写入，请交给 `actions`

### 7.3 `transforms`

职责：标准值与协议值之间的归一化。

适用场景：

- 布尔值 / 枚举值转换
- 数值 clamp
- 字段兼容回读
- 复杂类型标准化

注意事项：

- `read()` 返回 `undefined` 表示值不可用，UI 会保留当前状态
- `write()` 返回 `undefined` 表示本次 stdKey 不下发
- 如果该转换具有跨品牌共性，应优先提炼到 `TRANSFORMS_COMMON`

### 7.4 `actions`

职责：当 `keyMap + setFeature` 不能表达写入时，提供自定义写动作。

适用场景：

- 协议要求调用专用方法
- 协议要求一次写多个字段
- 协议写入顺序有严格要求
- 按键映射、配置槽切换、复合面板写入等

建议：

- 优先用 `{ method: "setXxx" }`
- 若必须写函数，函数中仍应只做品牌协议调用，不做 DOM 逻辑

### 7.5 `dpiSnapper`

职责：统一 DPI 取整/对齐策略。

适用场景：

- DPI 步进不是简单固定步长
- DPI 使用分段步进

如品牌使用固定步长，可优先复用 `defaultDpiSnapper`。

### 7.6 `features`

职责：声明品牌 / 系列级静态 UI 能力超集。

这是接入时最重要的一组字段，至少要逐项决策以下内容：

- `keymapButtonCount`
- `hasPerformanceMode`
- `hasConfigSlots`
- `hasDualPollingRates`
- `hideBasicSynapse`
- `hideBasicFooterSecondaryText`
- `hasDpiLods`
- `hasDpiAdvancedAxis`
- `hasMotionSync`
- `hasLinearCorrection`
- `hasRippleControl`
- `hasPrimarySurfaceToggle`
- `hasSecondarySurfaceToggle`
- `hasPrimaryLedFeature`
- `hasKeyScanRate`
- `hasLongRange`
- `hasOnboardMemoryMode`
- `hasLightforceSwitch`
- `hasSurfaceMode`
- `hasBhopDelay`
- `hasSensorAngle`
- `hasSurfaceFeel`
- `advancedLayout`
- `supportsBatteryRequest`
- `batteryPollMs`
- `batteryPollTag`
- `deferDpiSlotCountUiUntilAck`
- `warnOnDisableOnboardMemoryMode`
- `autoEnableOnboardMemoryOnConnect`

说明：

- `features` 表达的是品牌静态超集，不表达 PID 动态差异
- PID/机型差异应进入 `cfg.capabilities`

### 7.7 `ui`

职责：声明该品牌的 UI 元数据，不声明协议逻辑。

常见字段包括：

- `landingTitle`
- `landingCaption`
- `landingReadyText`
- `keymap.imageSrc`
- `keymap.points`
- `perfMode`
- `lights`
- `lightCycles`
- `lod`
- `led`
- `secondarySurface`
- `advancedPanelDensity`
- `advancedPanels`
- `advancedSingleOrders`
- `advancedSourceRegionByStdKey`
- `advancedCycleStateMeta`
- `basicModeTypography`
- `pollingThemeByWirelessHz`
- `onboardMemoryDisableConfirmText`

## 8. 逐面板接入决策清单

下面是新增品牌时必须逐面板确认的内容。

### 8.1 按键映射面板

必须确认：

- 设备是否支持按键重映射
- 支持的按键数量是多少
- 每个按键的物理点位如何映射到 UI 图
- 动作目录有哪些
- 动作目录是否能落入 `mouse / keyboard / system` 三类
- 读回时是否能把 `(funckey, keycode)` 转回可显示标签

当前项目中的硬边界：

- 当前 `index.html` 只有 `data-btn="1"` 到 `data-btn="6"` 的 6 个点位
- 当前 `app.js` 用 `features.keymapButtonCount` 隐藏超出数量的点位
- 当前 UI 默认把 **左键（按钮 1）锁定为不可修改**
- 当前动作 tab 只支持三类：`mouse`、`keyboard`、`system`

因此：

- 若新品牌按钮数 `< 6`，可通过 `features.keymapButtonCount` 隐藏多余点位
- 若新品牌按钮数 `> 6`，必须扩展 `index.html`、`refactor.ui.js`、`app.js`
- 若新品牌允许重映射左键，必须评估并修改当前左键锁定逻辑
- 若动作类别超出三类，必须扩展动作面板 UI

协议/profile 必备项：

- 协议输出 `cfg.buttonMappings`
- 若支持映射写入，协议实现 `setButtonMappingBySelect(...)` 或等效动作写方法
- 协议导出 `KEYMAP_ACTIONS`
- 协议导出 `listKeyActionsByType()`
- 协议导出 `labelFromFunckeyKeycode(...)`
- profile 设置 `features.keymapButtonCount`
- profile 设置 `ui.keymap.imageSrc` 与 `ui.keymap.points`

### 8.2 DPI 面板

必须确认：

- DPI 档位总数是否固定，是否可动态调整
- 当前活动 DPI 档索引如何读写
- DPI 是否支持 X/Y 独立轴
- DPI 是否支持 LOD 数组
- DPI 最小值、最大值、步进规则是什么
- DPI 是否使用固定步进还是分段步进

当前项目中的关键字段：

- 运行时 `capabilities`
  - `dpiSlotCount`
  - `maxDpi`
  - `dpiStep`
  - `dpiPolicy`（可选）
  - `dpiSegments`（可选）
- 配置字段
  - `dpiSlots` / `dpiSlotsX` / `dpiSlotsY`
  - `activeDpiSlotIndex`
  - `dpiLods`

profile/ranges 必备决策：

- `features.hasDpiAdvancedAxis`
- `features.hasDpiLods`
- `features.deferDpiSlotCountUiUntilAck`
- `ranges.dpi.step`
- `ranges.dpi.stepSegments`（如有）
- `ranges.dpi.policy`（如有）
- `dpiSnapper`

注意事项：

- 如果只支持单轴 DPI，请让 `dpiSlotsY` 回落到 `dpiSlotsX` 语义
- 如果支持双轴 DPI，请提供 `setDpi(slot, { x, y })` 的稳定语义
- 如果步进是分段的，不能只给一个表面 `step`，还应提供 `dpiPolicy` / `dpiSegments`
- `maxDpi` 必须进入 `capabilities`，否则 UI 范围可能被裁错

### 8.3 基础性能面板

必须确认：

- 是否有性能模式
- 性能模式有哪几档
- 是单回报率还是双回报率
- 是否有独立无线回报率
- 是否有板载配置槽位
- 是否有无线策略 / 通讯协议等额外开关

当前项目中的关键决策项：

- `features.hasPerformanceMode`
- `features.hasDualPollingRates`
- `features.hasConfigSlots`
- `features.hideBasicSynapse`
- `features.hideBasicFooterSecondaryText`
- `features.hasWirelessStrategy`
- `features.hasCommProtocol`

当前项目中的关键数据项：

- `ui.perfMode`
- `ranges.polling.basicHz`
- `ranges.polling.advHz`
- `ranges.polling.wiredHz`
- `ranges.polling.wirelessHz`
- `cfg.pollingHz`
- `cfg.pollingWirelessHz`
- `cfg.enabledProfileSlotCount` / `cfg.profileSlotStates`
- `cfg.activeProfileSlotIndex`

注意事项：

- 若 `features.hasDualPollingRates === true`，`refactor.ui.js` 会优先用 `ranges.polling.wiredHz / wirelessHz` 渲染双列回报率 UI
- 若 `features.hasDualPollingRates === false`，`app.js` 会优先用 `capabilities.pollingRates` 更新通用回报率下拉
- 若 `features.hasConfigSlots === true`，需保证 profile 提供 `configSlotCount` / `activeConfigSlotIndex` 的映射与 transform
- 当前顶部配置槽 UI 上限为 `MAX_CONFIG_SLOT_COUNT = 5`；如果设备支持超过 5 个配置槽，需要扩展 `refactor.core.js` 和相关 UI
- 当前性能模式 UI 主要围绕常见模式键（如 `low / hp / sport / oc`）做主题和文案复用；若新品牌输出非标准 mode key，需核对 `ui.perfMode`、标签映射、选中态和禁用态是否仍然正确

### 8.4 高级参数面板

必须确认：

- 使用双列布局还是单列布局
- 每个功能对应哪个语义项 `data-adv-item`
- 每个功能的顶层宿主/控件是 `toggle / cycle / range / select / panel` 哪种类型
- 若是复合面板，需要明确它通常由 `data-adv-control="panel"` 作为宿主，再组合内部子控件，不是再发明新的品牌私有 control type
- 各 stdKey 的 source region 属于 `dual-left / dual-right / single` 中哪一列
- 哪些高级项由静态 `features` 控制
- 哪些高级项需要动态 `capabilities` 控制

当前项目中的关键决策项：

- `features.advancedLayout`
- `ui.advancedPanels`
- `ui.advancedSingleOrders`
- `ui.advancedSourceRegionByStdKey`
- `ui.advancedPanelDensity`

当前项目中的高级面板区域固定为：

- `dual-left`
- `dual-right`
- `single`

当前项目中的 `data-adv-control` 类型固定为：

- `toggle`
- `cycle`
- `range`
- `select`
- `panel`

补充说明：

- `composite` 不是新的 `data-adv-control` 类型名称
- `panel` 是当前项目里用于复合宿主卡片的控制标记，例如 `smartTrackingComposite`
- `dynamicSensitivityComposite`、`smartTrackingComposite` 一类能力项属于“复合面板/宿主模式”
- 这类项的顶层仍由某个 `data-adv-item` 承载，内部再组合多个现有控制与读回逻辑

注意事项：

- 若现有语义面板可复用，优先通过 `features` / `ui` / `capabilities` 驱动，不要新建 DOM
- 若新增的是复合面板，通常还需要补 `app.js` 的复合读回/事件绑定逻辑
- 若 `requiresCapabilities` 声明了某个 capability key，缺失键会被当前前端视为“不支持并隐藏”
- 高级面板是否显示由 `ADVANCED_UI_REUSE_SPEC.md` 规定，不得在 `applyVariant()` 或 `app.js` 再做品牌分支显隐

### 8.5 电池、状态与头部信息

必须确认：

- 是否支持主动请求电量
- 是否只会通过推送事件给出电池状态
- `batteryPercent` 与 `batteryIsCharging` 如何读取
- 设备名、固件、序列号是否可读取

当前项目中的关键决策项：

- `features.supportsBatteryRequest`
- `features.batteryPollMs`
- `features.batteryPollTag`

注意事项：

- 如果 `supportsBatteryRequest === false`，`app.js` 不会主动轮询电池
- 若支持 `requestBattery()`，协议层应在请求成功后同时发 `onBattery()` 和必要的 `onConfig()` 更新
- 即便不支持主动请求，只要协议层能通过事件推送 `onBattery()`，头部状态仍可更新

### 8.6 板载内存、配置槽、连接行为

必须确认：

- 是否存在板载内存模式
- 是否断开前必须打开某模式
- 是否连接后要自动启用某模式

当前项目中的关键决策项：

- `features.hasOnboardMemoryMode`
- `features.warnOnDisableOnboardMemoryMode`
- `features.autoEnableOnboardMemoryOnConnect`
- `ui.onboardMemoryDisableConfirmText`

注意事项：

- 若启用了 `autoEnableOnboardMemoryOnConnect`，连接后 `app.js` 会检查并尝试自动写入 `onboardMemoryMode: true`
- 若启用了 `warnOnDisableOnboardMemoryMode`，关闭时会弹确认

## 9. 什么时候不用改 `app.js` / `refactor.ui.js`

满足以下条件时，通常只需改：

- `device_runtime.js`
- `protocol_api_<brand>.js`
- `refactor.core.js` 中的 `AppConfig.ranges.<brand>`
- `refactor.profiles.js`

条件是：

- 新品牌所有功能都能映射到现有 stdKey
- 所有高级项都能复用现有 `data-adv-item`
- 所有顶层控制类型都属于现有 `toggle / cycle / range / select / panel`
- 若存在复合面板，也必须复用现有 `data-adv-item` + `data-adv-control="panel"` 宿主模式，而不是引入品牌私有控制类型
- 现有 `app.js` 已有这些 stdKey 的写入绑定与读回 setter

这应是首选目标。

## 10. 什么时候必须改 `app.js`

只有以下情况才应修改 `app.js`：

- 新增了一个全新的 stdKey，当前没有任何事件绑定
- 新增了一个全新的 stdKey，当前 `applyConfigToUi()` 没有读回 setter
- 新增了一个新的复合面板，需要品牌无关的复合同步逻辑
- 现有 UI 边界被突破，例如：
  - 按键数量超过 6
  - 配置槽位超过 5
  - 动作类别超出 `mouse / keyboard / system`

强约束：

- 改 `app.js` 时也必须保持品牌无关写法
- 不得写 `if (brand === "newbrand")`

## 11. 什么时候必须改 `refactor.ui.js`

只有以下情况才应修改 `refactor.ui.js`：

- 新增了一个全新的语义面板项，需要宿主查询规则
- 新增了一个全新的控制类型
- 现有高级面板 host 目录无法定位你的新面板
- 需要新增品牌无关的元数据渲染规则

强约束：

- 不得在 `refactor.ui.js` 内新增品牌或 PID 分支
- 可见性仍应走 `features + capabilities + layout`

## 12. 什么时候必须改 `index.html`

只有以下情况才应修改 `index.html`：

- 现有 `data-adv-item` 无法表达新的高级功能
- 现有按键映射点位数量不够
- 现有面板结构无法承载新的复合控件

修改时必须遵循：

- 使用 `data-adv-region`
- 使用 `data-adv-item`
- 使用 `data-adv-control`
- 使用 `data-std-key`

不要新增只有品牌自己知道含义的匿名 DOM 结构。

## 13. 新增 stdKey 的标准扩展流程

当现有标准键不足以表达新功能时，按以下顺序扩展：

1. 判断该功能是否是跨品牌共性
2. 若是共性：
   - 在 `refactor.core.js` 增加 `KEYMAP_COMMON` / `TRANSFORMS_COMMON` 默认支持
3. 在 `refactor.profiles.js` 中声明该 stdKey 的：
   - `keyMap`
   - `transforms`
   - `actions`（必要时）
   - `features` / `ui` 元数据
4. 在 `app.js` 中新增：
   - 事件绑定 `enqueueDevicePatch({ stdKey: value })`
   - `applyConfigToUi()` 读回 setter
5. 若涉及高级面板：
   - 优先复用现有语义 DOM
   - 如不能复用，再扩展 `index.html` + `refactor.ui.js`

不要先改 `app.js`，再回头补 profile。顺序错了会导致逻辑漂移。

## 14. 当前工程边界和上限

以下是当前项目已存在的硬边界，新增品牌时必须先核对：

- 按键映射点位：当前只内建 `1..6`
- 顶部配置槽位：当前上限 `5`
- 动作类别：当前只内建 `mouse / keyboard / system`
- 高级区域：当前只有 `dual-left / dual-right / single`
- 高级控制类型：当前只有 `toggle / cycle / range / select / panel`
- 其中 `panel` 主要用于复合宿主卡片；`composite` 仍是组织模式描述，不是额外的 control 枚举值

如果新品牌超出上述边界，必须先做 UI 和运行时扩展设计，不要试图“硬塞”。

## 15. 常见误区

- 误区 1：只写了协议文件，没写 profile
  - 结果：设备能连上，但 UI 不知道怎么读写字段
- 误区 2：只写了 profile.features，没写 `capabilities`
  - 结果：多 PID 设备无法做动态裁剪
- 误区 3：把 PID 差异写进前端 if/else
  - 结果：维护成本暴涨，违背当前架构
- 误区 4：把新品牌私有字段塞进 `KEYMAP_COMMON`
  - 结果：污染所有品牌共享标准键
- 误区 5：新增了 stdKey，但没在 `applyConfigToUi()` 做回读
  - 结果：能写不能显，UI 状态漂移
- 误区 6：新增高级项只隐藏内部 input，不隐藏宿主卡片
  - 结果：面板残留空壳
- 误区 7：认为 `enterDelayMs` 等 profile 字段已经全局生效
  - 结果：依赖了当前并未消费的保留字段

## 16. 手工验收与联调清单

新增品牌后，至少应手工验证以下内容：

### 16.1 连接链路

- 设备是否能被正确识别为新品牌
- 是否加载到正确的 `protocol_api_<brand>.js`
- `bootstrapSession()` 是否能返回完整 `cfg`
- 顶部设备名是否正确显示

### 16.2 能力链路

- `hidApi.capabilities` 是否存在
- `cfg.capabilities` 是否存在
- `getCapabilities()` 是否拿到完整能力包
- 高级面板是否按能力包正确显示/隐藏

### 16.3 按键映射

- 点位数量是否正确
- 动作列表分类是否正确
- 选择动作后是否能正确写入
- 设备回读后标签是否正确回显

### 16.4 DPI

- 档位数量是否正确
- 激活档切换是否正确
- 最大 DPI 是否正确限制 UI 范围
- DPI 步进是否符合设备规则
- 若支持双轴，X/Y 是否能独立生效
- 若支持 LOD，LOD UI 是否正确回显

### 16.5 基础性能

- 性能模式数量是否正确
- 回报率选项是否完整
- 双回报率设备的 wired/wireless 是否各自正确
- 配置槽位是否正确显示和切换

### 16.6 高级参数

- 布局是单列还是双列是否正确
- 每个高级项的控件类型是否正确
- 不支持项是否隐藏，而不是禁用后空着
- 复合面板内部状态是否正确同步

### 16.7 电池与状态

- 若支持电量：页面进入后是否能刷新电量
- 自动轮询是否按预期频率触发
- 断开设备后是否停止轮询

## 17. 最终交付自检清单

- 是否已在 `device_runtime.js` 注册品牌 id、matcher、filters、脚本路径
- 是否已实现 `protocol_api_<brand>.js` 并符合 `PROTOCOL_API_DESIGN_SPEC.md`
- 是否已实现 `cfg.capabilities` / `hidApi.capabilities` 并符合 `CAPABILITIES_CONTRACT_SPEC.md`
- 是否已在 `refactor.core.js` 增加 `AppConfig.ranges.<brand>`
- 是否已在 `refactor.profiles.js` 注册品牌 profile
- 是否优先复用了现有 stdKey、现有面板和现有控制类型
- 是否避免了 `app.js` / `refactor.ui.js` 的品牌分支
- 若新增 stdKey，是否已补齐写入绑定与读回 setter
- 若新增语义面板，是否已补齐 `index.html` / `refactor.ui.js` / `app.js` / `refactor.profiles.js`
- 是否已完成连接、按键、DPI、基础性能、高级参数、电池的手工验证



