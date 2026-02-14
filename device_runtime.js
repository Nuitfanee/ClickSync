
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
  const VALID = new Set(["chaos", "rapoo", "atk", "logitech"]);
  const ATK_VENDOR_IDS = new Set([0x373b, 0x3710]);

  function _isRapooDevice(d) {
    return (
      d?.vendorId === 0x24ae &&
      Array.isArray(d?.collections) &&
      d.collections.some((c) => {
        const page = Number(c?.usagePage);
        const usage = Number(c?.usage);
        return page === 0xff00 && (usage === 14 || usage === 15);
      })
    );
  }

  function _isAtkDevice(d) {
    return (
      ATK_VENDOR_IDS.has(Number(d?.vendorId)) &&
      Array.isArray(d?.collections) &&
      d.collections.some((c) => Number(c?.usagePage) === 0xff02 && Number(c?.usage) === 0x0002)
    );
  }

  function _isChaosDevice(d) {
    return (
      d?.vendorId === 0x1915 &&
      Array.isArray(d?.collections) &&
      d.collections.some((c) => {
        const page = Number(c?.usagePage);
        return page === 65290 || page === 65280;
      })
    );
  }

  function _isLogitechDevice(d) {
    return (
      d?.vendorId === 0x046d &&
      Array.isArray(d?.collections) &&
      d.collections.some((c) => {
        const page = Number(c?.usagePage);
        const usage = Number(c?.usage);
        if (page !== 0xff00) return false;
        if (!Number.isFinite(usage)) return true;
        return usage === 0x01 || usage === 0x02;
      })
    );
  }

  /**
   * DEVICE_REGISTRY 定义硬件指纹以识别设备类型。
   * 目的：在不依赖 UI 的前提下完成设备类型识别，
   * 通过 vendor/product id 与 usage page/usage 签名完成判定。
   */
  const DEVICE_REGISTRY = [
    {
      type: "rapoo",
      label: "Rapoo",

      match: _isRapooDevice,
      filters: [
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 14 },
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 15 },
      ],
    },
    {
      type: "atk",
      label: "ATK",
      match: _isAtkDevice,
      filters: [
        { vendorId: 0x373b, usagePage: 0xff02, usage: 0x0002 },
        { vendorId: 0x3710, usagePage: 0xff02, usage: 0x0002 },
      ],
    },
    {
      type: "chaos",
      label: "Chaos",
      match: _isChaosDevice,
      filters: [
        { vendorId: 0x1915, usagePage: 65290 },
        { vendorId: 0x1915, usagePage: 65280 },
      ],
    },
    {
      type: "logitech",
      label: "Logitech",
      match: _isLogitechDevice,
      filters: [
        { vendorId: 0x046d, usagePage: 0xff00, usage: 0x01 },
        { vendorId: 0x046d, usagePage: 0xff00, usage: 0x02 },
        { vendorId: 0x046d, usagePage: 0xff00 },
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
  // 3) 低层辅助（脚本加载）
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

  // ============================================================
  // 4) 硬编码过滤候选设备（不使用评分排序）
  // ============================================================
  function _filterDevicesByType(devices, type) {
    const list = Array.isArray(devices) ? devices : [];
    if (type === "rapoo") return list.filter(_isRapooDevice);
    if (type === "atk") return list.filter(_isAtkDevice);
    if (type === "chaos") return list.filter(_isChaosDevice);
    if (type === "logitech") return list.filter(_isLogitechDevice);
    return [];
  }

  function _filterKnownDevices(devices) {
    const list = Array.isArray(devices) ? devices : [];
    return list.filter((d) => _isRapooDevice(d) || _isAtkDevice(d) || _isChaosDevice(d) || _isLogitechDevice(d));
  }

  /**
   * 收集并过滤候选设备列表。
   * 目的：完全使用硬编码过滤规则剔除非目标设备，不做通用评分排序。
   *
   * @param {HIDDevice|null} primary - 主设备候选。
   * @param {string|null} preferType - 偏好类型。
   * @param {Object} [opts]
   * @param {boolean} [opts.pinPrimary=false] - 是否固定主设备优先。
   * @returns {Promise<HIDDevice[]>} 过滤后的设备列表。
   */
  async function _collectCandidatesByFilter(primary, preferType, { pinPrimary = false } = {}) {
    const uniq = [];
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

    const t = preferType ? String(preferType).toLowerCase() : null;
    let list = [];
    if (t) {
      list = _filterDevicesByType(uniq, t);
      if (!list.length) list = _filterKnownDevices(uniq);
    } else {
      list = _filterKnownDevices(uniq);
    }

    if (pinPrimary && primary && list.includes(primary)) {
      return [primary, ...list.filter((d) => d !== primary)];
    }
    return list;
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
   * 目的：仅基于硬编码过滤规则选择候选，并优先复用已有 HID 句柄
   *（navigator.hid.getDevices）以避免重复权限弹窗。
   *
   * @param {Object} [args]
   * @param {string|null} [args.preferredType] - 偏好设备类型。
   * @returns {Promise<Object>} 设备与候选列表。
   */
  async function autoConnect({ preferredType = null } = {}) {
    if (!navigator.hid) return { device: null, candidates: [], detectedType: null };
    const candidates = await _collectCandidatesByFilter(null, preferredType);
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
   * @returns {Promise<Object>} 连接结果与候选列表。
   */
  async function connect(mode = false, { primaryDevice = null, preferredType = null, pinPrimary = false } = {}) {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID。");

    let primary = null;

    if (mode && typeof mode === "object" && mode.vendorId) {
      primary = mode;
    } else if (mode === true) {
      primary = await requestDevice();
    } else if (primaryDevice) {
      primary = primaryDevice;
    } else {
      const auto = await autoConnect({ preferredType });
      primary = auto.device;
    }

    if (!primary) {
      return { device: null, candidates: [], detectedType: null, preferredType: preferredType || null };
    }

    const detectedType = identifyDeviceType(primary);
    const preferType = preferredType || detectedType || getSelectedDevice();
    const candidates = await _collectCandidatesByFilter(primary, preferType, { pinPrimary });

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
        : (device === "logitech")
          ? "./protocol_api_logitech.js"
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
