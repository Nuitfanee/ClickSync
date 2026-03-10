# Protocol API Design Spec

适用范围：`src/protocols/protocol_api_*.js` 协议文件。  
目标：以 `src/protocols/protocol_api_razer.js` 为参考样板，定义一套可维护、可扩展、可被当前前端引擎正确消费的品牌协议设计规范。

关联文档：
- `CAPABILITIES_CONTRACT_SPEC.md`：规定运行时 `capabilities` 输出契约
- `ADVANCED_UI_REUSE_SPEC.md`：规定高级面板 UI 语义规则和裁剪引擎契约
- `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md`：规定新品牌接入当前项目的标准流程、改动边界与验收清单

## 维护者入口

| 你正在做什么 | 先看本文哪些章节 | 联动阅读 |
| --- | --- | --- |
| 新建或重构 `protocol_api_<brand>.js` | 第 2、3、4、5、6、7、8、9、10 节 | `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` |
| 排查协议层为什么没法被前端正确消费 | 第 4、5、6、7、8、18、19、22 节 | `CAPABILITIES_CONTRACT_SPEC.md` |
| 设计 PID / 机型矩阵、transport、codec、planner | 第 9、10、11、12、13、14、15 节 | `PROTOCOL_MAINTAINER_GUIDE.md` |
| 对齐事件、错误、缓存和写入责任边界 | 第 15、16、17、18、19 节 | `CAPABILITIES_CONTRACT_SPEC.md` |

## 协议文件内部导航

| 你要改的层 | 对应章节 | 你会得到什么 |
| --- | --- | --- |
| 顶层导出与实例接口 | 第 4、5 节 | `ProtocolApi` 导出标准、`MouseMouseHidApi` 必需接口 |
| 握手、配置快照与能力快照 | 第 6、7、8、10 节 | `bootstrapSession()`、`cfg`、`capabilities` 的统一合同 |
| PID / 机型矩阵 | 第 9、10 节 | 单一真相矩阵与能力构建方式 |
| Transport / Codec / Transformer / Planner | 第 11、12、13、14、15 节 | 内部分层、命令编排、reconcile 边界 |
| 事件与错误模型 | 第 16、17 节 | 订阅接口、错误码、调试入口 |
| 与前端和 runtime 的协作 | 第 18、19、22 节 | profile 对接、运行时装载、自检清单 |

## 本文在整套规范中的位置

- 本文只约束 `protocol_api_*` 文件应该如何设计、如何暴露前端可消费接口。
- 本文不规定高级面板宿主和显隐公式，那部分由 `ADVANCED_UI_REUSE_SPEC.md` 定义。
- 本文也不单独定义 `capabilities` 的命名与 shape 合同，那部分由 `CAPABILITIES_CONTRACT_SPEC.md` 统一约束。
- 如果你是在做完整品牌接入，应把本文与 `NEW_BRAND_PROTOCOL_ONBOARDING_SPEC.md` 配合阅读。
- 全套文档的任务式导航入口见 `PROTOCOL_MAINTAINER_GUIDE.md`。

## 推荐阅读顺序

1. 先读第 1、2、3 节，确认协议文件的设计目标、总体分层和文件内部结构。
2. 再读第 4 到 10 节，明确前端运行时硬性接口、`MouseMouseHidApi`、`bootstrapSession()`、`cfg` 和 `capabilities` 合同。
3. 然后阅读第 11 到 17 节，完成 transport、codec、transformer、planner、reconcile、事件和错误模型设计。
4. 最后阅读第 18 到 22 节，确认与 profile、runtime 的边界，并按清单自检。

## 1. 协议设计目标

- 将品牌协议知识集中在 `protocol_api_*` 内部，避免把传输细节泄漏到 UI 层。
- 让前端通过 **单一品牌 Profile + 协议层能力快照** 工作，而不是通过 PID 分支工作。
- 让新品牌协议在不修改 `app.js` 业务分支的前提下，完成连接、读回、写入、能力裁剪和事件推送。
- 让多 PID / 多机型差异优先收敛为协议层能力矩阵，而不是拆分前端 profile。

## 2. 协议文件应该如何分层

新品牌协议应尽量遵循与 Razer 相同的 6+1 层结构：

- `0) Errors & utility helpers`
  - 协议层错误类型、基础工具函数、字节/数值工具
- `1) Device identity & capability model`
  - VID/PID、支持列表、PID 能力矩阵、能力构建函数
- `2) Transport layer`
  - 队列、发送/接收、重试、超时、设备打开/关闭细节
