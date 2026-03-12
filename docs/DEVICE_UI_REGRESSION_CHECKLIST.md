# Device UI Regression Checklist

适用范围：当前项目已接入的 6 个设备品牌 UI 回归。  
目标：在每次修改 `device_runtime.js`、`refactor.core.js`、`refactor.profiles.js`、`refactor.ui.js`、`app.js` 或 keymap 图片资源后，快速确认“主页面、按键映射图、主题类名、高级面板”没有串线或缺失。

关联代码：
- `src/core/device_runtime.js`
- `src/refactor/refactor.core.js`
- `src/refactor/refactor.profiles.js`
- `src/refactor/refactor.ui.js`
- `src/core/app.js`

## 1. 通用回归步骤

1. 完整刷新页面，避免旧 HTML / JS / 图片缓存干扰结果。
2. 一次只连接 1 台设备，避免多设备同时授权导致误选。
3. 完成连接后，依次检查：
   - 顶部设备卡片是否显示正确品牌/型号
   - `document.body` 的 `device-*` 类名是否正确
   - 按键映射页鼠标示意图是否成功加载
   - 按键映射热点数量是否符合当前设备
   - 高级面板布局是否正确
   - 高级面板中应显示/应隐藏的项是否符合本清单

## 2. DevTools 快速探针

在浏览器控制台执行下面的片段，可以快速抓取当前 UI 状态：

```js
(() => {
  const img = document.querySelector("#keys .kmImg");
  const visibleKeymapButtons = Array.from(document.querySelectorAll("#keys .kmPoint"))
    .filter((el) => getComputedStyle(el).display !== "none")
    .map((el) => el.dataset.btn);
  const visibleAdvancedItems = Array.from(document.querySelectorAll(
    '#advancedPanel [data-adv-control="range"],'
    + '#advancedPanel [data-adv-control="toggle"],'
    + '#advancedPanel [data-adv-control="cycle"],'
    + '#advancedPanel [data-adv-control="panel"]'
  ))
    .filter((el) => getComputedStyle(el).display !== "none")
    .map((el) => el.getAttribute("data-adv-item"))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);

  return {
    runtimeDevice: window.DeviceRuntime?.getSelectedDevice?.(),
    bodyClasses: Array.from(document.body.classList).filter((cls) => cls.startsWith("device-")),
    keymapSrc: img?.getAttribute("src") || null,
    keymapNaturalWidth: img?.naturalWidth || 0,
    keymapNaturalHeight: img?.naturalHeight || 0,
    visibleKeymapButtons,
    visibleAdvancedItems,
  };
})();
```

判定规则：
- `keymapNaturalWidth` 和 `keymapNaturalHeight` 必须大于 `0`
- `bodyClasses` 必须命中下面各设备的预期
- `visibleKeymapButtons` 必须与按钮数一致
- `visibleAdvancedItems` 必须与当前设备的静态/动态能力预期一致

## 3. 共通失败特征

| 现象 | 优先怀疑点 |
| --- | --- |
| 主页面主题切到别家品牌 | `normalizeDeviceId()`、`DeviceAdapters.getAdapter()`、`__applyDeviceVariantOnce()` |
| 按键映射图是破图 | `ui.keymap.imageSrc`、图片资源路径、`kmImg` 默认图 |
| 按键热点数量不对 | `features.keymapButtonCount` |
| 高级面板布局错列 | `features.advancedLayout` |
| 高级面板项显示过多或过少 | `features.hasXxx`、`ui.advancedPanels`、`cfg.capabilities` |
| Ninjutso 样式不像当前设计 | `ui.skinClass = "atk"` 是否生效 |

## 4. 设备逐项清单

### 4.1 Chaos

基础预期：
- `runtimeDevice = "chaos"`
- `bodyClasses` 只应包含 `device-chaos`
- 按键映射图应为 `./assets/images/default.png`
- 按键热点应为 `1,2,3,4,5,6`

主页面预期：
- 性能模式区域可见
- 配置槽位不可见
- 双回报率 UI 不可见

高级面板预期：
- 布局应为 `dual`
- 应显示：
  - `sleepSeconds`
  - `debounceMs`
  - `sensorAngle`
  - `surfaceFeel`
  - `motionSync`
  - `linearCorrection`
  - `rippleControl`
  - `secondarySurfaceToggle`
  - `surfaceModePrimary`
  - `primaryLedFeature`
- 不应显示：
  - `keyScanningRate`
  - `dpiLightEffect`
  - `receiverLightEffect`
  - `longRangeMode`

### 4.2 Rapoo

基础预期：
- `runtimeDevice = "rapoo"`
- `bodyClasses` 只应包含 `device-rapoo`
- 按键映射图应为 `./assets/images/default.png`
- 按键热点应为 `1,2,3,4,5,6`

主页面预期：
- 性能模式区域可见
- 配置槽位不可见
- 双回报率 UI 不可见
- Rapoo 基础开关区可见

高级面板预期：
- 布局应为 `dual`
- 应显示：
  - `sleepSeconds`
  - `debounceMs`
  - `sensorAngle`
  - `surfaceFeel`
  - `motionSync`
  - `linearCorrection`
  - `rippleControl`
  - `keyScanningRate`
  - `surfaceModePrimary`
  - `primaryLedFeature`
- 不应显示：
  - `secondarySurfaceToggle`
  - `dpiLightEffect`
  - `receiverLightEffect`
  - `longRangeMode`

### 4.3 ATK

基础预期：
- `runtimeDevice = "atk"`
- `bodyClasses` 只应包含 `device-atk`
- 按键映射图应为 `./assets/images/default.png`
- 按键热点应为 `1,2,3,4,5,6`

