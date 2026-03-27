# Protocol Maintainer Guide

适用范围：面向当前项目协议体系的维护者总览入口。  
目标：帮助维护者在阅读大量规范前，先快速判断“我该先看哪一份文档、这个问题属于哪一层、哪些文件应该改、哪些文件不该改”。

关联文档：
- `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md`：新增品牌时的完整接入流程、文件边界、模板与验收清单
- `PROTOCOL_API_DESIGN_SPEC.md`：`src/protocols/protocol_api_*.js` 的协议设计标准
- `CAPABILITIES_CONTRACT_SPEC.md`：协议层对前端输出 `capabilities` 的统一合同
- `ADVANCED_UI_REUSE_SPEC.md`：高级面板的语义规则、可见性公式、宿主目录与复用边界

## 1. 先用这张表选择文档

| 你现在要处理的任务 | 第一份先读 | 第二份再读 | 第三份再读 | 重点收获 |
| --- | --- | --- | --- | --- |
| 新增一个全新品牌 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | `PROTOCOL_API_DESIGN_SPEC.md` | `CAPABILITIES_CONTRACT_SPEC.md` / `ADVANCED_UI_REUSE_SPEC.md` | 从设备识别、协议实现到 UI 复用与验收的完整路径 |
| 重写或新建 `protocol_api_<brand>.js` | `PROTOCOL_API_DESIGN_SPEC.md` | `CAPABILITIES_CONTRACT_SPEC.md` | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | 协议文件如何分层、必须导出什么、如何与前端协作 |
| 排查高级面板为什么显示/隐藏不对 | `ADVANCED_UI_REUSE_SPEC.md` | `CAPABILITIES_CONTRACT_SPEC.md` | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | 可见性公式、gate 规则、host 目录、运行时刷新入口 |
| 判断一个字段该放 `features`、`capabilities` 还是 `cfg.xxx` | `CAPABILITIES_CONTRACT_SPEC.md` | `ADVANCED_UI_REUSE_SPEC.md` | `PROTOCOL_API_DESIGN_SPEC.md` | 三层语义边界和命名规则 |
| 不确定要不要改 `app.js`、`refactor.ui.js`、`index.html` | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | `ADVANCED_UI_REUSE_SPEC.md` | `PROTOCOL_API_DESIGN_SPEC.md` | 变更边界与例外条件 |
| 需要做交付前验收 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | `PROTOCOL_API_DESIGN_SPEC.md` | `CAPABILITIES_CONTRACT_SPEC.md` | 手工验证项、自检清单、运行时一致性要求 |

## 2. 四份规范分别解决什么问题

| 文档 | 主要解决的问题 | 维护者最常用的场景 | 不负责解决的问题 |
| --- | --- | --- | --- |
| `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` | 新品牌怎样接入当前项目、通常要改哪些文件、什么时候必须扩展 UI | 做品牌接入、排查改动边界、准备联调与验收 | 不展开讲协议文件内部每一层怎么实现 |
| `PROTOCOL_API_DESIGN_SPEC.md` | 协议文件内部怎么组织、如何暴露前端可消费接口、如何管理 PID/机型矩阵 | 新建或重构 `protocol_api_*`、设计 transport/codec/planner | 不负责规定高级面板显隐公式 |
| `CAPABILITIES_CONTRACT_SPEC.md` | `capabilities` 必须长什么样、哪些字段必须统一命名、`hidApi.capabilities` 与 `cfg.capabilities` 如何对应 | 设计动态能力包、排查字段命名和 shape 问题 | 不负责规定 DOM 布局和面板宿主位置 |
| `ADVANCED_UI_REUSE_SPEC.md` | 高级面板如何按 `features + capabilities + layout` 裁剪、`data-adv-item` 如何复用 | 排查高级面板显隐、扩展新的语义面板项 | 不负责规定协议命令和 transport 细节 |

## 3. 从设备到 UI 的协作链路

维护者可以始终按下面这条链路定位问题：

1. `src/core/device_runtime.js`
   - 识别当前设备属于哪个品牌
   - 根据品牌动态加载 `protocol_api_<brand>.js`
2. `src/protocols/protocol_api_<brand>.js`
   - 建立设备身份、PID/机型矩阵、transport、codec、planner
   - 输出 `hidApi.capabilities`
   - 通过 `bootstrapSession()` / `onConfig()` 输出 `cfg.capabilities`