- `3) Codec layer`
  - 纯命令构造、响应解析、报文常量
- `4) Transformers`
  - 原始值 <-> 运行时值的归一化/反归一化
- `5) Planner`
  - 外部 patch 归一化、能力校验、命令序列编排、下一状态预测
- `6) Public API facade`
  - 对外 `MouseMouseHidApi` 实例接口、缓存、事件发射、配置快照
- `7) ProtocolApi exports`
  - 挂载到 `window.ProtocolApi` 的导出对象和品牌元数据

强约束：

- `protocol_api_*` 不做 DOM 操作
- `protocol_api_*` 不读取 `refactor.ui.js` / `index.html` 结构
- `protocol_api_*` 不应依赖 `profile.ui` 文案或布局元数据
- 协议层只通过 **配置快照 + 能力快照 + 事件** 与前端交互

## 3. 文件内部结构标准

建议每个协议文件显式分节，分节顺序尽量固定，以便后续维护者快速定位：

1. 头部注释：目标、分层、边界
2. `ProtocolError` 与基础 helper
3. 设备常量 / PID 常量 / 报文常量
4. PID / 机型能力矩阵
5. Transport driver
6. Codec command builder / parser
7. Transformers
8. Planner / SPEC
9. Public facade class
10. `ProtocolApi` 导出

强烈建议：

- 魔法数字只出现于常量区或 codec 区
- 不要把 send/recv 细节分散到 facade 方法中
- 不要把 capability 判定分散到多个方法里重复写

## 4. 当前前端运行时要求的硬性接口

以下接口是当前前端运行时可正确消费新协议的最小合同。

### 4.1 `ProtocolApi` 顶层导出

每个品牌协议文件加载后，必须把以下成员挂到 `window.ProtocolApi`：

- `ProtocolApi.MouseMouseHidApi`
  - 必需
  - 当前 `app.js` 用它构造 HID API 实例
- `ProtocolApi.resolveMouseDisplayName(vendorId, productId, fallbackName)`
  - 必需
  - 当前连接流和顶部设备信息会调用它
- `ProtocolApi.<BRAND>_HID`
  - 强烈建议必需
  - 用于品牌协议元信息表达
- `ProtocolApi.MOUSE_HID`
  - 强烈建议提供为兼容别名
  - 推荐指向当前品牌 HID 元信息对象，供部分品牌无关逻辑读取共享元数据

推荐标准形状：

```js
ProtocolApi.BRAND_HID = {
  vendorId: 0x0000,
  productIds: [0x0001, 0x0002],
  defaultFilters: [
    { vendorId: 0x0000, productId: 0x0001 },
    { vendorId: 0x0000, productId: 0x0002 },
  ],
  isSupportedPid(productId) {
    return SUPPORTED_PID_SET.has(Number(productId));
  },
};
```

如品牌没有 PID 细分，而是单一机型，也建议保留同样结构，保持合同统一。

推荐兼容写法：

```js
ProtocolApi.BRAND_HID = { ... };
ProtocolApi.MOUSE_HID = ProtocolApi.BRAND_HID;
```

### 4.2 可选导出

如果品牌支持按键映射，建议导出：

- `ProtocolApi.KEYMAP_ACTIONS`
- `ProtocolApi.listKeyActionsByType()`
- `ProtocolApi.labelFromFunckeyKeycode(funckey, keycode)`

这三项不是所有品牌都必须实现，但如果 profile / UI 涉及按键映射目录，它们应保持稳定输出。

## 5. `MouseMouseHidApi` 实例必须长什么样

### 5.1 必需接口

以下接口应视为新协议的必需合同：

- `new ProtocolApi.MouseMouseHidApi()`
- `device` getter/setter
- `capabilities` getter 或等价实例字段
- `bootstrapSession(opts)`
- `close(opts?)`
- `onConfig(cb, opts?)`
- `onBattery(cb)`
- `onRawReport(cb)`
- `getCachedConfig()`
- `requestConfig()`

### 5.1.1 `capabilities` 实例属性要求

当前 `app.js` 会在握手开始前尝试读取 `hidApi.capabilities` 作为早期能力入口。
因此，新品牌协议应显式提供：

- `get capabilities()` 或同等只读实例字段
- 其 shape 应尽量与最终 `cfg.capabilities` 一致
- 在 `device` 变化后应立即反映当前 PID / 机型的基础能力
- 若早期阶段无法确认某些能力，应输出保守值，而不是乐观值

推荐做法：

- `device setter` 内同步刷新内部能力对象
- `get capabilities()` 统一调用能力快照函数返回标准结构