主页面预期：
- 性能模式区域可见
- 配置槽位不可见
- 双回报率 UI 不可见

高级面板预期：
- 布局应为 `dual`
- 应显示：
  - `sleepSeconds`
  - `debounceMs`
  - `sensorAngle`
  - `surfaceFeel`
  - `motionSync`
  - `linearCorrection`
  - `rippleControl`
  - `dpiLightEffect`
  - `receiverLightEffect`
  - `longRangeMode`
- 不应显示：
  - `surfaceModePrimary`
  - `primaryLedFeature`
  - `secondarySurfaceToggle`
  - `keyScanningRate`

### 4.4 Ninjutso

基础预期：
- `runtimeDevice = "ninjutso"`
- `bodyClasses` 必须同时包含：
  - `device-ninjutso`
  - `device-atk`
- 按键映射图应为 `./assets/images/ninjutso.png`
- 按键热点应为 `1,2,3,4,5`
- 按键 `6` 必须隐藏

主页面预期：
- 性能模式区域可见
- 配置槽位不可见
- 双回报率 UI 不可见
- 视觉皮肤应复用 ATK 风格，但运行时设备仍是 `ninjutso`

高级面板预期：
- 布局应为 `dual`
- 应显示：
  - `sleepSeconds`
  - `debounceMs`
  - `sensorAngle`
  - `surfaceFeel`
  - `secondarySurfaceToggle`
  - `surfaceModePrimary`
  - `primaryLedFeature`
  - `dpiLightEffect`
- 特别检查：
  - 静态颜色面板应存在
  - `motionSync`
  - `linearCorrection`
  - `rippleControl`
  - `receiverLightEffect`
  - `longRangeMode`
  不应显示

### 4.5 Logitech

基础预期：
- `runtimeDevice = "logitech"`
- `bodyClasses` 只应包含 `device-logitech`
- 按键映射基础图应为 `./assets/images/GPW.png`
- 若设备名精确匹配 `PRO X 2 DEX`，应切换为 `./assets/images/GPW_DEX.png`
- 按键热点应为 `1,2,3,4,5`
- 按键 `6` 必须隐藏

主页面预期：
- 性能模式区域不可见
- 配置槽位可见
- 双回报率 UI 可见
- 板载内存相关入口可见

高级面板预期：
- 布局应为 `single`
- 应显示：
  - `onboardMemory`
  - `lightforceSwitch`
  - `surfaceMode`
  - `bhopToggle`
  - `bhopDelay`
- 不应显示：
  - `sleepSeconds`
  - `sensorAngle`
  - `dynamicSensitivityComposite`
  - `smartTrackingComposite`
  - `lowPowerThresholdPercent`
  - `hyperpollingIndicator`

### 4.6 Razer

基础预期：
- `runtimeDevice = "razer"`
- `bodyClasses` 只应包含 `device-razer`
- 按键映射图应为 `./assets/images/VIPER_V3_耿鬼.png`
- 按键热点应为 `1,2,3,4,5,6`

主页面预期：
- 性能模式区域不可见
- 配置槽位不可见
- 高级面板为 `single`

高级面板通用规则：
- `sleepSeconds` 必须始终可见
- 以下面板由 `cfg.capabilities` / `hidApi.capabilities` 决定：
  - `sensorAngle`
  - `dynamicSensitivityComposite`
  - `smartTrackingComposite`
  - `lowPowerThresholdPercent`
  - `hyperpollingIndicator`
- 任何声明了能力 gate 的项，在能力缺失或为 `false` 时都必须隐藏

当前 PID 级别预期：
- `DeathAdder V3 Pro (Wired/Wireless/Alt)`：
  - 应显示 `sleepSeconds`
  - 应显示 `smartTrackingComposite`
  - 应显示 `lowPowerThresholdPercent`
  - 不应显示 `sensorAngle`
  - 不应显示 `dynamicSensitivityComposite`
  - 不应显示 `hyperpollingIndicator`
- `DeathAdder V3 HyperSpeed (Wired/Wireless)`：
  - 预期同上
- `Viper V3 Pro (Wired)`：
  - 应显示 `sleepSeconds`
  - 应显示 `sensorAngle`
  - 应显示 `dynamicSensitivityComposite`
  - 应显示 `smartTrackingComposite`
  - 应显示 `lowPowerThresholdPercent`
  - 不应显示 `hyperpollingIndicator`
- `Viper V3 Pro (Wireless)`：
  - 应显示 `sleepSeconds`
  - 应显示 `sensorAngle`
  - 应显示 `dynamicSensitivityComposite`
  - 应显示 `smartTrackingComposite`
  - 应显示 `lowPowerThresholdPercent`
  - 应显示 `hyperpollingIndicator`

## 5. 必查的缓存/回退点

每次改完后，至少再确认这几个兜底没有失效：

1. `index.html` 中 `#keys .kmImg` 默认图仍然存在
2. `BaseCommonProfile.ui.keymap.imageSrc` 仍然指向 `./assets/images/default.png`
3. `applyKeymapVariant()` 在图片加载失败时，仍会回退到模板默认图
4. `normalizeDeviceId()` 与 `DeviceAdapters.getAdapter()` 没有重新出现品牌级错误回退

## 6. 最小交付标准

在一次完整回归中，至少满足以下结果才算通过：

1. 6 个设备都不会出现主页面主题串线
2. 6 个设备的按键映射图都能成功加载，不出现破图
3. 设备按钮数量与 `keymapButtonCount` 一致
4. Ninjutso 同时具备真实设备类和 ATK 皮肤类
5. Logitech 的单列高级面板与配置槽/双回报率同时正确
6. Razer 的能力驱动高级面板不会把不支持项误显示出来
