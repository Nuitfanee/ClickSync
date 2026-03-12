/**
 * refactor.profiles.js: device profile composition and adapter registry.
 *
 * Responsibilities:
 * - Build BaseCommonProfile defaults.
 * - Compose per-device profiles via composeDeviceProfile().
 * - Export DeviceAdapters.getAdapter(id) runtime snapshots.
 *
 * Profile-first extension rule:
 * - Add or change device behavior in profile sections first.
 * - Avoid app.js or refactor.ui.js brand-specific branches.
 *
 * Profile sections and intent:
 * - ranges: UI selectable value domains.
 * - keyMap: stdKey -> protocol field(s).
 * - transforms: stdKey read/write normalization.
 * - actions: protocol-specific write handlers when setFeature is insufficient.
 * - features: feature gates and layout capabilities.
 * - ui: text/order/cycle metadata/source-region mapping.
 *
 * New device onboarding flow:
 * 1) Add AppConfig.ranges.<device> in refactor.core.js.
 * 2) Compose profile with only overrides from BaseCommonProfile.
 * 3) Declare unsupported capabilities with null/false explicitly.
 * 4) Register profile in DEVICE_PROFILES.
 * 5) Ensure DeviceRuntime can identify the hardware and load matching protocol script.
 *
 * Advanced single-source rule:
 * - Declare stdKey source region in ui.advancedSourceRegionByStdKey.
 * - app.js binds and commits only in that region.
 * - No cross-region fallback for value mapping.
 */

