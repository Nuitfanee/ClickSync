# Capabilities Contract Spec

适用范围：协议层对前端输出的运行时 `capabilities` 能力包。  
目标：为各品牌逐步迁移到 **“单一品牌 Profile + 协议层 PID/机型能力矩阵 + 前端动态裁剪 UI”** 架构提供统一的能力设计标准，保证前端可无品牌/PID 分支地正确消费。

关联文档：`ADVANCED_UI_REUSE_SPEC.md` 负责高级面板 UI 复用与裁剪规则；本文负责协议层 `capabilities` 的输出契约。

## 维护者入口

| 你正在判断什么 | 先看本文哪些章节 | 联动阅读 |
| --- | --- | --- |
| 某个字段该放 `features`、`capabilities` 还是 `cfg.xxx` | 第 2、3 节 | `ADVANCED_UI_REUSE_SPEC.md` |
| `capabilities` 应该长什么样、必须有哪些基础字段 | 第 4、5、6、7、8 节 | `PROTOCOL_API_DESIGN_SPEC.md` |
| 旧协议怎么迁移到统一能力合同 | 第 9、10、11、12、13、14、15 节 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` |
| 为什么前端现在不能直接看 PID / report id | 第 3、6、10、11 节 | `PROTOCOL_MAINTAINER_GUIDE.md` |

## 三层放置速查表

| 信息类型 | 应该放在哪一层 | 典型例子 | 不该放在哪一层 |
| --- | --- | --- | --- |
| 品牌 / 系列级静态超集 | `profile.features` | `hasSensorAngle`、`hasMotionSync` | 不该放进 `cfg.capabilities` 冒充动态支持性 |
| 当前 PID / 机型动态支持性 | `cfg.capabilities` / `hidApi.capabilities` | `sensorAngle: true`、`dynamicSensitivity: false` | 不该写成前端 PID 分支 |
| 当前设备实际值 | `cfg.xxx` | `cfg.sensorAngle = 3`、`cfg.lowPowerThresholdPercent = 20` | 不该塞进 `capabilities` |

## 本文在整套规范中的位置

- 本文规定的是“协议层给前端的动态能力合同”，不是品牌 profile 模板，也不是高级面板 DOM 规则。
- 本文最适合在设计 `cfg.capabilities` / `hidApi.capabilities` 时阅读。
- 如果你已经明确能力 key 没问题，但面板显隐仍异常，应联动查看 `ADVANCED_UI_REUSE_SPEC.md`。
- 如果你正在写 `protocol_api_<brand>.js`，要同时阅读 `PROTOCOL_API_DESIGN_SPEC.md`。
- 全套文档的任务式导航入口见 `PROTOCOL_MAINTAINER_GUIDE.md`。

## 推荐阅读顺序

1. 先读第 1、2、3 节，彻底分清 `features`、`capabilities` 和 `cfg 实际值`。
2. 再读第 4、5、6、7、8 节，确定能力包的标准 shape、基础字段、gate key 和双时机输出关系。
3. 最后阅读第 9 到 15 节，按协议层实现结构完成迁移、兼容和自检。

## 1. 为什么需要统一 `capabilities` 合同

- 将 **PID / 机型差异** 收敛在协议层，不把 PID 判断散落到前端。
- 将协议内部实现细节翻译为 **前端可直接消费的语义能力键**。
- 保持前端 Profile 为 **品牌级静态规则**，不拆前端 PID 子 profile。
- 让 `cfg.capabilities` / `hidApi.capabilities` 成为前端运行时的唯一动态能力输入。
- 为后续品牌迁移提供统一命名、统一结构、统一缺失处理规则。

## 2. 先把三层语义彻底分开

### 2.1 `profile.features`

- 归属：前端 profile 层
- 语义：品牌 / 系列级 **静态能力超集**
- 用途：决定该品牌是否存在某类 UI 语义或交互结构
- 例子：`hasSensorAngle`、`hasMotionSync`、`hasOnboardMemoryMode`

### 2.2 `cfg.capabilities` / `hidApi.capabilities`

- 归属：协议层运行时输出
- 语义：当前接入 **PID / 机型 / 运行态的动态能力子集**
- 用途：决定当前设备是否真正支持某项能力，供前端动态裁剪 UI
- 例子：`sensorAngle: true`、`dynamicSensitivity: false`

### 2.3 `cfg.xxx` 实际配置值

- 归属：配置快照层
- 语义：当前设备实际配置值
- 用途：驱动控件当前值显示 / 回写
- 例子：`cfg.sensorAngle = 3`、`cfg.lowPowerThresholdPercent = 20`

### 2.4 禁止混层

- 不允许把当前值塞进 `capabilities`
- 不允许把动态支持性写进 `profile.features`
- 不允许让前端用 PID 分支替代 `capabilities`

## 3. 前端实际如何消费 `capabilities`

当前前端高级面板引擎对 `capabilities` 的消费方式已经固定，相关实现可参考：
- `src/refactor/refactor.core.js`
- `src/refactor/refactor.ui.js`
- `src/core/app.js`

### 3.1 可见性公式

前端统一按以下公式计算高级面板可见性：

`visible = layoutPass && enabledPass && featurePass && capabilityPass`

其中：
- `enabledPass`：`rule.enabled !== false`；前端不再存在 `advancedSingleItems` 之类的单列白名单回退
- `featurePass`：`requiresFeatures` 的 key 必须全部在 `profile.features` 上为真
- `capabilityPass`：`requiresCapabilities` 的 key 必须全部在 `capabilities` 上为真

### 3.2 缺失键规则

这是强约束：

- 如果某高级面板声明了 `requiresCapabilities`
- 那么该能力键 **缺失即视为不支持**
- 即：只有 `capabilities[key] === true` 才通过

因此，协议层输出中：
- 可以把缺失理解为不支持
- 但**推荐始终显式输出 `true/false` 完整键集**，避免调试歧义和缓存残留问题

### 3.3 前端不消费 PID

前端动态裁剪引擎只消费：
- `profile.features`
- `cfg.capabilities` / `hidApi.capabilities`
- 当前布局信息

前端不应消费：
- `productId`
- 协议命令号
- report id
- tx route
- usagePage 等传输细节

## 4. `capabilities` 的标准数据结构

前端当前要求 `capabilities` 为 **扁平对象**，不支持嵌套路径 gate。

标准结构：

```js
capabilities: {
  dpiSlotCount: number,
  maxDpi: number,
  dpiStep: number,
  pollingRates: number[] | null,

  someCapabilityA: true,
  someCapabilityB: false,
}
```

### 4.1 结构约束

- 必须是普通对象
- 必须是扁平 key-value 结构
- gate 字段必须是布尔值
- 不允许用 `1/0`、`"yes"`、`"supported"`、`null` 表示支持性
- 数值字段必须是前端可直接消费的归一化值
- 数组字段必须是前端可直接渲染的枚举值

### 4.2 为什么要求扁平结构

当前 `requiresCapabilities` 直接按顶层 key 求值。若协议层输出嵌套结构，例如：

```js
capabilities: {
  sensor: { angle: true }
}
```

则前端无法直接通过 `requiresCapabilities: ["sensor.angle"]` 这种路径表达式消费。除非前端引擎整体升级，否则运行时能力包必须保持扁平结构。

## 5. 跨品牌基础必备字段

以下字段应作为跨品牌运行时 `capabilities` 的基础字段保留：

- `dpiSlotCount: number`
- `maxDpi: number`
- `dpiStep: number`
- `pollingRates: number[] | null`

### 5.1 约束说明

- `dpiSlotCount`
  - 正整数
  - 表示当前设备支持的 DPI 档位数量
- `maxDpi`
  - 正整数
  - 表示当前设备支持的最大 DPI
- `dpiStep`
  - 正整数
  - 表示 DPI 步进；如设备为分段步进，仍需输出当前基础步进，并可额外通过其他字段或 profile range 表达更复杂策略
- `pollingRates`
  - 升序、去重、数值数组
  - 无法确定时可为 `null`

### 5.1.1 可选扩展字段

以下字段不是所有品牌都必须提供，但当前前端运行时已能识别，建议在需要时采用统一命名：

- `dpiPolicy`
- `dpiSegments`

约束如下：

- 若提供，必须是前端可直接消费的归一化结构
- 若不提供，前端应能回退到 profile ranges 或既有默认值
- 不要把品牌私有、未经归一化的原始协议结构直接塞入这些字段

### 5.2 兼容说明

旧协议中常见的内部字段：
- `dpiSlotMax`
- `dpiMin`
- `pollingRatesWired`
- `pollingRatesWireless`
- `performanceModes`

这些可以继续作为协议内部 profile / metadata 存在，但**若要进入统一运行时能力合同**，需折算或映射到标准运行时字段后再输出给前端。

### 5.3 协议内部 `profile.capabilities` 与运行时 `cfg.capabilities` 不是一层

很多现有协议文件中已经存在品牌内部的 `DEFAULT_PROFILE.capabilities` 或类似结构。这类对象可以继续保留，但它们与运行时输出给前端的 `cfg.capabilities` **不是同一合同**。

约束如下：

- 协议内部 `profile.capabilities` 可以保留品牌私有字段
- 运行时 `cfg.capabilities` 必须整理为前端统一可消费的标准 shape
- 不应把协议内部 `profile.capabilities` 原样透传给前端作为最终合同
- 若内部字段命名与前端合同不一致，必须在快照层完成翻译

典型例子：
- 内部字段 `dpiSlotMax` 进入运行时合同后应转换为 `dpiSlotCount`
- 内部字段 `pollingRatesWired/pollingRatesWireless` 进入运行时合同前应折算成当前设备可用的 `pollingRates`

## 6. 动态 Gate 字段标准

动态 gate 字段用于前端 `requiresCapabilities` 直接判断面板是否显示。

### 6.1 命名规则

- 使用 `camelCase`
- 使用正向语义命名
- 表达“是否支持”，而不是“当前值”
- 优先使用前端语义面板/功能名，而不是协议命令名
- 同类功能跨品牌尽量复用同名键

### 6.2 推荐的统一语义能力键（v1）

以下键建议作为跨品牌统一语义能力键保留集合：

- `sensorAngle`
- `smartTracking`
- `dynamicSensitivity`
- `lowPowerThresholdPercent`
- `hyperpollingIndicatorMode`
- `motionSync`
- `linearCorrection`
- `rippleControl`
- `surfaceFeel`
- `secondarySurfaceToggle`
- `keyScanningRate`
- `surfaceModePrimary`
- `primaryLedFeature`
- `dpiLightEffect`
- `receiverLightEffect`
- `longRangeMode`
- `onboardMemory`
- `lightforceSwitch`
- `surfaceMode`
- `bhopDelay`

### 6.3 命名示例

推荐：
- `sensorAngle`
- `smartTracking`
- `lightforceSwitch`
- `receiverLightEffect`

不推荐：
- `supports_0x85`
- `txFFHyper`
- `wireless8kOnly`
- `sensorAngleAvailableByCmd`

### 6.4 何时应该新增一个 capability key

只有当某项能力满足以下条件之一时，才建议新增动态 capability key：

- 同一品牌 / 同一前端 profile 下，该能力会因 PID / 机型不同而变化
- 前端需要依据该能力决定某个高级面板或复合面板是否显示
- 该能力属于“支持性”而非“当前值”
- 该能力无法仅靠 `profile.features` 这个静态超集准确表达

不建议新增 capability key 的情况：

- 只是当前状态值变化，而不是是否支持
- 只是文案、主题、布局差异
- 只是 source region 差异
- 整个品牌内始终一致、不会随 PID 变化；此时更适合放在 `profile.features`

### 6.5 面板语义与 capability key 的推荐映射（v1）

以下映射用于指导“高级面板语义项”与“运行时能力键”如何对应：

- `dynamicSensitivityComposite -> dynamicSensitivity`
- `smartTrackingComposite -> smartTracking`
- `sensorAngle -> sensorAngle`
- `lowPowerThresholdPercent -> lowPowerThresholdPercent`
- `hyperpollingIndicator -> hyperpollingIndicatorMode`
- `motionSync -> motionSync`
- `linearCorrection -> linearCorrection`
- `rippleControl -> rippleControl`
- `surfaceFeel -> surfaceFeel`
- `secondarySurfaceToggle -> secondarySurfaceToggle`
- `keyScanningRate -> keyScanningRate`
- `surfaceModePrimary -> surfaceModePrimary`
- `primaryLedFeature -> primaryLedFeature`
- `dpiLightEffect -> dpiLightEffect`
- `receiverLightEffect -> receiverLightEffect`
- `longRangeMode -> longRangeMode`
- `onboardMemory -> onboardMemory`
- `lightforceSwitch -> lightforceSwitch`
- `surfaceMode -> surfaceMode`
- `bhopToggle/bhopDelay -> bhopDelay`

说明：

- capability key 应优先对应“顶层语义功能”或“复合面板”，而不是其内部子控件
- 例如 `smartTracking` gate 控制的是整个 `smartTrackingComposite`，而不是分别为 `smartTrackingLevel`、`smartTrackingLiftDistance`、`smartTrackingLandingDistance` 建三个独立 gate
- 并非每个高级面板都必须有动态 capability key；只有存在 PID/机型差异时才需要动态化

## 7. 快照输出规则

### 7.1 必须输出完整快照

协议层对前端输出 `capabilities` 时，推荐每次都输出完整快照，而不是局部 patch。

原因：
- `app.js` 当前会缓存并合并能力包
- 同设备刷新时，局部遗漏字段可能导致旧能力残留
- 完整快照更利于调试、日志、问题定位

### 7.2 显式 `false` 优于缺失

虽然前端对声明了 `requiresCapabilities` 的项遵循“缺失按不支持处理”，但仍建议：

- 支持时输出 `true`
- 不支持时输出 `false`
- 不依赖“省略该键”表达不支持

### 7.3 稳定输出形状

同一品牌协议的 `capabilities` 输出形状应尽量稳定：
- 同品牌不同 PID：key 集保持尽量一致，仅 value 不同
- 同一 PID 不同刷新时机：key 集保持一致
- `hidApi.capabilities` 与 `cfg.capabilities` 的语义一致、shape 一致

## 8. `hidApi.capabilities` 与 `cfg.capabilities` 的标准关系

建议所有品牌统一成以下双时机模型：

### 8.1 `hidApi.capabilities`

- 用途：连接初期的早期能力快照
- 时机：拿到设备身份、尚未完成完整配置读取时即可提供
- 目标：让前端尽早进行保守 UI 裁剪

### 8.2 `cfg.capabilities`

- 用途：完整配置快照中的最终能力包
- 时机：默认配置快照、完整设备读回、配置刷新
- 目标：作为最终权威能力包

### 8.3 二者关系约束

- key 名必须一致
- 语义必须一致
- `cfg.capabilities` 不得比 `hidApi.capabilities` 缺字段
- 早期快照拿不准时，宁可保守输出 `false`，不要乐观输出 `true`

## 9. 协议层推荐实现结构

建议每个品牌最终统一成以下四层：

### 9.1 设备身份 / PID 能力矩阵层

- 单一真相表
- 一行表示一个 PID / 机型 / 固定变体
- 可包含协议内部实现字段与语义支持字段

示例职责：
- 识别支持 PID
- 保存 report id / tx route / polling mode 等协议细节
- 保存语义支持布尔项

### 9.2 语义能力构建层

建议实现一个类似 `buildCapabilities(pid)` 的函数：

- 输入：设备 PID / 机型标识
- 输出：协议内部统一能力对象
- 负责把矩阵行翻译成稳定的语义能力集合

### 9.3 前端快照层

建议实现一个类似 `_capabilitiesSnapshot(caps)` 的函数：

- 输入：协议内部能力对象
- 输出：前端消费契约对象
- 负责把内部字段整理为前端最终使用的标准 shape

### 9.4 配置快照层

- 默认配置快照要带 `capabilities`
- 完整设备读回也要带 `capabilities`
- 所有对前端发出的配置快照都尽量带完整能力包

## 10. 协议内部字段与前端字段的关系

### 10.1 可以保留在协议内部的字段

- `featureReportId`
- `defaultTx`
- `lowThresholdTx`
- `hyperIndicatorTx`
- `pollingMode`
- `usagePage`
- `usage`
- 其他 transport / codec / route 细节

### 10.2 需要翻译后再给前端的字段

- `pollingMode` -> `pollingRates`
- PID 差异 -> 一组布尔 gate
- 协议命令支持关系 -> 语义能力键

### 10.3 不应直接暴露给前端作为裁剪依据

- 命令编号
- report id
- tx 值
- 内部 profile id
- 固件包布局偏移信息

## 11. 反模式清单

- 在前端维护第二份 PID 能力矩阵
- 在 `app.js` / `refactor.ui.js` 中写品牌或 PID 分支控制高级面板显示
- 用当前配置值冒充能力支持性
- 用缺失字段和 `false` 混用表达不支持，且无稳定规则
- 使用协议内部命令名作为跨品牌能力键
- 同一能力在不同品牌用不同名字而无必要
- 输出嵌套 `capabilities` 导致前端无法 gate
- 只在部分刷新时机输出能力包，导致 UI 状态不稳定

## 12. 现有品牌迁移流程建议

将现有品牌迁移到统一 `capabilities` 合同时，建议按以下顺序执行：

1. 列出该品牌全部支持 PID / 机型
2. 建立协议层单一真相矩阵
3. 为每个 PID 标出语义支持布尔项
4. 抽出统一 `buildCapabilities(...)`
5. 抽出统一 `capabilitiesSnapshot(...)`
6. 让默认配置快照与完整回读都带 `cfg.capabilities`
7. 如可行，连接初期补上 `hidApi.capabilities`
8. 前端 profile 中只写 `requiresCapabilities`，不写 PID 分支
9. 手工验证：全支持、部分不支持、缺失键三类场景

## 13. 当前运行时兼容要求

为兼容当前前端实现，迁移后的品牌至少应满足：

- `capabilities` 是扁平对象
- 基础字段存在：`dpiSlotCount`、`maxDpi`、`dpiStep`、`pollingRates`
- 用于高级面板裁剪的键为顶层布尔值
- `cfg.capabilities` 能在 `applyConfigToUi()` 路径进入前端
- 连接初期若提供 `hidApi.capabilities`，其 shape 必须与 `cfg.capabilities` 一致

## 14. Razer 作为参考样板

Razer 当前是本仓库首个完整按 PID 细分矩阵并驱动前端高级面板裁剪的样板。

其参考点包括：
- 协议层 PID 矩阵
- `buildCapabilities(pid)`
- `_capabilitiesSnapshot(...)`
- 前端单一 `RazerProfile + requiresCapabilities`

后续品牌迁移时，应优先复用其“协议层统一收敛、前端只消费语义能力”的模式，而不是复制具体字段实现细节。

## 15. 自检清单

- 是否明确区分了 `features`、`capabilities`、`cfg 实际值`
- 是否所有动态裁剪都可仅靠 `capabilities` 完成，而无需 PID 分支
- 是否 `capabilities` 保持扁平对象
- 是否 gate 字段全部为布尔值
- 是否基础字段 `dpiSlotCount / maxDpi / dpiStep / pollingRates` 已规范输出
- 是否 `hidApi.capabilities` 与 `cfg.capabilities` shape 一致
- 是否完整配置快照始终带 `cfg.capabilities`
- 是否不再依赖前端维护 PID 矩阵副本
- 是否跨品牌同类能力尽量复用统一 key 命名
- 是否对“缺失键”行为有稳定且文档化的约束








