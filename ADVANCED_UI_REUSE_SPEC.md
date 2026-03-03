# Advanced UI 复用规范（约束版）

适用范围：`advancedPanel` 及其单列/双列高级参数区域。  
目标：新增样式或交互时，保持可复用、可维护、协议无关。

## 1) 必须遵守的分层边界
- `refactor.core.js`：只负责标准键（stdKey）公共能力、范围、工具，不做 DOM 操作。
- `refactor.profiles.js`：只负责设备差异（`keyMap/transforms/actions/features/ui`）。
- `refactor.ui.js`：只负责布局/可见性/文案渲染，不写协议逻辑。
- `app.js`：只负责运行时绑定与提交（`enqueueDevicePatch`），不写品牌分支。

## 2) 语义 DOM 合同（必须）
- 高级控件统一使用 `data-adv-*`：
  - `data-adv-region`: `dual-left | dual-right | single`
  - `data-adv-item`: 语义项（品牌无关）
  - `data-adv-control`: `toggle | cycle | range | select`
  - `data-std-key`: 标准键
- 查询必须走语义选择器与 helper；不要在业务逻辑中依赖品牌 ID。
- `data-adv-item` 与 `data-adv-control` 必须在同一元素上（复合选择，不可后代空格）。

## 3) 样式类命名规则
- 类名只负责“外观”，不承载业务语义。
- 可复用控件使用中性命名（例如 `adv-composite-mode-input`），避免设备/功能专属前缀。
- 行为绑定优先用 `data-adv-*`，类名仅作样式钩子。

## 4) 单列复用规则（Advanced Single）
- 新增单列语义项前，先判断是否可复用已有 `data-adv-item` 卡片。
- 单列参数职责拆分：
  - `features.advancedSingleItems`：只负责单列语义项可见性白名单。
  - `ui.advancedSingleOrders`：只负责单列语义项排序（按 `data-adv-item` 映射到 CSS `order`）。
- 排序落点规则：单列排序必须作用于 `data-adv-region="single"` 的直系布局子项（order host），
  不能假设语义项节点一定是直系子项（存在 `shutter-list` 等中间容器时也要生效）。
- 确需新增时，必须同时更新：
  1. `index.html`：新增语义节点（`data-adv-*`）
  2. `refactor.profiles.js`：`features.advancedSingleItems`
  3. `refactor.profiles.js`：`ui.advancedSingleOrders`（如需排序控制）
  4. `refactor.ui.js`：单列白名单选择器/能力门控/排序应用（如需要）
  5. `app.js`：语义绑定与读写同步

## 5) Source Region 规则（单一来源）
- `stdKey` 来源区域由 `profile.ui.advancedSourceRegionByStdKey` 声明。
- `app.js` 与 `refactor.ui.js` 只读取该映射，不做跨区域 fallback/转发。
- 任何“单控件多区域兜底”都视为违规。

## 6) 高级面板密度参数（Advanced Panel Density）
- 参数位置：`profile.ui.advancedPanelDensity`。
- 可选值：`default | compact`。
- 默认值：`default`（由 `BaseCommonProfile.ui` 提供）。
- 读取与映射：仅 `refactor.ui.js` 读取该参数，并将其映射到 `#advancedPanel[data-adv-density]`。
- 约束：`app.js`、`protocol`、`actions`、`transforms` 禁止读取此样式参数。

## 6.1) 文案映射参数（Profile UI Metadata）
- 参数位置：`profile.ui.*`（示例：`smartTrackingLevelLabels`、`smartTrackingLevelHint`）。
- 语义：仅用于 UI 显示映射；协议值/范围仍以 stdKey 与 ranges 为准。
- 读取边界：`app.js` 可读取这些参数用于渲染；`protocol`、`actions`、`transforms` 禁止读取文案参数。
- 默认行为：未配置时回退到页面原始文案或数值显示。

## 7) 写入与读回规则
- 控件写入统一：`enqueueDevicePatch({ stdKey: value })`。
- 禁止在 UI 层直接调用 `protocol_api_*`。
- `applyConfigToUi()` 必须有对应读回同步，避免 UI 与设备状态漂移。

## 8) 新样式/新复用控件标准流程
1. 确认需求是否仅改外观；若是，优先只改 CSS/结构，不改 stdKey 语义。
2. 确认是否已有可复用 `data-adv-item`；有则复用，无则新增语义项。
3. 在 `index.html` 落地语义节点（`data-adv-region/item/control/std-key`）。
4. 在 `refactor.profiles.js` 配置 `advancedSingleItems`、`advancedSingleOrders`（按需）与 `advancedSourceRegionByStdKey`。
5. 在 `app.js` 用语义 helper 绑定事件，写入只走 `enqueueDevicePatch`。
6. 在 `applyConfigToUi()` 补齐读回。
7. 在 `refactor.ui.js` 仅补布局/可见性/排序/文案元数据（如有需要）。
8. 做最小回归：切换、禁用态、读回态、能力门控、布局切换。

## 8.2) 可视化复用注意事项
- 先复用骨架，再扩展参数：优先复用现有 DOM + helper；只有现有骨架无法表达时才新增组件。
- 文案参数化归 `profile.ui`：如 `smartTrackingLevelLabels`、`smartTrackingLevelHint`；`app.js` 仅消费参数渲染。
- 视觉可见性门控归 `refactor.ui.js`：例如 `features.showHeightViz`；不要在 `app.js` 写品牌开关。
- 保持 source 单一：所有可视化读取值必须通过 `getSource*ByStdKey(...)` 或等价语义 helper，禁止跨区域兜底。
- 保持写回协议不变：可视化只影响显示，不改变 `enqueueDevicePatch({ stdKey: value })` 的值域与语义。
- 复用样式不绑语义：样式类保持中性，不把 `data-adv-item` 含义编码到 class 名中。
- 对于重复公式，第三处复用前必须抽 helper：例如高度换算、条宽换算、离散映射；防止多处漂移。
- 新增可视化后必须补读回验证：`applyConfigToUi()` 后视觉状态要与当前配置一致（非仅用户拖动时正确）。

## 9) 禁止项（PR 拒绝）
- 在 `app.js` 引入品牌 if/else 分支处理同类控件。
- 用 class/id 代替 `data-adv-*` 作为核心行为绑定入口。
- 只改样式不改语义同步，导致 UI 可见但不可写/不可读回。
- 新增重复语义卡片（已有语义项可复用却另起一套）。
- 在协议层或业务层读取 `profile.ui.advancedPanelDensity` 并驱动行为逻辑。

## 10) 交付前自检清单
- 语义属性齐全：`data-adv-region/item/control/std-key`。
- 绑定路径正确：helper 查询 + `enqueueDevicePatch`。
- profile 映射完整：`advancedSingleItems` + `advancedSingleOrders`（按需）+ `advancedSourceRegionByStdKey`。
- 无跨区域 fallback，无品牌分支。
- 仅最小必要改动，且不破坏现有能力门控。