### 5.2 推荐标准写接口

以下接口强烈建议统一实现：

- `setBatchFeatures(obj)`
- `setFeature(key, value)`
- `setDpi(slot, value, opts?)`
- `setDpiSlotCount(n)`
- `setActiveDpiSlotIndex(index)`

原因：

- `refactor.profiles.js` 的 actions 已优先按这些方法编排
- 当前 `app.js` 将写入 reconcile 责任下放到协议层的 `setBatchFeatures()`
- 新品牌若也使用这些标准写接口，前端无需新增品牌分支

### 5.3 可选扩展接口

按能力支持情况，可额外实现：

- `requestBattery()`
- `requestConfiguration()` / `getConfig()` / `readConfig()` / `requestDeviceConfig()` 作为 `requestConfig()` 兼容别名
- `setButtonMappingBySelect(...)`
- `setSlotCount(...)` / `setCurrentDpiIndex(...)` 作为兼容别名

原则：

- 新增别名可以有，但不要让别名成为唯一入口
- 标准入口应始终明确、稳定

## 6. `bootstrapSession()` 语义合同

这是当前前端握手流程最重要的协议入口。

### 6.1 必须满足的行为

- `bootstrapSession(opts)` 必须返回 `Promise<{ cfg, meta }>`
- 成功时 `cfg` 必须是当前缓存配置快照
- 解析失败时应抛出明确错误，而不是返回半结构对象
- 在 resolve 之前，协议层必须至少触发一次 `onConfig()` 可消费的配置状态

### 6.2 推荐标准流程

建议统一为：

1. `device` 就位
2. `open()`
3. 生成默认配置快照 `_makeDefaultCfg()`
4. 执行首次完整读回 `_readDeviceStateSnapshot()`
5. 成功时合并到 `_cfg`
6. 失败时根据策略决定是否使用缓存 fallback
7. `_emitConfig()`
8. 返回 `{ cfg: getCachedConfig(), meta }`

### 6.3 必须与 `app.js` 的职责边界一致

当前运行时约束为：

- `app.js` 负责候选设备选择、握手总超时、UI 切页时机
- `protocol_api_*` 负责 open/read 重试、缓存 fallback、首次配置发射

因此：

- 不要把前端握手超时逻辑写回协议文件
- 不要让 `app.js` 再回到旧式 `waitForNextConfig()` 启动路径

## 7. 配置快照合同

协议层对前端输出的 `_cfg` / `cfg` 必须是**前端可直接消费的运行时配置对象**。

### 7.1 快照必须具备的特性

- 始终是普通对象
- 可被深拷贝
- 不暴露底层 DataView / Uint8Array 作为主业务字段
- 字段命名稳定，不随一次读回路径变化而变化
- 每次 `_emitConfig()` 前尽量保持 shape 稳定

### 7.2 推荐基础字段

建议所有品牌配置快照至少包含：

- `capabilities`
- `deviceName`
- `firmwareVersion`
- `serial`

以及品牌 profile 需要映射的原始配置字段，例如：

- `pollingHz`
- `dpi` / `dpiStages`
- `activeDpiStageIndex`
- `buttonMappings`
- 电池 / 休眠 / 传感器相关字段

### 7.3 默认配置必须与能力一致

`_makeDefaultCfg()` 必须基于当前能力模型生成默认配置：

- 若某 capability 为 `true`，对应交互字段应给出可用默认值
- 若某 capability 为 `false`，不应伪造一个“看起来支持”的业务值
- 前端是否显示某面板靠 `capabilities` 决定，配置值只负责显示当前值

## 8. `capabilities` 设计标准

新品牌协议必须遵循 `CAPABILITIES_CONTRACT_SPEC.md` 的运行时能力合同。

本规范只强调协议设计层的落地方式：

- 协议内部可以有自己的 profile/caps/transport metadata
- 对前端输出时必须收敛为统一 `cfg.capabilities`
- `cfg.capabilities` 与 `hidApi.capabilities` 应尽量 shape 一致
- `hidApi.capabilities` 应由协议实例显式暴露，而不是让前端猜测
- 动态能力差异优先来自 PID/机型矩阵，不来自前端判断

## 9. PID / 机型能力矩阵标准

如果品牌存在多 PID / 多机型差异，必须优先建立**单一真相矩阵**。

### 9.1 设计要求

- 一行表示一个 PID 或固定机型变体
- 行对象应同时包含：
  - 身份字段：`pid`、`name`
  - 协议细节字段：report id / tx route / polling mode / usage variant 等
  - 语义支持字段：`sensorAngle`、`smartTracking` 等布尔项
