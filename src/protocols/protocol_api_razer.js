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
  const RAZER_BUSY_RETRY = 32;
  // Small backoff reduces transient misalignment loops on some hosts/dongles.
  const RAZER_RETRY_BACKOFF_MS = 16;
  // When only one report-id is available, allow short retry for transient NotAllowedError.
  const RAZER_NOT_ALLOWED_SAME_ID_RETRY = 2;
  // Some wireless paths need a short settle window right after open().
  const RAZER_POST_OPEN_SETTLE_MS = 60;

  const PID = Object.freeze({
    VIPER_V3_PRO_WIRED: 0x00c0,
    VIPER_V3_PRO_WIRELESS: 0x00c1,
    DEATHADDER_V3_PRO_WIRED_ALT: 0x00c2,
    DEATHADDER_V3_PRO_WIRELESS_ALT: 0x00c3,
    DEATHADDER_V3_HYPERSPEED_WIRED: 0x00c4,
    DEATHADDER_V3_HYPERSPEED_WIRELESS: 0x00c5,
  });

  const PID_NAME = Object.freeze({
    [PID.VIPER_V3_PRO_WIRED]: "Razer Viper V3 Pro (Wired)",
    [PID.VIPER_V3_PRO_WIRELESS]: "Razer Viper V3 Pro (Wireless)",
    [PID.DEATHADDER_V3_PRO_WIRED_ALT]: "Razer DeathAdder V3 Pro (Wired Alt)",
    [PID.DEATHADDER_V3_PRO_WIRELESS_ALT]: "Razer DeathAdder V3 Pro (Wireless Alt)",
    [PID.DEATHADDER_V3_HYPERSPEED_WIRED]: "Razer DeathAdder V3 HyperSpeed (Wired)",
    [PID.DEATHADDER_V3_HYPERSPEED_WIRELESS]: "Razer DeathAdder V3 HyperSpeed (Wireless)",
  });

  // OpenRazer driver (driver/razermouse_driver.c) uses report index 0x00 for this PID family.
  // Keep it hardcoded to avoid interface/report-id probing guesses.
  const PID_FEATURE_REPORT_ID = Object.freeze({
    [PID.VIPER_V3_PRO_WIRED]: 0x00,
    [PID.VIPER_V3_PRO_WIRELESS]: 0x00,
    [PID.DEATHADDER_V3_PRO_WIRED_ALT]: 0x00,
    [PID.DEATHADDER_V3_PRO_WIRELESS_ALT]: 0x00,
    [PID.DEATHADDER_V3_HYPERSPEED_WIRED]: 0x00,
    [PID.DEATHADDER_V3_HYPERSPEED_WIRELESS]: 0x00,
  });

  const SUPPORTED_PIDS = Object.freeze(Object.values(PID));
  const SUPPORTED_PID_SET = new Set(SUPPORTED_PIDS);

  const REPORT_STATUS = Object.freeze({
    NEW_COMMAND: 0x00,
    BUSY: 0x01,
    SUCCESSFUL: 0x02,
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

  const PID_POLLING_V2 = new Set([PID.VIPER_V3_PRO_WIRELESS]);

  const PID_BATTERY = new Set([
    PID.VIPER_V3_PRO_WIRED,
    PID.VIPER_V3_PRO_WIRELESS,
    PID.DEATHADDER_V3_PRO_WIRED_ALT,
    PID.DEATHADDER_V3_PRO_WIRELESS_ALT,
    PID.DEATHADDER_V3_HYPERSPEED_WIRED,
    PID.DEATHADDER_V3_HYPERSPEED_WIRELESS,
  ]);

  const PID_HYPER_INDICATOR = new Set([PID.VIPER_V3_PRO_WIRELESS]);

  const PID_LOW_THRESHOLD_TX_FF = new Set([]);

  function getWaitMsForPid(pid) {
    // Mirrors razer_get_report() wait groups in razermouse_driver.c.
    if (pid === PID.VIPER_V3_PRO_WIRELESS) return 60;
    return 31;
  }

  function buildCapabilities(pid) {
    return {
      supported: SUPPORTED_PID_SET.has(pid),
      polling: true,
      pollingMode: PID_POLLING_V2.has(pid) ? "v2" : "legacy",
      dpi: true,
      dpiStages: true,
      battery: PID_BATTERY.has(pid),
      charging: PID_BATTERY.has(pid),
      idle: PID_BATTERY.has(pid),
      lowBatteryThreshold: PID_BATTERY.has(pid),
      lowPowerThresholdPercent: PID_BATTERY.has(pid),
      hyperpollingIndicatorMode: PID_HYPER_INDICATOR.has(pid),
      dynamicSensitivity: SUPPORTED_PID_SET.has(pid),
      smartTracking: SUPPORTED_PID_SET.has(pid),
      sensorAngle: SUPPORTED_PID_SET.has(pid),
    };
  }

  function txForField(pid, field) {
    if (field === "chargeLowThreshold" && PID_LOW_THRESHOLD_TX_FF.has(pid)) return 0xff;
    if (field === "lowPowerThresholdPercent" && PID_LOW_THRESHOLD_TX_FF.has(pid)) return 0xff;
    if (field === "hyperpollingIndicatorMode" && pid === PID.VIPER_V3_PRO_WIRELESS) return 0xff;
    if (field === "dynamicSensitivity") return RAZER_CONST.TX_DEFAULT;
    if (field === "smartTracking") return RAZER_CONST.TX_DEFAULT;
    if (field === "sensorAngle") return RAZER_CONST.TX_DEFAULT;
    if (field === "buttonMapping") return RAZER_CONST.TX_DEFAULT;
    return RAZER_CONST.TX_DEFAULT;
  }

  function normalizePid(device) {
    return Number(device?.productId ?? device?.productID ?? 0);
  }

  function getFeatureReportIdForPid(pid) {
    const rid = PID_FEATURE_REPORT_ID[Number(pid)];
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
    }

    setDevice(device, productId = 0) {
      this.device = device || null;
      this.productId = Number(productId || 0);
      this._featureReportIds = this._collectFeatureReportIds();
    }

    _requireOpenDevice() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("HID device is not opened", "NOT_OPEN");
    }

    _collectFeatureReportIds() {
      // No report-id probing. Use the OpenRazer-aligned fixed report index.
      return [getFeatureReportIdForPid(this.productId)];
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
     * Send one command packet and wait for a matching response.
     * Matching rule follows openrazer: remainingPackets + class + commandId.
     */
    async sendAndWait(packet, opts = {}) {
      return this.queue.enqueue(async () => {
        this._requireOpenDevice();

        const requestBytes = packet instanceof Uint8Array
          ? ProtocolCodec.fitReport(packet)
          : ProtocolCodec.encodeRazerReport(packet || {});

        const request = ProtocolCodec.parseRazerReport(requestBytes);

        const reportId = Number(this._featureReportIds[0] ?? getFeatureReportIdForPid(this.productId));

        const busyRetry = RAZER_BUSY_RETRY;
        const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : getWaitMsForPid(this.productId);
        const responseValidator = typeof opts.responseValidator === "function"
          ? opts.responseValidator
          : null;

        let lastErr = null;

        for (let attempt = 0; attempt <= busyRetry; attempt++) {
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
                  remainingPackets: request.remainingPackets,
                  commandClass: request.commandClass,
                  commandId: request.commandId,
                },
                got: {
                  remainingPackets: response.remainingPackets,
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

            if (response.status === REPORT_STATUS.BUSY) {
              if (attempt < busyRetry) continue;
              throw new ProtocolError("Razer device stayed busy", "DEVICE_BUSY", { reportId, attempts: attempt + 1 });
            }

            if (response.status === REPORT_STATUS.FAILURE) {
              throw new ProtocolError("Razer command failed", "DEVICE_COMMAND_FAILURE", { reportId, response });
            }
            if (response.status === REPORT_STATUS.TIMEOUT) {
              throw new ProtocolError("Razer command timeout status", "DEVICE_COMMAND_TIMEOUT", { reportId, response });
            }
            if (response.status === REPORT_STATUS.NOT_SUPPORTED) {
              throw new ProtocolError("Razer command not supported", "DEVICE_COMMAND_NOT_SUPPORTED", { reportId, response });
            }

            return response;
          } catch (err) {
            lastErr = err;
            const name = String(err?.name || "");
            const msg = String(err?.message || "").toLowerCase();
            const code = String(err?.code || "");

            // Keep retries on the same fixed report-id; never switch IDs.
            const isNotAllowed = name === "NotAllowedError" || msg.includes("notallowederror");
            const isFeatureWriteErr = msg.includes("failed to write the feature report");
            const isFeatureReadErr = msg.includes("failed to receive the feature report")
              || msg.includes("failed to read the feature report");

            const isPermissionPathErr = isNotAllowed || isFeatureWriteErr || isFeatureReadErr;

            if (isPermissionPathErr) {
              if (attempt < Math.min(busyRetry, RAZER_NOT_ALLOWED_SAME_ID_RETRY)) {
                if (RAZER_RETRY_BACKOFF_MS > 0) await sleep(RAZER_RETRY_BACKOFF_MS);
                continue;
              }
              throw err;
            }

            if (
              code === "IO_READ_TIMEOUT"
              || code === "RESPONSE_MISMATCH"
              || code === "RESPONSE_VALIDATION_FAILED"
            ) {
              if (RAZER_RETRY_BACKOFF_MS > 0) await sleep(RAZER_RETRY_BACKOFF_MS);
            }
            if (attempt >= busyRetry) throw err;
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
      if (src.byteLength === RAZER_REPORT_LEN) return src;
      const out = new Uint8Array(RAZER_REPORT_LEN);
      out.set(src.subarray(0, RAZER_REPORT_LEN));
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
        req.remainingPackets === res.remainingPackets &&
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

      setDpiXY(tx, dpiX, dpiY) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x05,
          dataSize: 0x07,
          arguments: [
            RAZER_CONST.VARSTORE,
            (clampU16(dpiX) >> 8) & 0xff,
            clampU16(dpiX) & 0xff,
            (clampU16(dpiY) >> 8) & 0xff,
            clampU16(dpiY) & 0xff,
            0x00,
            0x00,
          ],
        });
      },

      getDpiXY(tx, variableStorage = RAZER_CONST.NOSTORE) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x85,
          dataSize: 0x07,
          arguments: [clampU8(variableStorage)],
        });
      },

      setDpiStages(tx, stages, activeStageOneBased) {
        const count = clampInt(stages.length, 1, RAZER_MAX_DPI_STAGES);
        const argsLen = 3 + count * 7;

        const args = new Uint8Array(argsLen);
        args[0] = RAZER_CONST.VARSTORE;
        args[1] = clampInt(activeStageOneBased, 1, count);
        args[2] = count;

        let offset = 3;
        for (let i = 0; i < count; i++) {
          const stage = stages[i] || { x: 800, y: 800 };
          const x = clampU16(stage.x);
          const y = clampU16(stage.y);
          args[offset++] = i;
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


      getDpiStages(tx, variableStorage = RAZER_CONST.VARSTORE) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x04,
          commandId: 0x86,
          dataSize: 0x26,
          arguments: [clampU8(variableStorage)],
        });
      },

      setButtonMappingRep4(tx, sourceCode, actionQuad) {
        const src = clampU16(sourceCode);
        const action = Array.isArray(actionQuad) ? actionQuad.slice(0, 4) : [];
        if (action.length !== 4) {
          throw new ProtocolError("REP4 actionQuad must be [act0,act1,act2,act3]", "BAD_PARAM", {
            actionQuad,
          });
        }
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x02,
          commandId: 0x0c,
          dataSize: 0x0a,
          // Synapse capture layout:
          // [01, src_lo, src_hi, act0, act1, act2, act3, 00, 00, 00]
          arguments: [
            0x01,
            src & 0xff,
            (src >> 8) & 0xff,
            clampU8(action[0]),
            clampU8(action[1]),
            clampU8(action[2]),
            clampU8(action[3]),
            0x00,
            0x00,
            0x00,
          ],
        });
      },

      getButtonMappingRep4(tx, sourceCode) {
        const src = clampU16(sourceCode);
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x02,
          commandId: 0x8c,
          dataSize: 0x0a,
          // Readback keeps the same payload envelope as write:
          // [01, src_lo, src_hi, 00, 00, 00, 00, 00, 00, 00]
          arguments: [
            0x01,
            src & 0xff,
            (src >> 8) & 0xff,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ],
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

      setDynamicSensitivityEnabled(tx, enabled) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x10,
          dataSize: 0x02,
          arguments: [0x01, enabled ? 0x01 : 0x00],
        });
      },

      getDynamicSensitivityEnabled(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x90,
          dataSize: 0x02,
          arguments: [0x01, 0x00],
        });
      },

      setDynamicSensitivityMode(tx, mode) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x11,
          dataSize: 0x02,
          arguments: [0x01, clampInt(mode, 0, 2)],
        });
      },

      getDynamicSensitivityMode(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x91,
          dataSize: 0x02,
          arguments: [0x01, 0x00],
        });
      },

      setSensorAngle(tx, angle) {
        const a = clampInt(angle, -44, 44);
        const raw = a < 0 ? (0x100 + a) & 0xff : a & 0xff;
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x14,
          dataSize: 0x03,
          arguments: [0x01, 0x01, raw],
        });
      },

      getSensorAngle(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x94,
          dataSize: 0x03,
          arguments: [0x01, 0x01, 0x00],
        });
      },

      setSmartTrackingPrelude(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x03,
          dataSize: 0x03,
          arguments: [0x00, 0x04, 0x01],
        });
      },

      setSmartTrackingModeSymmetric(tx, level) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x0b,
          dataSize: 0x04,
          arguments: [0x00, 0x04, 0x01, clampInt(level, 0, 2)],
        });
      },

      setSmartTrackingModeAsymmetric(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x0b,
          dataSize: 0x04,
          arguments: [0x00, 0x04, 0x04, 0x00],
        });
      },

      getSmartTrackingMode(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x8b,
          dataSize: 0x04,
          arguments: [0x00, 0x04, 0x00, 0x00],
        });
      },

      setSmartTrackingAsymmetricDistances(tx, liftDistance, landingDistance) {
        let lift = clampInt(liftDistance, 2, 26);
        let landing = clampInt(landingDistance, 1, 25);
        if (landing >= lift) {
          lift = Math.min(26, landing + 1);
          if (landing >= lift) landing = Math.max(1, lift - 1);
        }
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x05,
          dataSize: 0x0a,
          arguments: [
            0x00,
            0x04,
            clampU8(lift - 1),
            clampU8(landing - 1),
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ],
        });
      },

      getSmartTrackingAsymmetricDistances(tx) {
        return ProtocolCodec.encodeRazerReport({
          transactionId: tx,
          commandClass: 0x0b,
          commandId: 0x85,
          dataSize: 0x0a,
          arguments: [0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
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
      const activeOneBased = clampInt(args[1] ?? 1, 1, Math.max(1, count));
      const stages = [];
      let offset = 3;

      for (let i = 0; i < count; i++) {
        const dpiOffset = offset + 1;
        if (dpiOffset + 4 > payloadSize) break;
        const x = ((args[offset + 1] << 8) | args[offset + 2]) & 0xffff;
        const y = ((args[offset + 3] << 8) | args[offset + 4]) & 0xffff;
        stages.push({ x: TRANSFORMERS.clampDpi(x), y: TRANSFORMERS.clampDpi(y) });
        offset += 7;
      }

      return {
        dpiStages: stages,
        activeDpiStageIndex: clampInt(activeOneBased - 1, 0, Math.max(0, stages.length - 1)),
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
      return clampInt(v, 0, 2);
    },

    normalizeSmartTrackingMode(v) {
      const s = String(v ?? "symmetric").trim().toLowerCase();
      if (s === "asymmetric" || s === "asym") return "asymmetric";
      return "symmetric";
    },

    normalizeSmartTrackingLevel(v) {
      return clampInt(v, 0, 2);
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
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpi", "dpi/dpiX/dpiY", pid);
        const tx = txForField(pid, "dpi");
        return [{
          packet: ProtocolCodec.commands.setDpiXY(tx, nextState.dpi.x, nextState.dpi.y),
        }];
      },
    },

    dpiStages: {
      key: "dpiStages",
      kind: "direct",
      priority: 30,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiStages", "dpiStages", pid);
        const tx = txForField(pid, "dpiStages");
        const active = clampInt(nextState.activeDpiStageIndex, 0, Math.max(0, nextState.dpiStages.length - 1)) + 1;
        return [{
          packet: ProtocolCodec.commands.setDpiStages(tx, nextState.dpiStages, active),
        }];
      },
    },

    activeDpiStageIndex: {
      key: "activeDpiStageIndex",
      kind: "virtual",
      priority: 31,
      triggers: ["activeDpiStageIndex"],
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiStages", "activeDpiStageIndex", pid);
        const tx = txForField(pid, "activeDpiStageIndex");
        const active = clampInt(nextState.activeDpiStageIndex, 0, Math.max(0, nextState.dpiStages.length - 1)) + 1;
        return [{
          packet: ProtocolCodec.commands.setDpiStages(tx, nextState.dpiStages, active),
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
        return [{ packet: ProtocolCodec.commands.setDynamicSensitivityEnabled(tx, nextState.dynamicSensitivityEnabled) }];
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
          { packet: ProtocolCodec.commands.setDynamicSensitivityEnabled(tx, true) },
          { packet: ProtocolCodec.commands.setDynamicSensitivityMode(tx, nextState.dynamicSensitivityMode) },
        ];
        if (!explicitEnabled) {
          seq.push({ packet: ProtocolCodec.commands.setDynamicSensitivityEnabled(tx, false) });
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
      plan({ pid, caps, patch, nextState }) {
        requireCapability(caps, "smartTracking", "smartTracking", pid);
        const tx = txForField(pid, "smartTracking");
        const mode = TRANSFORMERS.normalizeSmartTrackingMode(nextState.smartTrackingMode);
        const shouldWriteAsymmetricDistance = mode === "asymmetric"
          && (
            Object.prototype.hasOwnProperty.call(patch, "smartTrackingLiftDistance")
            || Object.prototype.hasOwnProperty.call(patch, "smartTrackingLandingDistance")
          );

        const seq = [{ packet: ProtocolCodec.commands.setSmartTrackingPrelude(tx) }];
        if (mode === "asymmetric") {
          seq.push({ packet: ProtocolCodec.commands.setSmartTrackingModeAsymmetric(tx) });
          if (shouldWriteAsymmetricDistance) {
            const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
              nextState.smartTrackingLiftDistance,
              nextState.smartTrackingLandingDistance
            );
            seq.push({ packet: ProtocolCodec.commands.setSmartTrackingAsymmetricDistances(tx, dist.lift, dist.landing) });
          }
        } else {
          seq.push({ packet: ProtocolCodec.commands.setSmartTrackingModeSymmetric(tx, nextState.smartTrackingLevel) });
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
    }

    setProductId(productId) {
      this.productId = Number(productId || 0);
      this.capabilities = buildCapabilities(this.productId);
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

      if (Object.prototype.hasOwnProperty.call(patch, "smartTrackingMode")) {
        next.smartTrackingMode = TRANSFORMERS.normalizeSmartTrackingMode(patch.smartTrackingMode);
      } else {
        next.smartTrackingMode = TRANSFORMERS.normalizeSmartTrackingMode(next.smartTrackingMode ?? "symmetric");
      }

      if (Object.prototype.hasOwnProperty.call(patch, "smartTrackingLevel")) {
        next.smartTrackingLevel = TRANSFORMERS.normalizeSmartTrackingLevel(patch.smartTrackingLevel);
      } else {
        next.smartTrackingLevel = TRANSFORMERS.normalizeSmartTrackingLevel(next.smartTrackingLevel ?? 2);
      }

      const hasLift = Object.prototype.hasOwnProperty.call(patch, "smartTrackingLiftDistance");
      const hasLanding = Object.prototype.hasOwnProperty.call(patch, "smartTrackingLandingDistance");
      if (hasLift || hasLanding) {
        if (!Object.prototype.hasOwnProperty.call(patch, "smartTrackingMode")) {
          next.smartTrackingMode = "asymmetric";
        }
        if (next.smartTrackingMode === "asymmetric") {
          const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
            hasLift ? patch.smartTrackingLiftDistance : (next.smartTrackingLiftDistance ?? 2),
            hasLanding ? patch.smartTrackingLandingDistance : (next.smartTrackingLandingDistance ?? 1)
          );
          next.smartTrackingLiftDistance = dist.lift;
          next.smartTrackingLandingDistance = dist.landing;
        }
      } else {
        const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
          next.smartTrackingLiftDistance ?? 2,
          next.smartTrackingLandingDistance ?? 1
        );
        next.smartTrackingLiftDistance = dist.lift;
        next.smartTrackingLandingDistance = dist.landing;
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

  // REP4 source codes captured from Synapse write packets.
  const REP4_SOURCE_CODE_BY_BUTTON_ID = Object.freeze({
    1: 0x0001, // 推断：左键源编码，与其他按键编码模式一致
    2: 0x0002,
    3: 0x0003,
    4: 0x0005, // 前进键
    5: 0x0004, // 后退键
    6: 0x0060, // DPI 键
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

  const REP4_MOUSE_ACTION_BY_LABEL = Object.freeze({
    左键: [0x01, 0x01, 0x01, 0x00],
    右键: [0x01, 0x01, 0x02, 0x00],
    中键: [0x01, 0x01, 0x03, 0x00],
    后退: [0x01, 0x01, 0x04, 0x00],
    前进: [0x01, 0x01, 0x05, 0x00],
    左键双击: [0x0b, 0x01, 0x01, 0x00],
    向上滚动: [0x01, 0x01, 0x09, 0x00],
    向下滚动: [0x01, 0x01, 0x0a, 0x00],
    禁止按键: [0x01, 0x01, 0x00, 0x00],
    DPI循环: [0x06, 0x01, 0x06, 0x00],
  });

  // Moderate inference: keep DPI family writable as 06 01 X to match capture style.
  const REP4_DPI_ACTION_BY_LABEL = Object.freeze({
    dpiUp: [0x06, 0x01, 0x01, 0x00],
    dpiDown: [0x06, 0x01, 0x02, 0x00],
    tiltLeft: [0x06, 0x01, 0x03, 0x00],
    tiltRight: [0x06, 0x01, 0x04, 0x00],
    profile: [0x06, 0x01, 0x05, 0x00],
    sniper: [0x06, 0x01, 0x06, 0x00],
  });

  const REP4_MEDIA_ACTION_BY_LABEL = Object.freeze({
    // Captured media write path uses [0a, 02, 00, consumer_hid].
    音量加: [0x0a, 0x02, 0x00, 0xe9],
    音量减: [0x0a, 0x02, 0x00, 0xea],
    静音: [0x0a, 0x02, 0x00, 0xe2],
    上一曲: [0x0a, 0x02, 0x00, 0xb6],
    // Inferred from standard consumer HID set; verify with capture if needed.
    下一曲: [0x0a, 0x02, 0x00, 0xb5],
    "播放/暂停": [0x0a, 0x02, 0x00, 0xcd],
    计算器: [0x0a, 0x02, 0x01, 0x92],    
    我的电脑: [0x0a, 0x02, 0x01, 0x94],   
    浏览器: [0x0a, 0x02, 0x02, 0x23],     
    邮件: [0x0a, 0x02, 0x01, 0x8a],       
    媒体播放器: [0x0a, 0x02, 0x01, 0x83], 
    停止播放: [0x0a, 0x02, 0x00, 0xb7],   
    浏览器后退: [0x0a, 0x02, 0x02, 0x24], 
    浏览器前进: [0x0a, 0x02, 0x02, 0x25], 
    刷新页面: [0x0a, 0x02, 0x02, 0x27],   
    打开收藏夹: [0x0a, 0x02, 0x02, 0x2a], 
    系统搜索: [0x0a, 0x02, 0x02, 0x21],   
  });

  function normalizeActionLabel(label) {
    const raw = String(label || "").trim();
    if (!raw) return "";
    return raw;
  }

  function resolveRep4ActionFromLabel(label) {
    const canonical = normalizeActionLabel(label);
    if (!canonical) return null;
    const hit = (
      REP4_MOUSE_ACTION_BY_LABEL[canonical]
      || REP4_DPI_ACTION_BY_LABEL[canonical]
      || REP4_MEDIA_ACTION_BY_LABEL[canonical]
    );
    if (hit) return hit.slice(0, 4).map((x) => clampU8(x));

    const action = LABEL_TO_PROTOCOL_ACTION[canonical];
    if (action && clampU8(action.funckey) === 0x02) {
      const packed = clampInt(action.keycode, 0, 0xffff);
      return [0x02, 0x02, (packed >> 8) & 0xff, packed & 0xff];
    }
    return null;
  }

  function resolveRep4ActionFromObject(raw) {
    if (!isObject(raw)) return null;
    const explicitLabel = String(raw.label ?? raw.source ?? "").trim();
    if (explicitLabel) {
      const byLabel = resolveRep4ActionFromLabel(explicitLabel);
      if (byLabel) return byLabel;
    }
    const fk = clampU8(raw.funckey ?? raw.func ?? 0);
    const kc = clampInt(raw.keycode ?? raw.code ?? 0, 0, 0xffff);
    if (fk === 0x02) {
      return [0x02, 0x02, (kc >> 8) & 0xff, kc & 0xff];
    }
    const label = FUNCKEY_KEYCODE_TO_LABEL.get(`${fk}:${kc}`);
    return label ? resolveRep4ActionFromLabel(label) : null;
  }

  const REP4_WRITABLE_LABELS = Object.freeze(
    (() => {
      const labels = new Set([
        ...Object.keys(REP4_MOUSE_ACTION_BY_LABEL),
        ...Object.keys(REP4_DPI_ACTION_BY_LABEL),
        ...Object.keys(REP4_MEDIA_ACTION_BY_LABEL),
      ]);
      for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
        if (clampU8(action?.funckey) === 0x02) {
          labels.add(label);
        }
      }
      return labels;
    })()
  );

  const BUTTON_ID_BY_REP4_SOURCE_CODE = (() => {
    const out = new Map();
    for (const [btnIdRaw, sourceCode] of Object.entries(REP4_SOURCE_CODE_BY_BUTTON_ID)) {
      const btnId = clampInt(btnIdRaw, 1, 6);
      out.set(clampU16(sourceCode), btnId);
    }
    return out;
  })();

  function quadletKey(a0, a1, a2, a3) {
    return `${clampU8(a0)}:${clampU8(a1)}:${clampU8(a2)}:${clampU8(a3)}`;
  }

  const REP4_LABEL_BY_ACTION_QUADLET = (() => {
    const out = new Map();
    const add = (label, quadlet) => {
      if (!label || !Array.isArray(quadlet) || quadlet.length < 4) return;
      const key = quadletKey(quadlet[0], quadlet[1], quadlet[2], quadlet[3]);
      if (!out.has(key)) out.set(key, label);
    };
    for (const [label, quadlet] of Object.entries(REP4_MOUSE_ACTION_BY_LABEL)) add(label, quadlet);
    for (const [label, quadlet] of Object.entries(REP4_DPI_ACTION_BY_LABEL)) add(label, quadlet);
    for (const [label, quadlet] of Object.entries(REP4_MEDIA_ACTION_BY_LABEL)) add(label, quadlet);
    return out;
  })();

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

  const UNKNOWN_REP4_READ_SOURCE = "未知(回包异常)";
  const REP4_READ_MAX_ATTEMPTS = 7;
  const REP4_READ_STABLE_HITS_REQUIRED = 2;
  const REP4_READ_RETRY_DELAY_MS = 20;
  const RETRYABLE_REP4_READ_ERROR_CODES = new Set([
    "REP4_READ_EMPTY",
    "REP4_READ_INVALID",
    "REP4_SOURCE_ECHO_MISMATCH",
    "REP4_READ_UNKNOWN_ACTION",
    "REP4_READ_UNSTABLE",
  ]);

  function buildUnknownRep4Entry(sourceText = UNKNOWN_REP4_READ_SOURCE) {
    return {
      source: String(sourceText || UNKNOWN_REP4_READ_SOURCE),
      funckey: 0x00,
      keycode: 0x0000,
    };
  }

  function hexU8(v) {
    return clampU8(v).toString(16).padStart(2, "0").toUpperCase();
  }

  function buildUnknownRep4QuadletEntry(quadlet) {
    const a0 = Array.isArray(quadlet) ? clampU8(quadlet[0]) : 0x00;
    const a1 = Array.isArray(quadlet) ? clampU8(quadlet[1]) : 0x00;
    const a2 = Array.isArray(quadlet) ? clampU8(quadlet[2]) : 0x00;
    const a3 = Array.isArray(quadlet) ? clampU8(quadlet[3]) : 0x00;
    return buildUnknownRep4Entry(`未知(REP4:${hexU8(a0)}-${hexU8(a1)}-${hexU8(a2)}-${hexU8(a3)})`);
  }

  function resolveActionFromRep4Quadlet(_btnId, quadlet) {
    if (!Array.isArray(quadlet) || quadlet.length < 4) return buildUnknownRep4QuadletEntry(quadlet);

    const a0 = clampU8(quadlet[0]);
    const a1 = clampU8(quadlet[1]);
    const a2 = clampU8(quadlet[2]);
    const a3 = clampU8(quadlet[3]);

    if (a0 === 0x02 && a1 === 0x02) {
      const keycode = ((a2 << 8) | a3) & 0xffff;
      const label = FUNCKEY_KEYCODE_TO_LABEL.get(`2:${keycode}`);
      if (!label) return buildUnknownRep4QuadletEntry(quadlet);
      return {
        source: label,
        funckey: 0x02,
        keycode,
      };
    }

    const label = REP4_LABEL_BY_ACTION_QUADLET.get(quadletKey(a0, a1, a2, a3));
    if (!label) return buildUnknownRep4QuadletEntry(quadlet);

    const action = LABEL_TO_PROTOCOL_ACTION[label];
    if (!action) return buildUnknownRep4QuadletEntry(quadlet);

    return {
      source: label,
      funckey: clampU8(action.funckey),
      keycode: clampInt(action.keycode, 0, 0xffff),
    };
  }

  function extractRep4ReadQuadlet(btnId, sourceCode, res) {
    const expectedSourceCode = clampU16(sourceCode);
    const expectedBtn = BUTTON_ID_BY_REP4_SOURCE_CODE.get(expectedSourceCode);
    const b = clampInt(Number.isFinite(btnId) ? btnId : (expectedBtn ?? 1), 1, 6);
    const args = res?.arguments;
    if (!(args instanceof Uint8Array) || args.length < 7) {
      throw new ProtocolError("REP4 mapping response is invalid", "REP4_READ_INVALID", {
        btnId: b,
        expectedSourceCode,
        argsLength: args instanceof Uint8Array ? args.length : -1,
      });
    }
    if (clampU8(args[0]) !== 0x01) {
      throw new ProtocolError("REP4 mapping response header is invalid", "REP4_READ_INVALID", {
        btnId: b,
        expectedSourceCode,
        header: clampU8(args[0]),
      });
    }

    const sourceEcho = ((clampU8(args[2]) << 8) | clampU8(args[1])) & 0xffff;
    // Strict source echo validation avoids applying another key's response
    // to the current slot during connect-time jitter.
    if (sourceEcho !== expectedSourceCode) {
      throw new ProtocolError("REP4 source echo mismatch", "REP4_SOURCE_ECHO_MISMATCH", {
        btnId: b,
        expectedSourceCode,
        sourceEcho,
      });
    }

    return [clampU8(args[3]), clampU8(args[4]), clampU8(args[5]), clampU8(args[6])];
  }

  function isKnownRep4Quadlet(quadlet) {
    if (!Array.isArray(quadlet) || quadlet.length < 4) return false;
    const a0 = clampU8(quadlet[0]);
    const a1 = clampU8(quadlet[1]);
    const a2 = clampU8(quadlet[2]);
    const a3 = clampU8(quadlet[3]);

    if (a0 === 0x02 && a1 === 0x02) {
      const keycode = ((a2 << 8) | a3) & 0xffff;
      return FUNCKEY_KEYCODE_TO_LABEL.has(`2:${keycode}`);
    }

    return REP4_LABEL_BY_ACTION_QUADLET.has(quadletKey(a0, a1, a2, a3));
  }

  function isRetryableRep4ReadError(err) {
    return RETRYABLE_REP4_READ_ERROR_CODES.has(String(err?.code || ""));
  }

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
      this._driver = new UniversalHidDriver();
      this._planner = new CommandPlanner(0);
      this._opQueue = new SendQueue();
      this._onConfigCbs = new Set();
      this._onBatteryCbs = new Set();
      this._onRawReportCbs = new Set();
      this._boundInputReport = (event) => this._handleInputReport(event);
      this._closed = true;

      if (device) this.device = device;
      this._cfg = this._makeDefaultCfg();
    }

    set device(dev) {
      if (this._device && this._device !== dev && typeof this._device.removeEventListener === "function") {
        this._device.removeEventListener("inputreport", this._boundInputReport);
      }
      this._device = dev || null;
      const pid = normalizePid(this._device);
      this._planner.setProductId(pid);
      this._driver.setDevice(this._device, pid);
      this._cfg = this._makeDefaultCfg();
    }

    get device() {
      return this._device;
    }

    _pid() {
      return normalizePid(this._device);
    }

    _caps() {
      return buildCapabilities(this._pid());
    }

    _ensureSupported() {
      const pid = this._pid();
      ensureSupportedPid(pid);
      return pid;
    }

    async _ensureOpen() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      this._ensureSupported();
      if (!this.device.opened) {
        await this.open();
      }
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

    _snapshotForUi() {
      const cfg = deepClone(this._cfg || {});
      if (!isObject(cfg.capabilities)) {
        cfg.capabilities = this._capabilitiesSnapshot(this._caps());
      }
      return cfg;
    }

    _emitConfig() {
      if (this._closed) return;
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
      const reportBytes = toDataViewU8(event?.data);
      this._emitRawReport({
        reportId,
        bytes: new Uint8Array(reportBytes || []),
        timestamp: Number(event?.timeStamp ?? Date.now()),
      });
    }

    _attachInputReportListener() {
      if (!this.device || typeof this.device.addEventListener !== "function") return;
      if (typeof this.device.removeEventListener === "function") {
        this.device.removeEventListener("inputreport", this._boundInputReport);
      }
      this.device.addEventListener("inputreport", this._boundInputReport);
    }

    _detachInputReportListener() {
      if (!this.device || typeof this.device.removeEventListener !== "function") return;
      this.device.removeEventListener("inputreport", this._boundInputReport);
    }

    _makeDefaultCfg() {
      const pid = this._pid();
      const caps = buildCapabilities(pid);

      const cfg = {
        capabilities: this._capabilitiesSnapshot(caps),
        deviceName: this.device?.productName ? String(this.device.productName) : (PID_NAME[pid] || "Razer Mouse"),
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
        cfg.smartTrackingMode = "symmetric";
        cfg.smartTrackingLevel = 2;
        cfg.smartTrackingLiftDistance = 2;
        cfg.smartTrackingLandingDistance = 1;
      }

      if (caps.sensorAngle) {
        cfg.sensorAngle = 0;
      }

      return cfg;
    }

    async open() {
      if (!this.device) throw new ProtocolError("open() requires a HID device", "NO_DEVICE");
      const pid = this._ensureSupported();

      if (!this.device.opened) {
        await this.device.open();
      }

      this._closed = false;
      this._driver.setDevice(this.device, pid);
      this._planner.setProductId(pid);
      this._cfg = this._makeDefaultCfg();
      this._attachInputReportListener();

      if (RAZER_POST_OPEN_SETTLE_MS > 0) {
        await sleep(RAZER_POST_OPEN_SETTLE_MS);
      }

      let updates = null;
      try {
        updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: true });
      } catch (e) {
        const msg = String(e?.message || e);
        throw new ProtocolError(`Initial state read failed: ${msg}`, "INITIAL_READ_FAIL", { cause: e });
      }
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
    }

    // Unified session bootstrap entry: open -> initial read -> timeout/retry -> cache fallback,
    // while guaranteeing at least one _emitConfig() call.
    async bootstrapSession(opts = {}) {
      const options = isObject(opts) ? opts : {};
      const {
        device = null,
        reason = "",
        openRetry = 2,
        readRetry = 2,
        openRetryDelayMs = 120,
        readRetryDelayMs = 120,
        readTimeoutMs = 1200,
        useCacheFallback = true,
      } = options;
      // Single-read strategy: the initial read is completed inside open().
      // readRetry/readRetryDelayMs/readTimeoutMs are currently kept for interface compatibility.
      void readRetry;
      void readRetryDelayMs;
      void readTimeoutMs;

      if (device) this.device = device;

      const cachedCfg = this.getCachedConfig();
      const maxOpenAttempts = clampInt(openRetry, 1, 10);
      const openDelayMs = clampInt(openRetryDelayMs, 0, 5000);

      let openAttempts = 0;
      let readAttempts = 0;
      let openErr = null;
      for (let i = 0; i < maxOpenAttempts; i++) {
        openAttempts = i + 1;
        readAttempts = openAttempts;
        try {
          await this.open();
          openErr = null;
          break;
        } catch (e) {
          openErr = e;
          if (i < maxOpenAttempts - 1 && openDelayMs > 0) await sleep(openDelayMs);
        }
      }

      let usedCacheFallback = false;
      if (openErr) {
        const isInitialReadFail = String(openErr?.code || "") === "INITIAL_READ_FAIL";
        if (isInitialReadFail && useCacheFallback && cachedCfg && typeof cachedCfg === "object") {
          this._cfg = Object.assign({}, cachedCfg);
          usedCacheFallback = true;
        } else {
          throw openErr;
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
        },
      };
    }

    async close() {
      this._closed = true;
      this._detachInputReportListener();
      if (!this.device) return;
      try {
        if (this.device.opened) await this.device.close();
      } catch {
        // ignore close errors
      }
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
        const updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: false });
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
              const updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: false });
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
        const pid = this._pid();
        const b = clampInt(btnId, 1, 6);
        const sourceCode = REP4_SOURCE_CODE_BY_BUTTON_ID[b];
        if (!Number.isFinite(sourceCode)) {
          throw new ProtocolError(`Btn${b} mapping source code is not defined`, "FEATURE_UNSUPPORTED", {
            btnId: b,
            pid,
          });
        }
        let action = null;
        let source = "";
        let rep4Action = null;

        if (typeof labelOrObj === "string") {
          const resolved = resolveActionFromLabel(b, labelOrObj);
          if (!resolved) {
            throw new ProtocolError(`Unknown key action label: ${labelOrObj}`, "BAD_PARAM", { btnId: b, label: labelOrObj });
          }
          action = resolved.action;
          source = resolved.source || resolved.label || "";
          rep4Action = resolveRep4ActionFromLabel(resolved.label || source || labelOrObj);
        } else if (isObject(labelOrObj)) {
          action = {
            funckey: clampU8(labelOrObj.funckey ?? labelOrObj.func ?? 0),
            keycode: clampInt(labelOrObj.keycode ?? labelOrObj.code ?? 0, 0, 0xffff),
          };
          source = String(labelOrObj.source ?? labelOrObj.label ?? "custom").trim() || "custom";
          rep4Action = resolveRep4ActionFromObject(
            Object.assign({}, labelOrObj, {
              funckey: action.funckey,
              keycode: action.keycode,
              source,
            })
          );
        } else {
          throw new ProtocolError("key action must be label string or {funckey,keycode}", "BAD_PARAM");
        }

        if (!Array.isArray(rep4Action) || rep4Action.length !== 4) {
          throw new ProtocolError("Key action is not supported by Razer REP4 mapping write path", "FEATURE_UNSUPPORTED", {
            btnId: b,
            pid,
            sourceCode,
            label: typeof labelOrObj === "string" ? labelOrObj : (labelOrObj?.label ?? labelOrObj?.source ?? source),
            funckey: action?.funckey,
            keycode: action?.keycode,
          });
        }

        const tx = txForField(pid, "buttonMapping");
        const packet = ProtocolCodec.commands.setButtonMappingRep4(tx, sourceCode, rep4Action);
        await this._driver.sendAndWait(packet);

        const next = Array.isArray(this._cfg?.buttonMappings)
          ? this._cfg.buttonMappings.slice(0, 6)
          : buildDefaultRazerButtonMappings();
        while (next.length < 6) {
          next.push({ source: "", funckey: 0x00, keycode: 0x0000 });
        }
        next[b - 1] = {
          source,
          funckey: clampU8(action.funckey),
          keycode: clampInt(action.keycode, 0, 0xffff),
        };

        this._cfg = Object.assign({}, this._cfg, { buttonMappings: next });
        this._emitConfig();
        return {
          btnId: b,
          sourceCode,
          rep4Action: rep4Action.slice(0, 4),
          action: next[b - 1],
        };
      });
    }

    async _safeQuery(packet, fallback = null, opts = {}) {
      try {
        return await this._driver.sendAndWait(packet, opts);
      } catch (err) {
        const name = String(err?.name || "");
        const msg = String(err?.message || "").toLowerCase();
        if (
          name === "NotAllowedError"
          || msg.includes("notallowederror")
          || msg.includes("failed to write the feature report")
          || msg.includes("failed to receive the feature report")
          || msg.includes("failed to read the feature report")
        ) {
          throw err;
        }
        return fallback;
      }
    }

    async _readButtonMappingsSnapshot({ strictStability = false } = {}) {
      const pid = this._ensureSupported();
      const tx = txForField(pid, "buttonMapping");
      const out = Array.from({ length: 6 }, () => buildUnknownRep4Entry());

      for (let btnId = 1; btnId <= 6; btnId++) {
        const sourceCode = REP4_SOURCE_CODE_BY_BUTTON_ID[btnId];
        if (!Number.isFinite(sourceCode)) continue;
        let resolved = null;
        let lastQuadSig = "";
        let stableHits = 0;
        const cachedMapping = normalizeButtonMappingEntry(this._cfg?.buttonMappings?.[btnId - 1]);

        // Retry for transient empty/misaligned reads and require stable decode.
        for (let attempt = 1; attempt <= REP4_READ_MAX_ATTEMPTS; attempt++) {
          let readRes = null;
          try {
            readRes = await this._safeQuery(
              ProtocolCodec.commands.getButtonMappingRep4(tx, sourceCode),
              null,
              {
                // Reject stale/misaligned packets before decode layer maps button slots.
                responseValidator: (_request, response) => {
                  const args = response?.arguments;
                  if (!(args instanceof Uint8Array) || args.length < 3) return false;
                  const sourceEcho = ((clampU8(args[2]) << 8) | clampU8(args[1])) & 0xffff;
                  return sourceEcho === clampU16(sourceCode);
                },
              }
            );
            if (!readRes?.arguments) {
              throw new ProtocolError("REP4 mapping response is empty", "REP4_READ_EMPTY", {
                btnId,
                sourceCode: clampU16(sourceCode),
                attempt,
              });
            }

            const quadlet = extractRep4ReadQuadlet(btnId, sourceCode, readRes);
            const sig = quadletKey(quadlet[0], quadlet[1], quadlet[2], quadlet[3]);
            if (sig === lastQuadSig) {
              stableHits += 1;
            } else {
              lastQuadSig = sig;
              stableHits = 1;
            }

            if (!isKnownRep4Quadlet(quadlet)) {
              throw new ProtocolError("REP4 mapping quadlet is unknown", "REP4_READ_UNKNOWN_ACTION", {
                btnId,
                sourceCode: clampU16(sourceCode),
                attempt,
                quadlet: quadlet.slice(0, 4),
              });
            }

            const candidate = resolveActionFromRep4Quadlet(btnId, quadlet);
            const needStrictStability = !!strictStability || !isSameButtonAction(candidate, cachedMapping);
            const requiredHits = needStrictStability ? REP4_READ_STABLE_HITS_REQUIRED : 1;

            if (stableHits < requiredHits) {
              throw new ProtocolError("REP4 mapping read is unstable", "REP4_READ_UNSTABLE", {
                btnId,
                sourceCode: clampU16(sourceCode),
                attempt,
                stableHits,
                required: requiredHits,
              });
            }

            resolved = candidate;
            break;
          } catch (err) {
            const canRetry = isRetryableRep4ReadError(err) && attempt < REP4_READ_MAX_ATTEMPTS;
            if (!canRetry) break;
            if (REP4_READ_RETRY_DELAY_MS > 0) {
              await sleep(REP4_READ_RETRY_DELAY_MS);
            }
          }
        }

        out[btnId - 1] = resolved || buildUnknownRep4Entry();
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

    // Read full runtime snapshot used by open()/requestConfig().
    async _readDeviceStateSnapshot({ strictButtonMappingRead = false } = {}) {
      const pid = this._ensureSupported();
      const caps = this._caps();
      const tx = txForField(pid, "snapshot");
      const updates = {
        deviceName: this.device?.productName ? String(this.device.productName) : (PID_NAME[pid] || "Razer Mouse"),
        capabilities: this._capabilitiesSnapshot(caps),
      };

      const fw = await this._safeQuery(ProtocolCodec.commands.getFirmwareVersion(tx));
      if (fw?.arguments) {
        updates.firmwareVersion = `v${Number(fw.arguments[0] ?? 0)}.${Number(fw.arguments[1] ?? 0)}`;
      }

      const serial = await this._safeQuery(ProtocolCodec.commands.getSerial(tx));
      if (serial?.arguments) {
        updates.serial = asciiFromBytes(serial.arguments.subarray(0, 22));
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

      const dpi = await this._safeQuery(ProtocolCodec.commands.getDpiXY(tx, RAZER_CONST.NOSTORE));
      if (dpi?.arguments) {
        updates.dpi = {
          x: ((dpi.arguments[1] << 8) | (dpi.arguments[2] & 0xff)) & 0xffff,
          y: ((dpi.arguments[3] << 8) | (dpi.arguments[4] & 0xff)) & 0xffff,
        };
      }

      const stages = await this._safeQuery(ProtocolCodec.commands.getDpiStages(tx, RAZER_CONST.VARSTORE));
      if (stages?.arguments) {
        const parsed = TRANSFORMERS.parseDpiStagesResponse(stages);
        if (parsed.dpiStages?.length) updates.dpiStages = parsed.dpiStages;
        updates.activeDpiStageIndex = parsed.activeDpiStageIndex;
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
        const dynEnabled = await this._safeQuery(ProtocolCodec.commands.getDynamicSensitivityEnabled(txDyn));
        if (dynEnabled?.arguments) {
          updates.dynamicSensitivityEnabled = !!clampU8(dynEnabled.arguments[1] ?? 0);
        }
        const dynMode = await this._safeQuery(ProtocolCodec.commands.getDynamicSensitivityMode(txDyn));
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
        const modeRes = await this._safeQuery(ProtocolCodec.commands.getSmartTrackingMode(txTracking));
        if (modeRes?.arguments) {
          const modeSel = clampU8(modeRes.arguments[2] ?? 0x01);
          updates.smartTrackingMode = modeSel === 0x04 ? "asymmetric" : "symmetric";
          if (updates.smartTrackingMode === "symmetric") {
            updates.smartTrackingLevel = TRANSFORMERS.normalizeSmartTrackingLevel(modeRes.arguments[3] ?? 0);
          }
        }

        // Keep asymmetric pair fresh regardless of current mode to avoid stale defaults
        // after config refreshes that happen while device is in symmetric mode.
        const distRes = await this._safeQuery(ProtocolCodec.commands.getSmartTrackingAsymmetricDistances(txTracking));
        if (distRes?.arguments) {
          // 0x0b/0x85 response layout from captures:
          // args[0]=0x00, args[1]=0x04, args[2]=selector/fixed flag,
          // args[3]=lift-1, args[4]=landing-1.
          const dist = TRANSFORMERS.normalizeSmartTrackingDistances(
            clampU8(distRes.arguments[3] ?? 0) + 1,
            clampU8(distRes.arguments[4] ?? 0) + 1
          );
          updates.smartTrackingLiftDistance = dist.lift;
          updates.smartTrackingLandingDistance = dist.landing;
        }
      }

      const buttonMappings = await this._readButtonMappingsSnapshot({
        strictStability: !!strictButtonMappingRead,
      });
      if (Array.isArray(buttonMappings) && buttonMappings.length) {
        updates.buttonMappings = buttonMappings;
      }

      // REP4 keymap readback uses strict decode; failed reads are surfaced as unknown placeholders.

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
    })),
    isSupportedPid(productId) {
      return SUPPORTED_PID_SET.has(Number(productId));
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
      if (!REP4_WRITABLE_LABELS.has(label)) continue;
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