3. `src/refactor/refactor.core.js`
   - 提供标准键、共享 transforms、`AppConfig.ranges`
   - 提供高级面板默认规则、可见性求值等纯规则能力
4. `src/refactor/refactor.profiles.js`
   - 声明品牌 profile
   - 用 `features` 表达静态超集
   - 用 `ui.advancedPanels` / `keyMap` / `transforms` / `actions` 把品牌翻译成前端标准语义
5. `src/refactor/refactor.ui.js`
   - 读取 profile 和运行时能力
   - 按布局、排序、语义 host 和规则模型渲染高级面板
6. `src/core/app.js`
   - 绑定 DOM 事件
   - 触发标准写入链路
   - 调用 `applyConfigToUi(cfg)` 和 `applyCapabilityStateToRuntime(cap)` 刷新 UI

## 4. 维护时一定要守住的跨层边界

- PID / 机型真相属于协议层，不属于前端。
- `profile.features` 是品牌/系列静态超集，`cfg.capabilities` / `hidApi.capabilities` 是当前设备动态子集，`cfg.xxx` 是当前实际值。
- 高级面板显隐必须统一走 `features + capabilities + layout`，不要在 `app.js` / `refactor.ui.js` 散落品牌分支。
- 协议层不操作 DOM，UI 层不直接调用 `protocol_api_*`。
- 新增 DOM、新控件、新 stdKey 之前，先确认现有语义项和现有控制类型是否已经足够表达。

## 5. 维护任务速查

| 你看到的现象 | 优先检查的层 | 常见根因 |
| --- | --- | --- |
| 设备能连接，但 UI 没法读写 | `refactor.profiles.js` + `refactor.core.js` | `keyMap` / `transforms` / `actions` / `ranges` 未补齐 |
| 高级面板整卡片不见了 | `ADVANCED_UI_REUSE_SPEC.md` 对应规则 + `capabilities` 输出 | `requiresCapabilities` 缺键、`features` 未开启、host 目录未注册 |
| 同品牌不同 PID 前端行为错乱 | `protocol_api_*` + `CAPABILITIES_CONTRACT_SPEC.md` | PID 差异没有先收敛为统一能力矩阵 |
| 写入成功但 UI 回显错 | `app.js` + profile transforms | `applyConfigToUi()` 缺 setter 或 `transforms.read()` 返回不稳定 |
| 需要增加新功能但不确定先改哪里 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` 第 7、9、10、11、12、13 节 | 扩展顺序反了，先动了 `app.js` 或写了品牌分支 |

## 6. 推荐阅读路径

### 6.1 新品牌接入

1. 先读 `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md`
2. 再读 `PROTOCOL_API_DESIGN_SPEC.md`
3. 实现 `capabilities` 时读 `CAPABILITIES_CONTRACT_SPEC.md`
4. 复用或扩展高级面板时读 `ADVANCED_UI_REUSE_SPEC.md`
5. 回到 onboarding 文档做手工验收和最终自检

### 6.2 排查高级面板显隐

1. 先读 `ADVANCED_UI_REUSE_SPEC.md`
2. 对照 `CAPABILITIES_CONTRACT_SPEC.md` 确认动态 gate 的 key、shape、缺失行为
3. 回到 `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` 检查是否真的需要改 `app.js` / `refactor.ui.js` / `index.html`
4. 如果问题属于切设备残留，先检查 device-scoped rebuild contract 和 reversible variant render，不要先补品牌分支

### 6.3 重构协议文件

1. 先读 `PROTOCOL_API_DESIGN_SPEC.md`
2. 再读 `CAPABILITIES_CONTRACT_SPEC.md`
3. 最后用 `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` 校验与 runtime/profile 的对接边界

## 7. 最后给维护者的工作习惯建议

- 先判断问题属于哪一层，再动代码；不要直接在 `app.js` 或 DOM 上补品牌分支。
- 先判断现有语义是否可复用，再决定是否扩展 `stdKey`、`data-adv-item` 或控制类型。
- 先补协议层能力和 profile 映射，再补 UI；不要为了赶进度让前端开始消费 PID 或 report id。
- 每次改动前都沿着“设备识别 -> 协议 -> capabilities -> profile -> UI -> app”这条链路过一遍，能显著减少返工。
