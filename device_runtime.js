(() => {
  "use strict";

  const STORAGE_KEY = "device.selected";
  const VALID = new Set(["chaos", "rapoo", "atk"]);

  // ============================================================
  // 设备注册表
  // 定义各设备类型的识别规则和 WebHID 过滤器配置
  // ============================================================
  const DEVICE_REGISTRY = [
    {
      type: "rapoo",
      label: "Rapoo",
      // 识别条件：雷柏厂商 ID 且包含厂商自定义 Usage Page
      match: (d) => d.vendorId === 0x24ae && d.collections.some(c => c.usagePage === 0xff00),
      filters: [
        // 仅匹配 Usage 14 或 15 的厂商集合（用于协议通信）
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 14 },
        { vendorId: 0x24ae, usagePage: 0xff00, usage: 15 }
      ]
    },
    
    {
      type: "atk",
      label: "ATK",
      // 识别条件：ATK 厂商 ID 且包含指定的厂商集合（Usage Page 0xFF02, Usage 0x0002）
      match: (d) =>
        d.vendorId === 0x373b &&
        Array.isArray(d.collections) &&
        d.collections.some((c) => Number(c.usagePage) === 0xff02 && Number(c.usage) === 0x0002),
      filters: [
        // ATK 厂商集合过滤器
        { vendorId: 0x373b, usagePage: 0xff02, usage: 0x0002 },
      ],
    },
    {
      type: "chaos",
      label: "Chaos",
      // 识别条件：Chaos 厂商 ID
      match: (d) => d.vendorId === 0x1915,
      filters: [
        // 优先匹配 Vendor Collection（Usage Page 0xFF0A），用于设备配置写入
        { vendorId: 0x1915, usagePage: 65290 }, 
        // 兼容其他 Vendor Usage Page
        { vendorId: 0x1915, usagePage: 65280 },

      ]
    }
  ];

  function getSelectedDevice() {
    const v = (localStorage.getItem(STORAGE_KEY) || "chaos").toLowerCase();
    return VALID.has(v) ? v : "chaos";
  }

  function setSelectedDevice(device, { reload = true } = {}) {
    const v = String(device || "").toLowerCase();
    const next = VALID.has(v) ? v : "chaos";
    // 仅在设备类型实际变更时执行持久化和页面刷新
    if (next !== getSelectedDevice()) {
        try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
        if (reload) {
          try { location.reload(); } catch (_) {}
        }
    }
  }

  function _scriptExists(src) {
    return Array.from(document.scripts).some((s) => (s.src || "").includes(src));
  }

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

  const DeviceRuntime = {
    getSelectedDevice,
    setSelectedDevice,

    /**
     * 请求 HID 设备
     * 聚合所有设备类型的过滤器，通过 WebHID API 请求用户选择设备
     * @returns {Promise<HIDDevice|null>} 用户选择的设备对象，取消时返回 null
     */
    async requestDevice() {
      if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID");
      
      const allFilters = DEVICE_REGISTRY.flatMap(entry => entry.filters);
      // 对过滤器进行去重处理，避免重复请求相同设备
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
    },

    /**
     * 识别设备类型
     * 根据设备的厂商 ID 和集合特征匹配注册表中的设备类型
     * @param {HIDDevice} device - HID 设备对象
     * @returns {string|null} 设备类型（"chaos" | "rapoo" | "atk"），未匹配时返回 null
     */
    identifyDeviceType(device) {
      if (!device) return null;
      for (const entry of DEVICE_REGISTRY) {
        if (entry.match(device)) return entry.type;
      }
      return null;
    },

    /**
     * 确保协议脚本已加载
     * 根据当前选中的设备类型动态加载对应的协议 API 脚本
     * @returns {Promise<{device: string, ProtocolApi: Object}>} 设备类型和协议 API 对象
     * @throws {Error} 当协议脚本加载失败或未正确导出 ProtocolApi 时抛出错误
     */
    async ensureProtocolLoaded() {
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
        throw new Error("ProtocolApi 初始化失败：协议脚本未正确导出 window.ProtocolApi");
      }

      return {
        device,
        ProtocolApi: window.ProtocolApi,
      };
    },

    /**
     * 获取协议就绪 Promise
     * 返回协议加载的 Promise，确保多次调用返回同一个 Promise 实例（单例模式）
     * @returns {Promise<{device: string, ProtocolApi: Object}>} 协议加载 Promise
     */
    whenProtocolReady() {
      if (!this.__p) {
        this.__p = this.ensureProtocolLoaded();
      }
      return this.__p;
    },
  };

  window.DeviceRuntime = DeviceRuntime;
  try { void DeviceRuntime.whenProtocolReady(); } catch (_) {}
})();
