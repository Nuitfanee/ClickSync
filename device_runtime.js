
/**
 * Manifesto: Runtime Orchestration
 * 本模块统一处理 WebHID 发现、协议加载与设备选择流程，
 * 用于保证 UI 与协议加载路径隔离，并降低并发竞态风险。
 *
 * 禁止事项：
 * - 这里不渲染 UI；只做运行期编排。
 * - 不写设备 UI 分支；识别必须走注册表。
 * - 未确保协议加载前，禁止访问协议 API。
 */

// ============================================================
// 1) 常量与设备注册表（硬件指纹）
// ============================================================
(() => {
  "use strict";

  const STORAGE_KEY = "device.selected";
  const LAST_HID_KEY = "mouse.lastHid";
  const VALID = new Set(["chaos", "rapoo", "atk"]);


  /**
   * DEVICE_REGISTRY 定义硬件指纹以识别设备类型。
   * 目的：在不依赖 UI 的前提下完成设备类型识别，
   * 通过 vendor/product id 与 usage page/usage 签名完成判定。
   */
  const DEVICE_REGISTRY = [
    {
      type: "rapoo",
      label: "Rapoo",

      match: (d) => d.vendorId === 0x24ae && d.collections.some((c) => c.usagePage === 0xff00),
      filters: [
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 14 },
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 15 },
      ],
    },
    {
      type: "atk",
      label: "ATK",
      match: (d) =>
        d.vendorId === 0x373b &&
        Array.isArray(d.collections) &&
        d.collections.some((c) => Number(c.usagePage) === 0xff02 && Number(c.usage) === 0x0002),
      filters: [
        { vendorId: 0x373b, usagePage: 0xff02, usage: 0x0002 },
      ],
    },
    {
      type: "chaos",
      label: "Chaos",
      match: (d) => d.vendorId === 0x1915,
      filters: [
        { vendorId: 0x1915, usagePage: 65290 },
        { vendorId: 0x1915, usagePage: 65280 },
      ],
    },
  ];

  // ============================================================
  // 2) 选择与持久化
  // ============================================================
  /**
   * 规范化设备 ID。
   * 目的：统一入口并消除别名，避免状态漂移。
   *
   * @param {string} id - 设备标识。
   * @returns {string} 规范化后的设备标识。
   */
  const normalizeDeviceId = (id) => {
    const x = String(id || "").toLowerCase();
    return VALID.has(x) ? x : "chaos";
  };

  /**
   * 获取当前选择的设备。
   * 目的：统一读取入口，保证 UI 与 Runtime 一致。
   *
   * @returns {string} 设备标识。
   */
  function getSelectedDevice() {
    const v = (localStorage.getItem(STORAGE_KEY) || "chaos").toLowerCase();
    return VALID.has(v) ? v : "chaos";
  }

  /**
   * 设置当前选择的设备，并按需触发刷新。
   * 目的：切换设备时刷新 UI 与协议绑定，确保状态一致。
   *
   * @param {string} device - 设备标识。
   * @param {Object} [opts]
   * @param {boolean} [opts.reload=true] - 是否刷新页面。
   * @returns {void} 无返回值。
   */
  function setSelectedDevice(device, { reload = true } = {}) {
    const next = normalizeDeviceId(device);
    if (next !== getSelectedDevice()) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
      if (reload) {
        try { location.reload(); } catch (_) {}
      }
    }
  }

  /**
   * 保存最近一次连接的 HID 设备信息。
   * 目的：为自动连接提供优先匹配依据，减少重复授权。
   *
   * @param {HIDDevice} dev - HID 设备实例。
   * @returns {void} 无返回值。
   */
  function saveLastHidDevice(dev) {
    if (!dev) return;
    try {
      localStorage.setItem(
        LAST_HID_KEY,
        JSON.stringify({
          vendorId: dev.vendorId,
          productId: dev.productId,
          productName: dev.productName || "",
          ts: Date.now(),
        })
      );
    } catch (_) {}
  }

  /**
   * 读取上一次连接的 HID 设备信息。
   * 目的：基于历史选择提升自动连接命中率。
   *
   * @returns {Object|null} 设备摘要信息。
   */
  function loadLastHidDevice() {
    try {
      return JSON.parse(localStorage.getItem(LAST_HID_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  // ============================================================
  // 3) 低层辅助（脚本加载 + HID 结构检查）
  // ============================================================
  /**
   * 判断协议脚本是否已存在。
   * 目的：避免重复注入脚本导致副作用。
   *
   * @param {string} src - 脚本路径。
   * @returns {boolean} 是否已存在。
   */
  function _scriptExists(src) {
    return Array.from(document.scripts).some((s) => (s.src || "").includes(src));
  }

  /**
   * 动态加载协议脚本。
   * 目的：按需加载降低首屏负担并隔离协议差异。
   *
   * @param {string} src - 脚本路径。
   * @returns {Promise<void>} 加载完成 Promise。
   */
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (_scriptExists(src)) return resolve();
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  /**
   * 判断设备是否包含指定 usagePage。
   * 目的：利用 usagePage 识别协议类型，提高判定准确性。
   *
   * @param {HIDDevice} d - HID 设备。
   * @param {number} page - usagePage。
   * @returns {boolean} 是否匹配。
   */
  function _hasUsagePage(d, page) {
    const cols = d?.collections || [];
    return Array.isArray(cols) && cols.some((c) => Number(c?.usagePage) === Number(page));
  }

  /**
   * 判断设备是否包含厂商自定义 usagePage。
   * 目的：利用厂商自定义页提高识别优先级。
   *
   * @param {HIDDevice} d - HID 设备。
   * @returns {boolean} 是否存在厂商页。
   */
  function _hasAnyVendorPage(d) {
    const cols = d?.collections || [];
    return Array.isArray(cols) && cols.some((c) => {
      const p = Number(c?.usagePage);
      return Number.isFinite(p) && p >= 0xff00 && p <= 0xffff;
    });
  }

  /**
   * 判断设备是否包含指定输出报告 ID。
   * 目的：通过输出报告 ID 判断写入能力。
   *
   * @param {HIDDevice} d - HID 设备。
   * @param {number} rid - 报告 ID。
   * @returns {boolean} 是否存在。
   */
  function _hasOutRid(d, rid) {
    const cols = d?.collections || [];
    return Array.isArray(cols) && cols.some((c) => Array.isArray(c?.outputReports) && c.outputReports.some((r) => Number(r?.reportId) === Number(rid)));
  }

  /**
   * 判断设备是否匹配单个过滤器。
   * 目的：集中过滤逻辑，避免筛选分散。
   *
   * @param {HIDDevice} dev - HID 设备。
   * @param {Object} filter - 过滤条件。
   * @returns {boolean} 是否匹配。
   */
  function _matchesFilter(dev, filter) {
    if (!dev || !filter) return false;
    if (filter.vendorId != null && dev.vendorId !== filter.vendorId) return false;
    const page = filter.usagePage;
    const usage = filter.usage;
    if (page == null && usage == null) return true;

    const cols = dev?.collections || [];
    return Array.isArray(cols) && cols.some((c) => {
      if (page != null && Number(c?.usagePage) !== Number(page)) return false;
      if (usage != null && Number(c?.usage) !== Number(usage)) return false;
      return true;
    });
  }

  /**
   * 判断设备是否匹配任一过滤器。
   * 目的：支持多条件并集以提高发现率。
   *
   * @param {HIDDevice} dev - HID 设备。
   * @param {Object[]} filters - 过滤条件数组。
   * @returns {boolean} 是否匹配任一条件。
   */
  function _matchesAnyFilter(dev, filters) {
    if (!filters || !filters.length) return true;
    return filters.some((f) => _matchesFilter(dev, f));
  }

  /**
   * Rapoo 设备的 usage 细化评分。
   * 目的：利用 Rapoo usage 差异提高评分精度。
   *
   * @param {HIDDevice} d - HID 设备。
   * @returns {number} 分值。
   */
  function _rapooUsageScore(d) {
    const cols = d?.collections || [];
    const usage = cols.find((c) => Number(c?.usagePage) === 0xff00)?.usage;
    if (usage === 14) return 120;
    if (usage === 15) return 60;
    return 0;
  }


  // ============================================================
  // 4) 候选评分与排序
  // ============================================================
  /**
   * 为设备计算综合评分。
   * 目的：通过可解释权重排序提升自动连接稳定性。
   *
   * @param {HIDDevice} d - HID 设备。
   * @param {string|null} preferType - 偏好类型。
   * @param {Object|null} savedDevice - 历史设备信息。
   * @returns {number} 分值。
   */
  function _scoreDevice(d, preferType, savedDevice) {
    let s = 0;
    if (!d) return s;

    if (_hasUsagePage(d, 65290)) s += 900;
    if (_hasUsagePage(d, 0xFF00)) s += 600;
    if (_hasAnyVendorPage(d)) s += 300;

    if (_hasOutRid(d, 6)) s += 1200;

    if (preferType === "chaos") {
      if (_hasUsagePage(d, 65290)) s += 200;
      if (_hasUsagePage(d, 65280)) s += 80;
    } else if (preferType === "rapoo") {
      if (_hasUsagePage(d, 0xff00)) s += 200;
      s += _rapooUsageScore(d);
    }

    if (savedDevice && d.vendorId === savedDevice.vendorId && d.productId === savedDevice.productId) s += 200;

    if (Array.isArray(d?.collections) && d.collections.some((c) => Number(c?.usagePage) !== 0x0001)) s += 30;

    return s;
  }


  /**
   * 收集并排序候选设备列表。
   * 目的：统一候选收集以复用评分与回退策略。
   *
   * @param {HIDDevice|null} primary - 主设备候选。
   * @param {string|null} preferType - 偏好类型。
   * @param {Object} [opts]
   * @param {boolean} [opts.pinPrimary=false] - 是否固定主设备优先。
   * @param {Object|null} [opts.savedDevice] - 历史设备信息。
   * @returns {Promise<HIDDevice[]>} 排序后的设备列表。
   */
  async function _collectCandidates(primary, preferType, { pinPrimary = false, savedDevice = null } = {}) {
    const uniq = [];
    /**
     * 将设备加入候选列表（去重）。
     * 目的：保证候选唯一性，避免重复评分与尝试。
     *
     * @param {HIDDevice|null} d - HID 设备。
     */
    const push = (d) => {
      if (!d) return;
      if (uniq.includes(d)) return;
      uniq.push(d);
    };

    push(primary);
    try {
      const devs = await navigator.hid.getDevices();
      for (const d of (devs || [])) push(d);
    } catch (_) {}

    let list = uniq;
    const t = preferType || null;
    if (t) {
      const typed = uniq.filter((d) => identifyDeviceType(d) === t);
      if (typed.length) list = typed;
    }

    if (t) {
      const entry = DEVICE_REGISTRY.find((e) => e.type === t);
      if (entry?.filters?.length) {
        const filtered = list.filter((d) => _matchesAnyFilter(d, entry.filters));
        if (filtered.length) list = filtered;
      }

      if (t === "rapoo") {
        const strictRapoo = list.filter((d) =>
          d.vendorId === 0x24ae &&
          Array.isArray(d.collections) &&
          d.collections.some((c) => Number(c.usagePage) === 0xff00 && (Number(c.usage) === 14 || Number(c.usage) === 15))
        );
        if (strictRapoo.length) list = strictRapoo;
      }
    }

    const sorted = [...list].sort((a, b) => _scoreDevice(b, t, savedDevice) - _scoreDevice(a, t, savedDevice));
    if (pinPrimary && primary) {
      return [primary, ...sorted.filter((d) => d !== primary)];
    }
    return sorted;
  }


  // ============================================================
  // 5) 连接策略
  // ============================================================
  /**
   * 触发用户授权选择设备。
   * 目的：符合浏览器权限模型，保证由用户手势触发。
   *
   * @returns {Promise<HIDDevice|null>} 选择的设备或 null。
   */
  async function requestDevice() {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID。");

    const allFilters = DEVICE_REGISTRY.flatMap((entry) => entry.filters);
    const uniqueFilters = [];
    const seen = new Set();
    for (const f of allFilters) {
      const s = JSON.stringify(f);
      if (!seen.has(s)) {
        seen.add(s);
        uniqueFilters.push(f);
      }
    }

    const devices = await navigator.hid.requestDevice({ filters: uniqueFilters });
    return devices[0] || null;
  }


  /**
   * 识别设备类型。
   * 目的：将设备与适配器/协议关联，避免 UI 参与判断。
   *
   * @param {HIDDevice} device - HID 设备。
   * @returns {string|null} 设备类型。
   */
  function identifyDeviceType(device) {
    if (!device) return null;
    for (const entry of DEVICE_REGISTRY) {
      if (entry.match(device)) return entry.type;
    }
    return null;
  }


  /**
   * 自动连接候选选择。
   * 目的：通过评分排序稳定回连，并优先复用已有 HID 句柄
   *（navigator.hid.getDevices）以避免重复权限弹窗。
   *
   * @param {Object} [args]
   * @param {string|null} [args.preferredType] - 偏好设备类型。
   * @param {Object|null} [args.savedDevice] - 历史设备信息。
   * @returns {Promise<Object>} 设备与候选列表。
   */
  async function autoConnect({ preferredType = null, savedDevice = null } = {}) {
    if (!navigator.hid) return { device: null, candidates: [], detectedType: null };
    const candidates = await _collectCandidates(null, preferredType, { savedDevice });
    const device = candidates[0] || null;
    return {
      device,
      candidates,
      detectedType: identifyDeviceType(device),
      preferredType: preferredType || null,
    };
  }


  /**
   * 连接流程（手动/自动，带候选回退）。
   * 目的：统一连接入口，避免设备分支渗透到 UI。
   *
   * @param {boolean|Object} mode - true 触发弹窗，Object 直接指定设备。
   * @param {Object} [opts]
   * @param {Object|null} [opts.primaryDevice] - 主设备候选。
   * @param {string|null} [opts.preferredType] - 偏好设备类型。
   * @param {boolean} [opts.pinPrimary] - 是否固定主设备优先。
   * @param {Object|null} [opts.savedDevice] - 历史设备信息。
   * @returns {Promise<Object>} 连接结果与候选列表。
   */
  async function connect(mode = false, { primaryDevice = null, preferredType = null, pinPrimary = false, savedDevice = null } = {}) {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID。");

    let primary = null;

    if (mode && typeof mode === "object" && mode.vendorId) {
      primary = mode;
    } else if (mode === true) {
      primary = await requestDevice();
    } else if (primaryDevice) {
      primary = primaryDevice;
    } else {
      const auto = await autoConnect({ preferredType, savedDevice });
      primary = auto.device;
    }

    if (!primary) {
      return { device: null, candidates: [], detectedType: null, preferredType: preferredType || null };
    }

    const detectedType = identifyDeviceType(primary);
    const preferType = preferredType || detectedType || getSelectedDevice();
    const candidates = await _collectCandidates(primary, preferType, { pinPrimary, savedDevice });

    return { device: primary, candidates, detectedType, preferredType: preferType };
  }


  // ============================================================
  // 6) 协议加载（按设备动态注入）
  // ============================================================
  /**
   * 确保所选设备的协议 API 已加载。
   * 目的：按需加载保持 Runtime 轻量，并避免 UI 过早绑定协议脚本。
   *
   * @returns {Promise<{device: string, ProtocolApi: Object}>} 设备与协议对象。
   */
  async function ensureProtocolLoaded() {
    const device = getSelectedDevice();
    const src = (device === "rapoo")
      ? "./protocol_api_rapoo.js"
      : (device === "atk")
        ? "./protocol_api_atk.js"
        : "./protocol_api_chaos.js";

    if (!window.ProtocolApi) {
      await _loadScript(src);
    }

    if (!window.ProtocolApi) {
      throw new Error("ProtocolApi 未加载，期望 window.ProtocolApi 可用。");
    }

    return { device, ProtocolApi: window.ProtocolApi };
  }


  /**
   * 获取协议准备完成的单例 Promise。
   * 目的：避免重复加载脚本引发竞态或重复执行。
   *
   * @returns {Promise<{device: string, ProtocolApi: Object}>} 协议准备结果。
   */
  function whenProtocolReady() {
    if (!this.__p) {
      this.__p = ensureProtocolLoaded();
    }
    return this.__p;
  }

  // ============================================================
  // 7) 对外 Runtime API
  // ============================================================
  const DeviceRuntime = {
    getSelectedDevice,
    setSelectedDevice,
    normalizeDeviceId,
    saveLastHidDevice,
    loadLastHidDevice,
    requestDevice,
    identifyDeviceType,
    autoConnect,
    connect,
    ensureProtocolLoaded,
    whenProtocolReady,
  };

  window.DeviceRuntime = DeviceRuntime;
  try { void DeviceRuntime.whenProtocolReady(); } catch (_) {}
})();