- `SUPPORTED_PIDS`、`PID_NAME`、`defaultFilters` 等应从矩阵派生，而不是手写多份副本

### 9.2 单一来源原则

矩阵必须是该品牌 PID 能力的单一真相来源：

- 不要在 facade 再写第二份 PID if/else
- 不要在 codec / planner / read path 各自重复维护 capability 分支
- 如某字段需随 PID 路由不同，仍应从矩阵派生

### 9.3 无 PID 品牌如何处理

如果品牌只有单一 productId，也建议保留“矩阵式”结构：

- 便于未来扩展更多 PID
- 便于保持所有品牌协议风格统一

## 10. 能力构建与快照输出

建议统一实现两层能力函数：

- `buildCapabilities(pid)`
  - 面向协议内部
  - 负责把矩阵行翻译为内部能力对象
- `_capabilitiesSnapshot(caps)`
  - 面向前端输出
  - 负责把内部能力整理为运行时 `cfg.capabilities`

强约束：

- `buildCapabilities()` 不做 DOM/UI 判断
- `_capabilitiesSnapshot()` 不输出协议内部调试字段
- `cfg.capabilities` 应始终走统一快照函数生成

## 11. Transport 层规范

### 11.1 队列化

必须有单一发送队列，确保：

- 多次写入按顺序执行
- 读写不会并发踩踏设备状态
- 上层 facade 不直接裸发命令

### 11.2 重试策略集中化

超时、BUSY、NotAllowedError、短暂失配等重试策略必须集中放在 transport 层，不要散落到业务方法：

- `sendAndWait()`
- `runSequence()`
- `open()` 前后 settle window
- read/write retry budget

### 11.3 设备路由细节集中化

以下逻辑应集中在 transport / routing helper，而不是散落：

- report id 选择
- tx / transaction id 选择
- waitMs 选择
- 同 PID 的特殊通信路径

## 12. Codec 层规范

codec 层负责**纯协议报文知识**：

- 命令构造
- 报文长度
- 字节偏移
- 响应状态解析
- CRC / checksum / opcode 处理（若协议需要）

强约束：

- codec 不读取 `_cfg`
- codec 不判定当前品牌业务能力是否显示 UI
- codec 输出尽量是纯数据，便于测试

## 13. Transformer 层规范

transformer 层负责原始值与运行时值之间的归一化。

职责包括：

- clamp / normalize
- 枚举值映射
- 设备原始编码 <-> 前端业务值
- DPI / 电量 / 角度 / tracking 等字段归一化

强约束：

- 不把 normalize 逻辑散落在 read/write 方法内到处复制
- 同一个字段的读写变换应尽量共享 transformer

## 14. Planner / SPEC 规范

建议新品牌都实现与 Razer 同类的 planner 层。

### 14.1 planner 的标准输入输出

输入：

- 当前 `_cfg`
- 外部 patch

输出：

- `patch`
- `nextState`
- `commands`

### 14.2 planner 必须承担的责任

- 过滤无效字段
- 参数合法化
- 按 capability 拒绝不支持字段
- 将一个业务 patch 编译为有序命令序列
- 生成本次写入完成后的预测缓存状态 `nextState`

### 14.3 不允许的反模式

- 在 facade 的每个 setter 中手写一套命令排序
- 在 transport 层直接决定业务 patch 含义
- 对不支持字段静默吞掉且无错误

## 15. 写入与 reconcile 规范

### 15.1 标准写入口

`setBatchFeatures(obj)` 应作为协议层标准写入口：

1. 校验/归一化 patch
2. 通过 planner 编译命令
3. transport 顺序执行
4. 成功后更新 `_cfg`
5. 失败时执行一次协议层 readback reconcile
6. `_emitConfig()`，必要时 `_emitBattery()`

### 15.2 责任边界

当前前端约束是：

- `enqueueDevicePatch()` 只负责排队、防抖、intent、日志
- 写失败后的状态校准由协议层负责

因此：

- 不要把 reconcile 逻辑塞回 `app.js`
- 协议层写失败后不要只抛错不校准缓存

## 16. 事件模型规范

### 16.1 `onConfig(cb, { replay = true } = {})`

- 必须返回取消订阅函数
- `replay=true` 时应尽快把当前快照回放给订阅者
- 发射内容必须是前端可消费快照，而不是内部 `_cfg` 引用

### 16.2 `onBattery(cb)`

- 必须返回取消订阅函数
- 若品牌支持电池，电量变更和刷新后应及时发射
- 若品牌不支持电池，允许永不发射；若外部调用 `requestBattery()`，应抛明确不支持错误

