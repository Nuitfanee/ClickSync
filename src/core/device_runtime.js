/**
 * Runtime layer: WebHID discovery and protocol bootstrap orchestration.
 *
 * Scope in this file:
 * - Persist selected device id and last HID metadata.
 * - Identify device type from HID fingerprint (vendor/product/usage signatures).
 * - Build connect candidates for manual and auto connect.
 * - Load selected protocol script and expose readiness promise.
 *
 * Out of scope in this file:
 * - No DOM/UI rendering.
 * - No profile key mapping or value transforms (handled by refactor.core/profiles).
 * - No feature read/write business logic (handled by app.js + DeviceWriter/Reader).
 *
 * Startup chain:
 * 1) app.js calls DeviceRuntime.whenProtocolReady().
 * 2) ensureProtocolLoaded() injects protocol_api_* and resolves ProtocolApi.
 * 3) app.js calls DeviceRuntime.connect(...) to get detectedType + candidates.
 * 4) app.js performs bootstrapSession() handshake and drives UI.
 *
 * New device onboarding in runtime:
 * 1) Add id to VALID.
 * 2) Add matcher + request filters in DEVICE_REGISTRY.
 * 3) Add vid/pid fallback in _inferTypeByVidPid when necessary.
 * 4) Add script path branch in ensureProtocolLoaded().
 * 5) Add profile in refactor.profiles.js (runtime only identifies and loads protocol).
 */