// ============================================================
// 2) Device profiles and adapters (registration + translation)
// ============================================================
(function () {
  const {
    DEFAULT_DEVICE_ID,
    clamp,
    normalizeDeviceId,
    toNumber,
    readBool,
    readNumber,
    normalizeDpiSlotArray,
    normalizeDpiLodArray,
    normalizeButtonMappingPatch,
    rapooTexts,
    atkTexts,
    ninjutsoTexts,
    razerTexts,
    KEYMAP_COMMON,
    TRANSFORMS_COMMON,
    readSurfaceFeelFallback,
    MAX_CONFIG_SLOT_COUNT,
    readEnabledConfigSlotCount,
    readActiveConfigSlotIndex,
    clampRazerStageCount,
    stagesToDpiSlotsX,
    stagesToDpiSlotsY,
    stagesToDpiSlots,
    stagesToSlotCount,
    defaultDpiSnapper,
    LOGITECH_DPI_STEP_SEGMENTS,
    toNinjutsoLedMode,
    fromNinjutsoLedMode,
    toNinjutsoLedBrightness,
    fromNinjutsoLedBrightness,
    normalizeHexColor,
  } = window.__DeviceRefactorCore || {};
  const FALLBACK_DEVICE_ID = String(DEFAULT_DEVICE_ID || "chaos").trim().toLowerCase() || "chaos";

  // ============================================================
  // Profile builder functions
  // ============================================================

  function mergeProfileSection(baseSection, overrideSection) {
    if (overrideSection === undefined) {
      if (baseSection && typeof baseSection === "object" && !Array.isArray(baseSection)) {
        return { ...baseSection };
      }
      return baseSection;
    }
    if (
      baseSection &&
      typeof baseSection === "object" &&
      !Array.isArray(baseSection) &&
      overrideSection &&
      typeof overrideSection === "object" &&
      !Array.isArray(overrideSection)
    ) {
      return { ...baseSection, ...overrideSection };
    }
    return overrideSection;
  }

  function composeProtocolSections(baseProfile, overrides = {}) {
    return {
      keyMap: mergeProfileSection(baseProfile?.keyMap, overrides?.keyMap) || {},
      transforms: mergeProfileSection(baseProfile?.transforms, overrides?.transforms) || {},
      actions: mergeProfileSection(baseProfile?.actions, overrides?.actions) || {},
      features: mergeProfileSection(baseProfile?.features, overrides?.features) || {},
    };
  }

  // Advanced single-source binding contract (UI-only):
  // - Key is standard key (stdKey), value is one source region: dual-left | dual-right | single.
  // - This mapping controls where advanced controls are read/written/bound in app.js.
  // - Device overrides must be declared in profile.ui.advancedSourceRegionByStdKey.
  // - Do not add brand branches in app.js/refactor.ui.js for source-region differences.
  const ADVANCED_SOURCE_REGION_DEFAULTS = Object.freeze({
    sleepSeconds: "dual-left",
    debounceMs: "dual-left",
    surfaceMode: "single",
    bhopMs: "single",
    hyperpollingIndicatorMode: "single",
  });

  // Build protocol-neutral defaults. Device profiles are composed from this base.
  function buildCommonProfileDefaults() {
    return {
      ui: {
        landingTitle: rapooTexts.landingTitle,
        landingCaption: rapooTexts.landingCaption,
        landingReadyText: "",
        keymap: {
          imageSrc: "./assets/images/default.png",
        },
        lod: rapooTexts.lod,
        led: rapooTexts.led,
        perfMode: rapooTexts.perfMode,
        lights: rapooTexts.lights,
        advancedPanelDensity: "default",
        advancedPanels: {},
        advancedSingleOrders: {},
        advancedSourceRegionByStdKey: { ...ADVANCED_SOURCE_REGION_DEFAULTS },
      },
      ranges: window.AppConfig?.ranges?.rapoo,
      keyMap: {
        ...KEYMAP_COMMON,
        surfaceModePrimary: "glassMode",
        surfaceModeSecondary: null,
        primaryLedFeature: "ledLowBattery",
        surfaceFeel: "opticalEngineLevel",
        keyScanningRate: "keyScanningRate",
        wirelessStrategyMode: "wirelessStrategy",
        commProtocolMode: "commProtocol",
      },
      transforms: {
        ...TRANSFORMS_COMMON,
        surfaceModePrimary: { write: (v) => !!v, read: readBool },
        primaryLedFeature: { write: (v) => !!v, read: readBool },
        surfaceFeel: { write: (v) => toNumber(v), read: readSurfaceFeelFallback },
        keyScanningRate: { write: (v) => toNumber(v), read: readNumber },
        wirelessStrategyMode: {
          write: (v) => (!!v ? "full" : "smart"),
          read: (raw) => {
            if (raw == null) return undefined;
            if (typeof raw === "string") return raw.toLowerCase() === "full";
            return !!raw;
          },
        },
        commProtocolMode: {
          write: (v) => (!!v ? "initial" : "efficient"),
          read: (raw) => {
            if (raw == null) return undefined;
            if (typeof raw === "string") return raw.toLowerCase() === "initial";
            return !!raw;
          },
        },
      },
      actions: {
        buttonMappingPatch: async ({ hidApi, value, adapter }) => {
          const setter = hidApi?.setButtonMappingBySelect;
          if (typeof setter !== "function") return;
          const capRaw = toNumber(adapter?.features?.keymapButtonCount);
          const maxButtons = Number.isFinite(capRaw) ? Math.max(1, Math.round(capRaw)) : 6;
          const patch = typeof normalizeButtonMappingPatch === "function"
            ? normalizeButtonMappingPatch(value, { maxButtons })
            : value;
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
          const buttons = Object.keys(patch)
            .map((btn) => Math.trunc(Number(btn)))
            .filter((btn) => Number.isFinite(btn) && btn >= 1 && btn <= maxButtons)
            .sort((a, b) => a - b);
          for (const btn of buttons) {
            await setter.call(hidApi, btn, patch[btn]);
          }
        },
      },
      dpiSnapper: defaultDpiSnapper,
      features: {
        hasPrimarySurfaceToggle: true,
        hasSecondarySurfaceToggle: false,
        hasPrimaryLedFeature: true,
        hasPerformanceMode: true,
        hasConfigSlots: false,
        hasDualPollingRates: false,
        hideBasicSynapse: false,
        hideBasicFooterSecondaryText: false,
        hasMotionSync: true,
        hasLinearCorrection: true,
        hasRippleControl: true,
        hasKeyScanRate: true,
        hasWirelessStrategy: true,
        hasCommProtocol: true,
        hasLongRange: false,
        hasAtkLights: false,
        hasDpiLightCycle: false,
        hasReceiverLightCycle: false,
        hasStaticLedColorPanel: false,
        hasDpiColors: false,
        hasDpiLods: false,
        hasDpiAdvancedAxis: true,
        hasSensorAngle: true,
        hideSensorAngleVisualization: false,
        hideSensorAngleCenterMark: false,
        hasSurfaceFeel: true,
        showHeightViz: true,
        hideSportPerfMode: false,
        advancedLayout: "dual",
        hasOnboardMemoryMode: false,
        warnOnDisableOnboardMemoryMode: false,
        autoEnableOnboardMemoryOnConnect: false,
        hasLightforceSwitch: false,
        hasSurfaceMode: false,
        hasBhopDelay: false,
        // When true, UI defers local slot-count repaint until device config ack to avoid transient DPI jumps.
        deferDpiSlotCountUiUntilAck: false,
        ledMasterBySecondarySurface: false,
        ledMasterGatesDpiLightEffect: false,
        ledMasterGatesReceiverLightEffect: false,
        ledMasterGatesSurfaceFeel: false,
        ledMasterGatesStaticLedColor: false,
        surfaceFeelRequiresDpiLightEffect: false,
        surfaceFeelRequiredDpiLightValue: 1,
        staticLedColorRequiresDpiLightEffect: false,
        staticLedColorRequiredDpiLightValue: 0,
        supportsBatteryRequest: false,
        batteryPollMs: 120000,
        batteryPollTag: "2min",
        enterDelayMs: 0,
      },
    };
  }

  const BaseCommonProfile = buildCommonProfileDefaults();

  // Compose rule:
  // - BaseCommonProfile is the single shared baseline.
  // - Device profile provides only explicit overrides.
  // - Adapter consumers (app/ui/core) should not infer behavior from device id branches.
  function composeDeviceProfile({
    id,
    ui,
    ranges,
    keyMap,
    transforms,
    actions,
    dpiSnapper,
    features,
  }) {
    const profileId = String(id || "").trim().toLowerCase() || FALLBACK_DEVICE_ID;
    const protocolSections = composeProtocolSections(
      BaseCommonProfile,
      { keyMap, transforms, actions, features }
    );
    return {
      id: profileId,
      ui: mergeProfileSection(BaseCommonProfile.ui, ui) || {},
      ranges: ranges === undefined ? BaseCommonProfile.ranges : ranges,
      keyMap: protocolSections.keyMap,
      transforms: protocolSections.transforms,
      actions: protocolSections.actions,
      dpiSnapper: typeof dpiSnapper === "function" ? dpiSnapper : BaseCommonProfile.dpiSnapper,
      features: protocolSections.features,
    };
  }

  // New device onboarding template:
  // Single-source workflow for new devices:
  // 1) Define protocol differences in keyMap/transforms/actions/features as usual.
  // 2) In `ui.advancedSourceRegionByStdKey`, override only changed stdKeys.
  //    Example: sleepSeconds -> single, debounceMs -> dual-left.
  // 3) Ensure source-region DOM has semantic controls with matching data-std-key
  //    (usually hidden select + visible range for discrete slider semantics).
  // 4) Do not modify app.js with brand-specific branches.
  // const NewBrandProfile = composeDeviceProfile({
  //   id: newbrand,
  //   ui: {
  //     landingTitle: ...,
  //     landingCaption: ...,
  //     advancedSourceRegionByStdKey: {
  //       ...ADVANCED_SOURCE_REGION_DEFAULTS,
  //       // Override only if this device differs from defaults.
  //       sleepSeconds: single,
  //     },
  //   },
  //   ranges: window.AppConfig?.ranges?.newbrand,
  //   keyMap: {
  //     // Only declare differences from common defaults.
  //   },
  //   transforms: {
  //     // Only declare differences from common defaults.
  //   },
  //   actions: {
  //     // Optional action overrides.
  //   },
  //   features: {
  //     // Feature toggles and advancedLayout.
  //   },
  // });

  // ============================================================
  // Device profile definitions (sorted alphabetically by device name)
  // ============================================================

  const AtkProfile = composeDeviceProfile({
    id: "atk",
    ui: {
      landingReadyText: "ATK READY",
      landingTitle: atkTexts.landingTitle,
      landingCaption: atkTexts.landingCaption,
      lod: atkTexts.lod,
      led: atkTexts.led,
      advancedCycleStateMeta: atkTexts.advancedCycleStateMeta,
      perfMode: atkTexts.perfMode,
      lights: atkTexts.lights,
    },
    ranges: window.AppConfig?.ranges?.atk,
    keyMap: {
      surfaceModePrimary: null,
      primaryLedFeature: null,
      keyScanningRate: null,
      wirelessStrategyMode: null,
      commProtocolMode: null,
      longRangeMode: "longRangeMode",
      dpiLightEffect: "dpiLightEffect",
      receiverLightEffect: "receiverLightEffect",
    },
    transforms: {
      longRangeMode: { write: (v) => !!v, read: readBool },
      dpiLightEffect: { write: (v) => toNumber(v), read: readNumber },
      receiverLightEffect: { write: (v) => toNumber(v), read: readNumber },
    },
    dpiSnapper: defaultDpiSnapper,
    features: {
      hasPrimarySurfaceToggle: false,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: false,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: true,
      hasAtkLights: true,
      hasDpiLightCycle: true,
      hasReceiverLightCycle: true,
      hasDpiColors: true,
      hideSportPerfMode: true,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
      enterDelayMs: 120,
    },
  });

  const ChaosProfile = composeDeviceProfile({
    id: "chaos",
    ui: {
      landingReadyText: "CHAOS  READY",
      landingTitle: "",
      landingCaption: "",
      lod: null,
      led: null,
      perfMode: null,
      lights: null,
    },
    ranges: window.AppConfig?.ranges?.chaos,
    keyMap: {
      pollingHz: ["pollingHz", "polling_rate", "polling_rate_hz", "pollingRateHz", "reportRateHz", "reportHz"],
      surfaceModePrimary: "lodHeight",
      surfaceModeSecondary: "glassMode",
      primaryLedFeature: ["ledEnabled", "rgb_switch", "ledRaw"],
      surfaceFeel: "sensorFeel",
      keyScanningRate: null,
      wirelessStrategyMode: null,
      commProtocolMode: null,
    },
    transforms: {
      surfaceModePrimary: {
        write: (v) => (!!v ? "low" : "high"),
        read: (raw) => {
          if (raw == null) return undefined;
          if (typeof raw === "string") return raw.toLowerCase() === "low";
          return !!raw;
        },
      },
      surfaceModeSecondary: { write: (v) => !!v, read: readBool },
      primaryLedFeature: { write: (v) => !!v, read: readBool },
      surfaceFeel: { write: (v) => toNumber(v), read: readNumber },
      keyScanningRate: null,
      wirelessStrategyMode: null,
      commProtocolMode: null,
      sleepSeconds: {
        write: (v) => toNumber(v),
        read: (raw, ctx) => {
          const direct = readNumber(raw);
          if (direct != null) return direct;
          const legacy = toNumber(ctx?.cfg?.sleep16);
          if (legacy == null) return undefined;
          const map = window.ProtocolApi?.MOUSE_HID?.sleepCodeToSeconds || {};
          if (map[String(legacy)] != null) return map[String(legacy)];
          const values = Object.values(map);
          if (values.includes(legacy)) return legacy;
          return legacy;
        },
      },
    },
    dpiSnapper: defaultDpiSnapper,
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: true,
      hasPrimaryLedFeature: true,
      hasPerformanceMode: true,
      hasConfigSlots: false,
      hasDualPollingRates: false,
      hideBasicSynapse: false,
      hideBasicFooterSecondaryText: false,
      hasMotionSync: true,
      hasLinearCorrection: true,
      hasRippleControl: true,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiLightCycle: false,
      hasReceiverLightCycle: false,
      hasStaticLedColorPanel: false,
      hasDpiColors: false,
      hasDpiLods: false,
      hasDpiAdvancedAxis: false,
      hasSensorAngle: true,
      hideSensorAngleVisualization: false,
      hideSensorAngleCenterMark: false,
      hasSurfaceFeel: true,
      showHeightViz: false,
      hideSportPerfMode: false,
      advancedLayout: "dual",
      hasOnboardMemoryMode: false,
      warnOnDisableOnboardMemoryMode: false,
      autoEnableOnboardMemoryOnConnect: false,
      hasLightforceSwitch: false,
      hasSurfaceMode: false,
      hasBhopDelay: false,
      deferDpiSlotCountUiUntilAck: false,
      ledMasterBySecondarySurface: false,
      ledMasterGatesDpiLightEffect: false,
      ledMasterGatesReceiverLightEffect: false,
      ledMasterGatesSurfaceFeel: false,
      ledMasterGatesStaticLedColor: false,
      surfaceFeelRequiresDpiLightEffect: false,
      surfaceFeelRequiredDpiLightValue: 1,
      staticLedColorRequiresDpiLightEffect: false,
      staticLedColorRequiredDpiLightValue: 0,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
      enterDelayMs: 0,
    },
  });

  // Profiles are composed with a flat common base + per-device overrides model.
  // Logitech profile extends common protocol defaults via explicit overrides only.
  const LOGITECH_POLLING_THEME_BY_HZ = Object.freeze({
    125: "#065F46",
    250: "#00A86B",
    500: "#2563EB",
    1000: "#000000",
    2000: "#1E3A8A",
    4000: "#6B21A8",
    8000: "#4F46E5",
  });

  const LogitechProfile = composeDeviceProfile({
    id: "logitech",
    ui: {
      landingReadyText: "LOGITECH READY",
      pollingThemeByWirelessHz: LOGITECH_POLLING_THEME_BY_HZ,
      advancedPanels: {
        sleepSeconds: {
          enabled: false,
        },
        sensorAngle: {
          enabled: false,
        },
        dynamicSensitivityComposite: {
          enabled: false,
        },
        smartTrackingComposite: {
          enabled: false,
        },
        lowPowerThresholdPercent: {
          enabled: false,
        },
        hyperpollingIndicator: {
          enabled: false,
        },
      },
      basicModeTypography: {
        columnsOffsetX: -120,
      },
      keymap: {
        imageSrc: "./assets/images/GPW.png",
        variants: [
          {
            deviceNames: ["PRO X 2 DEX"],
            imageSrc: "./assets/images/GPW_DEX.png",
            // Placeholder points: fine-tune against the final device illustration if needed.
            points: {
              1: { x: 32, y: 20, side: "left" },
              2: { x: 65, y: 38, side: "right" },
              3: { x: 50.2, y: 24, side: "right" },
              4: { x: 22, y: 39, side: "left" },
              5: { x: 24, y: 52, side: "left" },
              6: { x: 52, y: 70, side: "right" },
            },
          },
        ],
      },
      basicFooterTypography: {
        footerJustifyContent: "flex-start",
        footerAlignItems: "baseline",
        footerGap: "clamp(8px, 1.1vw, 14px)",
        footerPadding: "30px 40px 22px 200px",
        tickerFontSize: "clamp(14px, 1.2vw, 18px)",
        tickerFontWeight: "600",
        tickerOpacity: "0.7",
        tickerLineHeight: "1.24",
        tickerLetterSpacing: "0.008em",
        tickerGap: "clamp(12px, 1.4vw, 20px)",
        labelFontSize: "clamp(14px, 1.2vw, 18px)",
        labelFontWeight: "500",
        labelLetterSpacing: "0.008em",
      },
      onboardMemoryDisableConfirmText: "是否关闭板载内存模式，关闭后驱动设置不保证可用",
    },
    ranges: {
      ...(window.AppConfig?.ranges?.rapoo || {}),
      polling: {
        ...(window.AppConfig?.ranges?.rapoo?.polling || {}),
        wiredHz: [125, 250, 500, 1000],
        wirelessHz: [125, 250, 500, 1000, 2000, 4000, 8000],
      },
      dpi: {
        ...((window.AppConfig?.ranges?.rapoo?.dpi) || {}),
        step: 1,
        stepSegments: LOGITECH_DPI_STEP_SEGMENTS,
        policy: {
          mode: "segmented",
          step: 1,
          stepSegments: LOGITECH_DPI_STEP_SEGMENTS,
        },
      },
    },
    keyMap: {
      performanceMode: null,
      pollingWirelessHz: ["pollingWirelessHz", "polling_wireless_hz"],
      dpiLods: ["dpiLods", "dpi_lods", "lods"],
      configSlotCount: ["enabledProfileSlotCount", "profileSlotStates"],
      activeConfigSlotIndex: "activeProfileSlotIndex",
      onboardMemoryMode: "onboardMemoryMode",
      lightforceSwitch: "lightforceSwitch",
      surfaceMode: "surfaceMode",
      bhopMs: "bhopMs",
    },
    transforms: {
      dpiLods: {
        write: (v) => normalizeDpiLodArray(v),
        read: (raw) => normalizeDpiLodArray(raw, { fallback: "mid" }),
      },
      onboardMemoryMode: { write: (v) => !!v, read: readBool },
      lightforceSwitch: {
        write: (v) => {
          const mode = String(v || "").trim().toLowerCase();
          return mode === "hybrid" ? "hybrid" : "optical";
        },
        read: (raw) => {
          if (raw == null) return undefined;
          const mode = String(raw).trim().toLowerCase();
          return mode === "hybrid" ? "hybrid" : "optical";
        },
      },
      surfaceMode: {
        write: (v) => {
          const mode = String(v || "").trim().toLowerCase();
          if (mode === "on") return "on";
          if (mode === "off") return "off";
          return "auto";
        },
        read: (raw) => {
          if (raw == null) return undefined;
          const mode = String(raw).trim().toLowerCase();
          if (mode === "on") return "on";
          if (mode === "off") return "off";
          return "auto";
        },
      },
      bhopMs: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          const clamped = clamp(Math.round(n), 0, 1000);
          return Math.round(clamped / 100) * 100;
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 0, 1000);
        },
      },
      configSlotCount: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, MAX_CONFIG_SLOT_COUNT);
        },
        read: (raw, ctx) => readEnabledConfigSlotCount(raw, ctx),
      },
      activeConfigSlotIndex: {
        write: (v, ctx) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          const slotCountRaw = toNumber(ctx?.payload?.configSlotCount);
          const slotCount = Number.isFinite(slotCountRaw)
            ? clamp(Math.round(slotCountRaw), 1, MAX_CONFIG_SLOT_COUNT)
            : MAX_CONFIG_SLOT_COUNT;
          return clamp(Math.round(n), 0, Math.max(0, slotCount - 1));
        },
        read: (raw, ctx) => readActiveConfigSlotIndex(raw, ctx),
      },
    },
    actions: {
      activeConfigSlotIndex: { method: "setActiveProfileSlot" },
      onboardMemoryMode: { method: "setOnboardMemoryMode" },
      lightforceSwitch: { method: "setLightforceSwitch" },
      surfaceMode: { method: "setSurfaceMode" },
      bhopMs: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ bhopMs: value });
      },
    },
    features: {
      advancedLayout: "single",
      hasPerformanceMode: false,
      hasConfigSlots: true,
      hasDualPollingRates: true,
      hideBasicSynapse: true,
      hideBasicFooterSecondaryText: true,
      hasDpiLods: true,
      keymapButtonCount: 5,
      hasMotionSync: false,
      hasLinearCorrection: false,
      hasRippleControl: false,
      hasPrimarySurfaceToggle: false,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: false,
      hasKeyScanRate: false,
      hasOnboardMemoryMode: true,
      warnOnDisableOnboardMemoryMode: true,
      autoEnableOnboardMemoryOnConnect: true,
      hasLightforceSwitch: true,
      hasSurfaceMode: true,
      hasBhopDelay: true,
    },
  });

  const NinjutsoProfile = composeDeviceProfile({
    id: "ninjutso",
    ui: {
      skinClass: "atk",
      landingReadyText: "NINJUTSO READY",
      keymap: {
        imageSrc: "./assets/images/ninjutso.png",
        points: {
          1: { x: 30, y: 20, side: "left" },
          2: { x: 70, y: 38, side: "right" },
          3: { x: 50.5, y: 26, side: "right" },
          4: { x: 14, y: 40, side: "left" },
          5: { x: 14, y: 51, side: "left" },
        },
      },
      landingTitle: ninjutsoTexts.landingTitle,
      landingCaption: ninjutsoTexts.landingCaption,
      lod: ninjutsoTexts.lod,
      led: ninjutsoTexts.led,
      secondarySurface: ninjutsoTexts.ledMaster,
      perfMode: ninjutsoTexts.perfMode,
      lightCycles: ninjutsoTexts.lightCycles,
      staticLedColor: ninjutsoTexts.staticLedColor,
      advancedSectionHeaders: ninjutsoTexts.advancedSectionHeaders,
      lights: ninjutsoTexts.lights,
      advancedOrders: {
        surfaceModePrimary: 50,
        primaryLedFeature: 60,
        secondarySurfaceToggle: 70,
        dpiLightEffect: 80,
        staticLedColor: 85,
        receiverLightEffect: 90,
      },
    },
    ranges: window.AppConfig?.ranges?.ninjutso,
    keyMap: {
      surfaceModePrimary: "burstEnabled",
      surfaceModeSecondary: "ledEnabled",
      primaryLedFeature: "hyperClick",
      surfaceFeel: "ledSpeed",
      keyScanningRate: null,
      wirelessStrategyMode: null,
      commProtocolMode: null,
      sensorAngle: "ledBrightness",
      dpiLightEffect: "ledMode",
      receiverLightEffect: "ledBrightness",
      staticLedColor: "ledColor",
    },
    transforms: {
      surfaceModePrimary: { write: (v) => !!v, read: readBool },
      surfaceModeSecondary: { write: (v) => !!v, read: readBool },
      primaryLedFeature: { write: (v) => !!v, read: readBool },
      surfaceFeel: {
        write: (v) => clamp(Math.trunc(Number(v) || 0), 0, 20),
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.trunc(n), 0, 20);
        },
      },
      sensorAngle: {
        write: (v) => toNinjutsoLedBrightness(v),
        read: (raw) => fromNinjutsoLedBrightness(raw),
      },
      dpiLightEffect: {
        write: (v) => toNinjutsoLedMode(v),
        read: (raw) => fromNinjutsoLedMode(raw),
      },
      receiverLightEffect: {
        write: (v) => toNinjutsoLedBrightness(v),
        read: (raw) => fromNinjutsoLedBrightness(raw),
      },
      staticLedColor: {
        write: (v) => normalizeHexColor(v, "#11119A"),
        read: (raw) => normalizeHexColor(raw, "#11119A"),
      },
    },
    dpiSnapper: defaultDpiSnapper,
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: true,
      hasPrimaryLedFeature: true,
      hasPerformanceMode: true,
      hasMotionSync: false,
      hasLinearCorrection: false,
      hasRippleControl: false,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: false,
      hasAtkLights: true,
      hasDpiLightCycle: true,
      hasReceiverLightCycle: false,
      hasStaticLedColorPanel: true,
      hasDpiColors: false,
      hasDpiLods: false,
      hasDpiAdvancedAxis: false,
      hasSensorAngle: true,
      hideSensorAngleVisualization: true,
      hideSensorAngleCenterMark: true,
      hasSurfaceFeel: true,
      surfaceModePrimaryLockPerfModes: ["oc"],
      showHeightViz: false,
      ledMasterBySecondarySurface: true,
      ledMasterGatesDpiLightEffect: true,
      ledMasterGatesReceiverLightEffect: true,
      ledMasterGatesSurfaceFeel: true,
      ledMasterGatesStaticLedColor: true,
      surfaceFeelRequiresDpiLightEffect: true,
      surfaceFeelRequiredDpiLightValue: 1,
      staticLedColorRequiresDpiLightEffect: true,
      staticLedColorRequiredDpiLightValue: 0,
      keymapButtonCount: 5,
      // Ninjutso protocol writes slot count first and then requires readback for stable slot DPI display.
      deferDpiSlotCountUiUntilAck: true,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
    },
  });

  const RapooProfile = composeDeviceProfile({
    id: "rapoo",
    ui: {
      landingReadyText: "RAPOO READY",
    },
    dpiSnapper: defaultDpiSnapper,
  });

  const normalizeRazerDynamicSensitivityMode = (v) => {
    const n = toNumber(v);
    if (!Number.isFinite(n)) return undefined;
    return clamp(Math.round(n), 0, 2);
  };

  const normalizeRazerSmartTrackingMode = (v) => {
    const mode = String(v ?? "symmetric").trim().toLowerCase();
    if (mode === "asymmetric" || mode === "asym") return "asymmetric";
    return "symmetric";
  };

  const normalizeRazerLowPowerThresholdPercent = (v) => {
    const n = toNumber(v);
    if (!Number.isFinite(n)) return undefined;
    const stepped = Math.round(Math.max(5, Math.min(100, n)) / 5) * 5;
    return clamp(stepped, 5, 100);
  };

  const normalizeRazerChargeLowThreshold = (v) => {
    if (typeof v === "string") {
      const text = v.trim().toLowerCase();
      if (!text) return undefined;
      const radix = text.startsWith("0x") ? 16 : 10;
      const parsed = Number.parseInt(text, radix);
      if (!Number.isFinite(parsed)) return undefined;
      return clamp(Math.round(parsed), 0x0d, 0xff);
    }
    const n = toNumber(v);
    if (!Number.isFinite(n)) return undefined;
    return clamp(Math.round(n), 0x0d, 0xff);
  };

  // Example of device-unique single-source advanced binding:
  // - sleepSeconds and hyperpollingIndicatorMode are sourced from `single` region.
  // - Protocol mapping remains in keyMap/transforms/actions (UI does not own protocol semantics).
  const RazerProfile = composeDeviceProfile({
    id: "razer",
    ui: {
      landingReadyText: "RAZER READY",
      keymap: {
        imageSrc: "./assets/images/VIPER_V3_耿鬼.png",
        points: {
          1: { x: 32, y: 14, side: "left" },
          2: { x: 68, y: 40, side: "right" },
          3: { x: 49.9, y: 25, side: "right" },
          4: { x: 26, y: 43, side: "left" },
          5: { x: 26, y: 54, side: "left" },
          6: { x: 49.9, y: 82, side: "right" },
        },
      },
      perfMode: razerTexts.perfMode,
      pollingThemeByWirelessHz: LOGITECH_POLLING_THEME_BY_HZ,
      basicModeTypography: {
        labelScaleX: 0.88,
        columnsOffsetX: -60,
      },
      advancedPanelDensity: "compact",
      advancedPanels: {
        dynamicSensitivityComposite: {
          requiresCapabilities: ["dynamicSensitivity"],
        },
        sensorAngle: {
          requiresFeatures: ["hasSensorAngle"],
          requiresCapabilities: ["sensorAngle"],
        },
        smartTrackingComposite: {
          requiresCapabilities: ["smartTracking"],
        },
        lowPowerThresholdPercent: {
          requiresCapabilities: ["lowPowerThresholdPercent"],
        },
        hyperpollingIndicator: {
          requiresCapabilities: ["hyperpollingIndicatorMode"],
        },
        sleepSeconds: {
          enabled: true,
        },
      },
      advancedSingleOrders: {
        hyperpollingIndicator: 10,
        dynamicSensitivityComposite: 20,
        sensorAngle: 30,
        smartTrackingComposite: 40,
        sleepSeconds: 50,
        lowPowerThresholdPercent: 60,
      },
      advancedCycleStateMeta: razerTexts.advancedCycleStateMeta,
      smartTrackingLevelLabels: razerTexts.smartTrackingLevelLabels,
      smartTrackingLevelHint: razerTexts.smartTrackingLevelHint,
      lowPowerThresholdLockedHint: razerTexts.lowPowerThresholdLockedHint,
      advancedSourceRegionByStdKey: {
        ...ADVANCED_SOURCE_REGION_DEFAULTS,
        sleepSeconds: "single",
        hyperpollingIndicatorMode: "single",
        dynamicSensitivityEnabled: "single",
        dynamicSensitivityMode: "single",
        sensorAngle: "single",
        smartTrackingMode: "single",
        smartTrackingLevel: "single",
        smartTrackingLiftDistance: "single",
        smartTrackingLandingDistance: "single",
        lowPowerThresholdPercent: "single",
        chargeLowThreshold: "single",
      },
    },
    ranges: {
      ...(window.AppConfig?.ranges?.razer || {}),
      dpi: {
        ...((window.AppConfig?.ranges?.razer?.dpi) || {}),
        step: 1,
        policy: {
          ...((window.AppConfig?.ranges?.razer?.dpi?.policy) || {}),
          mode: "fixed",
          step: 1,
        },
      },
    },
    keyMap: {
      performanceMode: null,
      pollingWirelessHz: null,
      dpiSlots: "dpiStages",
      dpiSlotsX: "dpiStages",
      dpiSlotsY: "dpiStages",
      dpiSlotCount: "dpiStages",
      activeDpiSlotIndex: "activeDpiStageIndex",
      sleepSeconds: "deviceIdleTime",
      debounceMs: null,
      hyperpollingIndicatorMode: "hyperpollingIndicatorMode",
      dynamicSensitivityEnabled: "dynamicSensitivityEnabled",
      dynamicSensitivityMode: "dynamicSensitivityMode",
      sensorAngle: "sensorAngle",
      smartTrackingMode: "smartTrackingMode",
      smartTrackingLevel: "smartTrackingLevel",
      smartTrackingLiftDistance: "smartTrackingLiftDistance",
      smartTrackingLandingDistance: "smartTrackingLandingDistance",
      lowPowerThresholdPercent: "lowPowerThresholdPercent",
      chargeLowThreshold: "chargeLowThreshold",
    },
    transforms: {
      pollingHz: {
        write: (v) => toNumber(v),
        read: (raw) => readNumber(raw),
      },
      dpiSlots: {
        write: (v) => normalizeDpiSlotArray(v),
        read: (raw) => stagesToDpiSlots(raw),
      },
      dpiSlotsX: {
        write: (v) => normalizeDpiSlotArray(v),
        read: (raw) => stagesToDpiSlotsX(raw),
      },
      dpiSlotsY: {
        write: (v) => normalizeDpiSlotArray(v),
        read: (raw) => stagesToDpiSlotsY(raw),
      },
      dpiSlotCount: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clampRazerStageCount(n, 1);
        },
        read: (raw) => stagesToSlotCount(raw),
      },
      activeDpiSlotIndex: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return Math.max(0, Math.round(n));
        },
        read: (raw) => readNumber(raw),
      },
      sleepSeconds: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return Math.max(0, Math.round(n));
        },
        read: (raw) => readNumber(raw),
      },
      hyperpollingIndicatorMode: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, 3);
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, 3);
        },
      },
      dynamicSensitivityEnabled: { write: (v) => !!v, read: readBool },
      dynamicSensitivityMode: {
        write: (v) => normalizeRazerDynamicSensitivityMode(v),
        read: (raw) => normalizeRazerDynamicSensitivityMode(raw),
      },
      sensorAngle: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), -44, 44);
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), -44, 44);
        },
      },
      smartTrackingMode: {
        write: (v) => normalizeRazerSmartTrackingMode(v),
        read: (raw) => normalizeRazerSmartTrackingMode(raw),
      },
      smartTrackingLevel: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 0, 2);
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 0, 2);
        },
      },
      smartTrackingLiftDistance: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 2, 26);
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 2, 26);
        },
      },
      smartTrackingLandingDistance: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, 25);
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, 25);
        },
      },
      lowPowerThresholdPercent: {
        write: (v) => normalizeRazerLowPowerThresholdPercent(v),
        read: (raw) => normalizeRazerLowPowerThresholdPercent(raw),
      },
      chargeLowThreshold: {
        write: (v) => normalizeRazerChargeLowThreshold(v),
        read: (raw) => normalizeRazerChargeLowThreshold(raw),
      },
    },
    actions: {
      pollingHz: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ pollingHz: value });
      },
      sleepSeconds: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ deviceIdleTime: value });
      },
      hyperpollingIndicatorMode: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ hyperpollingIndicatorMode: value });
      },
      dynamicSensitivityEnabled: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ dynamicSensitivityEnabled: value });
      },
      dynamicSensitivityMode: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ dynamicSensitivityMode: value });
      },
      sensorAngle: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ sensorAngle: value });
      },
      smartTrackingMode: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ smartTrackingMode: value });
      },
      smartTrackingLevel: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ smartTrackingLevel: value });
      },
      smartTrackingLiftDistance: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ smartTrackingLiftDistance: value });
      },
      smartTrackingLandingDistance: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ smartTrackingLandingDistance: value });
      },
      lowPowerThresholdPercent: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ lowPowerThresholdPercent: value });
      },
      chargeLowThreshold: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ chargeLowThreshold: value });
      },
      activeDpiSlotIndex: async ({ hidApi, value }) => {
        const idx = Math.max(0, Math.round(Number(value) || 0));
        if (typeof hidApi?.setActiveDpiSlotIndex !== "function") return;
        await hidApi.setActiveDpiSlotIndex(idx);
      },
      dpiSlotCount: async ({ hidApi, value }) => {
        const nextCount = clampRazerStageCount(value, 1);
        if (typeof hidApi?.setDpiSlotCount !== "function") return;
        await hidApi.setDpiSlotCount(nextCount);
      },
    },
    dpiSnapper: defaultDpiSnapper,
    features: {
      advancedLayout: "single",
      hasPrimarySurfaceToggle: false,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: false,
      hasPerformanceMode: false,
      hasConfigSlots: false,
      hasDualPollingRates: false,
      hideBasicSynapse: true,
      hideBasicFooterSecondaryText: false,
      hasMotionSync: false,
      hasLinearCorrection: false,
      hasRippleControl: false,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiLightCycle: false,
      hasReceiverLightCycle: false,
      hasStaticLedColorPanel: false,
      hasDpiColors: false,
      hasDpiLods: false,
      hasDpiAdvancedAxis: true,
      hasSensorAngle: true,
      hideSensorAngleVisualization: false,
      hideSensorAngleCenterMark: false,
      hasSurfaceFeel: false,
      showHeightViz: false,
      hideSportPerfMode: true,
      hasOnboardMemoryMode: false,
      warnOnDisableOnboardMemoryMode: false,
      autoEnableOnboardMemoryOnConnect: false,
      hasLightforceSwitch: false,
      hasSurfaceMode: false,
      hasBhopDelay: false,
      deferDpiSlotCountUiUntilAck: false,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
      keymapButtonCount: 6,
      enterDelayMs: 0,
    },
  });

  // Flat profile registry: each device is composed from common defaults plus explicit overrides.
  const DEVICE_PROFILES = {
    atk: AtkProfile,
    chaos: ChaosProfile,
    logitech: LogitechProfile,
    ninjutso: NinjutsoProfile,
    rapoo: RapooProfile,
    razer: RazerProfile,
  };

  // ============================================================
  // Runtime adapter section
  // ============================================================


  /**
   * Build runtime adapter snapshot from profile.
   * - Adapter is treated as read-only metadata by app.js/refactor.ui.js.
   * - Keep all device differences represented here, not in call sites.
   */
  function createAdapter(profile) {
    const cfg = profile?.ranges || window.AppConfig?.ranges?.[FALLBACK_DEVICE_ID];
    return {
      id: profile.id,
      ui: profile.ui || {},
      ranges: cfg,
      keyMap: profile.keyMap || {},
      transforms: profile.transforms || {},
      actions: profile.actions || {},
      dpiSnapper: typeof profile.dpiSnapper === "function" ? profile.dpiSnapper : null,
      features: profile.features || {},
    };
  }

  const adapters = Object.fromEntries(
    Object.entries(DEVICE_PROFILES).map(([id, profile]) => [id, createAdapter(profile)])
  );

  window.DeviceAdapters = {
    /**
     * Resolve runtime adapter by normalized device id.
     * This is the only adapter lookup entrypoint used by app.js and refactor.ui.js.
     */
    getAdapter(id) {
      return adapters[normalizeDeviceId(id)] || adapters[FALLBACK_DEVICE_ID];
    },
  };
})();