### 16.3 `onRawReport(cb)`

- 必须返回取消订阅函数
- 主要用于调试和观测，不应承担业务主逻辑

## 17. 错误模型规范

建议所有品牌都统一使用 `ProtocolError`，包含：

- `message`
- `code`
- `detail`

推荐错误码风格：

- `NO_DEVICE`
- `BAD_PARAM`
- `UNSUPPORTED_DEVICE`
- `FEATURE_UNSUPPORTED`
- `NOT_SUPPORTED_FOR_DEVICE`
- `INITIAL_READ_FAIL`
- `DEVICE_CLOSED`
- `TIMEOUT`

强约束：

- 对“该设备不支持该功能”要抛明确错误，不要默默忽略
- 对参数错误要抛 `BAD_PARAM` 类错误，不要自动写入畸形值

## 18. 与前端 profile 的协作边界

协议层与 `refactor.profiles.js` 的边界必须清晰：

- 协议层负责输出原始配置字段和能力字段
- profile 负责把 stdKey 映射到这些字段或动作
- UI 层只根据 stdKey / features / capabilities 渲染

因此：

- 新增协议字段时，要同步考虑 profile 的 `keyMap/transforms/actions`
- 但不要在协议层读取 profile 的 `ui.advancedPanels` 或布局信息

## 19. 与设备运行时装载的协作

新品牌协议上线时，协议文件之外还必须完成：

1. 在 `src/core/device_runtime.js` 注册脚本路径
2. 补充 HID 指纹匹配和 request filters
3. 在 `src/refactor/refactor.profiles.js` 增加品牌 profile
4. 确保 `capabilities` 命名与 profile 的 `requiresCapabilities` 对齐

但这些步骤属于品牌接入流程，不应回写为协议文件内部的品牌分支。

## 20. 推荐实现模板

```js
(() => {
  "use strict";

  class ProtocolError extends Error {}

  const PID = Object.freeze({ ... });

  const PID_CAPABILITY_MATRIX = Object.freeze([
    buildPidMatrixRow(...),
  ]);

  function buildCapabilities(pid) {
    ...
  }

  class SendQueue {
    enqueue(task) { ... }
  }

  const ProtocolCodec = Object.freeze({
    commands: { ... },
    parse: { ... },
  });

  const TRANSFORMERS = Object.freeze({ ... });

  class CommandPlanner {
    plan(currentCfg, payload) {
      return { patch, nextState, commands };
    }
  }

  class MouseMouseHidApi {
    constructor({ device = null } = {}) { ... }
    set device(dev) { ... }
    get device() { ... }
    async bootstrapSession(opts = {}) { ... }
    onConfig(cb, opts = {}) { ... }
    getCachedConfig() { ... }
    async requestConfig() { ... }
    async setBatchFeatures(obj) { ... }
    async close(opts = {}) { ... }
  }

  const root = window;
  const ProtocolApi = (root.ProtocolApi = root.ProtocolApi || {});
  ProtocolApi.BRAND_HID = { ... };
  ProtocolApi.resolveMouseDisplayName = function (...) { ... };
  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
})();
```

## 21. 反模式清单

- 在 `protocol_api_*` 内直接操作 DOM
- 在协议文件中写前端布局、主题或文案逻辑
- 不建能力矩阵，直接在每个方法里写 PID if/else
- 不经 planner，直接在 setter 中拼装长命令序列
- 不输出 `cfg.capabilities`，让前端自行猜测能力
- 写失败后不做 reconcile，导致前端缓存漂移
- 把原始协议字段直接暴露给前端作为 capability gate
- 在多个地方重复维护 `SUPPORTED_PIDS`、`PID_NAME`、`defaultFilters`

## 22. 新品牌接入自检清单

- 是否存在稳定的 `ProtocolApi.MouseMouseHidApi`
- 是否实现了 `bootstrapSession()` 并在 resolve 前至少发过一次配置
- 是否 `getCachedConfig()` 始终返回可消费快照
- 是否 `cfg.capabilities` 与能力合同一致
- 是否多 PID 差异已收敛到矩阵和能力构建函数
- 是否所有写入统一经 `setBatchFeatures()` 或其包装方法
- 是否写失败后做了协议层 readback reconcile
- 是否未在协议层引入任何 DOM/UI 依赖
- 是否导出了 `resolveMouseDisplayName()` 和品牌 HID 元数据
- 是否与 `device_runtime.js`、`refactor.profiles.js` 的命名契约一致