// ============================================================
// 1) Constants and device registry (hardware fingerprints)
// ============================================================
(() => {
  "use strict";

  const STORAGE_KEY = "device.selected";
  const LAST_HID_KEY = "mouse.lastHid";
  const DEFAULT_DEVICE_ID = "chaos";
  const VALID_DEVICE_IDS = Object.freeze(["chaos", "rapoo", "atk", "ninjutso", "logitech", "razer"]);
  const VALID = new Set(VALID_DEVICE_IDS);
  const PROTOCOL_SCRIPT_BY_DEVICE = Object.freeze({
    chaos: "./src/protocols/protocol_api_chaos.js",
    rapoo: "./src/protocols/protocol_api_rapoo.js",
    atk: "./src/protocols/protocol_api_atk.js",
    ninjutso: "./src/protocols/protocol_api_ninjutso.js",
    logitech: "./src/protocols/protocol_api_logitech.js",
    razer: "./src/protocols/protocol_api_razer.js",
  });
  const ATK_VENDOR_IDS = new Set([0x373b, 0x3710]);
  const NINJUTSO_VENDOR_ID = 0x093a;
  const NINJUTSO_PRODUCT_ID = 0xeb02;
  const NINJUTSO_ALLOWED_NAME = "ninjutso sora v3";
  const RAZER_VENDOR_ID = 0x1532;
  const RAZER_SUPPORTED_PIDS = new Set([0x00b3, 0x00b6, 0x00b7, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00e5, 0x00e6]);
  const RAZER_DEFAULT_CONTROL_USAGE_PAGE = 0x0c;

  function _isRazerSupportedVidPid(d) {
    return (
      Number(d?.vendorId) === RAZER_VENDOR_ID
      && RAZER_SUPPORTED_PIDS.has(Number(d?.productId))
    );
  }

  function _normalizeHidProductName(name) {
    return String(name || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function _walkHidCollections(collections, visit) {
    for (const collection of (Array.isArray(collections) ? collections : [])) {
      visit(collection);
      if (Array.isArray(collection?.children) && collection.children.length) {
        _walkHidCollections(collection.children, visit);
      }
    }
  }

  function _countHidReports(d, reportKey) {
    if (Array.isArray(d?.[reportKey]) && d[reportKey].length) return d[reportKey].length;
    let count = 0;
    _walkHidCollections(d?.collections, (collection) => {
      if (Array.isArray(collection?.[reportKey])) count += collection[reportKey].length;
    });
    return count;
  }

  function _hasFeatureReports(d) {
    return _countHidReports(d, "featureReports") > 0;
  }

  function _hasInputReports(d) {
    return _countHidReports(d, "inputReports") > 0;
  }

  function _getRazerTransportMeta(productId) {
    const getter = window.ProtocolApi?.RAZER_HID?.getTransportMeta;
    if (typeof getter !== "function") return null;
    try {
      const meta = getter(productId);
      if (!meta || typeof meta !== "object") return null;
      return {
        pid: Number(meta?.pid ?? productId ?? 0),
        name: String(meta?.name || ""),
        modelKey: String(meta?.modelKey || ""),
        transportRole: meta?.transportRole ? String(meta.transportRole) : null,
        bodyPid: Number.isFinite(Number(meta?.bodyPid)) ? Number(meta.bodyPid) : null,
        donglePid: Number.isFinite(Number(meta?.donglePid)) ? Number(meta.donglePid) : null,
        webhidFeatureReportId: Number.isFinite(Number(meta?.webhidFeatureReportId))
          ? Number(meta.webhidFeatureReportId)
          : 0,
        featureReportId: Number.isFinite(Number(meta?.featureReportId)) ? Number(meta.featureReportId) : null,
        eventReportId: Number.isFinite(Number(meta?.eventReportId)) ? Number(meta.eventReportId) : null,
        controlUsagePage: Number.isFinite(Number(meta?.controlUsagePage))
          ? Number(meta.controlUsagePage)
          : RAZER_DEFAULT_CONTROL_USAGE_PAGE,
      };
    } catch (_) {
      return null;
    }
  }

  function _sameRazerSummaryModel(a, b) {
    if (!a || !b) return false;
    if (a.modelKey && b.modelKey) return a.modelKey === b.modelKey;
    if (Number(a.productId) !== Number(b.productId)) return false;
    const aName = _normalizeHidProductName(a.productName);
    const bName = _normalizeHidProductName(b.productName);
    if (aName && bName) return aName === bName;
    return true;
  }

  function _isRazerOfficialControlShape(summary) {
    return !!(
      summary
      && summary.singleCollection
      && Number(summary.usagePage) === Number(summary.controlUsagePage)
    );
  }

  function _isRazerOfficialEventHandle(summary) {
    return !!summary?.officialEventCandidate;
  }

  function _isRazerOfficialControlCandidate(summary) {
    return !!(
      _isRazerOfficialControlShape(summary)
      && Number(summary?.firstCollectionFeatureReportCount ?? 0) > 0
    );
  }

  function _prefersRazerSharedEventHandle(summary) {
    if (_isRazerOfficialControlShape(summary)) {
      return Number(summary?.firstCollectionInputReportCount ?? 0) > 0;
    }
    return !!summary?.hasInputReports;
  }

  function _pickPreferredRazerRequestedDevice(devices) {
    const handles = _filterDevicesByType(devices, "razer").map((device) => ({
      device,
      summary: _buildRazerHandleSummary(device),
    }));
    const preferred = handles.find((item) => _isRazerOfficialControlShape(item.summary));
    return preferred?.device || null;
  }

  function _pickRazerOfficialControlHandle(handles, primaryDevice = null) {
    const primaryHandle = primaryDevice
      ? handles.find((item) => item.device === primaryDevice) || null
      : null;
    if (primaryHandle && _isRazerOfficialControlCandidate(primaryHandle.summary)) {
      return primaryHandle;
    }
    return (
      handles.find((item) => _isRazerOfficialControlCandidate(item.summary))
      || null
    );
  }

  function _pickRazerOfficialEventHandle(handles, controlHandle) {
    if (!controlHandle) return null;
    const controlSummary = controlHandle.summary;
    if (_prefersRazerSharedEventHandle(controlSummary)) {
      return controlHandle;
    }
    return (
      handles.find((item) => (
        item.device !== controlHandle.device
        && _isRazerOfficialEventHandle(item.summary)
        && _sameRazerSummaryModel(item.summary, controlSummary)
      ))
      || null
    );
  }

  function _buildRazerHandleSummary(d) {
    const collections = Array.isArray(d?.collections) ? d.collections : [];
    const firstCollection = collections[0] || null;
    const featureReportCount = _countHidReports(d, "featureReports");
    const inputReportCount = _countHidReports(d, "inputReports");
    const transportMeta = _getRazerTransportMeta(d?.productId);
    const firstCollectionFeatureReportCount = Array.isArray(firstCollection?.featureReports)
      ? firstCollection.featureReports.length
      : 0;
    const firstCollectionInputReportCount = Array.isArray(firstCollection?.inputReports)
      ? firstCollection.inputReports.length
      : 0;
    const controlUsagePage = Number.isFinite(Number(transportMeta?.controlUsagePage))
      ? Number(transportMeta.controlUsagePage)
      : RAZER_DEFAULT_CONTROL_USAGE_PAGE;
    const usagePage = Number(firstCollection?.usagePage ?? NaN);
    const officialControlCandidate = (
      collections.length === 1
      && usagePage === controlUsagePage
      && firstCollectionFeatureReportCount > 0
    );
    const officialEventCandidate = (
      collections.length > 1
      && inputReportCount > 0
      && String(d?.productName || "").trim().length > 0
    );
    return {
      vendorId: Number(d?.vendorId ?? 0),
      productId: Number(d?.productId ?? 0),
      productName: String(d?.productName || ""),
      collectionCount: collections.length,
      usagePage,
      usage: Number(firstCollection?.usage ?? NaN),
      singleCollection: collections.length === 1,
      firstCollectionFeatureReportCount,
      firstCollectionInputReportCount,
      featureReportCount,
      inputReportCount,
      hasFeatureReports: featureReportCount > 0,
      hasInputReports: inputReportCount > 0,
      controlUsagePage,
      webhidFeatureReportId: transportMeta?.webhidFeatureReportId ?? 0,
      officialControlCandidate,
      officialEventCandidate,
      modelKey: transportMeta?.modelKey || "",
      transportRole: transportMeta?.transportRole || null,
      bodyPid: transportMeta?.bodyPid ?? null,
      donglePid: transportMeta?.donglePid ?? null,
      featureReportId: transportMeta?.featureReportId ?? null,
      eventReportId: transportMeta?.eventReportId ?? null,
    };
  }

  function _sameRazerModel(a, b) {
    if (!_isRazerSupportedVidPid(a) || !_isRazerSupportedVidPid(b)) return false;
    return _sameRazerSummaryModel(_buildRazerHandleSummary(a), _buildRazerHandleSummary(b));
  }

  function _formatRazerHandleRef(d) {
    const vid = Number(d?.vendorId ?? 0) & 0xffff;
    const pid = Number(d?.productId ?? 0) & 0xffff;
    return `0x${vid.toString(16).padStart(4, "0")}:0x${pid.toString(16).padStart(4, "0")}`;
  }

  function _formatRazerUsagePage(usagePage) {
    return Number.isFinite(Number(usagePage))
      ? `0x${Math.trunc(Number(usagePage)).toString(16)}`
      : "n/a";
  }

  function _buildRazerDebugLabel(controlSummary, eventSummary, eventMode) {
    const controlLabel = `${_formatRazerHandleRef(controlSummary)} ctrl[c=${controlSummary.collectionCount},up=${_formatRazerUsagePage(controlSummary.usagePage)},rid=${Number(controlSummary.webhidFeatureReportId ?? 0)},ff=${Number(controlSummary.firstCollectionFeatureReportCount ?? 0)},fi=${Number(controlSummary.firstCollectionInputReportCount ?? 0)},f=${controlSummary.hasFeatureReports ? "y" : "n"},i=${controlSummary.hasInputReports ? "y" : "n"}]`;
    if (eventMode === "shared") return `${controlLabel} evt=shared`;
    return `${controlLabel} evt=${_formatRazerHandleRef(eventSummary)}[c=${eventSummary.collectionCount},up=${_formatRazerUsagePage(eventSummary.usagePage)},fi=${Number(eventSummary.firstCollectionInputReportCount ?? 0)},i=${eventSummary.hasInputReports ? "y" : "n"}]`;
  }

  function _buildRazerConnectionPlanError(code, handleSummaries = []) {
    const messageByCode = {
      MISSING_RAZER_CONTROL_INTERFACE: "Missing Razer control interface",
      MISSING_RAZER_BODY_CONTROL_INTERFACE: "Missing Razer body control interface for paired mouse model",
      MISSING_RAZER_EVENT_INTERFACE: "Missing Razer event interface with input reports",
    };
    return {
      code,
      message: messageByCode[code] || "Failed to resolve Razer connection plan",
      handleSummaries: Array.isArray(handleSummaries) ? handleSummaries.slice(0) : [],
    };
  }

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

  function _isRazerDevice(d) {
    return _isRazerSupportedVidPid(d);
  }

  function _isAllowedNinjutsoName(d) {
    return String(d?.productName || "").trim().toLowerCase() === NINJUTSO_ALLOWED_NAME;
  }

  function _passesConnectionFilter(d) {
    const vid = Number(d?.vendorId);
    const pid = Number(d?.productId);
    if (vid === NINJUTSO_VENDOR_ID && pid === NINJUTSO_PRODUCT_ID) {
      return _isAllowedNinjutsoName(d);
    }
    return true;
  }

  function _isNinjutsoDevice(d) {
    if (Number(d?.vendorId) !== NINJUTSO_VENDOR_ID || Number(d?.productId) !== NINJUTSO_PRODUCT_ID) return false;
    if (!_isAllowedNinjutsoName(d)) return false;
    // Some browsers/firmwares may not expose vendor pages consistently on first read.
    if (!Array.isArray(d?.collections) || !d.collections.length) return true;
    return d.collections.some((c) => {
      const page = Number(c?.usagePage);
      return page === 0xff01 || page === 0xff00;
    });
  }

  /**
   * DEVICE_REGISTRY defines hardware fingerprints for device-type identification.
   * Purpose: identify device type without UI participation.
   * Matching is based on vendor/product ID and usagePage/usage signatures.
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
      type: "ninjutso",
      label: "NINJUTSO",
      match: _isNinjutsoDevice,
      filters: [
        { vendorId: NINJUTSO_VENDOR_ID, productId: NINJUTSO_PRODUCT_ID, usagePage: 0xff01 },
        { vendorId: NINJUTSO_VENDOR_ID, productId: NINJUTSO_PRODUCT_ID, usagePage: 0xff00 },
        { vendorId: NINJUTSO_VENDOR_ID, productId: NINJUTSO_PRODUCT_ID },
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
    {
      type: "razer",
      label: "Razer",
      match: _isRazerDevice,
      filters: Array.from(RAZER_SUPPORTED_PIDS, (productId) => ({
        vendorId: RAZER_VENDOR_ID,
        productId,
        usagePage: RAZER_DEFAULT_CONTROL_USAGE_PAGE,
      })),
    },
  ];

  // ============================================================
  // 2) Selection and persistence
  // ============================================================
  /**
   * Normalize device ID.
   * Purpose: unify entrypoint and eliminate aliases to prevent state drift.
   *
   * @param {string} id - Device identifier.
   * @returns {string} Normalized device identifier.
   */
  const normalizeDeviceId = (id) => {
    const x = String(id || "").trim().toLowerCase();
    return VALID.has(x) ? x : DEFAULT_DEVICE_ID;
  };

  /**
   * Get currently selected device.
   * Purpose: keep a single read entrypoint and consistent UI/Runtime state.
   *
   * @returns {string} Device identifier.
   */
  function getSelectedDevice() {
    return normalizeDeviceId(localStorage.getItem(STORAGE_KEY) || DEFAULT_DEVICE_ID);
  }

  /**
   * Set current selected device and trigger reload if needed.
   * Purpose: refresh UI/protocol binding on device switch to keep state consistent.
   *
   * @param {string} device - Device identifier.
   * @param {Object} [opts]
   * @param {boolean} [opts.reload=true] - Whether to reload the page.
   * @returns {void} No return value.
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
   * Save metadata for the most recently connected HID device.
   * Purpose: provide preferred matching input for auto-connect and reduce repeated permission prompts.
   *
   * @param {HIDDevice} dev - HID device instance.
   * @returns {void} No return value.
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
   * Load the last connected HID device info.
   * Purpose: improve auto-connect hit rate using historical selection.
   *
   * @returns {Object|null} Device summary info.
   */
  function loadLastHidDevice() {
    try {
      return JSON.parse(localStorage.getItem(LAST_HID_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  // ============================================================
  // 3) Low-level helpers (script loading)
  // ============================================================
  /**
   * Check whether protocol script already exists.
   * Purpose: avoid side effects from duplicate script injection.
   *
   * @param {string} src - Script path.
   * @returns {boolean} Whether it already exists.
   */
  function _scriptExists(src) {
    try {
      const target = new URL(src, document.baseURI);
      const targetVersion = target.searchParams.get("v") || "";
      return Array.from(document.scripts).some((s) => {
        if (!s?.src) return false;
        const existing = new URL(s.src, document.baseURI);
        return (
          existing.origin === target.origin
          && existing.pathname === target.pathname
          && (existing.searchParams.get("v") || "") === targetVersion
        );
      });
    } catch (_) {
      return Array.from(document.scripts).some((s) => (s.src || "").includes(src));
    }
  }

  /**
   * Dynamically load protocol script.
   * Purpose: load on demand to reduce initial page cost and isolate protocol differences.
   *
   * @param {string} src - Script path.
   * @returns {Promise<void>} Promise resolved when loading completes.
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

  const __protocolApiCache = new Map();
  let __protocolReadyPromise = null;
  let __protocolReadyDevice = "";

  function _getAssetVersion() {
    return String(window.__APP_ASSET_VERSION__ || "").trim();
  }

  function _withAssetVersion(src) {
    const version = _getAssetVersion();
    if (!version) return src;
    try {
      const url = new URL(src, document.baseURI);
      url.searchParams.set("v", version);
      return url.toString();
    } catch (_) {
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}v=${encodeURIComponent(version)}`;
    }
  }

  function _withRuntimeSwitch(src) {
    try {
      const url = new URL(src, document.baseURI);
      url.searchParams.set("__runtime_switch", String(Date.now()));
      return url.toString();
    } catch (_) {
      const sep = src.includes("?") ? "&" : "?";
      return `${src}${sep}__runtime_switch=${Date.now()}`;
    }
  }

  function _getProtocolScriptSrc(device) {
    const normalized = normalizeDeviceId(device);
    return _withAssetVersion(PROTOCOL_SCRIPT_BY_DEVICE[normalized] || PROTOCOL_SCRIPT_BY_DEVICE.chaos);
  }

  // ============================================================
  // 4) Hardcoded candidate filtering (no score-based sorting)
  // ============================================================
  function _filterDevicesByType(devices, type) {
    const list = Array.isArray(devices) ? devices : [];
    if (type === "rapoo") return list.filter(_isRapooDevice);
    if (type === "atk") return list.filter(_isAtkDevice);
    if (type === "ninjutso") return list.filter(_isNinjutsoDevice);
    if (type === "chaos") return list.filter(_isChaosDevice);
    if (type === "logitech") return list.filter(_isLogitechDevice);
    if (type === "razer") return list.filter(_isRazerDevice);
    return [];
  }

  function _filterKnownDevices(devices) {
    const list = Array.isArray(devices) ? devices : [];
    return list.filter((d) => (
      _isRapooDevice(d)
      || _isAtkDevice(d)
      || _isNinjutsoDevice(d)
      || _isChaosDevice(d)
      || _isLogitechDevice(d)
      || _isRazerDevice(d)
    ));
  }

  /**
   * Collect and filter candidate device list.
   * Purpose: remove non-target devices strictly via hardcoded filters,
   * without generic score-based ranking.
   *
   * @param {HIDDevice|null} primary - Primary device candidate.
   * @param {string|null} preferType - Preferred type.
   * @param {Object} [opts]
   * @param {boolean} [opts.pinPrimary=false] - Whether to pin primary device first.
   * @returns {Promise<HIDDevice[]>} Filtered device list.
   */
  async function _collectAuthorizedDevices({ primary = null, extraDevices = [] } = {}) {
    const uniq = [];
    const push = (d) => {
      if (!d) return;
      if (!_passesConnectionFilter(d)) return;
      if (uniq.includes(d)) return;
      uniq.push(d);
    };

    push(primary);
    for (const d of (Array.isArray(extraDevices) ? extraDevices : [])) push(d);

    try {
      const devs = await navigator.hid.getDevices();
      for (const d of (devs || [])) push(d);
    } catch (_) {}

    return uniq;
  }

  async function _collectCandidatesByFilter(primary, preferType, { pinPrimary = false } = {}) {
    const uniq = await _collectAuthorizedDevices({ primary });

    const t = preferType ? String(preferType).toLowerCase() : null;
    let list = [];
    if (t) {
      list = _filterDevicesByType(uniq, t);
      if (!list.length) list = _filterKnownDevices(uniq);
    } else {
      list = _filterKnownDevices(uniq);
    }

    if (pinPrimary && primary) {
      if (!list.includes(primary)) return [primary, ...list];
      return [primary, ...list.filter((d) => d !== primary)];
    }
    return list;
  }

  function resolveRazerConnectionPlans(devices, { primaryDevice = null } = {}) {
    const allHandles = _filterDevicesByType(devices, "razer").map((device, index) => ({
      device,
      index,
      summary: _buildRazerHandleSummary(device),
    }));
    const sameModelHandles = primaryDevice
      ? allHandles.filter((item) => _sameRazerModel(item.device, primaryDevice))
      : [];
    const handles = sameModelHandles.length ? sameModelHandles : allHandles;
    const handleSummaries = handles.map((item) => item.summary);
    const controlHandle = _pickRazerOfficialControlHandle(handles, primaryDevice);

    if (!controlHandle) {
      return {
        connectionPlans: [],
        connectionPlanError: _buildRazerConnectionPlanError("MISSING_RAZER_CONTROL_INTERFACE", handleSummaries),
      };
    }

    const eventHandle = _pickRazerOfficialEventHandle(handles, controlHandle);
    if (!eventHandle) {
      return {
        connectionPlans: [],
        connectionPlanError: _buildRazerConnectionPlanError("MISSING_RAZER_EVENT_INTERFACE", handleSummaries),
      };
    }

    const controlSummary = controlHandle.summary;
    const eventSummary = eventHandle.summary;
    const eventMode = eventHandle.device === controlHandle.device ? "shared" : "separate";

    return {
      connectionPlans: [{
        controlDevice: controlHandle.device,
        eventDevice: eventHandle.device,
        eventMode,
        debugLabel: _buildRazerDebugLabel(controlSummary, eventSummary, eventMode),
        controlSummary,
        eventSummary,
      }],
      connectionPlanError: null,
    };
  }


  // ============================================================
  // 5) Connection strategy
  // ============================================================
  /**
   * Trigger user-authorized device selection.
   * Purpose: satisfy browser permission model with user-gesture initiation.
   *
   * @returns {Promise<HIDDevice|null>} Selected device or null.
   */
  // Browser permission entrypoint for manual HID selection.
  // Maintainers: keep filter source centralized in DEVICE_REGISTRY.
  async function _requestAuthorizedDeviceSelection({ preferDifferentFrom = null } = {}) {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID");

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
    if (!Array.isArray(devices) || !devices.length) {
      return { devices: [], device: null };
    }
    const filteredDevices = devices.filter(_passesConnectionFilter);
    if (!filteredDevices.length) {
      return { devices: [], device: null };
    }

    const avoidType = preferDifferentFrom ? normalizeDeviceId(preferDifferentFrom) : null;
    if (avoidType && filteredDevices.length > 1) {
      const typed = filteredDevices.map((dev) => ({
        dev,
        type: identifyDeviceType(dev),
      }));
      const hasAvoid = typed.some((x) => x.type === avoidType);
      if (hasAvoid) {
        const preferred = typed.find((x) => x.type && x.type !== avoidType);
        if (preferred?.dev) {
          return {
            devices: filteredDevices,
            device: preferred.dev,
          };
        }
      }
    }

    const preferredRazerDevice = _pickPreferredRazerRequestedDevice(filteredDevices);
    if (preferredRazerDevice) {
      return {
        devices: filteredDevices,
        device: preferredRazerDevice,
      };
    }

    return {
      devices: filteredDevices,
      device: filteredDevices[0] || null,
    };
  }

  async function requestDevice({ preferDifferentFrom = null } = {}) {
    const selection = await _requestAuthorizedDeviceSelection({ preferDifferentFrom });
    return selection?.device || null;
  }


  function _inferTypeByVidPid(device) {
    const vid = Number(device?.vendorId);
    const pid = Number(device?.productId);
    if (vid === 0x24ae) return "rapoo";
    if (ATK_VENDOR_IDS.has(vid)) return "atk";
    if (vid === NINJUTSO_VENDOR_ID && pid === NINJUTSO_PRODUCT_ID) {
      return _isAllowedNinjutsoName(device) ? "ninjutso" : null;
    }
    if (vid === 0x1915) return "chaos";
    if (vid === 0x046d) return "logitech";
    if (vid === RAZER_VENDOR_ID && RAZER_SUPPORTED_PIDS.has(pid)) return "razer";
    return null;
  }

  /**
   * Identify device type.
   * Purpose: bind device to adapter protocol without UI-side branching.
   *
   * @param {HIDDevice} device - HID device.
   * @returns {string|null} Device type.
   */
  function identifyDeviceType(device) {
    if (!device) return null;
    for (const entry of DEVICE_REGISTRY) {
      if (entry.match(device)) return entry.type;
    }
    return _inferTypeByVidPid(device);
  }


  /**
   * Auto-connect candidate selection.
   * Purpose: pick candidates only via hardcoded filtering rules and
   * prioritize reusing existing HID handles (navigator.hid.getDevices)
   * to avoid repeated permission prompts.
   *
   * @param {Object} [args]
   * @param {string|null} [args.preferredType] - Preferred device type.
   * @returns {Promise<Object>} Device and candidate list.
   */
  // Auto-connect probe using navigator.hid.getDevices() only (no permission prompt).
  async function autoConnect({ preferredType = null } = {}) {
    if (!navigator.hid) return { device: null, candidates: [], detectedType: null };
    const candidates = await _collectCandidatesByFilter(null, preferredType);
    let device = candidates[0] || null;
    let detectedType = identifyDeviceType(device);
    let connectionPlans = null;
    let connectionPlanError = null;
    if (detectedType === "razer") {
      const authorizedDevices = await _collectAuthorizedDevices({ primary: device, extraDevices: candidates });
      const resolved = resolveRazerConnectionPlans(authorizedDevices, { primaryDevice: device });
      connectionPlans = Array.isArray(resolved?.connectionPlans) ? resolved.connectionPlans : [];
      connectionPlanError = resolved?.connectionPlanError || null;
      if (connectionPlans.length) {
        device = connectionPlans[0].controlDevice || device;
        detectedType = identifyDeviceType(device) || detectedType;
      }
    }
    return {
      device,
      candidates,
      detectedType,
      preferredType: preferredType || null,
      connectionPlans,
      connectionPlanError,
    };
  }


  /**
   * Connection flow (manual/auto with candidate fallback).
   * Purpose: provide a unified connection entrypoint and keep device branches out of UI.
   *
   * @param {boolean|Object} mode - true to trigger chooser dialog; Object to use a specific device directly.
   * @param {Object} [opts]
   * @param {Object|null} [opts.primaryDevice] - Primary device candidate.
   * @param {string|null} [opts.preferredType] - Preferred device type.
   * @param {boolean} [opts.pinPrimary] - Whether to keep primary candidate first.
   * @returns {Promise<Object>} Connection result and candidate list.
   */
  // Build connection plan for app.js handshake stage.
  // This function only selects and orders candidates; it does not open transport.
  async function connect(mode = false, { primaryDevice = null, preferredType = null, pinPrimary = false } = {}) {
    if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID");

    let primary = null;
    let chooserDevices = [];

    if (mode && typeof mode === "object" && mode.vendorId) {
      primary = mode;
    } else if (mode === true) {
      const selection = await _requestAuthorizedDeviceSelection({
        preferDifferentFrom: preferredType || getSelectedDevice(),
      });
      primary = selection?.device || null;
      chooserDevices = Array.isArray(selection?.devices) ? selection.devices : [];
    } else if (primaryDevice) {
      primary = primaryDevice;
    } else {
      const auto = await autoConnect({ preferredType });
      primary = auto.device;
    }

    if (!primary) {
      return { device: null, candidates: [], detectedType: null, preferredType: preferredType || null };
    }
    if (!_passesConnectionFilter(primary)) {
      return { device: null, candidates: [], detectedType: null, preferredType: preferredType || null };
    }

    const detectedType = identifyDeviceType(primary);
    const isManualPick = mode === true || (mode && typeof mode === "object" && mode.vendorId);
    const preferType = (
      isManualPick
        ? (detectedType || preferredType)
        : (preferredType || detectedType)
    ) || getSelectedDevice();
    const candidates = await _collectCandidatesByFilter(primary, preferType, { pinPrimary });
    let device = primary;
    let connectionPlans = null;
    let connectionPlanError = null;
    if (detectedType === "razer") {
      const authorizedDevices = await _collectAuthorizedDevices({
        primary,
        extraDevices: [...chooserDevices, ...candidates],
      });
      const resolved = resolveRazerConnectionPlans(authorizedDevices, { primaryDevice: primary });
      connectionPlans = Array.isArray(resolved?.connectionPlans) ? resolved.connectionPlans : [];
      connectionPlanError = resolved?.connectionPlanError || null;
      if (connectionPlans.length) {
        device = connectionPlans[0].controlDevice || device;
      }
    }

    return {
      device,
      candidates,
      detectedType,
      preferredType: preferType,
      connectionPlans,
      connectionPlanError,
    };
  }


  // ============================================================
  // 6) Protocol loading (dynamic by selected device)
  // ============================================================
  /**
   * Ensure selected-device protocol API is loaded.
   * Purpose: keep runtime lightweight with on-demand loading
   * and prevent premature UI binding to protocol scripts.
   *
   * @returns {Promise<{device: string, ProtocolApi: Object}>} Device and protocol object.
   */
  // Load protocol_api_* script for current selected device.
  // New device protocol onboarding must add mapping here.
  async function ensureProtocolLoaded(deviceId = null) {
    const device = normalizeDeviceId(deviceId || getSelectedDevice());
    const cachedProtocolApi = __protocolApiCache.get(device);
    if (cachedProtocolApi?.MouseMouseHidApi) {
      window.ProtocolApi = cachedProtocolApi;
      window.__DEVICE_PROTOCOL_DEVICE__ = device;
      return { device, ProtocolApi: cachedProtocolApi };
    }

    if (window.__DEVICE_PROTOCOL_DEVICE__ === device && window.ProtocolApi?.MouseMouseHidApi) {
      __protocolApiCache.set(device, window.ProtocolApi);
      return { device, ProtocolApi: window.ProtocolApi };
    }

    const src = _getProtocolScriptSrc(device);
    const prevProtocolApi = window.ProtocolApi;
    window.ProtocolApi = {};
    try {
      const loadSrc = _scriptExists(src) ? _withRuntimeSwitch(src) : src;
      await _loadScript(loadSrc);
    } catch (err) {
      window.ProtocolApi = prevProtocolApi;
      throw err;
    }

    if (!window.ProtocolApi?.MouseMouseHidApi) {
      window.ProtocolApi = prevProtocolApi;
      throw new Error("ProtocolApi 未加载，期望 window.ProtocolApi 可用");
    }

    __protocolApiCache.set(device, window.ProtocolApi);
    window.__DEVICE_PROTOCOL_DEVICE__ = device;

    return { device, ProtocolApi: window.ProtocolApi };
  }


  /**
   * Get memoized protocol-readiness promise.
   * Purpose: avoid race conditions or duplicate execution from repeated script loading.
   *
   * @returns {Promise<{device: string, ProtocolApi: Object}>} Protocol readiness result.
   */
  // Memoized readiness promise to prevent duplicate script injection races.
  function whenProtocolReady(deviceId = null) {
    const device = normalizeDeviceId(deviceId || getSelectedDevice());
    if (!__protocolReadyPromise || __protocolReadyDevice !== device) {
      __protocolReadyDevice = device;
      __protocolReadyPromise = ensureProtocolLoaded(device).catch((err) => {
        if (__protocolReadyDevice === device) {
          __protocolReadyPromise = null;
        }
        throw err;
      });
    }
    return __protocolReadyPromise;
  }

  // ============================================================
  // 7) Public runtime API
  // ============================================================
  const DeviceRuntime = {
    DEFAULT_DEVICE_ID,
    VALID_DEVICE_IDS,
    getSelectedDevice,
    setSelectedDevice,
    normalizeDeviceId,
    saveLastHidDevice,
    loadLastHidDevice,
    requestDevice,
    identifyDeviceType,
    autoConnect,
    connect,
    resolveRazerConnectionPlans,
    ensureProtocolLoaded,
    whenProtocolReady,
  };

  window.DeviceRuntime = DeviceRuntime;
  try { void DeviceRuntime.whenProtocolReady(); } catch (_) {}
})();



