(() => {
  "use strict";

  /*
   * ============================================================
   * protocol_api_razer.js
   *
   * Goal:
   * - Production-oriented WebHID protocol driver for selected Razer mice.
   * - Keep protocol knowledge centralized and maintainable.
   * - Keep business/UI layer free from packet assembly details.
   *
   * Architecture:
   * 0) Errors & utility helpers
   * 1) PID capability model
   * 2) Transport layer (queue + send/recv + retry)
   * 3) Codec layer (90-byte Razer report)
   * 4) Value transformers
   * 5) SPEC + Planner
   * 6) Public API facade + exports
   *
   */

  // ============================================================
  // 0) Errors & basic helpers
  // ============================================================
  class ProtocolError extends Error {
    constructor(message, code = "UNKNOWN", detail = null) {
      super(message);
      this.name = "ProtocolError";
      this.code = code;
      this.detail = detail;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  const clampInt = (n, min, max) => {
    const x = Math.trunc(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.min(max, Math.max(min, x));
  };

  const clampU8 = (n) => clampInt(n, 0, 0xff);

  const clampU16 = (n) => clampInt(n, 0, 0xffff);

  const deepClone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      if (Array.isArray(v)) return v.slice(0);
      if (isObject(v)) return Object.assign({}, v);
      return v;
    }
  };

  const asciiFromBytes = (u8) => {
    if (!(u8 instanceof Uint8Array)) return "";
    let out = "";
    for (let i = 0; i < u8.length; i++) {
      const c = Number(u8[i]);
      if (c === 0x00) break;
      out += String.fromCharCode(c);
    }
    return out.trim();
  };

  const toDataViewU8 = (raw) => {
    if (raw instanceof DataView) {
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (raw instanceof Uint8Array) return raw;
    return new Uint8Array(raw || []);
  };

  // ============================================================
  // 1) Device constants & capability model
  //    - Supported VID/PID list
  //    - Feature gates by PID
  //    - Transaction-ID routing for special fields
  // ============================================================
  const RAZER_VENDOR_ID = 0x1532;
  const RAZER_REPORT_LEN = 0x5a; // 90 bytes, from RAZER_REPORT_LEN/RAZER_USB_REPORT_LEN.
  const RAZER_MAX_DPI_STAGES = 5;
  // Unified retry policy: all commands get the same BUSY retry budget.
  const RAZER_BUSY_RETRY = 10;
  // Small backoff reduces transient misalignment loops on some hosts/dongles.
  const RAZER_RETRY_BACKOFF_MS = 16;
  // When only one report-id is available, allow short retry for transient NotAllowedError.
  const RAZER_NOT_ALLOWED_SAME_ID_RETRY = 0;
  // Some wireless paths need a short settle window right after open().
  const RAZER_POST_OPEN_SETTLE_MS = 60;
  // OBM button I/O is noticeably more timing-sensitive than the rest of the
  // snapshot traffic, especially on wireless dongle paths.
  const RAZER_OBM_BUTTON_IO_WAIT_MS = 24;
  const RAZER_OBM_BUTTON_IO_RETRY = 3;
  const RAZER_OBM_BUTTON_IO_RETRY_DELAY_MS = 24;
  // Official Synapse WebHID mouse control path uses Consumer usage page.
  const RAZER_WEBHID_CONTROL_USAGE_PAGE = 0x0c;

  const PID = Object.freeze({
    HYPERPOLLING_WIRELESS_DONGLE: 0x00b3,
    DEATHADDER_V3_PRO_WIRED: 0x00b6,
    DEATHADDER_V3_PRO_WIRELESS: 0x00b7,
    VIPER_V3_PRO_WIRED: 0x00c0,
    VIPER_V3_PRO_WIRELESS: 0x00c1,
    DEATHADDER_V3_PRO_WIRED_ALT: 0x00c2,
    DEATHADDER_V3_PRO_WIRELESS_ALT: 0x00c3,
    DEATHADDER_V3_HYPERSPEED_WIRED: 0x00c4,
    DEATHADDER_V3_HYPERSPEED_WIRELESS: 0x00c5,
    VIPER_V4_PRO_WIRED: 0x00e5,
    VIPER_V4_PRO_WIRELESS: 0x00e6,
  });

  const TRANSPORT_ROLE = Object.freeze({
    SINGLE: "single",
    BODY: "body",
    DONGLE: "dongle",
    STANDALONE_DONGLE: "standalone_dongle",
  });

  const REPORT_STATUS = Object.freeze({
    NEW_COMMAND: 0x00,
    BUSY: 0x01,
    SUCCESS: 0x02,
    SUCCESSFUL: 0x02,
    FAIL: 0x03,
    FAILURE: 0x03,
    TIMEOUT: 0x04,
    NOT_SUPPORTED: 0x05,
  });

  const RAZER_CONST = Object.freeze({
    NOSTORE: 0x00,
    VARSTORE: 0x01,
    ZERO_LED: 0x00,
    SCROLL_WHEEL_LED: 0x01,
    LOGO_LED: 0x04,
    BACKLIGHT_LED: 0x05,
    RIGHT_SIDE_LED: 0x10,
    LEFT_SIDE_LED: 0x11,
    TX_DEFAULT: 0x1f,
  });

  const OFFICIAL_MOUSE_PROFILE_ID = 0x01;
  const OFFICIAL_PROXIMITY_CLASS_ID = 0x00;
  const OFFICIAL_PROXIMITY_SENSOR_ID = 0x04;
  const DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE = Object.freeze({
    smartTrackingMode: "symmetric",
    smartTrackingLevel: 1,
    smartTrackingLiftDistance: 13,
    smartTrackingLandingDistance: 12,
  });
  const DEFAULT_RAZER_SMART_TRACKING_OFFICIAL_MODEL = Object.freeze({
    isAsymmetric: false,
    trackingDistance: 2,
    liftOffDistance: 13,
    landingDistance: 12,
  });

  const OFFICIAL_BUTTON_MODE = Object.freeze({
    NORMAL: 0x00,
    HYPERSHIFT: 0x01,
  });

  const OFFICIAL_OBM_SLOT_TO_BUTTON_ID = Object.freeze({
    1: 0x01,
    2: 0x02,
    3: 0x03,
    4: 0x05,
    5: 0x04,
    6: 0x60,
  });

  const OFFICIAL_OBM_FUNCTION_ID = Object.freeze({
    OFF: 0x00,
    BUTTON_CODE: 0x01,
    KEY_CODE: 0x02,
    DPI: 0x06,
    PROFILE: 0x07,
    POWER_KEYS: 0x09,
    MEDIA_KEYS: 0x0a,
    DOUBLE_CLICK: 0x0b,
    MODE_BUTTON_KEY: 0x0c,
    TURBO_MODE_KEY: 0x0d,
    TURBO_MODE_BUTTON: 0x0e,
    RAZER_KEY: 0x11,
    SCROLL_WHEEL_MODE: 0x12,
    WIN8_SHORTCUTS_KEY: 0x15,
  });

  // Synapse Web mouse OBM button commands use a fixed data_size of 0x50 even
  // though only the first 3 or 10 argument bytes are semantically populated.
  const OFFICIAL_OBM_SINGLE_BUTTON_ASSIGNMENT_DATA_SIZE = 0x50;

  const OFFICIAL_OBM_BUTTON_TARGET = Object.freeze({
    LEFT_BUTTON: 0x01,
    RIGHT_BUTTON: 0x02,
    SCROLL_BUTTON: 0x03,
    BUTTON_4: 0x04,
    BUTTON_5: 0x05,
    SCROLL_UP: 0x09,
    SCROLL_DOWN: 0x0a,
    DPI_CYCLE_UP: 0x60,
    DPI_CYCLE_DOWN: 0x61,
  });

  const OFFICIAL_OBM_DPI_ACTION = Object.freeze({
    DPI_UP: 0x01,
    DPI_DOWN: 0x02,
    DPI_CLUTCH: 0x05,
    DPI_CYCLE_UP: 0x06,
    DPI_CYCLE_DOWN: 0x07,
  });

  const OFFICIAL_MODIFIER_BITS = Object.freeze({
    LEFT_CTRL: 0x01,
    LEFT_SHIFT: 0x02,
    LEFT_ALT: 0x04,
    LEFT_GUI: 0x08,
    RIGHT_CTRL: 0x10,
    RIGHT_SHIFT: 0x20,
    RIGHT_ALT: 0x40,
    RIGHT_GUI: 0x80,
  });

  const OFFICIAL_MEDIA_USAGE = Object.freeze({
    MUTE_VOLUME: 0x00e2,
    PREVIOUS_TRACK: 0x00b6,
    MEDIA_STOP: 0x00b7,
    NEXT_TRACK: 0x00b5,
    MEDIA_PLAY_OR_PAUSE: 0x00cd,
    VOLUME_UP: 0x00e9,
    VOLUME_DOWN: 0x00ea,
    CALCULATOR: 0x0192,
    THIS_PC: 0x0194,
    WEB_BROWSER: 0x0223,
    MAIL: 0x018a,
    MEDIA_PLAYER: 0x0183,
    WEB_BACK: 0x0224,
    WEB_FORWARD: 0x0225,
    WEB_REFRESH: 0x0227,
    WEB_FAVORITES: 0x022a,
    WEB_SEARCH: 0x0221,
  });

  const OFFICIAL_WIN8_SHORTCUT = Object.freeze({
    SCREENSHOT: 99,
    XBOX_GAME_BAR: 100,
    CYCLE_APPS: 101,
  });

  function buildPidMatrixRow(pid, name, overrides = null) {
    const normalizedPid = clampU16(pid);
    return Object.freeze(Object.assign({
      pid: normalizedPid,
      name,
      modelKey: `razer_${normalizedPid.toString(16).padStart(4, "0")}`,
      transportRole: TRANSPORT_ROLE.SINGLE,
      bodyPid: normalizedPid,
      donglePid: normalizedPid,
      webhidFeatureReportId: 0x00,
      featureReportId: 0x00,
      eventReportId: 0x00,
      controlUsagePage: RAZER_WEBHID_CONTROL_USAGE_PAGE,
      pollingMode: "legacy",
      battery: true,
      hyperpollingIndicatorMode: false,
      dynamicSensitivity: false,
      smartTracking: true,
      sensorAngle: false,
      lowThresholdTx: null,
      hyperIndicatorTx: null,
      defaultTx: RAZER_CONST.TX_DEFAULT,
    }, overrides || {}));
  }

  /*
   * Razer PID capability matrix (single source of truth)
   *
   * pid     role      feat evt polling  battery  hyperIM  dynamic  tracking  angle  name
   * 0x00b3  sdongle   00   00  v2       Y        Y        -        Y         -      HyperPolling Wireless Dongle
   * 0x00b6  body      00   00  legacy   Y        -        -        Y         -      DeathAdder V3 Pro (Wired)
   * 0x00b7  dongle    00   00  legacy   Y        -        -        Y         -      DeathAdder V3 Pro (Wireless)
   * 0x00c0  body      04   05  legacy   Y        -        Y        Y         Y      Viper V3 Pro (Wired)
   * 0x00c1  dongle    04   05  v2       Y        Y        Y        Y         Y      Viper V3 Pro (Wireless)
   * 0x00c2  body      00   00  legacy   Y        -        -        Y         -      DeathAdder V3 Pro (Wired Alt)
   * 0x00c3  dongle    00   00  legacy   Y        -        -        Y         -      DeathAdder V3 Pro (Wireless Alt)
   * 0x00c4  body      00   00  legacy   Y        -        -        Y         -      DeathAdder V3 HyperSpeed (Wired)
   * 0x00c5  dongle    00   00  legacy   Y        -        -        Y         -      DeathAdder V3 HyperSpeed (Wireless)
   * 0x00e5  body      04   05  legacy   Y        -        Y        Y         Y      Viper V4 Pro (Wired)
   * 0x00e6  dongle    04   05  v2       Y        -        Y        Y         Y      Viper V4 Pro (Wireless)
   */
  const PID_CAPABILITY_MATRIX = Object.freeze([
    buildPidMatrixRow(PID.HYPERPOLLING_WIRELESS_DONGLE, "Razer HyperPolling Wireless Dongle", {
      modelKey: "hyperpolling_wireless_dongle",
      transportRole: TRANSPORT_ROLE.STANDALONE_DONGLE,
      bodyPid: null,
      donglePid: PID.HYPERPOLLING_WIRELESS_DONGLE,
      pollingMode: "v2",
      hyperpollingIndicatorMode: true,
      hyperIndicatorTx: 0xff,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_PRO_WIRED, "Razer DeathAdder V3 Pro (Wired)", {
      modelKey: "deathadder_v3_pro",
      transportRole: TRANSPORT_ROLE.BODY,
      bodyPid: PID.DEATHADDER_V3_PRO_WIRED,
      donglePid: PID.DEATHADDER_V3_PRO_WIRELESS,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_PRO_WIRELESS, "Razer DeathAdder V3 Pro (Wireless)", {
      modelKey: "deathadder_v3_pro",
      transportRole: TRANSPORT_ROLE.DONGLE,
      bodyPid: PID.DEATHADDER_V3_PRO_WIRED,
      donglePid: PID.DEATHADDER_V3_PRO_WIRELESS,
    }),
    buildPidMatrixRow(PID.VIPER_V3_PRO_WIRED, "Razer Viper V3 Pro (Wired)", {
      modelKey: "viper_v3_pro",
      transportRole: TRANSPORT_ROLE.BODY,
      bodyPid: PID.VIPER_V3_PRO_WIRED,
      donglePid: PID.VIPER_V3_PRO_WIRELESS,
      featureReportId: 0x04,
      eventReportId: 0x05,
      dynamicSensitivity: true,
      sensorAngle: true,
    }),
    buildPidMatrixRow(PID.VIPER_V3_PRO_WIRELESS, "Razer Viper V3 Pro (Wireless)", {
      modelKey: "viper_v3_pro",
      transportRole: TRANSPORT_ROLE.DONGLE,
      bodyPid: PID.VIPER_V3_PRO_WIRED,
      donglePid: PID.VIPER_V3_PRO_WIRELESS,
      featureReportId: 0x04,
      eventReportId: 0x05,
      pollingMode: "v2",
      hyperpollingIndicatorMode: true,
      dynamicSensitivity: true,
      sensorAngle: true,
      hyperIndicatorTx: 0xff,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_PRO_WIRED_ALT, "Razer DeathAdder V3 Pro (Wired Alt)", {
      modelKey: "deathadder_v3_pro_alt",
      transportRole: TRANSPORT_ROLE.BODY,
      bodyPid: PID.DEATHADDER_V3_PRO_WIRED_ALT,
      donglePid: PID.DEATHADDER_V3_PRO_WIRELESS_ALT,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_PRO_WIRELESS_ALT, "Razer DeathAdder V3 Pro (Wireless Alt)", {
      modelKey: "deathadder_v3_pro_alt",
      transportRole: TRANSPORT_ROLE.DONGLE,
      bodyPid: PID.DEATHADDER_V3_PRO_WIRED_ALT,
      donglePid: PID.DEATHADDER_V3_PRO_WIRELESS_ALT,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_HYPERSPEED_WIRED, "Razer DeathAdder V3 HyperSpeed (Wired)", {
      modelKey: "deathadder_v3_hyperspeed",
      transportRole: TRANSPORT_ROLE.BODY,
      bodyPid: PID.DEATHADDER_V3_HYPERSPEED_WIRED,
      donglePid: PID.DEATHADDER_V3_HYPERSPEED_WIRELESS,
    }),
    buildPidMatrixRow(PID.DEATHADDER_V3_HYPERSPEED_WIRELESS, "Razer DeathAdder V3 HyperSpeed (Wireless)", {
      modelKey: "deathadder_v3_hyperspeed",
      transportRole: TRANSPORT_ROLE.DONGLE,
      bodyPid: PID.DEATHADDER_V3_HYPERSPEED_WIRED,
      donglePid: PID.DEATHADDER_V3_HYPERSPEED_WIRELESS,
    }),
    buildPidMatrixRow(PID.VIPER_V4_PRO_WIRED, "Razer Viper V4 Pro (Wired)", {
      modelKey: "viper_v4_pro",
      transportRole: TRANSPORT_ROLE.BODY,
      bodyPid: PID.VIPER_V4_PRO_WIRED,
      donglePid: PID.VIPER_V4_PRO_WIRELESS,
      featureReportId: 0x04,
      eventReportId: 0x05,
      dynamicSensitivity: true,
      sensorAngle: true,
    }),
    buildPidMatrixRow(PID.VIPER_V4_PRO_WIRELESS, "Razer Viper V4 Pro (Wireless)", {
      modelKey: "viper_v4_pro",
      transportRole: TRANSPORT_ROLE.DONGLE,
      bodyPid: PID.VIPER_V4_PRO_WIRED,
      donglePid: PID.VIPER_V4_PRO_WIRELESS,
      featureReportId: 0x04,
      eventReportId: 0x05,
      pollingMode: "v2",
      dynamicSensitivity: true,
      sensorAngle: true,
    }),
  ]);

  const PID_CAPABILITY_MATRIX_BY_PID = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, row]))
  );

  const PID_NAME = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, row.name]))
  );

  const PID_TRANSPORT_META = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, Object.freeze({
      pid: row.pid,
      name: row.name,
      modelKey: row.modelKey,
      transportRole: row.transportRole,
      bodyPid: row.bodyPid,
      donglePid: row.donglePid,
      webhidFeatureReportId: row.webhidFeatureReportId,
      featureReportId: row.featureReportId,
      eventReportId: row.eventReportId,
      controlUsagePage: row.controlUsagePage,
    })]))
  );

  const PID_FEATURE_REPORT_ID = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, row.featureReportId]))
  );

  const PID_WEBHID_FEATURE_REPORT_ID = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, row.webhidFeatureReportId]))
  );

  const PID_EVENT_REPORT_ID = Object.freeze(
    Object.fromEntries(PID_CAPABILITY_MATRIX.map((row) => [row.pid, row.eventReportId]))
  );

  const SUPPORTED_PIDS = Object.freeze(PID_CAPABILITY_MATRIX.map((row) => row.pid));
  const SUPPORTED_PID_SET = new Set(SUPPORTED_PIDS);

  const SNAPSHOT_READ_MODE = Object.freeze({
    CONNECT_FULL: "connect_full",
    REFRESH_FULL: "refresh_full",
  });

  function getWaitMsForPid(pid) {
    void pid;
    return 0;
  }

  function isPermissionPathError(err) {
    const name = String(err?.name || "");
    const msg = String(err?.message || "").toLowerCase();
    return (
      name === "NotAllowedError"
      || msg.includes("notallowederror")
      || msg.includes("failed to write the feature report")
      || msg.includes("failed to receive the feature report")
      || msg.includes("failed to read the feature report")
    );
  }

  function shouldRetryOfficialObmButtonIoError(err) {
    if (isPermissionPathError(err)) return true;
    const code = String(err?.code || "");
    return (
      code === "IO_READ_TIMEOUT"
      || code === "IO_WRITE_TIMEOUT"
      || code === "DEVICE_COMMAND_NEW_COMMAND"
      || code === "DEVICE_BUSY"
      || code === "DEVICE_COMMAND_FAILURE"
      || code === "DEVICE_COMMAND_TIMEOUT"
      || code === "RESPONSE_MISMATCH"
      || code === "RESPONSE_VALIDATION_FAILED"
    );
  }

  function buildCapabilities(pid) {
    const matrixRow = PID_CAPABILITY_MATRIX_BY_PID[pid] || null;
    return {
      supported: !!matrixRow,
      polling: true,
      pollingMode: matrixRow?.pollingMode || "legacy",
      dpi: true,
      dpiStages: true,
      battery: !!matrixRow?.battery,
      charging: !!matrixRow?.battery,
      idle: !!matrixRow?.battery,
      lowBatteryThreshold: !!matrixRow?.battery,
      lowPowerThresholdPercent: !!matrixRow?.battery,
      hyperpollingIndicatorMode: !!matrixRow?.hyperpollingIndicatorMode,
      dynamicSensitivity: !!matrixRow?.dynamicSensitivity,
      smartTracking: !!matrixRow?.smartTracking,
      sensorAngle: !!matrixRow?.sensorAngle,
    };
  }

  function txForField(pid, field) {
    const matrixRow = PID_CAPABILITY_MATRIX_BY_PID[pid] || null;
    if (
      (field === "chargeLowThreshold" || field === "lowPowerThresholdPercent")
      && matrixRow?.lowThresholdTx === 0xff
    ) return 0xff;
    if (field === "hyperpollingIndicatorMode" && matrixRow?.hyperIndicatorTx === 0xff) return 0xff;
    return matrixRow?.defaultTx ?? RAZER_CONST.TX_DEFAULT;
  }

  function normalizePid(device) {
    return Number(device?.productId ?? device?.productID ?? 0);
  }

  function getTransportMetaForPid(pid) {
    return PID_TRANSPORT_META[Number(pid)] || null;
  }

  function getFeatureReportIdForPid(pid) {
    const rid = PID_FEATURE_REPORT_ID[Number(pid)];
    return Number.isFinite(rid) ? clampU8(rid) : 0x00;
  }

  function getWebHidFeatureReportIdForPid(pid) {
    const rid = PID_WEBHID_FEATURE_REPORT_ID[Number(pid)];
    return Number.isFinite(rid) ? clampU8(rid) : 0x00;
  }

  function getEventReportIdForPid(pid) {
    const rid = PID_EVENT_REPORT_ID[Number(pid)];
    return Number.isFinite(rid) ? clampU8(rid) : 0x00;
  }

  function ensureSupportedPid(pid) {
    if (!SUPPORTED_PID_SET.has(pid)) {
      throw new ProtocolError(`Unsupported Razer PID: 0x${clampU16(pid).toString(16).padStart(4, "0")}`, "UNSUPPORTED_DEVICE", {
        pid,
        supportedPids: SUPPORTED_PIDS.slice(0),
      });
    }
    return pid;
  }

  class SendQueue {
    constructor() {
      this._p = Promise.resolve();
    }

    enqueue(task) {
      this._p = this._p.then(task, task);
      return this._p;
    }
  }

  // ============================================================
  // 2) Transport layer (Feature Report I/O)
  //    - Serial execution via queue
  //    - Timeout protection
  //    - Busy retry on a fixed report-id path
  // ============================================================
  class UniversalHidDriver {
    constructor() {
      this.device = null;
      this.productId = 0;
      this.queue = new SendQueue();
      this.sendTimeoutMs = 1500;
      this.readTimeoutMs = 1500;
      this._featureReportIds = [0];
      this._transactionId = 0;
    }

    setDevice(device, productId = 0) {
      this.device = device || null;
      this.productId = Number(productId || 0);
      this._featureReportIds = this._collectFeatureReportIds();
      this._transactionId = 0;
    }

    _requireOpenDevice() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("HID device is not opened", "NOT_OPEN");
    }

    _collectFeatureReportIds() {
      // Official Synapse WebHID mouse path uses reportId 0 for feature I/O.
      // The model-level feature/event report ids remain available as semantic metadata.
      return [getWebHidFeatureReportIdForPid(this.productId)];
    }

    _nextTransactionId() {
      // Match rzDevice25: return current counter, then increment, and wrap before 31.
      if (this._transactionId === 31) this._transactionId = 0;
      const tx = this._transactionId;
      this._transactionId += 1;
      return clampU8(tx);
    }

    _prepareRequestBytes(packet) {
      const raw = packet instanceof Uint8Array
        ? ProtocolCodec.fitReport(packet)
        : ProtocolCodec.encodeRazerReport(packet || {});
      const currentTx = clampU8(raw[1] ?? 0);
      if (currentTx === 0xff) return new Uint8Array(raw);
      return ProtocolCodec.withTransactionId(raw, this._nextTransactionId());
    }

    async _withTimeout(promise, timeoutMs, code, message) {
      return await Promise.race([
        promise,
        sleep(timeoutMs).then(() => {
          throw new ProtocolError(message, code, { timeoutMs });
        }),
      ]);
    }

    async _sendFeature(reportId, payload) {
      this._requireOpenDevice();
      await this._withTimeout(
        this.device.sendFeatureReport(Number(reportId), payload),
        this.sendTimeoutMs,
        "IO_WRITE_TIMEOUT",
        `sendFeatureReport timeout (${this.sendTimeoutMs}ms)`
      );
    }

    async _recvFeature(reportId) {
      this._requireOpenDevice();
      const raw = await this._withTimeout(
        this.device.receiveFeatureReport(Number(reportId)),
        this.readTimeoutMs,
        "IO_READ_TIMEOUT",
        `receiveFeatureReport timeout (${this.readTimeoutMs}ms)`
      );
      return toDataViewU8(raw);
    }

    /**
     * Send one official Razer command frame and wait for a matching response.
     * Matching rule follows Synapse Web: transactionId + commandClass + commandId.
     */
    async sendAndWait(packet, opts = {}) {
      return this.queue.enqueue(async () => {
        this._requireOpenDevice();

        const requestBytes = this._prepareRequestBytes(packet);
        const request = ProtocolCodec.parseRazerReport(requestBytes);

        const reportId = Number(this._featureReportIds[0] ?? getWebHidFeatureReportIdForPid(this.productId));

        const retryBudget = RAZER_BUSY_RETRY;
        const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : getWaitMsForPid(this.productId);
        const responseValidator = typeof opts.responseValidator === "function"
          ? opts.responseValidator
          : null;

        let lastErr = null;

        for (let attempt = 0; attempt <= retryBudget; attempt++) {
          try {
            await this._sendFeature(reportId, requestBytes);
            if (waitMs > 0) await sleep(waitMs);

            const raw = await this._recvFeature(reportId);
            const responseBytes = ProtocolCodec.fitReport(raw);
            const response = ProtocolCodec.parseRazerReport(responseBytes);

            if (!ProtocolCodec.matchResponse(request, response)) {
              throw new ProtocolError("Response does not match request", "RESPONSE_MISMATCH", {
                reportId,
                expected: {
                  transactionId: request.transactionId,
                  commandClass: request.commandClass,
                  commandId: request.commandId,
                },
                got: {
                  transactionId: response.transactionId,
                  commandClass: response.commandClass,
                  commandId: response.commandId,
                },
              });
            }

            if (responseValidator && !responseValidator(request, response)) {
              throw new ProtocolError("Response validator rejected packet", "RESPONSE_VALIDATION_FAILED", {
                reportId,
                commandClass: response.commandClass,
                commandId: response.commandId,
              });
            }

            switch (response.status) {
              case REPORT_STATUS.SUCCESS:
              case REPORT_STATUS.SUCCESSFUL:
                return response;
              case REPORT_STATUS.NEW_COMMAND:
                throw new ProtocolError("Razer device returned NEW_COMMAND", "DEVICE_COMMAND_NEW_COMMAND", {
                  reportId,
                  response,
                });
              case REPORT_STATUS.BUSY:
                throw new ProtocolError("Razer device returned BUSY", "DEVICE_BUSY", {
                  reportId,
                  response,
                  attempts: attempt + 1,
                });
              case REPORT_STATUS.FAIL:
              case REPORT_STATUS.FAILURE:
                throw new ProtocolError("Razer command failed", "DEVICE_COMMAND_FAILURE", {
                  reportId,
                  response,
                });
              case REPORT_STATUS.TIMEOUT:
                throw new ProtocolError("Razer command timeout status", "DEVICE_COMMAND_TIMEOUT", {
                  reportId,
                  response,
                });
              case REPORT_STATUS.NOT_SUPPORTED:
                throw new ProtocolError("Razer command not supported", "DEVICE_COMMAND_NOT_SUPPORTED", {
                  reportId,
                  response,
                });
              default:
                throw new ProtocolError("Unknown Razer command status", "DEVICE_COMMAND_UNKNOWN_STATUS", {
                  reportId,
                  response,
                });
            }
          } catch (err) {
            lastErr = err;
            const name = String(err?.name || "");
            const msg = String(err?.message || "").toLowerCase();
            const code = String(err?.code || "");

            if (
              code === "DEVICE_COMMAND_NOT_SUPPORTED"
              || code === "DEVICE_COMMAND_UNKNOWN_STATUS"
            ) {
              throw err;
            }

            const isPermissionPathErr = isPermissionPathError(err);

            if (isPermissionPathErr) {
              const permissionRetryBudget = Math.min(retryBudget, RAZER_NOT_ALLOWED_SAME_ID_RETRY);
              if (attempt >= permissionRetryBudget) throw err;
            }

            if (
              code === "IO_READ_TIMEOUT"
              || code === "DEVICE_COMMAND_NEW_COMMAND"
              || code === "DEVICE_BUSY"
              || code === "DEVICE_COMMAND_FAILURE"
              || code === "DEVICE_COMMAND_TIMEOUT"
              || code === "RESPONSE_MISMATCH"
              || code === "RESPONSE_VALIDATION_FAILED"
              || isPermissionPathErr
            ) {
              if (RAZER_RETRY_BACKOFF_MS > 0) await sleep(RAZER_RETRY_BACKOFF_MS);
              if (attempt < retryBudget) continue;
            }
            throw err;
          }
        }

        throw lastErr || new ProtocolError("sendAndWait failed", "IO_UNKNOWN");
      });
    }

    /**
     * Execute multiple commands sequentially in the same queue context.
     */
    async runSequence(commands) {
      if (!Array.isArray(commands) || commands.length === 0) return [];
      const results = [];
      for (const cmd of commands) {
        const packet = cmd?.packet ?? cmd?.report ?? cmd;
        const res = await this.sendAndWait(packet, {
          waitMs: cmd?.waitMs,
        });
        results.push(res);
      }
      return results;
    }
  }

  // ============================================================
  // 3) Codec layer
  //    - Encode/decode Razer 90-byte packets
  //    - CRC calculation
  //    - Command builders for each feature
  // ============================================================
  const ProtocolCodec = Object.freeze({
    fitReport(raw) {
      const src = toDataViewU8(raw);
      if (src.byteLength === RAZER_REPORT_LEN + 1) {
        return src.slice(1, RAZER_REPORT_LEN + 1);
      }
      if (src.byteLength === RAZER_REPORT_LEN) return src;
      const out = new Uint8Array(RAZER_REPORT_LEN);
      out.set(src.subarray(0, Math.min(src.byteLength, RAZER_REPORT_LEN)));
      return out;
    },

    withTransactionId(reportBytes, transactionId) {
      const out = new Uint8Array(ProtocolCodec.fitReport(reportBytes));
      out[1] = clampU8(transactionId);
      out[88] = ProtocolCodec.calcChecksum(out);
      return out;
    },

    calcChecksum(reportBytes) {
      const u8 = ProtocolCodec.fitReport(reportBytes);
      // razer_calculate_crc(): XOR byte[2..87].
      let crc = 0;
      for (let i = 2; i < 88; i++) crc ^= u8[i];
      return crc & 0xff;
    },

    encodeRazerReport({
      status = REPORT_STATUS.NEW_COMMAND,
      transactionId = RAZER_CONST.TX_DEFAULT,
      remainingPackets = 0x0000,
      protocolType = 0x00,
      commandClass = 0x00,
      commandId = 0x00,
      arguments: argsInput = [],
      dataSize = null,
    } = {}) {
      const args = argsInput instanceof Uint8Array ? argsInput : new Uint8Array(argsInput || []);
      if (args.length > 80) {
        throw new ProtocolError("Razer arguments length cannot exceed 80", "BAD_PARAM", { length: args.length });
      }

      const finalDataSize = dataSize == null ? args.length : clampInt(dataSize, 0, 80);
      if (finalDataSize < args.length) {
        throw new ProtocolError("dataSize cannot be smaller than argument length", "BAD_PARAM", {
          dataSize: finalDataSize,
          argsLength: args.length,
        });
      }

      const out = new Uint8Array(RAZER_REPORT_LEN);

      // struct razer_report layout from driver/razercommon.h.
      out[0] = clampU8(status);
      out[1] = clampU8(transactionId);
      out[2] = clampU8((remainingPackets >> 8) & 0xff);
      out[3] = clampU8(remainingPackets & 0xff);
      out[4] = clampU8(protocolType);
      out[5] = clampU8(finalDataSize);
      out[6] = clampU8(commandClass);
      out[7] = clampU8(commandId);
      out.set(args, 8);
      out[88] = ProtocolCodec.calcChecksum(out);
      out[89] = 0x00;

      return out;
    },

    parseRazerReport(raw) {
      const u8 = ProtocolCodec.fitReport(raw);
      const dataSize = clampInt(u8[5], 0, 80);
      return {
        status: u8[0],
        transactionId: u8[1],
        remainingPackets: ((u8[2] << 8) | u8[3]) & 0xffff,
        protocolType: u8[4],
        dataSize,
        commandClass: u8[6],
        commandId: u8[7],
        // Keep full 80-byte argument window because some drivers read fixed offsets
        // even when response data_size is smaller.
        arguments: u8.slice(8, 88),
        argumentsData: u8.slice(8, 8 + dataSize),
        crc: u8[88],
        reserved: u8[89],
        raw: u8,
      };
    },

    matchResponse(request, response) {
      const req = request?.raw ? request : ProtocolCodec.parseRazerReport(request);
      const res = response?.raw ? response : ProtocolCodec.parseRazerReport(response);
      return (
        req.transactionId === res.transactionId &&
        req.commandClass === res.commandClass &&
        req.commandId === res.commandId
      );
    },

    commands: {
      getSerial(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x00, commandId: 0x82, dataSize: 0x16 });
      },

      getFirmwareVersion(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x00, commandId: 0x81, dataSize: 0x02 });
      },

      getPollingRate(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x00, commandId: 0x85, dataSize: 0x01 });
      },

      setPollingRate(tx, pollingCode) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x00,
          commandId: 0x05,
          dataSize: 0x01,
          arguments: [clampU8(pollingCode)],
        });
      },

      getPollingRate2(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x00, commandId: 0xc0, dataSize: 0x01 });
      },

      setPollingRate2(tx, argument0, pollingCode) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x00,
          commandId: 0x40,
          dataSize: 0x02,
          arguments: [clampU8(argument0), clampU8(pollingCode)],
        });
      },

      setDpiXY(tx, dpiX, dpiY, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x05,
          dataSize: 0x07,
          arguments: [
            clampU8(profileId),
            (clampU16(dpiX) >> 8) & 0xff,
            clampU16(dpiX) & 0xff,
            (clampU16(dpiY) >> 8) & 0xff,
            clampU16(dpiY) & 0xff,
            0x00,
            0x00,
          ],
        });
      },

      getDpiXY(tx, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x85,
          dataSize: 0x07,
          arguments: [clampU8(profileId)],
        });
      },

      setDpiStages(tx, stages, activeStageIndex, profileId = OFFICIAL_MOUSE_PROFILE_ID, stageIds = null) {
        const count = clampInt(stages.length, 1, RAZER_MAX_DPI_STAGES);
        const argsLen = 3 + count * 7;
        const args = new Uint8Array(argsLen);
        args[0] = clampU8(profileId);
        const ids = Array.isArray(stageIds) ? stageIds : [];
        const resolvedStageIds = [];
        for (let i = 0; i < count; i++) {
          const fallbackId = i + 1;
          const stageId = clampU8(ids[i] ?? fallbackId);
          resolvedStageIds.push(stageId);
        }
        const activeIdx = clampInt(activeStageIndex, 0, count - 1);
        args[1] = resolvedStageIds[activeIdx] ?? resolvedStageIds[0] ?? 0x01;
        args[2] = count;

        let offset = 3;
        for (let i = 0; i < count; i++) {
          const stage = stages[i] || { x: 800, y: 800 };
          const x = clampU16(stage.x);
          const y = clampU16(stage.y);
          args[offset++] = resolvedStageIds[i];
          args[offset++] = (x >> 8) & 0xff;
          args[offset++] = x & 0xff;
          args[offset++] = (y >> 8) & 0xff;
          args[offset++] = y & 0xff;
          args[offset++] = 0x00;
          args[offset++] = 0x00;
        }

        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x06,
          // Synapse capture shows dynamic data size:
          // 3 stages -> 0x18, 4 stages -> 0x1f, 5 stages -> 0x26.
          dataSize: argsLen,
          arguments: args,
        });
      },


      getDpiStages(tx, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x86,
          dataSize: 0x26,
          arguments: [clampU8(profileId)],
        });
      },

      getSingleButtonAssignment(
        tx,
        profileId = OFFICIAL_MOUSE_PROFILE_ID,
        buttonId = 0x01,
        mode = OFFICIAL_BUTTON_MODE.NORMAL
      ) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x02,
          commandId: 0x8c,
          dataSize: OFFICIAL_OBM_SINGLE_BUTTON_ASSIGNMENT_DATA_SIZE,
          arguments: [clampU8(profileId), clampU8(buttonId), clampU8(mode)],
        });
      },

      setSingleButtonAssignment(
        tx,
        profileId = OFFICIAL_MOUSE_PROFILE_ID,
        buttonId = 0x01,
        mode = OFFICIAL_BUTTON_MODE.NORMAL,
        functionId = OFFICIAL_OBM_FUNCTION_ID.OFF,
        fnDataByteSize = 0,
        fnDataByte = null
      ) {
        const dataArray = fnDataByte instanceof Uint8Array ? fnDataByte : new Uint8Array(fnDataByte || []);
        const out = new Uint8Array(10);
        out[0] = clampU8(profileId);
        out[1] = clampU8(buttonId);
        out[2] = clampU8(mode);
        out[3] = clampU8(functionId);
        out[4] = clampInt(fnDataByteSize, 0, 5);
        out.set(dataArray.subarray(0, 5), 5);
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x02,
          commandId: 0x0c,
          dataSize: OFFICIAL_OBM_SINGLE_BUTTON_ASSIGNMENT_DATA_SIZE,
          arguments: out,
        });
      },

      getBattery(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x07, commandId: 0x80, dataSize: 0x02 });
      },

      getCharging(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x07, commandId: 0x84, dataSize: 0x02 });
      },

      getIdle(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x07, commandId: 0x83, dataSize: 0x02 });
      },

      setIdle(tx, idleSec) {
        const v = clampU16(idleSec);
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x07,
          commandId: 0x03,
          dataSize: 0x02,
          arguments: [(v >> 8) & 0xff, v & 0xff],
        });
      },

      getLowBatteryThreshold(tx) {
        return ProtocolCodec.encodeRazerReport({ transactionId: tx, commandClass: 0x07, commandId: 0x81, dataSize: 0x01 });
      },

      setLowBatteryThreshold(tx, threshold) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x07,
          commandId: 0x01,
          dataSize: 0x01,
          arguments: [clampU8(threshold)],
        });
      },

      setProximitySensorAccelerationState(tx, enabled, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x10,
          dataSize: 0x02,
          arguments: [clampU8(profileId), enabled ? 0x01 : 0x00],
        });
      },

      getProximitySensorAccelerationState(tx, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x90,
          dataSize: 0x02,
          arguments: [clampU8(profileId)],
        });
      },

      setProximitySensorAccelerationMode(tx, mode, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x11,
          dataSize: 0x02,
          arguments: [clampU8(profileId), clampInt(mode, 0, 3)],
        });
      },

      getProximitySensorAccelerationMode(tx, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x91,
          dataSize: 0x02,
          arguments: [clampU8(profileId)],
        });
      },

      setSensorAngle(tx, angle, profileId = OFFICIAL_MOUSE_PROFILE_ID, state = 0x01) {
        const a = clampInt(angle, -44, 44);
        const raw = a < 0 ? (0x100 + a) & 0xff : a & 0xff;
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x14,
          dataSize: 0x03,
          arguments: [clampU8(profileId), clampU8(state), raw],
        });
      },

      getSensorAngle(tx, profileId = OFFICIAL_MOUSE_PROFILE_ID) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x94,
          dataSize: 0x03,
          arguments: [clampU8(profileId)],
        });
      },

      setProximitySensorState(
        tx,
        classId = OFFICIAL_PROXIMITY_CLASS_ID,
        sensorId = OFFICIAL_PROXIMITY_SENSOR_ID,
        state = true
      ) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x03,
          dataSize: 0x03,
          arguments: [clampU8(classId), clampU8(sensorId), state ? 0x01 : 0x00],
        });
      },

      getProximitySensorConfiguration(
        tx,
        classId = OFFICIAL_PROXIMITY_CLASS_ID,
        sensorId = OFFICIAL_PROXIMITY_SENSOR_ID
      ) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x85,
          dataSize: 0x0a,
          arguments: [clampU8(classId), clampU8(sensorId)],
        });
      },

      setProximitySensorConfiguration(
        tx,
        classId = OFFICIAL_PROXIMITY_CLASS_ID,
        sensorId = OFFICIAL_PROXIMITY_SENSOR_ID,
        dataArray = null
      ) {
        const payload = dataArray instanceof Uint8Array ? dataArray : new Uint8Array(dataArray || []);
        const args = new Uint8Array(10);
        args[0] = clampU8(classId);
        args[1] = clampU8(sensorId);
        args.set(payload.subarray(0, 8), 2);
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x05,
          dataSize: args.length,
          arguments: args,
        });
      },

      getProximitySensorLiftSetting(
        tx,
        classId = OFFICIAL_PROXIMITY_CLASS_ID,
        sensorId = OFFICIAL_PROXIMITY_SENSOR_ID
      ) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x8b,
          dataSize: 0x04,
          arguments: [clampU8(classId), clampU8(sensorId)],
        });
      },

      setProximitySensorLiftSetting(
        tx,
        classId = OFFICIAL_PROXIMITY_CLASS_ID,
        sensorId = OFFICIAL_PROXIMITY_SENSOR_ID,
        liftMode = 0x01,
        liftHeight = 0x00
      ) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x0b,
          dataSize: 0x04,
          arguments: [clampU8(classId), clampU8(sensorId), clampU8(liftMode), clampU8(liftHeight)],
        });
      },

      setHyperpollingIndicatorMode(tx, mode) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x07,
          commandId: 0x10,
          dataSize: 0x01,
          arguments: [clampInt(mode, 1, 3)],
        });
      },

      getHyperpollingIndicatorMode(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x07,
          commandId: 0x90,
          dataSize: 0x01,
        });
      },
    },
  });

  // ============================================================
  // 4) Transformers
  //    - semantic values <-> protocol values
  //    - normalize and clamp user-facing payloads
  // ============================================================

  // Lookup tables are module-level constants to avoid repeated allocations.
  const POLLING_LEGACY_ENCODE_MAP = new Map([
    [1000, 0x01],
    [500, 0x02],
    [125, 0x08],
  ]);
  const POLLING_LEGACY_DECODE_MAP = new Map([
    [0x01, 1000],
    [0x02, 500],
    [0x08, 125],
  ]);
  const POLLING_V2_ENCODE_MAP = new Map([
    [8000, 0x01],
    [4000, 0x02],
    [2000, 0x04],
    [1000, 0x08],
    [500, 0x10],
    [250, 0x20],
    [125, 0x40],
  ]);
  const POLLING_V2_DECODE_MAP = new Map([
    [0x01, 8000],
    [0x02, 4000],
    [0x04, 2000],
    [0x08, 1000],
    [0x10, 500],
    [0x20, 250],
    [0x40, 125],
  ]);

  const TRANSFORMERS = Object.freeze({
    pollingLegacyEncode(hz) {
      const v = Number(hz);
      if (!POLLING_LEGACY_ENCODE_MAP.has(v)) {
        throw new ProtocolError(`Unsupported legacy polling rate: ${hz}`, "BAD_PARAM");
      }
      return POLLING_LEGACY_ENCODE_MAP.get(v);
    },

    pollingLegacyDecode(code) {
      return POLLING_LEGACY_DECODE_MAP.get(Number(code)) ?? 1000;
    },

    pollingV2Encode(hz) {
      const v = Number(hz);
      if (!POLLING_V2_ENCODE_MAP.has(v)) {
        throw new ProtocolError(`Unsupported v2 polling rate: ${hz}`, "BAD_PARAM");
      }
      return POLLING_V2_ENCODE_MAP.get(v);
    },

    pollingV2Decode(code) {
      return POLLING_V2_DECODE_MAP.get(Number(code)) ?? 1000;
    },

    clampDpi(dpi) {
      return clampInt(dpi, 100, 45000);
    },

    normalizeDpi(prevDpi, patch) {
      const prev = isObject(prevDpi) ? prevDpi : { x: 1600, y: 1600 };
      let x = prev.x;
      let y = prev.y;

      if (Object.prototype.hasOwnProperty.call(patch, "dpi")) {
        const raw = patch.dpi;
        if (isObject(raw)) {
          if (raw.x != null) x = raw.x;
          if (raw.X != null) x = raw.X;
          if (raw.y != null) y = raw.y;
          if (raw.Y != null) y = raw.Y;
        } else {
          x = raw;
          y = raw;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dpiX")) x = patch.dpiX;
      if (Object.prototype.hasOwnProperty.call(patch, "dpiY")) y = patch.dpiY;

      return {
        x: TRANSFORMERS.clampDpi(x),
        y: TRANSFORMERS.clampDpi(y),
      };
    },

    normalizeDpiStages(input, fallback) {
      const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
      const out = [];

      for (const item of source) {
        if (out.length >= 5) break;
        if (Number.isFinite(Number(item))) {
          const v = TRANSFORMERS.clampDpi(item);
          out.push({ x: v, y: v });
          continue;
        }
        if (isObject(item)) {
          const x = TRANSFORMERS.clampDpi(item.x ?? item.X ?? item.y ?? item.Y ?? 1600);
          const y = TRANSFORMERS.clampDpi(item.y ?? item.Y ?? item.x ?? item.X ?? x);
          out.push({ x, y });
          continue;
        }
      }

      if (!out.length) {
        out.push({ x: 800, y: 800 }, { x: 1600, y: 1600 }, { x: 3200, y: 3200 });
      }

      return out;
    },

    parseDpiStagesResponse(response) {
      const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
      const payloadSize = clampInt(response?.dataSize ?? args.length, 0, args.length);
      const declaredCount = clampInt(args[2] ?? 0, 0, RAZER_MAX_DPI_STAGES);
      const maxByPayload = Math.max(0, Math.floor(Math.max(0, payloadSize - 3) / 7));
      const count = clampInt(Math.min(declaredCount, maxByPayload), 0, RAZER_MAX_DPI_STAGES);
      const activeRaw = clampU8(args[1] ?? 0);
      const stages = [];
      const stageIds = [];
      let offset = 3;

      for (let i = 0; i < count; i++) {
        if (offset + 6 >= payloadSize) break;
        const stageId = clampU8(args[offset]);
        const x = ((args[offset + 1] << 8) | args[offset + 2]) & 0xffff;
        const y = ((args[offset + 3] << 8) | args[offset + 4]) & 0xffff;
        stages.push({ id: stageId, x: TRANSFORMERS.clampDpi(x), y: TRANSFORMERS.clampDpi(y) });
        stageIds.push(stageId);
        offset += 7;
      }

      let activeDpiStageIndex = stages.findIndex((stage) => stage.id === activeRaw);
      if (activeDpiStageIndex < 0 && activeRaw >= 1 && activeRaw <= stages.length) {
        activeDpiStageIndex = activeRaw - 1;
      } else if (activeDpiStageIndex < 0 && activeRaw < stages.length) {
        activeDpiStageIndex = activeRaw;
      }
      activeDpiStageIndex = clampInt(activeDpiStageIndex, 0, Math.max(0, stages.length - 1));

      return {
        classId: clampU8(args[0] ?? OFFICIAL_MOUSE_PROFILE_ID),
        stageIds,
        dpiStages: stages.map((stage) => ({ x: stage.x, y: stage.y })),
        activeDpiStageIndex,
      };
    },

    normalizeIdleTime(v) {
      const clamped = clampInt(v, 60, 900);
      // UI uses minute slots (1min~15min); keep protocol value aligned to 60s step.
      return clampInt(Math.round(clamped / 60) * 60, 60, 900);
    },

    toInt8Raw(v) {
      const n = clampInt(v, -128, 127);
      return n < 0 ? (0x100 + n) & 0xff : n & 0xff;
    },

    fromInt8Raw(raw) {
      const b = clampU8(raw);
      return b >= 0x80 ? b - 0x100 : b;
    },

    normalizeSensorAngle(v) {
      return clampInt(v, -44, 44);
    },

    normalizeDynamicSensitivityMode(v) {
      return clampInt(v, 0, 3);
    },

    normalizeSmartTrackingMode(v) {
      const s = String(v ?? "symmetric").trim().toLowerCase();
      if (s === "asymmetric" || s === "asym") return "asymmetric";
      return "symmetric";
    },

    normalizeSmartTrackingLevel(v) {
      return clampInt(v, 0, 2);
    },

    normalizeSmartTrackingTrackingDistance(v) {
      return clampInt(v, 1, 3);
    },

    smartTrackingLevelToTrackingDistance(v) {
      return clampInt(v, 0, 2) + 1;
    },

    trackingDistanceToSmartTrackingLevel(v) {
      return clampInt(v, 1, 3) - 1;
    },

    normalizeSmartTrackingDistances(liftDistance, landingDistance) {
      let lift = clampInt(liftDistance, 2, 26);
      let landing = clampInt(landingDistance, 1, 25);
      if (landing >= lift) {
        lift = Math.min(26, landing + 1);
        if (landing >= lift) landing = Math.max(1, lift - 1);
      }
      return { lift, landing };
    },

    normalizeLowPowerPercent(v) {
      const n = Number(v);
      const bounded = Number.isFinite(n) ? Math.min(100, Math.max(5, n)) : 5;
      return clampInt(Math.round(bounded / 5) * 5, 5, 100);
    },

    lowPowerPercentToRaw(percent) {
      const p = TRANSFORMERS.normalizeLowPowerPercent(percent);
      return clampInt(Math.ceil((p * 255) / 100), 0x0d, 0xff);
    },

    lowPowerRawToPercent(raw) {
      const r = clampInt(raw, 0x0d, 0xff);
      return TRANSFORMERS.normalizeLowPowerPercent((r * 100) / 255);
    },

    normalizeLowThreshold(v) {
      return clampInt(v, 0x0d, 0xff);
    },

    normalizeHyperIndicatorMode(v) {
      return clampInt(v, 1, 3);
    },

    batteryPercentFromRaw(raw) {
      const x = clampInt(raw, 0, 255);
      // Kernel exposes raw 0..255 at response.arguments[1]; frontend keeps percentage semantics.
      return clampInt(Math.round((x * 100) / 255), 0, 100);
    },
  });

  function normalizePublicSmartTrackingState(raw = null) {
    const seed = isObject(raw) ? raw : {};
    const mode = TRANSFORMERS.normalizeSmartTrackingMode(
      seed.smartTrackingMode ?? DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE.smartTrackingMode
    );
    const level = TRANSFORMERS.normalizeSmartTrackingLevel(
      seed.smartTrackingLevel ?? DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE.smartTrackingLevel
    );
    const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
      seed.smartTrackingLiftDistance ?? DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE.smartTrackingLiftDistance,
      seed.smartTrackingLandingDistance ?? DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE.smartTrackingLandingDistance
    );
    return {
      smartTrackingMode: mode,
      smartTrackingLevel: level,
      smartTrackingLiftDistance: dist.lift,
      smartTrackingLandingDistance: dist.landing,
    };
  }

  function buildOfficialSmartTrackingModelFromPublicState(raw = null) {
    const publicState = normalizePublicSmartTrackingState(raw);
    return {
      isAsymmetric: publicState.smartTrackingMode === "asymmetric",
      trackingDistance: TRANSFORMERS.smartTrackingLevelToTrackingDistance(publicState.smartTrackingLevel),
      liftOffDistance: publicState.smartTrackingLiftDistance,
      landingDistance: publicState.smartTrackingLandingDistance,
    };
  }

  function buildPublicSmartTrackingStateFromOfficialModel(raw = null) {
    const seed = isObject(raw) ? raw : {};
    const trackingDistance = TRANSFORMERS.normalizeSmartTrackingTrackingDistance(
      seed.trackingDistance ?? DEFAULT_RAZER_SMART_TRACKING_OFFICIAL_MODEL.trackingDistance
    );
    const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
      seed.liftOffDistance ?? DEFAULT_RAZER_SMART_TRACKING_OFFICIAL_MODEL.liftOffDistance,
      seed.landingDistance ?? DEFAULT_RAZER_SMART_TRACKING_OFFICIAL_MODEL.landingDistance
    );
    return {
      smartTrackingMode: seed.isAsymmetric ? "asymmetric" : "symmetric",
      smartTrackingLevel: TRANSFORMERS.trackingDistanceToSmartTrackingLevel(trackingDistance),
      smartTrackingLiftDistance: dist.lift,
      smartTrackingLandingDistance: dist.landing,
    };
  }

  function requireCapability(caps, capKey, featureName, pid) {
    if (!caps?.[capKey]) {
      throw new ProtocolError(
        `${featureName} is not supported for PID 0x${clampU16(pid).toString(16).padStart(4, "0")}`,
        "NOT_SUPPORTED_FOR_DEVICE",
        { featureName, pid, capability: capKey }
      );
    }
  }

  // ============================================================
  // 5) SPEC table
  //    - Describes how each semantic field maps to write commands
  //    - Priority controls write ordering
  // ============================================================
  const SPEC = Object.freeze({
    pollingHz: {
      key: "pollingHz",
      kind: "direct",
      priority: 10,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "polling", "pollingHz", pid);
        const tx = txForField(pid, "pollingHz");
        if (caps.pollingMode === "v2") {
          const code = TRANSFORMERS.pollingV2Encode(nextState.pollingHz);
          // Matches razer_attr_write_poll_rate() special double request for polling_rate2.
          return [
            { packet: ProtocolCodec.commands.setPollingRate2(tx, 0x00, code) },
            { packet: ProtocolCodec.commands.setPollingRate2(tx, 0x01, code) },
          ];
        }
        const code = TRANSFORMERS.pollingLegacyEncode(nextState.pollingHz);
        return [{ packet: ProtocolCodec.commands.setPollingRate(tx, code) }];
      },
    },

    dpi: {
      key: "dpi",
      kind: "virtual",
      priority: 20,
      triggers: ["dpi", "dpiX", "dpiY"],
      plan({ pid, caps, nextState, planner }) {
        requireCapability(caps, "dpi", "dpi/dpiX/dpiY", pid);
        const tx = txForField(pid, "dpi");
        const dpiCtx = planner?.getDpiWriteContext?.() || {};
        return [{
          packet: ProtocolCodec.commands.setDpiXY(
            tx,
            nextState.dpi.x,
            nextState.dpi.y,
            dpiCtx.profileId ?? OFFICIAL_MOUSE_PROFILE_ID
          ),
        }];
      },
    },

    dpiStages: {
      key: "dpiStages",
      kind: "direct",
      priority: 30,
      plan({ pid, caps, nextState, planner }) {
        requireCapability(caps, "dpiStages", "dpiStages", pid);
        const tx = txForField(pid, "dpiStages");
        const active = clampInt(nextState.activeDpiStageIndex, 0, Math.max(0, nextState.dpiStages.length - 1));
        const dpiCtx = planner?.getDpiWriteContext?.() || {};
        return [{
          packet: ProtocolCodec.commands.setDpiStages(
            tx,
            nextState.dpiStages,
            active,
            dpiCtx.profileId ?? OFFICIAL_MOUSE_PROFILE_ID,
            dpiCtx.stageIds ?? []
          ),
        }];
      },
    },

    activeDpiStageIndex: {
      key: "activeDpiStageIndex",
      kind: "virtual",
      priority: 31,
      triggers: ["activeDpiStageIndex"],
      plan({ pid, caps, nextState, planner }) {
        requireCapability(caps, "dpiStages", "activeDpiStageIndex", pid);
        const tx = txForField(pid, "activeDpiStageIndex");
        const active = clampInt(nextState.activeDpiStageIndex, 0, Math.max(0, nextState.dpiStages.length - 1));
        const dpiCtx = planner?.getDpiWriteContext?.() || {};
        return [{
          packet: ProtocolCodec.commands.setDpiStages(
            tx,
            nextState.dpiStages,
            active,
            dpiCtx.profileId ?? OFFICIAL_MOUSE_PROFILE_ID,
            dpiCtx.stageIds ?? []
          ),
        }];
      },
    },

    deviceIdleTime: {
      key: "deviceIdleTime",
      kind: "direct",
      priority: 40,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "idle", "deviceIdleTime", pid);
        const tx = txForField(pid, "deviceIdleTime");
        return [{ packet: ProtocolCodec.commands.setIdle(tx, nextState.deviceIdleTime) }];
      },
    },

    lowPowerThresholdPercent: {
      key: "lowPowerThresholdPercent",
      kind: "direct",
      priority: 41,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "lowPowerThresholdPercent", "lowPowerThresholdPercent", pid);
        const tx = txForField(pid, "lowPowerThresholdPercent");
        return [{ packet: ProtocolCodec.commands.setLowBatteryThreshold(tx, nextState.chargeLowThreshold) }];
      },
    },

    chargeLowThreshold: {
      key: "chargeLowThreshold",
      kind: "direct",
      priority: 42,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "lowBatteryThreshold", "chargeLowThreshold", pid);
        const tx = txForField(pid, "chargeLowThreshold");
        return [{ packet: ProtocolCodec.commands.setLowBatteryThreshold(tx, nextState.chargeLowThreshold) }];
      },
    },

    dynamicSensitivityEnabled: {
      key: "dynamicSensitivityEnabled",
      kind: "direct",
      priority: 50,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dynamicSensitivity", "dynamicSensitivityEnabled", pid);
        const tx = txForField(pid, "dynamicSensitivity");
        return [{ packet: ProtocolCodec.commands.setProximitySensorAccelerationState(tx, nextState.dynamicSensitivityEnabled) }];
      },
    },

    dynamicSensitivityMode: {
      key: "dynamicSensitivityMode",
      kind: "direct",
      priority: 51,
      plan({ pid, caps, patch, nextState }) {
        requireCapability(caps, "dynamicSensitivity", "dynamicSensitivityMode", pid);
        const tx = txForField(pid, "dynamicSensitivity");
        const explicitEnabled = Object.prototype.hasOwnProperty.call(patch, "dynamicSensitivityEnabled")
          ? !!patch.dynamicSensitivityEnabled
          : true;
        const seq = [
          { packet: ProtocolCodec.commands.setProximitySensorAccelerationState(tx, true) },
          { packet: ProtocolCodec.commands.setProximitySensorAccelerationMode(tx, nextState.dynamicSensitivityMode) },
        ];
        if (!explicitEnabled) {
          seq.push({ packet: ProtocolCodec.commands.setProximitySensorAccelerationState(tx, false) });
        }
        return seq;
      },
    },

    sensorAngle: {
      key: "sensorAngle",
      kind: "direct",
      priority: 52,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "sensorAngle", "sensorAngle", pid);
        const tx = txForField(pid, "sensorAngle");
        return [{ packet: ProtocolCodec.commands.setSensorAngle(tx, nextState.sensorAngle) }];
      },
    },

    smartTracking: {
      key: "smartTracking",
      kind: "virtual",
      priority: 53,
      triggers: ["smartTrackingMode", "smartTrackingLevel", "smartTrackingLiftDistance", "smartTrackingLandingDistance"],
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "smartTracking", "smartTracking", pid);
        const tx = txForField(pid, "smartTracking");
        const officialSmartTracking = buildOfficialSmartTrackingModelFromPublicState(nextState);
        const seq = [{ packet: ProtocolCodec.commands.setProximitySensorState(tx, OFFICIAL_PROXIMITY_CLASS_ID, OFFICIAL_PROXIMITY_SENSOR_ID, true) }];
        if (officialSmartTracking.isAsymmetric) {
          seq.push({
            packet: ProtocolCodec.commands.setProximitySensorLiftSetting(
              tx,
              OFFICIAL_PROXIMITY_CLASS_ID,
              OFFICIAL_PROXIMITY_SENSOR_ID,
              0x04,
              officialSmartTracking.trackingDistance - 1
            ),
          });
          seq.push({
            packet: ProtocolCodec.commands.setProximitySensorConfiguration(
              tx,
              OFFICIAL_PROXIMITY_CLASS_ID,
              OFFICIAL_PROXIMITY_SENSOR_ID,
              [officialSmartTracking.liftOffDistance - 1, officialSmartTracking.landingDistance - 1]
            ),
          });
        } else {
          seq.push({
            packet: ProtocolCodec.commands.setProximitySensorLiftSetting(
              tx,
              OFFICIAL_PROXIMITY_CLASS_ID,
              OFFICIAL_PROXIMITY_SENSOR_ID,
              0x01,
              officialSmartTracking.trackingDistance - 1
            ),
          });
        }
        return seq;
      },
    },

    hyperpollingIndicatorMode: {
      key: "hyperpollingIndicatorMode",
      kind: "direct",
      priority: 70,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "hyperpollingIndicatorMode", "hyperpollingIndicatorMode", pid);
        const tx = txForField(pid, "hyperpollingIndicatorMode");
        return [{ packet: ProtocolCodec.commands.setHyperpollingIndicatorMode(tx, nextState.hyperpollingIndicatorMode) }];
      },
    },
  });

  // ============================================================
  // 6) Planner
  //    - Normalizes external payload
  //    - Builds next state snapshot
  //    - Compiles ordered command list from SPEC
  // ============================================================
  class CommandPlanner {
    constructor(productId = 0) {
      this.productId = Number(productId || 0);
      this.capabilities = buildCapabilities(this.productId);
      this._dpiWriteContext = {
        profileId: OFFICIAL_MOUSE_PROFILE_ID,
        stageIds: [],
      };
    }

    setProductId(productId) {
      this.productId = Number(productId || 0);
      this.capabilities = buildCapabilities(this.productId);
      this._dpiWriteContext = {
        profileId: OFFICIAL_MOUSE_PROFILE_ID,
        stageIds: [],
      };
    }

    setDpiWriteContext({ profileId = OFFICIAL_MOUSE_PROFILE_ID, stageIds = [] } = {}) {
      this._dpiWriteContext = {
        profileId: clampU8(profileId),
        stageIds: Array.isArray(stageIds) ? stageIds.map((v) => clampU8(v)) : [],
      };
    }

    getDpiWriteContext() {
      return {
        profileId: clampU8(this._dpiWriteContext?.profileId ?? OFFICIAL_MOUSE_PROFILE_ID),
        stageIds: Array.isArray(this._dpiWriteContext?.stageIds) ? this._dpiWriteContext.stageIds.slice(0) : [],
      };
    }

    /**
     * Accepts external payload and keeps only fields supported by this build.
     * Also rejects removed fields with a clear NOT_SUPPORTED error.
     */
    normalizePayload(payload) {
      if (!isObject(payload)) return {};

      const out = {};
      const allow = new Set([
        "pollingHz",
        "dpi",
        "dpiX",
        "dpiY",
        "dpiStages",
        "activeDpiStageIndex",
        "deviceIdleTime",
        "lowPowerThresholdPercent",
        "chargeLowThreshold",
        "dynamicSensitivityEnabled",
        "dynamicSensitivityMode",
        "sensorAngle",
        "smartTrackingMode",
        "smartTrackingLevel",
        "smartTrackingLiftDistance",
        "smartTrackingLandingDistance",
        "hyperpollingIndicatorMode",
      ]);
      const removed = new Set([
        // Removed from this driver build (Razer mouse family scope reduction):
        // - matrix / wheel special controls
        "matrixBrightness",
        "matrixEffect",
        "scrollMode",
        "scrollAcceleration",
        "scrollSmartReel",
      ]);

      for (const key of Object.keys(payload)) {
        const normalizedKey = key;
        if (removed.has(normalizedKey)) {
          throw new ProtocolError(`${normalizedKey} is not supported in this driver build`, "NOT_SUPPORTED_FOR_DEVICE", {
            field: normalizedKey,
            reason: "removed_device_family",
          });
        }
        if (allow.has(normalizedKey)) out[normalizedKey] = payload[key];
      }

      return out;
    }

    _buildNextState(prevState, patch) {
      const next = deepClone(prevState || {});

      if (Object.prototype.hasOwnProperty.call(patch, "pollingHz")) {
        const hz = Number(patch.pollingHz);
        if (!Number.isFinite(hz)) throw new ProtocolError("pollingHz must be numeric", "BAD_PARAM");
        if (this.capabilities.pollingMode === "v2") {
          TRANSFORMERS.pollingV2Encode(hz);
        } else {
          TRANSFORMERS.pollingLegacyEncode(hz);
        }
        next.pollingHz = hz;
      }

      if (
        Object.prototype.hasOwnProperty.call(patch, "dpi") ||
        Object.prototype.hasOwnProperty.call(patch, "dpiX") ||
        Object.prototype.hasOwnProperty.call(patch, "dpiY")
      ) {
        next.dpi = TRANSFORMERS.normalizeDpi(next.dpi, patch);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "dpiStages")) {
        next.dpiStages = TRANSFORMERS.normalizeDpiStages(patch.dpiStages, next.dpiStages);
      } else {
        next.dpiStages = TRANSFORMERS.normalizeDpiStages(next.dpiStages, next.dpiStages);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "activeDpiStageIndex")) {
        next.activeDpiStageIndex = clampInt(patch.activeDpiStageIndex, 0, Math.max(0, next.dpiStages.length - 1));
      } else {
        next.activeDpiStageIndex = clampInt(next.activeDpiStageIndex ?? 0, 0, Math.max(0, next.dpiStages.length - 1));
      }

      if (Object.prototype.hasOwnProperty.call(patch, "deviceIdleTime")) {
        next.deviceIdleTime = TRANSFORMERS.normalizeIdleTime(patch.deviceIdleTime);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "chargeLowThreshold")) {
        next.chargeLowThreshold = TRANSFORMERS.normalizeLowThreshold(patch.chargeLowThreshold);
        next.lowPowerThresholdPercent = TRANSFORMERS.lowPowerRawToPercent(next.chargeLowThreshold);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "lowPowerThresholdPercent")) {
        next.lowPowerThresholdPercent = TRANSFORMERS.normalizeLowPowerPercent(patch.lowPowerThresholdPercent);
        next.chargeLowThreshold = TRANSFORMERS.lowPowerPercentToRaw(next.lowPowerThresholdPercent);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "hyperpollingIndicatorMode")) {
        next.hyperpollingIndicatorMode = TRANSFORMERS.normalizeHyperIndicatorMode(patch.hyperpollingIndicatorMode);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "dynamicSensitivityEnabled")) {
        next.dynamicSensitivityEnabled = !!patch.dynamicSensitivityEnabled;
      } else {
        next.dynamicSensitivityEnabled = !!next.dynamicSensitivityEnabled;
      }

      if (Object.prototype.hasOwnProperty.call(patch, "dynamicSensitivityMode")) {
        next.dynamicSensitivityMode = TRANSFORMERS.normalizeDynamicSensitivityMode(patch.dynamicSensitivityMode);
        if (!Object.prototype.hasOwnProperty.call(patch, "dynamicSensitivityEnabled")) {
          next.dynamicSensitivityEnabled = true;
        }
      } else {
        next.dynamicSensitivityMode = TRANSFORMERS.normalizeDynamicSensitivityMode(next.dynamicSensitivityMode ?? 1);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "sensorAngle")) {
        next.sensorAngle = TRANSFORMERS.normalizeSensorAngle(patch.sensorAngle);
      } else {
        next.sensorAngle = TRANSFORMERS.normalizeSensorAngle(next.sensorAngle ?? 0);
      }

      const hasSmartTrackingMode = Object.prototype.hasOwnProperty.call(patch, "smartTrackingMode");
      const hasSmartTrackingLevel = Object.prototype.hasOwnProperty.call(patch, "smartTrackingLevel");
      const hasLift = Object.prototype.hasOwnProperty.call(patch, "smartTrackingLiftDistance");
      const hasLanding = Object.prototype.hasOwnProperty.call(patch, "smartTrackingLandingDistance");
      if (hasSmartTrackingMode || hasSmartTrackingLevel || hasLift || hasLanding) {
        const smartTrackingSeed = {
          smartTrackingMode: hasSmartTrackingMode ? patch.smartTrackingMode : next.smartTrackingMode,
          smartTrackingLevel: hasSmartTrackingLevel ? patch.smartTrackingLevel : next.smartTrackingLevel,
          smartTrackingLiftDistance: hasLift ? patch.smartTrackingLiftDistance : next.smartTrackingLiftDistance,
          smartTrackingLandingDistance: hasLanding ? patch.smartTrackingLandingDistance : next.smartTrackingLandingDistance,
        };
        if ((hasLift || hasLanding) && !hasSmartTrackingMode) {
          smartTrackingSeed.smartTrackingMode = "asymmetric";
        }
        Object.assign(next, normalizePublicSmartTrackingState(smartTrackingSeed));
      } else if (
        next.smartTrackingMode != null
        || next.smartTrackingLevel != null
        || next.smartTrackingLiftDistance != null
        || next.smartTrackingLandingDistance != null
      ) {
        Object.assign(next, normalizePublicSmartTrackingState(next));
      }

      return next;
    }

    _collectSpecKeys(patch) {
      const keys = [];
      const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

      if (has("pollingHz")) keys.push("pollingHz");

      if (has("dpi") || has("dpiX") || has("dpiY")) {
        keys.push("dpi");
      }

      if (has("dpiStages")) {
        keys.push("dpiStages");
      } else if (has("activeDpiStageIndex")) {
        keys.push("activeDpiStageIndex");
      }

      if (has("deviceIdleTime")) keys.push("deviceIdleTime");
      if (has("lowPowerThresholdPercent")) {
        keys.push("lowPowerThresholdPercent");
      } else if (has("chargeLowThreshold")) {
        keys.push("chargeLowThreshold");
      }
      if (has("dynamicSensitivityMode")) {
        keys.push("dynamicSensitivityMode");
      } else if (has("dynamicSensitivityEnabled")) {
        keys.push("dynamicSensitivityEnabled");
      }
      if (has("sensorAngle")) keys.push("sensorAngle");
      if (
        has("smartTrackingMode")
        || has("smartTrackingLevel")
        || has("smartTrackingLiftDistance")
        || has("smartTrackingLandingDistance")
      ) {
        keys.push("smartTracking");
      }
      if (has("hyperpollingIndicatorMode")) keys.push("hyperpollingIndicatorMode");

      return keys;
    }

    _topoSort(keys) {
      return keys.slice(0).sort((a, b) => {
        const pa = SPEC[a]?.priority ?? 0;
        const pb = SPEC[b]?.priority ?? 0;
        return pa - pb;
      });
    }

    /**
     * Compile patch -> nextState -> command list.
     */
    plan(prevState, payload) {
      const patch = this.normalizePayload(payload);
      const nextState = this._buildNextState(prevState, patch);
      const keys = this._collectSpecKeys(patch);
      const sorted = this._topoSort(keys);

      const commands = [];
      for (const key of sorted) {
        const spec = SPEC[key];
        if (!spec) continue;
        const seq = spec.plan({
          pid: this.productId,
          caps: this.capabilities,
          patch,
          prevState,
          nextState,
          planner: this,
        });
        if (Array.isArray(seq) && seq.length) commands.push(...seq);
      }

      return { patch, nextState, commands };
    }
  }

  const DEFAULT_RAZER_BUTTON_SOURCE_BY_BUTTON = Object.freeze({
    1: "左键",
    2: "右键",
    3: "中键",
    4: "前进",
    5: "后退",
    6: "DPI循环",
  });

  const KEYMAP_ACTIONS = (() => {
    const actions = Object.create(null);
    const add = (label, type, funckey, keycode) => {
      if (!label || actions[label]) return;
      actions[label] = {
        type: String(type || "system"),
        funckey: clampU8(funckey),
        keycode: clampInt(keycode, 0, 0xffff),
      };
    };

    // Common UI labels.
    add("左键", "mouse", 0x01, 0x0000);
    add("右键", "mouse", 0x02, 0x0000);
    add("中键", "mouse", 0x04, 0x0000);
    add("前进", "mouse", 0x08, 0x0000);
    add("后退", "mouse", 0x10, 0x0000);
    add("DPI循环", "mouse", 0x20, 0x0005);
    add("禁止按键", "mouse", 0x07, 0x0000);
    add("左键双击", "mouse", 0x01, 0x0006);
    add("向上滚动", "mouse", 0x01, 0x0009);
    add("向下滚动", "mouse", 0x01, 0x000a);

    for (let i = 0; i < 26; i++) {
      add(String.fromCharCode(65 + i), "keyboard", 0x02, 0x0004 + i);
    }
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    for (let i = 0; i < digits.length; i++) {
      add(digits[i], "keyboard", 0x02, 0x001e + i);
    }
    for (let i = 1; i <= 12; i++) {
      add(`F${i}`, "keyboard", 0x02, 0x0039 + i);
    }
    add("Enter", "keyboard", 0x02, 0x0028);
    add("Esc", "keyboard", 0x02, 0x0029);
    add("Backspace", "keyboard", 0x02, 0x002a);
    add("Tab", "keyboard", 0x02, 0x002b);
    add("Space", "keyboard", 0x02, 0x002c);
    add("- _", "keyboard", 0x02, 0x002d);
    add("= +", "keyboard", 0x02, 0x002e);
    add("[ {", "keyboard", 0x02, 0x002f);
    add("] }", "keyboard", 0x02, 0x0030);
    add("\\ |", "keyboard", 0x02, 0x0031);
    add("; :", "keyboard", 0x02, 0x0033);
    add("' \"", "keyboard", 0x02, 0x0034);
    add("` ~", "keyboard", 0x02, 0x0035);
    add(", <", "keyboard", 0x02, 0x0036);
    add(". >", "keyboard", 0x02, 0x0037);
    add("/ ?", "keyboard", 0x02, 0x0038);
    add("Caps Lock", "keyboard", 0x02, 0x0039);
    add("Print Screen", "keyboard", 0x02, 0x0046);
    add("Scroll Lock", "keyboard", 0x02, 0x0047);
    add("Pause", "keyboard", 0x02, 0x0048);
    add("Insert", "keyboard", 0x02, 0x0049);
    add("Home", "keyboard", 0x02, 0x004a);
    add("Page Up", "keyboard", 0x02, 0x004b);
    add("Delete", "keyboard", 0x02, 0x004c);
    add("End", "keyboard", 0x02, 0x004d);
    add("Page Down", "keyboard", 0x02, 0x004e);
    add("Right Arrow", "keyboard", 0x02, 0x004f);
    add("Left Arrow", "keyboard", 0x02, 0x0050);
    add("Down Arrow", "keyboard", 0x02, 0x0051);
    add("Up Arrow", "keyboard", 0x02, 0x0052);
    add("Num Lock", "keyboard", 0x02, 0x0053);
    add("Numpad /", "keyboard", 0x02, 0x0054);
    add("Numpad *", "keyboard", 0x02, 0x0055);
    add("Numpad -", "keyboard", 0x02, 0x0056);
    add("Numpad +", "keyboard", 0x02, 0x0057);
    add("Numpad Enter", "keyboard", 0x02, 0x0058);
    add("Numpad 1", "keyboard", 0x02, 0x0059);
    add("Numpad 2", "keyboard", 0x02, 0x005a);
    add("Numpad 3", "keyboard", 0x02, 0x005b);
    add("Numpad 4", "keyboard", 0x02, 0x005c);
    add("Numpad 5", "keyboard", 0x02, 0x005d);
    add("Numpad 6", "keyboard", 0x02, 0x005e);
    add("Numpad 7", "keyboard", 0x02, 0x005f);
    add("Numpad 8", "keyboard", 0x02, 0x0060);
    add("Numpad 9", "keyboard", 0x02, 0x0061);
    add("Numpad 0", "keyboard", 0x02, 0x0062);
    add("Numpad .", "keyboard", 0x02, 0x0063);
    add("Left Ctrl", "keyboard", 0x02, 0x00e0);
    add("Left Shift", "keyboard", 0x02, 0x00e1);
    add("Left Alt", "keyboard", 0x02, 0x00e2);
    add("Left Win", "keyboard", 0x02, 0x00e3);
    add("Right Ctrl", "keyboard", 0x02, 0x00e4);
    add("Right Shift", "keyboard", 0x02, 0x00e5);
    add("Right Alt", "keyboard", 0x02, 0x00e6);
    add("Right Win", "keyboard", 0x02, 0x00e7);

    add("复制 Ctrl + C", "keyboard", 0x02, 0x0106);
    add("粘贴 Ctrl + V", "keyboard", 0x02, 0x0119);
    add("剪切 Ctrl + X", "keyboard", 0x02, 0x011b);
    add("撤销 Ctrl + Z", "keyboard", 0x02, 0x011d);
    add("重做 Ctrl + Y", "keyboard", 0x02, 0x011c);
    add("全选 Ctrl + A", "keyboard", 0x02, 0x0104);
    add("保存 Ctrl + S", "keyboard", 0x02, 0x0116);
    add("查找 Ctrl + F", "keyboard", 0x02, 0x0109);
    add("新建 Ctrl + N", "keyboard", 0x02, 0x0111);
    add("打印 Ctrl + P", "keyboard", 0x02, 0x0113);
    add("切换窗口 Alt + Tab", "keyboard", 0x02, 0x042b);
    add("关闭窗口 Alt + F4", "keyboard", 0x02, 0x043d);
    add("显示桌面 Win + D", "keyboard", 0x02, 0x0807);
    add("文件资源管理器 Win + E", "keyboard", 0x02, 0x0808);
    add("锁定电脑 Win + L", "keyboard", 0x02, 0x080f);
    add("运行 Win + R", "keyboard", 0x02, 0x0815);
    add("打开设置 Win + I", "keyboard", 0x02, 0x080c);
    add("任务管理器 Ctrl + Shift + Esc", "keyboard", 0x02, 0x0329);
    add("恢复关闭标签页 Ctrl + Shift + T", "keyboard", 0x02, 0x0317);

    add("音量加", "system", 0x40, 0x0000);
    add("音量减", "system", 0x40, 0x0001);
    add("静音", "system", 0x40, 0x0002);
    add("播放/暂停", "system", 0x40, 0x0004);
    add("下一曲", "system", 0x40, 0x0005);
    add("上一曲", "system", 0x40, 0x0006);
    add("计算器", "system", 0x40, 0x0007);
    add("我的电脑", "system", 0x40, 0x0008);
    add("浏览器", "system", 0x40, 0x0009);
    add("邮件", "system", 0x40, 0x000a);
    add("媒体播放器", "system", 0x40, 0x000b);
    add("停止播放", "system", 0x40, 0x000c);
    add("浏览器后退", "system", 0x40, 0x000d);
    add("浏览器前进", "system", 0x40, 0x000e);
    add("刷新页面", "system", 0x40, 0x000f);
    add("打开收藏夹", "system", 0x40, 0x0010);
    add("系统搜索", "system", 0x40, 0x0011);


    return Object.freeze(actions);
  })();

  const DEFAULT_RESET_LABEL_BY_BUTTON = Object.freeze({
    1: "左键",
    2: "右键",
    3: "中键",
    4: "前进",
    5: "后退",
    6: "DPI循环",
  });

  const LABEL_TO_PROTOCOL_ACTION = Object.freeze(
    Object.fromEntries(
      Object.entries(KEYMAP_ACTIONS).map(([label, action]) => [
        label,
        { funckey: action.funckey, keycode: action.keycode },
      ])
    )
  );

  const FUNCKEY_KEYCODE_TO_LABEL = (() => {
    const out = new Map();
    for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
      const key = `${Number(action.funckey)}:${Number(action.keycode)}`;
      if (!out.has(key)) out.set(key, label);
    }
    return out;
  })();

  function normalizeActionLabel(label) {
    const raw = String(label || "").trim();
    if (!raw) return "";
    return raw;
  }

  function normalizeButtonMappingEntry(entry, fallbackSource = "") {
    const raw = isObject(entry) ? entry : {};
    const source = String(raw.source ?? fallbackSource ?? "").trim() || String(fallbackSource || "").trim();
    return {
      source,
      funckey: clampU8(raw.funckey ?? raw.func ?? 0),
      keycode: clampInt(raw.keycode ?? raw.code ?? 0, 0, 0xffff),
    };
  }

  function isSameButtonAction(a, b) {
    const left = normalizeButtonMappingEntry(a);
    const right = normalizeButtonMappingEntry(b);
    return (
      clampU8(left.funckey) === clampU8(right.funckey)
      && clampInt(left.keycode, 0, 0xffff) === clampInt(right.keycode, 0, 0xffff)
    );
  }

  function hexU8(v) {
    return clampU8(v).toString(16).padStart(2, "0").toUpperCase();
  }

  const OFFICIAL_OBM_MOUSE_ASSIGNMENT_BY_PUBLIC_ACTION = Object.freeze({
    "1:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.LEFT_BUTTON] },
    "2:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.RIGHT_BUTTON] },
    "4:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.SCROLL_BUTTON] },
    "8:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.BUTTON_5] },
    "16:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.BUTTON_4] },
    "1:6": { functionId: OFFICIAL_OBM_FUNCTION_ID.DOUBLE_CLICK, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.LEFT_BUTTON] },
    "1:9": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.SCROLL_UP] },
    "1:10": { functionId: OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE, dataSize: 1, dataArray: [OFFICIAL_OBM_BUTTON_TARGET.SCROLL_DOWN] },
    "7:0": { functionId: OFFICIAL_OBM_FUNCTION_ID.OFF, dataSize: 0, dataArray: [] },
    "32:5": { functionId: OFFICIAL_OBM_FUNCTION_ID.DPI, dataSize: 1, dataArray: [OFFICIAL_OBM_DPI_ACTION.DPI_CYCLE_UP] },
  });

  const OFFICIAL_OBM_MEDIA_USAGE_BY_PUBLIC_ACTION = Object.freeze({
    "64:0": OFFICIAL_MEDIA_USAGE.VOLUME_UP,
    "64:1": OFFICIAL_MEDIA_USAGE.VOLUME_DOWN,
    "64:2": OFFICIAL_MEDIA_USAGE.MUTE_VOLUME,
    "64:4": OFFICIAL_MEDIA_USAGE.MEDIA_PLAY_OR_PAUSE,
    "64:5": OFFICIAL_MEDIA_USAGE.NEXT_TRACK,
    "64:6": OFFICIAL_MEDIA_USAGE.PREVIOUS_TRACK,
    "64:7": OFFICIAL_MEDIA_USAGE.CALCULATOR,
    "64:8": OFFICIAL_MEDIA_USAGE.THIS_PC,
    "64:9": OFFICIAL_MEDIA_USAGE.WEB_BROWSER,
    "64:10": OFFICIAL_MEDIA_USAGE.MAIL,
    "64:11": OFFICIAL_MEDIA_USAGE.MEDIA_PLAYER,
    "64:12": OFFICIAL_MEDIA_USAGE.MEDIA_STOP,
    "64:13": OFFICIAL_MEDIA_USAGE.WEB_BACK,
    "64:14": OFFICIAL_MEDIA_USAGE.WEB_FORWARD,
    "64:15": OFFICIAL_MEDIA_USAGE.WEB_REFRESH,
    "64:16": OFFICIAL_MEDIA_USAGE.WEB_FAVORITES,
    "64:17": OFFICIAL_MEDIA_USAGE.WEB_SEARCH,
  });

  const OFFICIAL_PUBLIC_ACTION_BY_MEDIA_USAGE = new Map([
    [OFFICIAL_MEDIA_USAGE.VOLUME_UP, { funckey: 0x40, keycode: 0x0000 }],
    [OFFICIAL_MEDIA_USAGE.VOLUME_DOWN, { funckey: 0x40, keycode: 0x0001 }],
    [OFFICIAL_MEDIA_USAGE.MUTE_VOLUME, { funckey: 0x40, keycode: 0x0002 }],
    [OFFICIAL_MEDIA_USAGE.MEDIA_PLAY_OR_PAUSE, { funckey: 0x40, keycode: 0x0004 }],
    [OFFICIAL_MEDIA_USAGE.NEXT_TRACK, { funckey: 0x40, keycode: 0x0005 }],
    [OFFICIAL_MEDIA_USAGE.PREVIOUS_TRACK, { funckey: 0x40, keycode: 0x0006 }],
    [OFFICIAL_MEDIA_USAGE.CALCULATOR, { funckey: 0x40, keycode: 0x0007 }],
    [OFFICIAL_MEDIA_USAGE.THIS_PC, { funckey: 0x40, keycode: 0x0008 }],
    [OFFICIAL_MEDIA_USAGE.WEB_BROWSER, { funckey: 0x40, keycode: 0x0009 }],
    [OFFICIAL_MEDIA_USAGE.MAIL, { funckey: 0x40, keycode: 0x000a }],
    [OFFICIAL_MEDIA_USAGE.MEDIA_PLAYER, { funckey: 0x40, keycode: 0x000b }],
    [OFFICIAL_MEDIA_USAGE.MEDIA_STOP, { funckey: 0x40, keycode: 0x000c }],
    [OFFICIAL_MEDIA_USAGE.WEB_BACK, { funckey: 0x40, keycode: 0x000d }],
    [OFFICIAL_MEDIA_USAGE.WEB_FORWARD, { funckey: 0x40, keycode: 0x000e }],
    [OFFICIAL_MEDIA_USAGE.WEB_REFRESH, { funckey: 0x40, keycode: 0x000f }],
    [OFFICIAL_MEDIA_USAGE.WEB_FAVORITES, { funckey: 0x40, keycode: 0x0010 }],
    [OFFICIAL_MEDIA_USAGE.WEB_SEARCH, { funckey: 0x40, keycode: 0x0011 }],
  ]);

  const OFFICIAL_MODIFIER_BITS_BY_LEGACY_USAGE = Object.freeze({
    0xe0: OFFICIAL_MODIFIER_BITS.LEFT_CTRL,
    0xe1: OFFICIAL_MODIFIER_BITS.LEFT_SHIFT,
    0xe2: OFFICIAL_MODIFIER_BITS.LEFT_ALT,
    0xe3: OFFICIAL_MODIFIER_BITS.LEFT_GUI,
    0xe4: OFFICIAL_MODIFIER_BITS.RIGHT_CTRL,
    0xe5: OFFICIAL_MODIFIER_BITS.RIGHT_SHIFT,
    0xe6: OFFICIAL_MODIFIER_BITS.RIGHT_ALT,
    0xe7: OFFICIAL_MODIFIER_BITS.RIGHT_GUI,
  });

  const OFFICIAL_LEGACY_USAGE_BY_MODIFIER_BITS = Object.freeze(
    Object.fromEntries(
      Object.entries(OFFICIAL_MODIFIER_BITS_BY_LEGACY_USAGE).map(([usage, bits]) => [bits, Number(usage)])
    )
  );

  function hexByteList(dataArray, size = dataArray?.length ?? 0) {
    const list = [];
    const src = dataArray instanceof Uint8Array ? dataArray : new Uint8Array(dataArray || []);
    const count = clampInt(size, 0, src.length);
    for (let i = 0; i < count; i++) list.push(hexU8(src[i]));
    return list.join("-");
  }

  function buildUnknownOfficialObmEntry(functionId = 0x00, dataArray = null, dataSize = 0) {
    const src = dataArray instanceof Uint8Array ? dataArray : new Uint8Array(dataArray || []);
    return {
      source: `鏈煡(瀹樻柟OBM:fn=${hexU8(functionId)} data=${hexByteList(src, dataSize)})`,
      funckey: 0x00,
      keycode: 0x0000,
    };
  }

  function buildOfficialObmDataArray(input = null) {
    const src = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    const out = new Uint8Array(5);
    out.set(src.subarray(0, 5), 0);
    return out;
  }

  function splitLegacyKeyboardActionKeycode(keycode) {
    const packed = clampInt(keycode, 0, 0xffff);
    let modifierBits = (packed >> 8) & 0xff;
    let hidUsage = packed & 0xff;
    if (!modifierBits && Object.prototype.hasOwnProperty.call(OFFICIAL_MODIFIER_BITS_BY_LEGACY_USAGE, hidUsage)) {
      modifierBits = OFFICIAL_MODIFIER_BITS_BY_LEGACY_USAGE[hidUsage];
      hidUsage = 0x00;
    }
    return { modifierBits, hidUsage };
  }

  function buildLegacyKeyboardActionKeycode(modifierBits = 0x00, hidUsage = 0x00) {
    const bits = clampU8(modifierBits);
    const hid = clampU8(hidUsage);
    if (!hid && Object.prototype.hasOwnProperty.call(OFFICIAL_LEGACY_USAGE_BY_MODIFIER_BITS, bits)) {
      return clampInt(OFFICIAL_LEGACY_USAGE_BY_MODIFIER_BITS[bits], 0, 0xffff);
    }
    return ((bits << 8) | hid) & 0xffff;
  }

  function buildOfficialObmAssignmentFromPublicAction(actionLike) {
    const action = normalizeButtonMappingEntry(actionLike);
    const actionKey = `${action.funckey}:${action.keycode}`;

    if (Object.prototype.hasOwnProperty.call(OFFICIAL_OBM_MOUSE_ASSIGNMENT_BY_PUBLIC_ACTION, actionKey)) {
      const hit = OFFICIAL_OBM_MOUSE_ASSIGNMENT_BY_PUBLIC_ACTION[actionKey];
      return {
        functionId: clampU8(hit.functionId),
        dataSize: clampInt(hit.dataSize, 0, 5),
        dataArray: buildOfficialObmDataArray(hit.dataArray),
      };
    }

    if (action.funckey === 0x02) {
      const { modifierBits, hidUsage } = splitLegacyKeyboardActionKeycode(action.keycode);
      return {
        functionId: OFFICIAL_OBM_FUNCTION_ID.KEY_CODE,
        dataSize: 2,
        dataArray: buildOfficialObmDataArray([modifierBits, hidUsage]),
      };
    }

    if (Object.prototype.hasOwnProperty.call(OFFICIAL_OBM_MEDIA_USAGE_BY_PUBLIC_ACTION, actionKey)) {
      const usage = clampU16(OFFICIAL_OBM_MEDIA_USAGE_BY_PUBLIC_ACTION[actionKey]);
      return {
        functionId: OFFICIAL_OBM_FUNCTION_ID.MEDIA_KEYS,
        dataSize: 2,
        dataArray: buildOfficialObmDataArray([usage & 0xff, (usage >> 8) & 0xff]),
      };
    }

    return null;
  }

  function parseOfficialObmAssignment(response, mode = OFFICIAL_BUTTON_MODE.NORMAL) {
    const args = response?.argumentsData instanceof Uint8Array && response.argumentsData.length
      ? response.argumentsData
      : response?.arguments instanceof Uint8Array
        ? response.arguments
        : new Uint8Array();
    if (!args.length) {
      throw new ProtocolError("OBM button assignment response is empty", "OBM_READ_FAILED");
    }
    const parsedMode = clampU8(args[2] ?? mode);
    return {
      profileId: clampU8(args[0] ?? OFFICIAL_MOUSE_PROFILE_ID),
      buttonId: clampU8(args[1] ?? 0x00),
      mode: parsedMode,
      functionId: clampU8(args[3] ?? 0x00),
      dataSize: clampInt(args[4] ?? 0x00, 0, 5),
      dataArray: buildOfficialObmDataArray(args.subarray(5, 10)),
    };
  }

  function buildPublicActionFromOfficialObmAssignment(assignment) {
    const fnId = clampU8(assignment?.functionId ?? 0x00);
    const dataSize = clampInt(assignment?.dataSize ?? 0x00, 0, 5);
    const dataArray = buildOfficialObmDataArray(assignment?.dataArray);

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.OFF) {
      return normalizeButtonMappingEntry({
        source: FUNCKEY_KEYCODE_TO_LABEL.get("7:0") || "绂佹鎸夐敭",
        funckey: 0x07,
        keycode: 0x0000,
      });
    }

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.BUTTON_CODE) {
      const target = clampU8(dataArray[0] ?? 0x00);
      let publicKey = "";
      switch (target) {
        case OFFICIAL_OBM_BUTTON_TARGET.LEFT_BUTTON: publicKey = "1:0"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.RIGHT_BUTTON: publicKey = "2:0"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.SCROLL_BUTTON: publicKey = "4:0"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.BUTTON_5: publicKey = "8:0"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.BUTTON_4: publicKey = "16:0"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.SCROLL_UP: publicKey = "1:9"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.SCROLL_DOWN: publicKey = "1:10"; break;
        case OFFICIAL_OBM_BUTTON_TARGET.DPI_CYCLE_UP: publicKey = "32:5"; break;
        default: break;
      }
      if (publicKey) {
        const [funckey, keycode] = publicKey.split(":").map((v) => Number(v));
        const source = FUNCKEY_KEYCODE_TO_LABEL.get(publicKey);
        if (source) return normalizeButtonMappingEntry({ source, funckey, keycode });
      }
      return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
    }

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.DOUBLE_CLICK) {
      if (clampU8(dataArray[0] ?? 0x00) === OFFICIAL_OBM_BUTTON_TARGET.LEFT_BUTTON) {
        const source = FUNCKEY_KEYCODE_TO_LABEL.get("1:6");
        if (source) return normalizeButtonMappingEntry({ source, funckey: 0x01, keycode: 0x0006 });
      }
      return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
    }

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.DPI) {
      if (clampU8(dataArray[0] ?? 0x00) === OFFICIAL_OBM_DPI_ACTION.DPI_CYCLE_UP) {
        const source = FUNCKEY_KEYCODE_TO_LABEL.get("32:5");
        if (source) return normalizeButtonMappingEntry({ source, funckey: 0x20, keycode: 0x0005 });
      }
      return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
    }

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.KEY_CODE) {
      const keycode = buildLegacyKeyboardActionKeycode(dataArray[0], dataArray[1]);
      const source = FUNCKEY_KEYCODE_TO_LABEL.get(`2:${keycode}`);
      if (source) return normalizeButtonMappingEntry({ source, funckey: 0x02, keycode });
      return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
    }

    if (fnId === OFFICIAL_OBM_FUNCTION_ID.MEDIA_KEYS) {
      const usage = ((clampU8(dataArray[1] ?? 0x00) << 8) | clampU8(dataArray[0] ?? 0x00)) & 0xffff;
      const action = OFFICIAL_PUBLIC_ACTION_BY_MEDIA_USAGE.get(usage);
      if (action) {
        const source = FUNCKEY_KEYCODE_TO_LABEL.get(`${action.funckey}:${action.keycode}`);
        if (source) return normalizeButtonMappingEntry({ source, funckey: action.funckey, keycode: action.keycode });
      }
      return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
    }

    return buildUnknownOfficialObmEntry(fnId, dataArray, dataSize);
  }

  function resolveButtonMappingActionInput(btnId, labelOrObj) {
    const slot = clampInt(btnId, 1, 6);

    if (typeof labelOrObj === "string") {
      return resolveActionFromLabel(slot, labelOrObj);
    }

    if (!isObject(labelOrObj)) return null;

    const explicitLabel = normalizeActionLabel(labelOrObj.label ?? labelOrObj.source ?? "");
    if (explicitLabel) {
      const byLabel = resolveActionFromLabel(slot, explicitLabel);
      if (byLabel) return byLabel;
    }

    const normalized = normalizeButtonMappingEntry(labelOrObj);
    const source = FUNCKEY_KEYCODE_TO_LABEL.get(`${normalized.funckey}:${normalized.keycode}`) || normalized.source;
    if (!source) return null;

    return {
      label: source,
      source,
      action: {
        funckey: normalized.funckey,
        keycode: normalized.keycode,
      },
    };
  }

  const OFFICIAL_OBM_WRITABLE_LABELS = Object.freeze(
    (() => {
      const labels = new Set();
      for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
        if (buildOfficialObmAssignmentFromPublicAction(action)) {
          labels.add(label);
        }
      }
      return labels;
    })()
  );

  function resolveActionFromLabel(btnId, label) {
    const b = clampInt(btnId, 1, 6);
    const canonical = normalizeActionLabel(label);
    if (!canonical) return null;

    // Reset flow in app.js uses legacy labels; remap them to Razer default source actions.
    if (canonical === DEFAULT_RESET_LABEL_BY_BUTTON[b]) {
      const sourceLabel = DEFAULT_RAZER_BUTTON_SOURCE_BY_BUTTON[b];
      const action = LABEL_TO_PROTOCOL_ACTION[sourceLabel];
      if (action) {
        return {
          label: sourceLabel,
          action: { funckey: action.funckey, keycode: action.keycode },
          source: sourceLabel,
        };
      }
    }

    const action = LABEL_TO_PROTOCOL_ACTION[canonical];
    if (!action) return null;
    return {
      label: canonical,
      action: { funckey: action.funckey, keycode: action.keycode },
      source: canonical,
    };
  }

  function buildDefaultRazerButtonMappings() {
    const mappings = [];
    for (let i = 1; i <= 6; i++) {
      const source = DEFAULT_RAZER_BUTTON_SOURCE_BY_BUTTON[i];
      const action = LABEL_TO_PROTOCOL_ACTION[source] || { funckey: 0x00, keycode: 0x0000 };
      mappings.push({
        source,
        funckey: clampU8(action.funckey),
        keycode: clampInt(action.keycode, 0, 0xffff),
      });
    }
    return mappings;
  }

  // ============================================================
  // 7) Public API facade
  //    - Maintains cached config
  //    - Coordinates planner + transport
  //    - Emits config/battery/raw-report events
  // ============================================================
  class MouseMouseHidApi {
    constructor({ device = null } = {}) {
      this._device = null;
      this._eventDevice = null;
      this._attachedInputDevice = null;
      this._transportPid = 0;
      this._sessionPid = 0;
      this._driver = new UniversalHidDriver();
      this._planner = new CommandPlanner(0);
      this._opQueue = new SendQueue();
      this._onConfigCbs = new Set();
      this._onBatteryCbs = new Set();
      this._onRawReportCbs = new Set();
      this._boundInputReport = (event) => this._handleInputReport(event);
      this._closed = true;
      this._sessionReadCache = this._makeSessionReadCache();

      if (device) this.device = device;
      this._cfg = this._makeDefaultCfg();
      this._syncCapabilitiesSnapshot();
    }

    set device(dev) {
      this._setSessionDevices(dev || null, null);
    }

    get device() {
      return this._device;
    }

    set eventDevice(dev) {
      this._setSessionDevices(this._device || null, dev || null);
    }

    get eventDevice() {
      return this._eventDevice;
    }

    _resolveTransportPid(controlDevice = this._device) {
      return normalizePid(controlDevice);
    }

    _resolveSessionPid(controlDevice = this._device) {
      return normalizePid(controlDevice);
    }

    _makeSessionReadCache() {
      return {
        dpiProfileId: OFFICIAL_MOUSE_PROFILE_ID,
        dpiStageIds: [],
      };
    }

    _resetSessionReadCache() {
      this._sessionReadCache = this._makeSessionReadCache();
      return this._sessionReadCache;
    }

    _resolveSnapshotReadMode(mode = "full", reason = "") {
      const normalizedMode = String(mode || "full").trim().toLowerCase();
      if (normalizedMode === "none") return "none";
      if (
        normalizedMode === SNAPSHOT_READ_MODE.CONNECT_FULL
        || normalizedMode === SNAPSHOT_READ_MODE.REFRESH_FULL
      ) {
        return normalizedMode;
      }
      return String(reason || "").trim().toLowerCase() === "connect"
        ? SNAPSHOT_READ_MODE.CONNECT_FULL
        : SNAPSHOT_READ_MODE.REFRESH_FULL;
    }

    _hasStaticSnapshotValue(key) {
      return String(this._cfg?.[key] || "").trim().length > 0;
    }

    _updateDpiWriteContext(profileId = OFFICIAL_MOUSE_PROFILE_ID, stageIds = []) {
      if (!this._sessionReadCache) this._resetSessionReadCache();
      this._sessionReadCache.dpiProfileId = clampU8(profileId);
      this._sessionReadCache.dpiStageIds = Array.isArray(stageIds) ? stageIds.map((v) => clampU8(v)) : [];
      this._planner.setDpiWriteContext({
        profileId: this._sessionReadCache.dpiProfileId,
        stageIds: this._sessionReadCache.dpiStageIds,
      });
    }

    _setSessionDevices(controlDevice, eventDevice) {
      this._detachInputReportListener();
      this._device = controlDevice || null;
      this._eventDevice = eventDevice || null;
      this._transportPid = this._resolveTransportPid(this._device);
      this._sessionPid = this._resolveSessionPid(this._device);
      this._planner.setProductId(this._sessionPid);
      this._driver.setDevice(this._device, this._transportPid);
      this._resetSessionReadCache();
      this._cfg = this._makeDefaultCfg();
      this._syncCapabilitiesSnapshot();
    }

    _resolveInputDevice() {
      const eventDevice = (
        this._eventDevice
        && this._eventDevice !== this._device
        && this._eventDevice.opened
      ) ? this._eventDevice : null;
      return eventDevice || this._device || null;
    }

    matchesHidDevice(device) {
      if (!device) return false;
      return (
        device === this._device
        || device === this._eventDevice
        || device === this._attachedInputDevice
      );
    }

    async _closeDeviceHandle(device) {
      if (!device) return;
      try {
        if (device.opened) await device.close();
      } catch {
        // ignore close errors
      }
    }

    _pid() {
      return this._sessionPid || this._resolveSessionPid(this._device);
    }

    _transportPidValue() {
      return this._transportPid || this._resolveTransportPid(this._device);
    }

    _caps() {
      return buildCapabilities(this._pid());
    }

    _ensureSupported() {
      const sessionPid = this._pid();
      const transportPid = this._transportPidValue();
      ensureSupportedPid(sessionPid);
      if (transportPid && transportPid !== sessionPid) ensureSupportedPid(transportPid);
      return sessionPid;
    }

    async _ensureOpen() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      this._ensureSupported();
      const needsOpen = !this.device.opened;
      if (needsOpen) {
        await this.open({ openEventDevice: false });
        return;
      }
      const inputDevice = this._resolveInputDevice();
      if (inputDevice && this._attachedInputDevice !== inputDevice) this._attachInputReportListener();
    }

    _capabilitiesSnapshot(caps = this._caps()) {
      const pollingRates = caps.pollingMode === "v2"
        ? [125, 250, 500, 1000, 2000, 4000, 8000]
        : [125, 500, 1000];
      return {
        dpiSlotCount: 5,
        maxDpi: 45000,
        dpiStep: 1,
        pollingRates: pollingRates.slice(0),
        dynamicSensitivity: !!caps.dynamicSensitivity,
        smartTracking: !!caps.smartTracking,
        sensorAngle: !!caps.sensorAngle,
        lowPowerThresholdPercent: !!caps.lowPowerThresholdPercent,
        hyperpollingIndicatorMode: !!caps.hyperpollingIndicatorMode,
      };
    }

    _syncCapabilitiesSnapshot(caps = this._caps()) {
      this.capabilities = this._capabilitiesSnapshot(caps);
      return this.capabilities;
    }

    _snapshotForUi() {
      const cfg = deepClone(this._cfg || {});
      if (!isObject(cfg.capabilities)) {
        cfg.capabilities = isObject(this.capabilities)
          ? deepClone(this.capabilities)
          : this._syncCapabilitiesSnapshot();
      }
      return cfg;
    }

    _emitConfig() {
      if (this._closed) return;
      this._syncCapabilitiesSnapshot();
      const cfg = this._snapshotForUi();
      for (const cb of Array.from(this._onConfigCbs)) {
        try {
          cb(cfg);
        } catch {
          // ignore callback exceptions
        }
      }
    }

    _emitBattery(bat) {
      if (this._closed) return;
      const payload = {
        batteryPercent: clampInt(bat?.batteryPercent ?? -1, -1, 100),
        batteryIsCharging: !!bat?.batteryIsCharging,
      };
      for (const cb of Array.from(this._onBatteryCbs)) {
        try {
          cb(payload);
        } catch {
          // ignore callback exceptions
        }
      }
    }

    _emitRawReport(raw) {
      if (this._closed) return;
      for (const cb of Array.from(this._onRawReportCbs)) {
        try {
          cb(raw);
        } catch {
          // ignore callback exceptions
        }
      }
    }

    _handleInputReport(event) {
      if (this._closed) return;

      const reportId = clampU8(event?.reportId ?? 0);
      const expectedReportId = getEventReportIdForPid(this._pid());
      const reportBytes = toDataViewU8(event?.data);
      this._emitRawReport({
        reportId,
        expectedReportId,
        bytes: new Uint8Array(reportBytes || []),
        timestamp: Number(event?.timeStamp ?? Date.now()),
      });
    }

    _attachInputReportListener() {
      const inputDevice = this._resolveInputDevice();
      if (!inputDevice || typeof inputDevice.addEventListener !== "function") return;
      if (this._attachedInputDevice && this._attachedInputDevice !== inputDevice) {
        this._detachInputReportListener();
      }
      if (typeof inputDevice.removeEventListener === "function") {
        inputDevice.removeEventListener("inputreport", this._boundInputReport);
      }
      inputDevice.addEventListener("inputreport", this._boundInputReport);
      this._attachedInputDevice = inputDevice;
    }

    _detachInputReportListener() {
      if (!this._attachedInputDevice || typeof this._attachedInputDevice.removeEventListener !== "function") {
        this._attachedInputDevice = null;
        return;
      }
      this._attachedInputDevice.removeEventListener("inputreport", this._boundInputReport);
      this._attachedInputDevice = null;
    }

    _makeDefaultCfg() {
      const pid = this._pid();
      const caps = buildCapabilities(pid);

      const cfg = {
        capabilities: this._capabilitiesSnapshot(caps),
        deviceName: PID_NAME[pid] || (this.device?.productName ? String(this.device.productName) : "Razer Mouse"),
        firmwareVersion: "",
        serial: "",
        pollingHz: caps.pollingMode === "v2" ? 1000 : 1000,
        dpi: { x: 1600, y: 1600 },
        dpiStages: [
          { x: 800, y: 800 },
          { x: 1600, y: 1600 },
          { x: 3200, y: 3200 },
        ],
        activeDpiStageIndex: 0,
        buttonMappings: buildDefaultRazerButtonMappings(),
      };

      if (caps.battery) {
        cfg.batteryPercent = -1;
        cfg.batteryIsCharging = false;
        cfg.deviceIdleTime = 300;
        cfg.chargeLowThreshold = 0x26;
        cfg.lowPowerThresholdPercent = TRANSFORMERS.lowPowerRawToPercent(cfg.chargeLowThreshold);
      }

      if (caps.hyperpollingIndicatorMode) {
        cfg.hyperpollingIndicatorMode = 1;
      }

      if (caps.dynamicSensitivity) {
        cfg.dynamicSensitivityEnabled = false;
        cfg.dynamicSensitivityMode = 1;
      }

      if (caps.smartTracking) {
        Object.assign(cfg, DEFAULT_RAZER_SMART_TRACKING_PUBLIC_STATE);
      }

      if (caps.sensorAngle) {
        cfg.sensorAngle = 0;
      }

      return cfg;
    }

    async open(opts = {}) {
      const options = isObject(opts) ? opts : {};
      const {
        openEventDevice = true,
        tolerateEventDeviceOpenFailure = false,
      } = options;
      if (!this.device) throw new ProtocolError("open() requires a HID device", "NO_DEVICE");
      const pid = this._ensureSupported();
      const transportPid = this._transportPidValue();
      const controlDevice = this.device;
      const eventDevice = (this.eventDevice && this.eventDevice !== controlDevice) ? this.eventDevice : null;
      let openedControl = false;
      let openedEvent = false;
      try {
        if (!controlDevice.opened) {
          await controlDevice.open();
          openedControl = true;
        }

        if (eventDevice && !eventDevice.opened) {
          await eventDevice.open();
          openedEvent = true;
        }

        this._closed = false;
        this._driver.setDevice(controlDevice, transportPid);
        this._planner.setProductId(pid);
        this._cfg = Object.assign({}, this._makeDefaultCfg(), isObject(this._cfg) ? this._cfg : {});
        this._detachInputReportListener();

        if (openEventDevice && eventDevice && !eventDevice.opened) {
          try {
            await eventDevice.open();
            openedEvent = true;
          } catch (err) {
            if (!tolerateEventDeviceOpenFailure) throw err;
            console.warn("[Razer] Event device open failed during bootstrap", err);
          }
        }

        this._attachInputReportListener();
      } catch (err) {
        this._closed = true;
        this._detachInputReportListener();
        if (openedEvent) await this._closeDeviceHandle(eventDevice);
        if (openedControl) await this._closeDeviceHandle(controlDevice);
        throw err;
      }

      if (RAZER_POST_OPEN_SETTLE_MS > 0) {
        await sleep(RAZER_POST_OPEN_SETTLE_MS);
      }
    }

    // Unified session bootstrap entry: open -> optional initial read -> timeout/retry -> cache fallback,
    // while guaranteeing at least one _emitConfig() call.
    async bootstrapSession(opts = {}) {
      const options = isObject(opts) ? opts : {};
      const hasDevice = Object.prototype.hasOwnProperty.call(options, "device");
      const hasEventDevice = Object.prototype.hasOwnProperty.call(options, "eventDevice");
      const hasOpenRetry = Object.prototype.hasOwnProperty.call(options, "openRetry");
      const hasReadRetry = Object.prototype.hasOwnProperty.call(options, "readRetry");
      const hasOpenRetryDelayMs = Object.prototype.hasOwnProperty.call(options, "openRetryDelayMs");
      const hasReadRetryDelayMs = Object.prototype.hasOwnProperty.call(options, "readRetryDelayMs");
      const normalizedReason = String(options.reason || "").trim().toLowerCase();
      const {
        reason = "",
        openRetry = (normalizedReason === "connect" ? 1 : 2),
        readRetry = 2,
        openRetryDelayMs = 120,
        readRetryDelayMs = (normalizedReason === "connect" ? 40 : 120),
        readTimeoutMs = 2000,
        sendTimeoutMs = null,
        useCacheFallback = true,
        initialReadMode = "full",
      } = options;

      if (hasDevice || hasEventDevice) {
        const nextControlDevice = hasDevice ? (options.device || null) : this.device;
        const nextEventDevice = hasEventDevice ? (options.eventDevice || null) : (hasDevice ? null : this.eventDevice);
        this._setSessionDevices(nextControlDevice, nextEventDevice);
      }

      const cachedCfg = this.getCachedConfig();
      const requestedOpenRetry = hasOpenRetry ? options.openRetry : openRetry;
      const requestedReadRetry = hasReadRetry ? options.readRetry : readRetry;
      const requestedOpenRetryDelayMs = hasOpenRetryDelayMs ? options.openRetryDelayMs : openRetryDelayMs;
      const requestedReadRetryDelayMs = hasReadRetryDelayMs ? options.readRetryDelayMs : readRetryDelayMs;
      const normalizedInitialReadMode = String(initialReadMode || "full").trim().toLowerCase();
      const snapshotReadMode = this._resolveSnapshotReadMode(normalizedInitialReadMode, normalizedReason);
      const maxOpenAttempts = clampInt(requestedOpenRetry, 1, 10);
      const maxReadAttempts = clampInt(requestedReadRetry, 1, 10);
      const openDelayMs = clampInt(requestedOpenRetryDelayMs, 0, 5000);
      const readDelayMs = clampInt(requestedReadRetryDelayMs, 0, 5000);
      const driverReadTimeoutMs = clampInt(readTimeoutMs, 250, 10_000);
      const driverSendTimeoutMs = clampInt(
        sendTimeoutMs == null ? Math.max(driverReadTimeoutMs, 1500) : sendTimeoutMs,
        250,
        10_000
      );
      this._driver.readTimeoutMs = driverReadTimeoutMs;
      this._driver.sendTimeoutMs = driverSendTimeoutMs;

      let openAttempts = 0;
      let readAttempts = 0;
      let openErr = null;
      for (let i = 0; i < maxOpenAttempts; i++) {
        openAttempts = i + 1;
        try {
          await this.open({
            openEventDevice: snapshotReadMode === "none",
            tolerateEventDeviceOpenFailure: snapshotReadMode === "none",
          });
          openErr = null;
          break;
        } catch (e) {
          openErr = e;
          if (i < maxOpenAttempts - 1 && openDelayMs > 0) await sleep(openDelayMs);
        }
      }

      let initialReadErr = null;
      if (!openErr && snapshotReadMode !== "none") {
        for (let i = 0; i < maxReadAttempts; i++) {
          readAttempts = i + 1;
          try {
            const updates = await this._readDeviceStateSnapshot({
              mode: snapshotReadMode,
            });
            if (updates && Object.keys(updates).length) {
              this._cfg = Object.assign({}, this._cfg, updates);
            }
            initialReadErr = null;
            break;
          } catch (e) {
            const msg = String(e?.message || e);
            initialReadErr = new ProtocolError(`Initial state read failed: ${msg}`, "INITIAL_READ_FAIL", { cause: e });
            if (i < maxReadAttempts - 1 && readDelayMs > 0) await sleep(readDelayMs);
          }
        }
      }

      if (!openErr && snapshotReadMode !== "none" && this.eventDevice && this.eventDevice !== this.device) {
        try {
          await this.open({
            openEventDevice: true,
            tolerateEventDeviceOpenFailure: true,
          });
        } catch (eventErr) {
          console.warn("[Razer] Event device bootstrap open failed", eventErr);
        }
      }

      let usedCacheFallback = false;
      const bootstrapErr = initialReadErr || openErr;
      if (bootstrapErr) {
        const isInitialReadFail = String(bootstrapErr?.code || "") === "INITIAL_READ_FAIL";
        if (isInitialReadFail && useCacheFallback && cachedCfg && typeof cachedCfg === "object") {
          this._cfg = Object.assign({}, cachedCfg);
          usedCacheFallback = true;
        } else {
          throw bootstrapErr;
        }
      }

      this._emitConfig();
      if (this._caps().battery) {
        this._emitBattery({
          batteryPercent: this._cfg?.batteryPercent,
          batteryIsCharging: this._cfg?.batteryIsCharging,
        });
      }

      return {
        cfg: this.getCachedConfig(),
        meta: {
          reason: String(reason || ""),
          openAttempts,
          readAttempts,
          usedCacheFallback,
          initialReadMode: normalizedInitialReadMode,
          readTimeoutMs: driverReadTimeoutMs,
          sendTimeoutMs: driverSendTimeoutMs,
        },
      };
    }

    async close() {
      this._closed = true;
      this._detachInputReportListener();
      const controlDevice = this.device;
      const eventDevice = (this.eventDevice && this.eventDevice !== controlDevice) ? this.eventDevice : null;
      if (eventDevice) await this._closeDeviceHandle(eventDevice);
      if (controlDevice) await this._closeDeviceHandle(controlDevice);
    }

    /**
     * Subscribe config snapshot updates.
     * Returns an unsubscribe function.
     */
    onConfig(cb, { replay = true } = {}) {
      if (typeof cb !== "function") return () => { };
      this._onConfigCbs.add(cb);
      if (replay && this._cfg) {
        const snapshot = this._snapshotForUi();
        queueMicrotask(() => {
          if (this._onConfigCbs.has(cb)) cb(snapshot);
        });
      }
      return () => this._onConfigCbs.delete(cb);
    }

    /**
     * Subscribe battery updates.
     * Returns an unsubscribe function.
     */
    onBattery(cb) {
      if (typeof cb !== "function") return () => { };
      this._onBatteryCbs.add(cb);
      return () => this._onBatteryCbs.delete(cb);
    }

    /**
     * Subscribe raw input reports from HID inputreport events.
     * Returns an unsubscribe function.
     */
    onRawReport(cb) {
      if (typeof cb !== "function") return () => { };
      this._onRawReportCbs.add(cb);
      return () => this._onRawReportCbs.delete(cb);
    }

    getCachedConfig() {
      return this._snapshotForUi();
    }

    /**
     * Refreshes runtime state from device and emits config/battery events.
     */
    async requestConfig() {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const updates = await this._readDeviceStateSnapshot({
          mode: SNAPSHOT_READ_MODE.REFRESH_FULL,
        });
        if (updates && Object.keys(updates).length) {
          this._cfg = Object.assign({}, this._cfg, updates);
        }
        this._emitConfig();

        if (this._caps().battery) {
          this._emitBattery({
            batteryPercent: this._cfg.batteryPercent,
            batteryIsCharging: this._cfg.batteryIsCharging,
          });
        }

        return this.getCachedConfig();
      });
    }

    async requestConfiguration() { return this.requestConfig(); }
    async getConfig() { return this.requestConfig(); }
    async readConfig() { return this.requestConfig(); }
    async requestDeviceConfig() { return this.requestConfig(); }

    /**
     * Read battery-related fields only.
     */
    async requestBattery() {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const caps = this._caps();
        if (!caps.battery) {
          throw new ProtocolError("Battery is not supported for this device", "NOT_SUPPORTED_FOR_DEVICE", {
            pid: this._pid(),
          });
        }

        const updates = await this._readBatterySnapshot();
        this._cfg = Object.assign({}, this._cfg, updates);

        const bat = {
          batteryPercent: this._cfg.batteryPercent,
          batteryIsCharging: this._cfg.batteryIsCharging,
        };
        this._emitBattery(bat);
        this._emitConfig();
        return bat;
      });
    }

    /**
     * Batch write entry:
     * - compile commands via planner
     * - execute in order
     * - update cached state and emit events
     */
    async setBatchFeatures(obj) {
      const payload = isObject(obj) ? obj : {};

      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const { patch, nextState, commands } = this._planner.plan(this._cfg, payload);

        if (commands.length) {
          try {
            await this._driver.runSequence(commands);
          } catch (err) {
            // On write failure, run a protocol-level readback reconciliation once
            // so the UI cache realigns with the device's actual state.
            try {
              const updates = await this._readDeviceStateSnapshot({
                mode: SNAPSHOT_READ_MODE.REFRESH_FULL,
              });
              if (updates && Object.keys(updates).length) {
                this._cfg = Object.assign({}, this._cfg, updates);
              }
              this._emitConfig();
              if (this._caps().battery) {
                this._emitBattery({
                  batteryPercent: this._cfg?.batteryPercent,
                  batteryIsCharging: this._cfg?.batteryIsCharging,
                });
              }
            } catch (reconcileErr) {
              console.warn("[Razer] Write reconcile failed", reconcileErr);
            }
            throw err;
          }
        }

        this._cfg = Object.assign({}, this._cfg, nextState);
        this._emitConfig();

        if (this._caps().battery) {
          this._emitBattery({
            batteryPercent: this._cfg.batteryPercent,
            batteryIsCharging: this._cfg.batteryIsCharging,
          });
        }

        return { patch, commands };
      });
    }

    async setFeature(key, value) {
      const k = String(key || "");
      if (!k) throw new ProtocolError("setFeature() requires key", "BAD_PARAM");
      return this.setBatchFeatures({ [k]: value });
    }

    async setDpi(slot, value, opts = {}) {
      const requestedSlot = clampInt(slot, 1, RAZER_MAX_DPI_STAGES);
      const base = TRANSFORMERS.normalizeDpiStages(this._cfg?.dpiStages, this._cfg?.dpiStages);
      const targetCount = clampInt(Math.max(base.length, requestedSlot), 1, RAZER_MAX_DPI_STAGES);
      const next = base.slice(0, targetCount);
      while (next.length < targetCount) {
        const seed = next[next.length - 1] || base[base.length - 1] || { x: 1600, y: 1600 };
        next.push({ x: seed.x, y: seed.y });
      }
      const s = requestedSlot;

      const valObj = isObject(value) ? value : null;
      const nextX = TRANSFORMERS.clampDpi(valObj ? (valObj.x ?? valObj.X ?? valObj.y ?? valObj.Y) : value);
      const nextY = TRANSFORMERS.clampDpi(valObj ? (valObj.y ?? valObj.Y ?? nextX) : nextX);
      next[s - 1] = { x: nextX, y: nextY };

      const patch = { dpiStages: next };
      if (opts && opts.select) {
        patch.activeDpiStageIndex = s - 1;
      }
      return this.setBatchFeatures(patch);
    }

    async setDpiSlotCount(n) {
      const count = clampInt(n, 1, RAZER_MAX_DPI_STAGES);
      const base = TRANSFORMERS.normalizeDpiStages(this._cfg?.dpiStages, this._cfg?.dpiStages);
      const next = base.slice(0, count);
      while (next.length < count) {
        // Initialize newly added stages to 800 uniformly to avoid showing inherited adjacent-stage values first.
        next.push({ x: 800, y: 800 });
      }

      const patch = { dpiStages: next };
      const active = clampInt(this._cfg?.activeDpiStageIndex ?? 0, 0, Math.max(0, count - 1));
      patch.activeDpiStageIndex = active;
      return this.setBatchFeatures(patch);
    }

    async setSlotCount(n) {
      return this.setDpiSlotCount(n);
    }

    async setActiveDpiSlotIndex(index) {
      const max = Math.max(0, (Array.isArray(this._cfg?.dpiStages) ? this._cfg.dpiStages.length : 1) - 1);
      const idx = clampInt(index, 0, max);
      return this.setBatchFeatures({ activeDpiStageIndex: idx });
    }

    async setCurrentDpiIndex(index) {
      return this.setActiveDpiSlotIndex(index);
    }

    async setButtonMappingBySelect(btnId, labelOrObj) {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const slot = clampInt(btnId, 1, 6);
        const buttonId = OFFICIAL_OBM_SLOT_TO_BUTTON_ID[slot];
        if (!buttonId) {
          throw new ProtocolError(`Unsupported Razer button slot: ${btnId}`, "BAD_PARAM", { btnId });
        }

        const resolved = resolveButtonMappingActionInput(slot, labelOrObj);
        if (!resolved?.action) {
          throw new ProtocolError(`Unknown or unsupported button action: ${String(labelOrObj ?? "")}`, "BAD_PARAM", {
            btnId: slot,
            value: labelOrObj,
          });
        }

        const assignment = buildOfficialObmAssignmentFromPublicAction(resolved.action);
        if (!assignment) {
          throw new ProtocolError(`Button action is not writable via official Razer OBM path: ${String(resolved.label || resolved.source || "")}`, "FEATURE_UNAVAILABLE", {
            btnId: slot,
            label: resolved.label || resolved.source || "",
          });
        }

        const tx = txForField(this._pid(), "buttonMappings");
        await this._driver.runSequence([{
          packet: ProtocolCodec.commands.setSingleButtonAssignment(
            tx,
            OFFICIAL_MOUSE_PROFILE_ID,
            buttonId,
            OFFICIAL_BUTTON_MODE.NORMAL,
            assignment.functionId,
            assignment.dataSize,
            assignment.dataArray
          ),
          waitMs: RAZER_OBM_BUTTON_IO_WAIT_MS,
        }]);

        let verified = null;
        try {
          verified = await this._readSingleOfficialObmButtonMapping(slot);
        } catch (err) {
          throw new ProtocolError("Button mapping verify readback failed", "VERIFY_FAILED", {
            btnId: slot,
            expected: normalizeButtonMappingEntry(resolved.action, resolved.source || resolved.label || ""),
            cause: err,
          });
        }
        if (!isSameButtonAction(verified, resolved.action)) {
          throw new ProtocolError("Button mapping verify mismatch", "VERIFY_FAILED", {
            btnId: slot,
            expected: normalizeButtonMappingEntry(resolved.action, resolved.source || resolved.label || ""),
            actual: verified,
          });
        }

        const defaultMappings = buildDefaultRazerButtonMappings();
        const nextMappings = Array.isArray(this._cfg?.buttonMappings)
          ? this._cfg.buttonMappings.slice(0, 6)
          : defaultMappings.slice(0, 6);
        while (nextMappings.length < 6) {
          nextMappings.push(defaultMappings[nextMappings.length] || normalizeButtonMappingEntry());
        }
        nextMappings[slot - 1] = verified;
        this._cfg = Object.assign({}, this._cfg, { buttonMappings: nextMappings });
        this._emitConfig();
      });
    }

    async _safeQuery(packet, fallback = null, opts = {}) {
      const {
        swallowPermissionPathError = true,
        swallowCodes = ["DEVICE_COMMAND_NOT_SUPPORTED"],
        ...sendOpts
      } = opts || {};
      const allowedCodes = new Set(
        Array.isArray(swallowCodes)
          ? swallowCodes.map((code) => String(code || ""))
          : []
      );
      try {
        return await this._driver.sendAndWait(packet, sendOpts);
      } catch (err) {
        if (isPermissionPathError(err)) {
          if (swallowPermissionPathError) return fallback;
          throw err;
        }
        if (allowedCodes.has(String(err?.code || ""))) {
          return fallback;
        }
        throw err;
      }
    }

    async _readSingleOfficialObmButtonMapping(btnId) {
      const slot = clampInt(btnId, 1, 6);
      const buttonId = OFFICIAL_OBM_SLOT_TO_BUTTON_ID[slot];
      if (!buttonId) {
        throw new ProtocolError(`Unsupported Razer button slot: ${btnId}`, "BAD_PARAM", { btnId });
      }

      const pid = this._pid();
      let lastErr = null;
      for (let attempt = 1; attempt <= RAZER_OBM_BUTTON_IO_RETRY; attempt++) {
        try {
          const tx = txForField(pid, "buttonMappings");
          const res = await this._driver.sendAndWait(
            ProtocolCodec.commands.getSingleButtonAssignment(
              tx,
              OFFICIAL_MOUSE_PROFILE_ID,
              buttonId,
              OFFICIAL_BUTTON_MODE.NORMAL
            ),
            { waitMs: RAZER_OBM_BUTTON_IO_WAIT_MS }
          );
          return buildPublicActionFromOfficialObmAssignment(
            parseOfficialObmAssignment(res, OFFICIAL_BUTTON_MODE.NORMAL)
          );
        } catch (err) {
          lastErr = err;
          if (attempt >= RAZER_OBM_BUTTON_IO_RETRY || !shouldRetryOfficialObmButtonIoError(err)) {
            throw err;
          }
          await sleep(RAZER_OBM_BUTTON_IO_RETRY_DELAY_MS);
        }
      }

      throw lastErr || new ProtocolError("OBM button mapping read failed", "OBM_READ_FAILED", {
        btnId: slot,
        buttonId,
      });
    }

    async _readButtonMappingsSnapshot() {
      this._ensureSupported();
      const cached = Array.isArray(this._cfg?.buttonMappings) && this._cfg.buttonMappings.length
        ? this._cfg.buttonMappings
        : buildDefaultRazerButtonMappings();
      const out = [];

      for (let slot = 1; slot <= 6; slot++) {
        const fallback = normalizeButtonMappingEntry(
          cached[slot - 1],
          DEFAULT_RAZER_BUTTON_SOURCE_BY_BUTTON[slot]
        );
        const buttonId = OFFICIAL_OBM_SLOT_TO_BUTTON_ID[slot];
        if (!buttonId) {
          out.push(fallback);
          continue;
        }

        try {
          out.push(await this._readSingleOfficialObmButtonMapping(slot));
        } catch (err) {
          console.warn("[Razer] OBM button read failed", { slot, buttonId, err });
          out.push(fallback);
        }
      }

      return out;
    }

    // Read battery + charging + idle + low-threshold snapshot.
    async _readBatterySnapshot() {
      const pid = this._ensureSupported();
      const caps = this._caps();
      if (!caps.battery) {
        throw new ProtocolError("Battery is not supported for this device", "NOT_SUPPORTED_FOR_DEVICE", { pid });
      }

      const tx = txForField(pid, "battery");
      const defaultRawThreshold = TRANSFORMERS.normalizeLowThreshold(
        this._cfg?.chargeLowThreshold ?? TRANSFORMERS.lowPowerPercentToRaw(this._cfg?.lowPowerThresholdPercent ?? 15)
      );
      const out = {
        batteryPercent: -1,
        batteryIsCharging: false,
        deviceIdleTime: this._cfg?.deviceIdleTime ?? 300,
        chargeLowThreshold: defaultRawThreshold,
        lowPowerThresholdPercent: TRANSFORMERS.lowPowerRawToPercent(defaultRawThreshold),
      };

      const batteryRes = await this._safeQuery(ProtocolCodec.commands.getBattery(tx));
      if (batteryRes?.arguments) {
        out.batteryPercent = TRANSFORMERS.batteryPercentFromRaw(batteryRes.arguments[1] ?? 0);
      }

      const chargingRes = await this._safeQuery(ProtocolCodec.commands.getCharging(tx));
      if (chargingRes?.arguments) {
        out.batteryIsCharging = !!(chargingRes.arguments[1] ?? 0);
      }

      if (caps.idle) {
        const idleRes = await this._safeQuery(ProtocolCodec.commands.getIdle(tx));
        if (idleRes?.arguments) {
          const rawIdleSec = ((idleRes.arguments[0] << 8) | (idleRes.arguments[1] & 0xff)) & 0xffff;
          out.deviceIdleTime = TRANSFORMERS.normalizeIdleTime(rawIdleSec);
        }
      }

      if (caps.lowBatteryThreshold) {
        const txLow = txForField(pid, "chargeLowThreshold");
        const lowRes = await this._safeQuery(ProtocolCodec.commands.getLowBatteryThreshold(txLow));
        if (lowRes?.arguments) {
          out.chargeLowThreshold = TRANSFORMERS.normalizeLowThreshold(lowRes.arguments[0]);
          out.lowPowerThresholdPercent = TRANSFORMERS.lowPowerRawToPercent(out.chargeLowThreshold);
        }
      }

      return out;
    }

    // Read the serialized runtime snapshot used by connect bootstrap and later refreshes.
    async _readDeviceStateSnapshot({ mode = SNAPSHOT_READ_MODE.REFRESH_FULL } = {}) {
      const pid = this._ensureSupported();
      const caps = this._caps();
      const tx = txForField(pid, "snapshot");
      const snapshotMode = this._resolveSnapshotReadMode(mode);
      const isConnectFull = snapshotMode === SNAPSHOT_READ_MODE.CONNECT_FULL;
      const updates = {
        deviceName: PID_NAME[pid] || (this.device?.productName ? String(this.device.productName) : "Razer Mouse"),
        capabilities: this._capabilitiesSnapshot(caps),
      };

      if (isConnectFull || !this._hasStaticSnapshotValue("firmwareVersion")) {
        const fw = await this._safeQuery(ProtocolCodec.commands.getFirmwareVersion(tx));
        if (fw?.arguments) {
          updates.firmwareVersion = `v${Number(fw.arguments[0] ?? 0)}.${Number(fw.arguments[1] ?? 0)}`;
        }
      }

      if (isConnectFull || !this._hasStaticSnapshotValue("serial")) {
        const serial = await this._safeQuery(ProtocolCodec.commands.getSerial(tx));
        if (serial?.arguments) {
          updates.serial = asciiFromBytes(serial.arguments.subarray(0, 22));
        }
      }

      if (caps.pollingMode === "v2") {
        const poll = await this._safeQuery(ProtocolCodec.commands.getPollingRate2(tx));
        if (poll?.arguments) {
          updates.pollingHz = TRANSFORMERS.pollingV2Decode(poll.arguments[1]);
        }
      } else {
        const poll = await this._safeQuery(ProtocolCodec.commands.getPollingRate(tx));
        if (poll?.arguments) {
          updates.pollingHz = TRANSFORMERS.pollingLegacyDecode(poll.arguments[0]);
        }
      }

      const stages = await this._safeQuery(ProtocolCodec.commands.getDpiStages(tx, OFFICIAL_MOUSE_PROFILE_ID));
      if (stages?.arguments) {
        const parsed = TRANSFORMERS.parseDpiStagesResponse(stages);
        if (parsed.dpiStages?.length) {
          this._updateDpiWriteContext(parsed.classId ?? OFFICIAL_MOUSE_PROFILE_ID, parsed.stageIds ?? []);
          const activeIndex = clampInt(parsed.activeDpiStageIndex ?? 0, 0, Math.max(0, parsed.dpiStages.length - 1));
          const activeStage = parsed.dpiStages[activeIndex] || parsed.dpiStages[0] || null;
          updates.dpiStages = parsed.dpiStages;
          updates.activeDpiStageIndex = activeIndex;
          if (activeStage) {
            updates.dpi = {
              x: activeStage.x,
              y: activeStage.y,
            };
          }
        }
      }

      if (!isObject(updates.dpi)) {
        const dpi = await this._safeQuery(ProtocolCodec.commands.getDpiXY(tx, OFFICIAL_MOUSE_PROFILE_ID));
        if (dpi?.arguments) {
          updates.dpi = {
            x: ((dpi.arguments[1] << 8) | (dpi.arguments[2] & 0xff)) & 0xffff,
            y: ((dpi.arguments[3] << 8) | (dpi.arguments[4] & 0xff)) & 0xffff,
          };
        }
      }

      if (caps.battery) {
        const battery = await this._readBatterySnapshot();
        Object.assign(updates, battery);
      }

      if (caps.hyperpollingIndicatorMode) {
        const txHyper = txForField(pid, "hyperpollingIndicatorMode");
        const hyper = await this._safeQuery(ProtocolCodec.commands.getHyperpollingIndicatorMode(txHyper));
        if (hyper?.arguments) {
          updates.hyperpollingIndicatorMode = TRANSFORMERS.normalizeHyperIndicatorMode(hyper.arguments[0]);
        }
      }

      if (caps.dynamicSensitivity) {
        const txDyn = txForField(pid, "dynamicSensitivity");
        const dynEnabled = await this._safeQuery(ProtocolCodec.commands.getProximitySensorAccelerationState(txDyn));
        if (dynEnabled?.arguments) {
          updates.dynamicSensitivityEnabled = !!clampU8(dynEnabled.arguments[1] ?? 0);
        }
        const dynMode = await this._safeQuery(ProtocolCodec.commands.getProximitySensorAccelerationMode(txDyn));
        if (dynMode?.arguments) {
          updates.dynamicSensitivityMode = TRANSFORMERS.normalizeDynamicSensitivityMode(dynMode.arguments[1] ?? 1);
        }
      }

      if (caps.sensorAngle) {
        const txAngle = txForField(pid, "sensorAngle");
        const angleRes = await this._safeQuery(ProtocolCodec.commands.getSensorAngle(txAngle));
        if (angleRes?.arguments) {
          updates.sensorAngle = TRANSFORMERS.normalizeSensorAngle(
            TRANSFORMERS.fromInt8Raw(angleRes.arguments[2] ?? 0)
          );
        }
      }

      if (caps.smartTracking) {
        const txTracking = txForField(pid, "smartTracking");
        const officialSmartTracking = Object.assign(
          {},
          DEFAULT_RAZER_SMART_TRACKING_OFFICIAL_MODEL,
          buildOfficialSmartTrackingModelFromPublicState(this._cfg)
        );
        const liftRes = await this._safeQuery(
          ProtocolCodec.commands.getProximitySensorLiftSetting(
            txTracking,
            OFFICIAL_PROXIMITY_CLASS_ID,
            OFFICIAL_PROXIMITY_SENSOR_ID
          )
        );
        if (liftRes?.arguments) {
          const modeSel = clampU8(liftRes.arguments[2] ?? 0x01);
          officialSmartTracking.isAsymmetric = modeSel === 0x04;
          if (liftRes.arguments[3] != null) {
            officialSmartTracking.trackingDistance = TRANSFORMERS.smartTrackingLevelToTrackingDistance(
              liftRes.arguments[3]
            );
          }
        }

        const distRes = await this._safeQuery(
          ProtocolCodec.commands.getProximitySensorConfiguration(
            txTracking,
            OFFICIAL_PROXIMITY_CLASS_ID,
            OFFICIAL_PROXIMITY_SENSOR_ID
          )
        );
        if (distRes?.arguments) {
          if (distRes.arguments[3] != null) {
            officialSmartTracking.liftOffDistance = clampU8(distRes.arguments[3]) + 1;
          }
          if (distRes.arguments[4] != null) {
            officialSmartTracking.landingDistance = clampU8(distRes.arguments[4]) + 1;
          }
        }
        Object.assign(updates, buildPublicSmartTrackingStateFromOfficialModel(officialSmartTracking));
      }

      const buttonMappings = await this._readButtonMappingsSnapshot();
      if (Array.isArray(buttonMappings) && buttonMappings.length) {
        updates.buttonMappings = buttonMappings;
      }

      // Button mapping snapshot now uses the official OBM path for every Razer PID.

      return updates;
    }
  }

  // ============================================================
  // 8) ProtocolApi exports
  // ============================================================
  const root = typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : global);
  const ProtocolApi = (root.ProtocolApi = root.ProtocolApi || {});

  ProtocolApi.RAZER_HID = {
    vendorId: RAZER_VENDOR_ID,
    productIds: SUPPORTED_PIDS.slice(0),
    defaultFilters: SUPPORTED_PIDS.map((productId) => ({
      vendorId: RAZER_VENDOR_ID,
      productId,
      usagePage: RAZER_WEBHID_CONTROL_USAGE_PAGE,
    })),
    isSupportedPid(productId) {
      return SUPPORTED_PID_SET.has(Number(productId));
    },
    getTransportMeta(productId) {
      const meta = getTransportMetaForPid(productId);
      return meta ? Object.assign({}, meta) : null;
    },
  };

  ProtocolApi.resolveMouseDisplayName = function resolveMouseDisplayName(vendorId, productId, fallbackName) {
    const vid = Number(vendorId) & 0xffff;
    const pid = Number(productId) & 0xffff;
    if (vid === RAZER_VENDOR_ID) {
      return PID_NAME[pid] || String(fallbackName || "Razer Mouse");
    }
    return String(fallbackName || `VID 0x${vid.toString(16)} PID 0x${pid.toString(16)}`);
  };

  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  ProtocolApi.listKeyActionsByType = function listKeyActionsByType() {
    const buckets = Object.create(null);
    for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
      if (!OFFICIAL_OBM_WRITABLE_LABELS.has(label)) continue;
      const type = String(action?.type || "system");
      if (!buckets[type]) buckets[type] = [];
      buckets[type].push(label);
    }
    return Object.entries(buckets).map(([type, items]) => ({ type, items }));
  };

  ProtocolApi.labelFromFunckeyKeycode = function labelFromFunckeyKeycode(funckey, keycode) {
    const fk = Number(funckey);
    const kc = Number(keycode);
    return FUNCKEY_KEYCODE_TO_LABEL.get(`${fk}:${kc}`) || `未知(${fk},${kc})`;
  };

  if (!ProtocolApi.MOUSE_HID) {
    ProtocolApi.MOUSE_HID = ProtocolApi.RAZER_HID;
  }

  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
  ProtocolApi.RazerHidApi = MouseMouseHidApi;
})();
