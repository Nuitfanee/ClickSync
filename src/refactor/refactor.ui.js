/**
 * refactor.ui.js: profile-driven DOM rendering layer.
 *
 * Responsibilities:
 * - Render layout/visibility/order/text/options from adapter.ui + adapter.features.
 * - Apply advanced layout runtime (dual/single) and semantic item visibility.
 * - Keep rendering protocol-agnostic; never call protocol APIs here.
 *
 * Semantic DOM contract for advanced controls:
 * - data-adv-region: dual-left | dual-right | single
 * - data-adv-item: semantic item id (brand-neutral)
 * - data-adv-control: toggle | cycle | range | select | panel
 * - data-std-key: standard key used by DeviceReader/Writer
 *
 * Single-source region binding contract:
 * - Source region per stdKey is defined in profile.ui.advancedSourceRegionByStdKey.
 * - UI rendering reads this mapping only to target source controls.
 * - No cross-region fallback or event forwarding in this layer.
 *
 * New device extension flow (UI side):
 * 1) Declare feature gates and layout in profile.features.
 * 2) Declare texts/orders/cycle metadata/source-region mapping in profile.ui.
 * 3) Reuse existing semantic cards before creating new advanced items.
 * 4) If a new card is required, add data-adv-* markup and semantic query usage.
 * 5) Do not add deviceId branches; keep feature/profile-driven behavior only.
 */

// ============================================================
// 3) DeviceUI: semantic slots -> view variants
// ============================================================
(function () {
  const { buildSelectOptions } = window.AppConfig?.utils || {};
  const {
    DEFAULT_DEVICE_ID,
    resolveAdvancedPanelRegistry,
    evaluateAdvancedPanelVisibility,
  } = window.__DeviceRefactorCore || {};
  const FALLBACK_DEVICE_ID = String(DEFAULT_DEVICE_ID || "chaos").trim().toLowerCase() || "chaos";
  const tr = (zh, en) => (typeof window !== "undefined" && typeof window.tr === "function")
    ? window.tr(zh, en)
    : zh;

  // ============================================================
  // DOM base utilities
  // ============================================================

  /**
   * Cache the element's original innerHTML.
   * Purpose: keep the initial template for reversible variant switching.
   *
   * @param {HTMLElement|null} el - Target element.
   * @param {string} key - Cache key.
   * @returns {void} no return value
   */
  function cacheInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (!el.dataset[k]) el.dataset[k] = el.innerHTML;
  }

  /**
   * Restore the element's original innerHTML.
   * Purpose: restore initial template and avoid repeated-switch DOM pollution.
   *
   * @param {HTMLElement|null} el - Target element.
   * @param {string} key - Cache key.
   * @returns {void} no return value
   */
  function restoreInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (el.dataset[k]) el.innerHTML = el.dataset[k];
  }

  /**
   * Apply a value list to a select element.
   * Purpose: keep option rendering in one place and avoid scattered config logic.
   *
   * @param {HTMLSelectElement|null} selectEl - Select element.
   * @param {Array<number|string>} values - Value list.
   * @param {(value: number|string) => string} labelFn - Label generator.
   * @returns {void} no return value
   */
  function applySelectOptions(selectEl, values, labelFn) {
    if (!selectEl || !Array.isArray(values)) return;
    selectEl.innerHTML = buildSelectOptions(values, labelFn);
  }

  function setCachedNodeDisplay(el, visible, visibleDisplay = null) {
    if (!el) return;
    if (el.dataset.__orig_display == null) {
      el.dataset.__orig_display = String(el.style.display ?? "");
    }
    el.style.display = visible
      ? (visibleDisplay == null ? (el.dataset.__orig_display || "") : String(visibleDisplay))
      : "none";
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  // ============================================================
  // Performance mode
  // ============================================================

  const PERF_LABEL_MAP = Object.freeze({
    low: "LOW POWER",
    hp: "STANDARD",
    standard: "STANDARD",
    sport: "COMPETITIVE",
    oc: "OVERCLOCK",
  });

  const PERF_DOM_MODE_MAP = Object.freeze({
    low: "eco",
    hp: "std",
    standard: "std",
    sport: "comp",
    oc: "oc",
  });

  function resolveEffectivePerfModes({ ui, features }) {
    const perfModeConfig = (ui?.perfMode && typeof ui.perfMode === "object") ? ui.perfMode : null;
    if (!perfModeConfig) return null;
    const perfModes = Object.keys(perfModeConfig).map((v) => String(v).trim()).filter(Boolean);
    if (!perfModes.length) return null;
    return perfModes.filter((mode) => !(features?.hideSportPerfMode && mode === "sport"));
  }

  function syncPerfModeRadios(doc, perfModes) {
    if (!Array.isArray(perfModes) || !perfModes.length) return null;
    const currentChecked = String(doc.querySelector('input[name="perfMode"]:checked')?.value || "");
    const fallbackPerf = perfModes.includes("hp") ? "hp" : perfModes[0];
    const selectedPerfMode = perfModes.includes(currentChecked) ? currentChecked : fallbackPerf;
    const hiddenHost = doc.querySelector("#basicMonolith .basicHiddenControls") || doc.body || doc.documentElement;
    const radios = Array.from(doc.querySelectorAll('input[name="perfMode"]'));
    radios.forEach((radio) => {
      if (!perfModes.includes(String(radio.value || ""))) {
        radio.remove();
      }
    });
    perfModes.forEach((mode) => {
      let radio = doc.querySelector(`input[name="perfMode"][value="${mode}"]`);
      if (!radio) {
        radio = doc.createElement("input");
        radio.type = "radio";
        radio.name = "perfMode";
        radio.value = mode;
        hiddenHost?.appendChild(radio);
      }
      radio.checked = mode === selectedPerfMode;
    });
    return selectedPerfMode;
  }

  function renderPerfModeItems(basicModeColumn, perfModes, selectedPerfMode) {
    if (!basicModeColumn || !Array.isArray(perfModes) || !perfModes.length) return false;
    const activePerf = selectedPerfMode || (perfModes.includes("hp") ? "hp" : perfModes[0]);
    basicModeColumn.innerHTML = perfModes
      .map((mode) => {
        const active = mode === activePerf ? " active" : "";
        const label = PERF_LABEL_MAP[mode] || mode.toUpperCase();
        const modeTag = PERF_DOM_MODE_MAP[mode] || mode;
        return `<div class="basicItem${active}" role="button" tabindex="0" data-perf="${mode}" data-mode="${modeTag}">${label}<div class="basicAnchor"></div></div>`;
      })
      .join("");
    return true;
  }

  // ============================================================
  // Basic footer
  // ============================================================

  function ensureBasicFooterVariantStyle(docRef) {
    const hostDoc = docRef?.nodeType === 9 ? docRef : (docRef?.ownerDocument || document);
    if (!hostDoc || hostDoc.getElementById("basicFooterVariantStyle")) return;
    const styleEl = hostDoc.createElement("style");
    styleEl.id = "basicFooterVariantStyle";
    styleEl.textContent = `
#basicMonolith.basicFooterSingleDesc .basicFooter{
  justify-content: var(--basic-footer-justify-content, flex-start);
  align-items: var(--basic-footer-align-items, center);
  gap: var(--basic-footer-gap, 12px);
  padding: var(--basic-footer-padding, 34px 40px 26px 200px);
}
#basicMonolith.basicFooterSingleDesc #basicStatusText{
  display: none;
}
#basicMonolith.basicFooterSingleDesc .basicTicker{
  font-size: var(--basic-footer-ticker-size, clamp(24px, 2.6vw, 34px));
  font-weight: var(--basic-footer-ticker-weight, 500);
  opacity: var(--basic-footer-ticker-opacity, 1);
  line-height: var(--basic-footer-ticker-line-height, 1.08);
  letter-spacing: var(--basic-footer-ticker-letter-spacing, 0.02em);
  align-items: center;
  flex-wrap: wrap;
  column-gap: var(--basic-footer-ticker-gap, 10px);
  row-gap: 4px;
}
#basicMonolith.basicFooterSingleDesc .basicTicker .ticker-label{
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: inherit;
  margin-right: 0;
  transform: none;
}
#basicMonolith .basicColumnLeft{
  transform: translateX(calc(var(--basic-columns-offset-x, 0px) + var(--basic-mode-column-offset-x, 0px)));
}
#basicMonolith .basicColumnRight{
  transform: translateX(calc(var(--basic-columns-offset-x, 0px) + var(--basic-hz-column-offset-x, 0px)));
}
#basicMonolith .basicColumnLeft .basicLabel{
  transform-origin: right center;
  transform: scaleX(var(--basic-mode-label-scale-x, 1));
}
`;
    hostDoc.head?.appendChild(styleEl);
  }

  function normalizeCssLength(raw) {
    if (raw == null) return null;
    if (typeof raw === "number" && Number.isFinite(raw)) return `${raw}px`;
    const text = String(raw).trim();
    return text || null;
  }

  function applyBasicModeTypographyVariant({ doc, ui }) {
    const basicMonolith = doc.getElementById("basicMonolith");
    if (!basicMonolith) return;
    const typography = (ui?.basicModeTypography && typeof ui.basicModeTypography === "object")
      ? ui.basicModeTypography
      : {};
    const rawScaleX = Number(typography.labelScaleX);
    if (!Number.isFinite(rawScaleX) || rawScaleX <= 0) {
      basicMonolith.style.removeProperty("--basic-mode-label-scale-x");
    } else {
      const clampedScaleX = Math.min(1.2, Math.max(0.6, rawScaleX));
      basicMonolith.style.setProperty("--basic-mode-label-scale-x", String(clampedScaleX));
    }

    const vars = {
      "--basic-columns-offset-x": normalizeCssLength(typography.columnsOffsetX),
      "--basic-mode-column-offset-x": normalizeCssLength(typography.modeColumnOffsetX),
      "--basic-hz-column-offset-x": normalizeCssLength(typography.hzColumnOffsetX),
    };
    Object.entries(vars).forEach(([name, value]) => {
      if (!value) {
        basicMonolith.style.removeProperty(name);
        return;
      }
      basicMonolith.style.setProperty(name, value);
    });
  }

  function applyBasicFooterVariant({ doc, ui, features }) {
    const basicMonolith = doc.getElementById("basicMonolith");
    const basicStatusText = doc.getElementById("basicStatusText");
    const hideSecondaryText = !!features.hideBasicFooterSecondaryText;

    if (basicStatusText) {
      if (basicStatusText.dataset.__orig_display == null) {
        basicStatusText.dataset.__orig_display = String(basicStatusText.style.display ?? "");
      }
      basicStatusText.style.display = hideSecondaryText
        ? "none"
        : (basicStatusText.dataset.__orig_display || "");
      basicStatusText.setAttribute("aria-hidden", hideSecondaryText ? "true" : "false");
    }

    if (!basicMonolith) return;
    ensureBasicFooterVariantStyle(doc);
    basicMonolith.classList.toggle("basicFooterSingleDesc", hideSecondaryText);

    const typography = (ui?.basicFooterTypography && typeof ui.basicFooterTypography === "object")
      ? ui.basicFooterTypography
      : {};
    const vars = {
      "--basic-footer-justify-content": typography.footerJustifyContent,
      "--basic-footer-align-items": typography.footerAlignItems,
      "--basic-footer-gap": typography.footerGap,
      "--basic-footer-padding": typography.footerPadding,
      "--basic-footer-ticker-size": typography.tickerFontSize,
      "--basic-footer-ticker-weight": typography.tickerFontWeight,
      "--basic-footer-ticker-opacity": typography.tickerOpacity,
      "--basic-footer-ticker-line-height": typography.tickerLineHeight,
      "--basic-footer-ticker-letter-spacing": typography.tickerLetterSpacing,
      "--basic-footer-ticker-gap": typography.tickerGap,
      "--basic-footer-label-size": typography.labelFontSize,
      "--basic-footer-label-weight": typography.labelFontWeight,
      "--basic-footer-label-spacing": typography.labelLetterSpacing,
    };

    Object.entries(vars).forEach(([name, value]) => {
      if (value == null || String(value).trim() === "") {
        basicMonolith.style.removeProperty(name);
        return;
      }
      basicMonolith.style.setProperty(name, String(value));
    });
  }

  // ============================================================
  // Keymap variant section
  // ============================================================

  const normalizeDeviceDisplayName = (name) =>
    String(name || "").trim().replace(/\s+/g, " ").toUpperCase();
  const __keymapPreloadCache = new Map();
  let __enterAssetPrepareSeq = 0;

  function createStaleEnterAssetsError() {
    const err = new Error("Enter asset preparation is stale");
    err.code = "STALE_ENTER_ASSETS";
    return err;
  }

  function getHostDocument(root) {
    return root?.nodeType === 9 ? root : (root?.ownerDocument || document);
  }

  function getKeymapCanvas(doc) {
    return getHostDocument(doc).getElementById("kmCanvas");
  }

  function getKeymapImage(doc) {
    return getHostDocument(doc).querySelector("#keys .kmImg");
  }

  function setKeymapReady(doc, ready) {
    const canvas = getKeymapCanvas(doc);
    if (canvas) canvas.dataset.keymapReady = ready ? "1" : "0";
  }

  function isImgReadyFor(imageEl, src) {
    return (
      !!imageEl
      && !!src
      && String(imageEl.getAttribute("src") || "").trim() === String(src || "").trim()
      && !!imageEl.complete
      && Number(imageEl.naturalWidth || 0) > 0
    );
  }

  function emitKeymapResize() {
    try { window.dispatchEvent(new Event("resize")); } catch (_) {}
  }

  function getTemplateKeymapScene(doc) {
    const hostDoc = getHostDocument(doc);
    const img = getKeymapImage(hostDoc);
    if (img && img.dataset.__orig_src == null) {
      img.dataset.__orig_src = String(img.getAttribute("src") || "").trim();
    }

    const points = Array.from(hostDoc.querySelectorAll("#keys .kmPoint"));
    const pointMap = {};
    points.forEach((point) => {
      if (point.dataset.__orig_x == null) {
        point.dataset.__orig_x = String(point.style.getPropertyValue("--x") || "");
      }
      if (point.dataset.__orig_y == null) {
        point.dataset.__orig_y = String(point.style.getPropertyValue("--y") || "");
      }
      if (point.dataset.__orig_side == null) {
        point.dataset.__orig_side = point.classList.contains("bubble-left")
          ? "left"
          : (point.classList.contains("bubble-right") ? "right" : "");
      }
      const btnId = String(point.getAttribute("data-btn") || "").trim();
      if (!btnId) return;
      const x = Number(point.dataset.__orig_x);
      const y = Number(point.dataset.__orig_y);
      const side = String(point.dataset.__orig_side || "").trim().toLowerCase();
      const cfg = {};
      if (Number.isFinite(x)) cfg.x = x;
      if (Number.isFinite(y)) cfg.y = y;
      if (side === "left" || side === "right") cfg.side = side;
      pointMap[btnId] = cfg;
    });

    return {
      imageSrc: String(img?.dataset.__orig_src || img?.getAttribute("src") || "").trim(),
      points: pointMap,
    };
  }

  function normalizeKeymapScene(scene, fallbackScene) {
    const fallback = (fallbackScene && typeof fallbackScene === "object")
      ? fallbackScene
      : { imageSrc: "", points: {} };
    const points = (scene?.points && typeof scene.points === "object")
      ? scene.points
      : {};
    return {
      imageSrc: String(scene?.imageSrc || fallback.imageSrc || "").trim(),
      points,
    };
  }

  function resolveKeymapVariant({ ui, deviceName }) {
    const keymapCfg = (ui?.keymap && typeof ui.keymap === "object") ? ui.keymap : {};
    const baseImageSrc = typeof keymapCfg.imageSrc === "string" ? keymapCfg.imageSrc : "";
    const basePoints = (keymapCfg.points && typeof keymapCfg.points === "object")
      ? keymapCfg.points
      : {};
    const normalizedName = normalizeDeviceDisplayName(deviceName);
    const variants = Array.isArray(keymapCfg.variants) ? keymapCfg.variants : [];
    const matched = variants.find((variant) => {
      if (!normalizedName) return false;
      const names = Array.isArray(variant?.deviceNames)
        ? variant.deviceNames
        : (variant?.deviceName ? [variant.deviceName] : []);
      return names.some((name) => normalizeDeviceDisplayName(name) === normalizedName);
    }) || null;
    if (!matched) {
      return {
        imageSrc: baseImageSrc,
        points: basePoints,
      };
    }
    const variantImageSrc = typeof matched.imageSrc === "string" ? matched.imageSrc : baseImageSrc;
    const variantPointsRaw = (matched.points && typeof matched.points === "object")
      ? matched.points
      : {};
    const mergedPoints = { ...basePoints };
    Object.entries(variantPointsRaw).forEach(([btnId, point]) => {
      if (!point || typeof point !== "object") return;
      const prev = (mergedPoints[btnId] && typeof mergedPoints[btnId] === "object")
        ? mergedPoints[btnId]
        : {};
      mergedPoints[btnId] = { ...prev, ...point };
    });
    return {
      imageSrc: variantImageSrc,
      points: mergedPoints,
    };
  }

  function applyKeymapPointScene(doc, pointMap = {}) {
    const hostDoc = getHostDocument(doc);
    const points = Array.from(hostDoc.querySelectorAll("#keys .kmPoint"));
    let changed = false;
    points.forEach((point) => {
      if (point.dataset.__orig_x == null) {
        point.dataset.__orig_x = String(point.style.getPropertyValue("--x") || "");
      }
      if (point.dataset.__orig_y == null) {
        point.dataset.__orig_y = String(point.style.getPropertyValue("--y") || "");
      }
      if (point.dataset.__orig_side == null) {
        point.dataset.__orig_side = point.classList.contains("bubble-left")
          ? "left"
          : (point.classList.contains("bubble-right") ? "right" : "");
      }
      const btnId = String(point.getAttribute("data-btn") || "");
      const pointCfg = pointMap[btnId] || pointMap[Number(btnId)] || null;
      const x = Number(pointCfg?.x);
      const y = Number(pointCfg?.y);
      const side = String(pointCfg?.side || "").trim().toLowerCase();
      const nextX = Number.isFinite(x) ? String(x) : String(point.dataset.__orig_x || "");
      const nextY = Number.isFinite(y) ? String(y) : String(point.dataset.__orig_y || "");
      const prevX = String(point.style.getPropertyValue("--x") || "");
      const prevY = String(point.style.getPropertyValue("--y") || "");
      if (nextX) {
        if (prevX !== nextX) {
          point.style.setProperty("--x", nextX);
          changed = true;
        }
      } else if (prevX) {
        point.style.removeProperty("--x");
        changed = true;
      }
      if (nextY) {
        if (prevY !== nextY) {
          point.style.setProperty("--y", nextY);
          changed = true;
        }
      } else if (prevY) {
        point.style.removeProperty("--y");
        changed = true;
      }
      const nextSide = (side === "left" || side === "right")
        ? side
        : String(point.dataset.__orig_side || "");
      const prevSide = point.classList.contains("bubble-left")
        ? "left"
        : (point.classList.contains("bubble-right") ? "right" : "");
      if (prevSide !== nextSide) {
        point.classList.remove("bubble-left", "bubble-right");
        if (nextSide === "left" || nextSide === "right") {
          point.classList.add(`bubble-${nextSide}`);
        }
        changed = true;
      }
    });
    return changed;
  }

  function ensureKeymapVariantHooks(doc) {
    const hostDoc = getHostDocument(doc);
    const img = getKeymapImage(hostDoc);
    if (!img || img.dataset.__variant_load_hooked) return;
    img.dataset.__variant_load_hooked = "1";
    img.addEventListener("load", () => {
      img.removeAttribute("data-keymap-load-failed");
      setKeymapReady(hostDoc, true);
      emitKeymapResize();
    }, { passive: true });
    img.addEventListener("error", () => {
      const fallbackScene = getTemplateKeymapScene(hostDoc);
      const fallbackSrc = String(fallbackScene.imageSrc || "").trim();
      const failedSrc = String(img.getAttribute("src") || "").trim();
      if (fallbackSrc && failedSrc && failedSrc !== fallbackSrc) {
        img.dataset.keymapLoadFailed = failedSrc;
        applyKeymapSceneSync({ doc: hostDoc, scene: fallbackScene });
        return;
      }
      setKeymapReady(hostDoc, true);
    }, { passive: true });
  }

  function resolveActiveKeymapScene({ doc, ui, deviceName }) {
    const fallbackScene = getTemplateKeymapScene(doc);
    return normalizeKeymapScene(resolveKeymapVariant({ ui, deviceName }), fallbackScene);
  }

  function applyKeymapSceneSync({ doc, scene }) {
    const hostDoc = getHostDocument(doc);
    const img = getKeymapImage(hostDoc);
    const nextScene = normalizeKeymapScene(scene, getTemplateKeymapScene(hostDoc));
    ensureKeymapVariantHooks(hostDoc);
    let changed = applyKeymapPointScene(hostDoc, nextScene.points);

    if (!img) {
      setKeymapReady(hostDoc, true);
      if (changed) emitKeymapResize();
      return;
    }

    const nextSrc = String(nextScene.imageSrc || "").trim();
    const curSrc = String(img.getAttribute("src") || "").trim();
    if (!nextSrc) {
      setKeymapReady(hostDoc, true);
    } else if (isImgReadyFor(img, nextSrc)) {
      setKeymapReady(hostDoc, true);
    } else {
      setKeymapReady(hostDoc, false);
      if (curSrc !== nextSrc) {
        img.setAttribute("src", nextSrc);
        changed = true;
      }
    }

    if (changed) emitKeymapResize();
  }

  function preloadImageSource(src) {
    const nextSrc = String(src || "").trim();
    if (!nextSrc) return Promise.resolve(nextSrc);
    const cached = __keymapPreloadCache.get(nextSrc);
    if (cached) return cached;

    const preloadPromise = new Promise((resolve, reject) => {
      const probe = new Image();
      const cleanup = () => {
        probe.onload = null;
        probe.onerror = null;
      };
      probe.decoding = "async";
      probe.onload = () => {
        cleanup();
        resolve(nextSrc);
      };
      probe.onerror = () => {
        cleanup();
        __keymapPreloadCache.delete(nextSrc);
        const err = new Error(`Keymap image failed to preload: ${nextSrc}`);
        err.code = "KEYMAP_PRELOAD_FAILED";
        reject(err);
      };
      probe.src = nextSrc;
      if (probe.complete) {
        if (Number(probe.naturalWidth || 0) > 0) {
          cleanup();
          resolve(nextSrc);
        } else {
          cleanup();
          __keymapPreloadCache.delete(nextSrc);
          const err = new Error(`Keymap image failed to preload: ${nextSrc}`);
          err.code = "KEYMAP_PRELOAD_FAILED";
          reject(err);
        }
      }
    });

    __keymapPreloadCache.set(nextSrc, preloadPromise);
    return preloadPromise;
  }

  function waitForImageElementReady(imageEl, src) {
    const nextSrc = String(src || "").trim();
    if (!imageEl || !nextSrc || isImgReadyFor(imageEl, nextSrc)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        imageEl.removeEventListener("load", onLoad);
        imageEl.removeEventListener("error", onError);
      };
      const onLoad = () => {
        if (!isImgReadyFor(imageEl, nextSrc)) return;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (String(imageEl.getAttribute("src") || "").trim() !== nextSrc) return;
        cleanup();
        const err = new Error(`Keymap image failed to render: ${nextSrc}`);
        err.code = "KEYMAP_RENDER_FAILED";
        reject(err);
      };
      imageEl.addEventListener("load", onLoad, { passive: true });
      imageEl.addEventListener("error", onError, { passive: true });
    });
  }

  function isEnterAssetPreparationCurrent(seq, guard = null) {
    return seq === __enterAssetPrepareSeq && (typeof guard !== "function" || !!guard());
  }

  async function applyPreparedKeymapScene({ doc, scene, seq, guard = null }) {
    const hostDoc = getHostDocument(doc);
    const img = getKeymapImage(hostDoc);
    const nextScene = normalizeKeymapScene(scene, getTemplateKeymapScene(hostDoc));
    ensureKeymapVariantHooks(hostDoc);

    if (!isEnterAssetPreparationCurrent(seq, guard)) throw createStaleEnterAssetsError();
    const pointsChanged = applyKeymapPointScene(hostDoc, nextScene.points);

    if (!img) {
      setKeymapReady(hostDoc, true);
      if (pointsChanged) emitKeymapResize();
      return;
    }

    const nextSrc = String(nextScene.imageSrc || "").trim();
    if (!nextSrc) {
      setKeymapReady(hostDoc, true);
      if (pointsChanged) emitKeymapResize();
      return;
    }

    if (isImgReadyFor(img, nextSrc)) {
      img.removeAttribute("data-keymap-load-failed");
      setKeymapReady(hostDoc, true);
      if (pointsChanged) emitKeymapResize();
      return;
    }

    setKeymapReady(hostDoc, false);
    if (String(img.getAttribute("src") || "").trim() !== nextSrc) {
      img.setAttribute("src", nextSrc);
    }
    await waitForImageElementReady(img, nextSrc);
    if (!isEnterAssetPreparationCurrent(seq, guard)) throw createStaleEnterAssetsError();

    img.removeAttribute("data-keymap-load-failed");
    setKeymapReady(hostDoc, true);
    emitKeymapResize();
  }

  async function prepareKeymapEnterAsset({ doc, ui, deviceName, seq, guard = null }) {
    const hostDoc = getHostDocument(doc);
    const fallbackScene = getTemplateKeymapScene(hostDoc);
    const targetScene = resolveActiveKeymapScene({ doc: hostDoc, ui, deviceName });
    const scenes = [targetScene];
    if (String(targetScene.imageSrc || "").trim() !== String(fallbackScene.imageSrc || "").trim()) {
      scenes.push(fallbackScene);
    }

    let finalScene = null;
    let lastErr = null;
    for (const scene of scenes) {
      if (!isEnterAssetPreparationCurrent(seq, guard)) throw createStaleEnterAssetsError();
      try {
        const nextSrc = String(scene.imageSrc || "").trim();
        if (nextSrc) {
          const img = getKeymapImage(hostDoc);
          if (!isImgReadyFor(img, nextSrc)) {
            await preloadImageSource(nextSrc);
          }
        }
        finalScene = scene;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!finalScene) throw lastErr || new Error("Unable to prepare keymap enter asset");
    await applyPreparedKeymapScene({ doc: hostDoc, scene: finalScene, seq, guard });
  }

  function prepareEnterAssets({ deviceId, adapter, root, deviceName = "", guard = null } = {}) {
    const doc = getHostDocument(root);
    const ui = adapter?.ui || {};
    const seq = (++__enterAssetPrepareSeq);
    const tasks = [];
    const registerTask = (name, task) => {
      if (typeof task !== "function") return;
      tasks.push(
        Promise.resolve()
          .then(task)
          .catch((err) => {
            if (err && !err.enterAssetName) err.enterAssetName = name;
            throw err;
          })
      );
    };

    registerTask("keymap", () => prepareKeymapEnterAsset({
      doc,
      ui,
      deviceName,
      seq,
      guard,
      deviceId,
    }));

    return Promise.all(tasks).then(() => {
      if (!isEnterAssetPreparationCurrent(seq, guard)) {
        throw createStaleEnterAssetsError();
      }
    });
  }

  function applyKeymapVariant({ doc, ui, deviceName }) {
    applyKeymapSceneSync({
      doc,
      scene: resolveActiveKeymapScene({ doc, ui, deviceName }),
    });
  }

  // ============================================================
  // Advanced layout
  // ============================================================

  const ADVANCED_LAYOUT_SINGLE = "single";
  const ADVANCED_LAYOUT_DUAL = "dual";
  const ADVANCED_PANEL_DENSITY_DEFAULT = "default";
  const ADVANCED_PANEL_DENSITY_COMPACT = "compact";
  const ADVANCED_PANEL_HOSTS = Object.freeze({
    sleepSeconds: Object.freeze([
      Object.freeze({ region: "dual-left", selector: '[data-adv-region="dual-left"] .slider-card[data-adv-item="sleepSeconds"][data-adv-control="range"]' }),
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] .slider-card[data-adv-item="sleepSeconds"][data-adv-control="range"]' }),
    ]),
    debounceMs: Object.freeze([
      Object.freeze({ region: "dual-left", selector: '[data-adv-region="dual-left"] .slider-card[data-adv-item="debounceMs"][data-adv-control="range"]' }),
    ]),
    sensorAngle: Object.freeze([
      Object.freeze({ region: "dual-left", selector: '[data-adv-region="dual-left"] .slider-card[data-adv-item="sensorAngle"][data-adv-control="range"]' }),
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] .slider-card[data-adv-item="sensorAngle"][data-adv-control="range"]' }),
    ]),
    surfaceFeel: Object.freeze([
      Object.freeze({ region: "dual-left", selector: '[data-adv-region="dual-left"] .slider-card[data-adv-item="surfaceFeel"][data-adv-control="range"]' }),
    ]),
    motionSync: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="motionSync"][data-adv-control="toggle"]' }),
    ]),
    linearCorrection: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="linearCorrection"][data-adv-control="toggle"]' }),
    ]),
    rippleControl: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="rippleControl"][data-adv-control="toggle"]' }),
    ]),
    secondarySurfaceToggle: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="secondarySurfaceToggle"][data-adv-control="toggle"]' }),
    ]),
    keyScanningRate: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="keyScanningRate"][data-adv-control="cycle"]', visibleDisplay: "block" }),
    ]),
    surfaceModePrimary: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="surfaceModePrimary"][data-adv-control="toggle"]' }),
    ]),
    primaryLedFeature: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="primaryLedFeature"][data-adv-control="toggle"]' }),
    ]),
    dpiLightEffect: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="dpiLightEffect"][data-adv-control="cycle"]', visibleDisplay: "block" }),
    ]),
    receiverLightEffect: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="receiverLightEffect"][data-adv-control="cycle"]', visibleDisplay: "block" }),
    ]),
    longRangeMode: Object.freeze([
      Object.freeze({ region: "dual-right", selector: '[data-adv-region="dual-right"] [data-adv-item="longRangeMode"][data-adv-control="toggle"]', visibleDisplay: "block" }),
    ]),
    onboardMemory: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="onboardMemory"][data-adv-control="toggle"]' }),
    ]),
    lightforceSwitch: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="lightforceSwitch"][data-adv-control="toggle"]' }),
    ]),
    surfaceMode: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="surfaceMode"][data-adv-control="cycle"]' }),
    ]),
    bhopToggle: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="bhopToggle"][data-adv-control="toggle"]' }),
    ]),
    bhopDelay: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] .slider-card[data-adv-item="bhopDelay"][data-adv-control="range"]' }),
    ]),
    dynamicSensitivityComposite: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="dynamicSensitivityComposite"][data-adv-control="cycle"]' }),
    ]),
    smartTrackingComposite: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="smartTrackingComposite"][data-adv-control="panel"]' }),
    ]),
    lowPowerThresholdPercent: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] .slider-card[data-adv-item="lowPowerThresholdPercent"][data-adv-control="range"]' }),
    ]),
    hyperpollingIndicator: Object.freeze([
      Object.freeze({ region: "single", selector: '[data-adv-region="single"] [data-adv-item="hyperpollingIndicator"][data-adv-control="cycle"]' }),
    ]),
  });

  function getAdvancedPanel(doc) {
    return doc?.getElementById?.("advancedPanel") || null;
  }

  function queryAdvancedRegion(doc, region) {
    const panel = getAdvancedPanel(doc);
    if (!panel || !region) return null;
    return panel.querySelector(`[data-adv-region="${region}"]`);
  }

  function queryAdvancedItem(doc, itemKey, { region = "", control = "" } = {}) {
    const panel = getAdvancedPanel(doc);
    if (!panel || !itemKey) return null;
    // Key maintenance rule:
    // data-adv-item and data-adv-control must live on the same element,
    // so use compound selectors.
    // Example:
    // [data-adv-item=sleepSeconds][data-adv-control=select]
    // Never use descendant spacing between them.
    // Otherwise advanced-page select/range queries fail and sliders/visuals stop updating.
    const regionPrefix = region ? `[data-adv-region="${region}"] ` : "";
    const selector = `[data-adv-item="${itemKey}"]` + (control ? `[data-adv-control="${control}"]` : "");
    return panel.querySelector(regionPrefix + selector);
  }

  function queryAdvancedContainer(doc, itemKey, { region = "", control = "" } = {}) {
    const panel = getAdvancedPanel(doc);
    if (!panel || !itemKey) return null;
    const prefix = region ? `[data-adv-region="${region}"] ` : "";
    const selector = `${prefix}[data-adv-item="${itemKey}"]${control ? `[data-adv-control="${control}"]` : ""}:not(input):not(select)`;
    return panel.querySelector(selector);
  }

  function queryAdvancedToggleInput(doc, itemKey, opts = {}) {
    const host = queryAdvancedItem(doc, itemKey, { ...opts, control: "toggle" }) || queryAdvancedItem(doc, itemKey, opts);
    if (!host) return null;
    if (host.matches?.('input[type="checkbox"]')) return host;
    return host.querySelector('input[type="checkbox"]');
  }

  function queryAdvancedRangeInput(doc, itemKey, opts = {}) {
    const host = queryAdvancedItem(doc, itemKey, { ...opts, control: "range" }) || queryAdvancedItem(doc, itemKey, opts);
    if (!host) return null;
    if (host.matches?.('input[type="range"]')) return host;
    return host.querySelector('input[type="range"]');
  }

  function queryAdvancedSelect(doc, itemKey, opts = {}) {
    const host = queryAdvancedItem(doc, itemKey, { ...opts, control: "select" }) || queryAdvancedItem(doc, itemKey, opts);
    if (!host) return null;
    if (host.matches?.("select")) return host;
    return host.querySelector("select");
  }

  // Source-region resolver used by UI option/range injection.
  // New device rule:
  // - Add or override stdKey mapping in profile.ui.advancedSourceRegionByStdKey.
  // - Keep this resolver generic; do not add brand-specific branches here.
  // - fallbackRegion is only used when mapping is absent; never do cross-region control fallback.
  const ADVANCED_SOURCE_REGIONS = new Set(["dual-left", "dual-right", "single"]);

  function resolveAdvancedSourceRegion(adapter, stdKey, fallbackRegion = "dual-left") {
    const fallback = ADVANCED_SOURCE_REGIONS.has(fallbackRegion) ? fallbackRegion : "dual-left";
    const mapping = adapter?.ui?.advancedSourceRegionByStdKey;
    const raw = String(mapping?.[stdKey] || "").trim().toLowerCase();
    return ADVANCED_SOURCE_REGIONS.has(raw) ? raw : fallback;
  }

  function resolveAdvancedLayout(features) {
    const raw = String(features?.advancedLayout || "").trim().toLowerCase();
    return raw === ADVANCED_LAYOUT_SINGLE ? ADVANCED_LAYOUT_SINGLE : ADVANCED_LAYOUT_DUAL;
  }

  function resolveAdvancedPanelDensity(ui) {
    const raw = String(ui?.advancedPanelDensity || "").trim().toLowerCase();
    return raw === ADVANCED_PANEL_DENSITY_COMPACT
      ? ADVANCED_PANEL_DENSITY_COMPACT
      : ADVANCED_PANEL_DENSITY_DEFAULT;
  }

  function applyAdvancedPanelDensity({ doc, ui }) {
    const advancedPanel = getAdvancedPanel(doc);
    if (!advancedPanel) return;
    advancedPanel.setAttribute("data-adv-density", resolveAdvancedPanelDensity(ui));
  }

  function applyAdvancedLayout({ doc, layout }) {
    const advancedPanel = getAdvancedPanel(doc);
    const advancedDualLeft = queryAdvancedRegion(doc, "dual-left");
    const advancedDualRight = queryAdvancedRegion(doc, "dual-right");
    const advancedSingleColumn = queryAdvancedRegion(doc, "single");
    const isSingle = layout === ADVANCED_LAYOUT_SINGLE;

    if (advancedPanel) {
      advancedPanel.classList.toggle("advanced-layout-single", isSingle);
      advancedPanel.classList.toggle("advanced-layout-dual", !isSingle);
      advancedPanel.setAttribute("aria-hidden", "false");
    }
    setCachedNodeDisplay(advancedDualLeft, !isSingle);
    setCachedNodeDisplay(advancedDualRight, !isSingle);
    setCachedNodeDisplay(advancedSingleColumn, isSingle);
  }

  function queryAdvancedPanelHost(doc, hostMeta) {
    if (!doc || !hostMeta?.selector) return null;
    return doc.querySelector(hostMeta.selector);
  }

  function isAdvancedPanelRegionVisible(layout, region) {
    return layout === ADVANCED_LAYOUT_SINGLE ? region === "single" : region !== "single";
  }

  function applyAdvancedPanelAvailability({ doc, adapter, layout, capabilities }) {
    const features = adapter?.features || {};
    const registry = typeof resolveAdvancedPanelRegistry === "function"
      ? resolveAdvancedPanelRegistry(adapter)
      : {};
    const capabilityBag = (capabilities && typeof capabilities === "object") ? capabilities : {};

    Object.entries(ADVANCED_PANEL_HOSTS).forEach(([itemKey, hostEntries]) => {
      const rule = registry?.[itemKey] || null;
      const nextHosts = Array.isArray(hostEntries) ? hostEntries : [];
      nextHosts.forEach((hostMeta) => {
        const node = queryAdvancedPanelHost(doc, hostMeta);
        if (!node) return;
        const region = String(hostMeta?.region || "").trim().toLowerCase();
        const regionPass = !Array.isArray(rule?.regions) || !rule.regions.length
          ? true
          : rule.regions.includes(region);
        const capabilityPass = typeof evaluateAdvancedPanelVisibility === "function"
          ? evaluateAdvancedPanelVisibility(rule, {
            features,
            capabilities: capabilityBag,
          })
          : true;
        const visible = regionPass && isAdvancedPanelRegionVisible(layout, region) && capabilityPass;
        setCachedNodeDisplay(node, visible, hostMeta?.visibleDisplay ?? null);
      });
    });
  }

  function setOrderWithRestore(el, rawOrder) {
    if (!el) return;
    if (el.dataset.__orig_order == null) el.dataset.__orig_order = String(el.style.order ?? "");
    if (rawOrder == null || rawOrder === "") {
      el.style.order = el.dataset.__orig_order || "";
      return;
    }
    const numeric = Number(rawOrder);
    el.style.order = Number.isFinite(numeric) ? String(numeric) : String(rawOrder);
  }

  function resolveAdvancedSingleOrderHost(singleRegion, node) {
    if (!singleRegion || !node) return null;
    let cur = node;
    while (cur && cur.parentElement && cur.parentElement !== singleRegion) {
      cur = cur.parentElement;
    }
    if (!cur || cur === singleRegion) return null;
    return cur;
  }

  function applyAdvancedSingleItemOrders({ doc, adapter }) {
    const ui = adapter?.ui || {};
    const registry = typeof resolveAdvancedPanelRegistry === "function"
      ? resolveAdvancedPanelRegistry(adapter)
      : {};
    const advancedSingleOrders = (ui?.advancedSingleOrders && typeof ui.advancedSingleOrders === "object")
      ? ui.advancedSingleOrders
      : {};
    const singleRegion = queryAdvancedRegion(doc, "single");
    if (!singleRegion) return;

    const hostOrderCandidates = new Map();
    Object.entries(ADVANCED_PANEL_HOSTS).forEach(([itemKey, hostEntries]) => {
      const singleHost = (Array.isArray(hostEntries) ? hostEntries : []).find((hostMeta) => hostMeta?.region === "single");
      if (!singleHost) return;
      const node = queryAdvancedPanelHost(doc, singleHost);
      if (!node) return;
      const host = resolveAdvancedSingleOrderHost(singleRegion, node);
      if (!host) return;
      if (!hostOrderCandidates.has(host)) hostOrderCandidates.set(host, []);
      const ruleOrder = Object.prototype.hasOwnProperty.call(registry?.[itemKey] || {}, "order")
        ? registry[itemKey].order
        : undefined;
      const rawOrder = ruleOrder !== undefined ? ruleOrder : advancedSingleOrders[itemKey];
      if (rawOrder === undefined) return;
      hostOrderCandidates.get(host).push(rawOrder);
    });

    hostOrderCandidates.forEach((orders, host) => {
      if (!Array.isArray(orders) || !orders.length) {
        setOrderWithRestore(host, null);
        return;
      }
      const numericOrders = orders
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      if (numericOrders.length) {
        setOrderWithRestore(host, Math.min(...numericOrders));
        return;
      }
      setOrderWithRestore(host, orders[0]);
    });
  }

  /**
   * Apply runtime layout and semantic item visibility for advanced panel.
   * - Reads only adapter.features and adapter.ui metadata (including density mode).
   * - Keeps source-region ownership profile-driven (no brand branches, no cross-region fallback).
   * - Safe to call repeatedly on capability updates and config readback.
   */
  function applyAdvancedRuntime({ adapter, root, capabilities = null }) {
    const doc = root || document;
    const features = adapter?.features || {};
    const ui = adapter?.ui || {};
    const layout = resolveAdvancedLayout(features);
    applyAdvancedLayout({ doc, layout });
    applyAdvancedPanelDensity({ doc, ui });
    applyAdvancedPanelAvailability({ doc, adapter, layout, capabilities });
    applyAdvancedSingleItemOrders({ doc, adapter });
  }

  // ============================================================
  // Slider track utilities
  // ============================================================

  function installAutoTrackInterval(root) {
    /**
     * Compute and write slider track tick interval.
     * Purpose: control tick density to balance performance and readability.
     *
     * @param {HTMLInputElement} input - Range input.
     * @param {HTMLElement} customTrack - Track element.
     * @returns {void} no return value
     */
    const updateTrackInterval = (input, customTrack) => {
      if (!input || !customTrack) return;
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 100;
      const step = parseFloat(input.step) || 1;
      const range = max - min;
      if (range <= 0) return;

      let effectiveStep = step;
      let count = range / effectiveStep;

      while (count > 20) {
        effectiveStep *= 2;
        count = range / effectiveStep;
      }

      if (count < 1) count = 1;

      const interval = (effectiveStep / range) * 100;
      customTrack.style.setProperty("--track-interval", `${interval}%`);
    };

    const sliders = root.querySelectorAll('#advancedPanel input[type="range"]');
    sliders.forEach((slider) => {
      const track = slider.closest(".range-wrap")?.querySelector(".custom-track");
      if (!track) return;
      updateTrackInterval(slider, track);

      const observer = new MutationObserver(() => updateTrackInterval(slider, track));
      observer.observe(slider, { attributes: true, attributeFilter: ["min", "max", "step"] });
    });
  }

  // ============================================================
  // applyVariant helper section
  // ============================================================

  function __setHeightVizVisible({ heightVizWrap, heightBlock, feelCard, visible }) {
    const target = (heightVizWrap && heightVizWrap !== feelCard) ? heightVizWrap : heightBlock;
    if (!target) return;
    if (target.dataset.__orig_display == null) target.dataset.__orig_display = String(target.style.display ?? "");
    target.style.display = visible ? (target.dataset.__orig_display || "") : "none";
  }

  function applyTextWithRestore(el, text) {
    if (!el) return;
    if (el.dataset.__orig_text == null) el.dataset.__orig_text = String(el.textContent ?? "");
    if (text != null) {
      el.textContent = String(text);
      return;
    }
    if (el.dataset.__orig_text != null) el.textContent = el.dataset.__orig_text;
  }

  function applySectionHeaderText(el, text) {
    const nextText = (text != null && String(text).trim() !== "") ? String(text) : null;
    applyTextWithRestore(el, nextText);
  }

  function applyMetaBlockWithRestore(item, meta) {
    if (!item) return;
    const nextMeta = (meta && typeof meta === "object" && !Array.isArray(meta)) ? meta : null;
    applyTextWithRestore(item.querySelector(".label-code"), nextMeta?.code);
    applyTextWithRestore(item.querySelector(".label-title"), nextMeta?.title);
    applyTextWithRestore(item.querySelector(".label-desc"), nextMeta?.desc);
  }

  function __setNodeDisplayByFeature(el, hideByFeature) {
    if (!el) return;
    if (el.dataset.__orig_display == null) {
      el.dataset.__orig_display = String(el.style.display ?? "");
    }
    el.style.display = hideByFeature ? "none" : (el.dataset.__orig_display || "");
  }

  function applyCycleMeta(item, meta) {
    applyMetaBlockWithRestore(item, meta);
  }

  const CYCLE_META_FIELD_SPEC = Object.freeze({
    code: { selector: ".label-code", cacheAttr: "data-adv-cycle-orig-code" },
    title: { selector: ".label-title", cacheAttr: "data-adv-cycle-orig-title" },
    desc: { selector: ".label-desc", cacheAttr: "data-adv-cycle-orig-desc" },
  });
  const cycleStateMetaBindings = new WeakMap();
  const cycleStateMetaBoundElements = new Set();

  function __resolveCycleStateValues(itemConfig) {
    if (!itemConfig || typeof itemConfig !== "object" || Array.isArray(itemConfig)) return null;
    const source = (itemConfig.values && typeof itemConfig.values === "object" && !Array.isArray(itemConfig.values))
      ? itemConfig.values
      : itemConfig;
    const out = {};
    Object.entries(source).forEach(([stateKey, stateMeta]) => {
      if (stateKey === "region" || stateKey === "values") return;
      if (!stateMeta || typeof stateMeta !== "object" || Array.isArray(stateMeta)) return;
      out[String(stateKey)] = stateMeta;
    });
    return Object.keys(out).length ? out : null;
  }

  function __resolveCycleStateMeta(valuesByState, currentValue) {
    if (!valuesByState || typeof valuesByState !== "object") return null;
    const valueKey = String(currentValue ?? "").trim();
    if (!valueKey) return null;
    if (Object.prototype.hasOwnProperty.call(valuesByState, valueKey)) {
      return valuesByState[valueKey];
    }
    const numericValue = Number(valueKey);
    if (!Number.isFinite(numericValue)) return null;
    const numericKey = String(numericValue);
    if (Object.prototype.hasOwnProperty.call(valuesByState, numericKey)) {
      return valuesByState[numericKey];
    }
    return null;
  }

  function __readCycleStateValue(cycleItem, selectEl) {
    const datasetValue = String(cycleItem?.dataset?.value ?? "").trim();
    if (datasetValue) return datasetValue;
    const selectValue = String(selectEl?.value ?? "").trim();
    if (selectValue) return selectValue;
    return "";
  }

  function __applyCycleStateField(cycleItem, field, nextText) {
    const spec = CYCLE_META_FIELD_SPEC[field];
    if (!spec) return;
    const node = cycleItem?.querySelector(spec.selector);
    if (!node) return;
    if (!node.hasAttribute(spec.cacheAttr)) {
      node.setAttribute(spec.cacheAttr, String(node.textContent ?? ""));
    }
    if (nextText != null && String(nextText).trim() !== "") {
      node.textContent = String(nextText);
      return;
    }
    node.textContent = node.getAttribute(spec.cacheAttr) || "";
  }

  function __applyCycleStateMeta(cycleItem, valuesByState, currentValue) {
    const resolvedMeta = __resolveCycleStateMeta(valuesByState, currentValue);
    __applyCycleStateField(cycleItem, "code", resolvedMeta?.code);
    __applyCycleStateField(cycleItem, "title", resolvedMeta?.title);
    __applyCycleStateField(cycleItem, "desc", resolvedMeta?.desc);
  }

  function __cleanupStaleCycleMetaBindings(doc) {
    cycleStateMetaBoundElements.forEach((cycleItem) => {
      if (doc.contains(cycleItem)) return;
      const state = cycleStateMetaBindings.get(cycleItem);
      state?.observer?.disconnect?.();
      if (state?.selectEl && state?.onSelectChange) {
        state.selectEl.removeEventListener("change", state.onSelectChange);
      }
      cycleStateMetaBoundElements.delete(cycleItem);
    });
  }

  function __ensureCycleStateMetaBinding(cycleItem) {
    if (!cycleItem) return null;
    let state = cycleStateMetaBindings.get(cycleItem);
    if (state) return state;

    const selectEl = cycleItem.querySelector('[data-adv-control="select"]') || cycleItem.querySelector("select");
    const nextState = {
      selectEl,
      valuesByState: null,
      refresh: null,
      onSelectChange: null,
      observer: null,
    };

    nextState.refresh = () => {
      const currentValue = __readCycleStateValue(cycleItem, nextState.selectEl);
      __applyCycleStateMeta(cycleItem, nextState.valuesByState, currentValue);
    };

    nextState.onSelectChange = () => {
      nextState.refresh?.();
    };

    if (nextState.selectEl) {
      nextState.selectEl.addEventListener("change", nextState.onSelectChange);
    }

    nextState.observer = new MutationObserver((mutations) => {
      if (!Array.isArray(mutations) || !mutations.length) return;
      const touched = mutations.some((m) => m?.type === "attributes" && m.attributeName === "data-value");
      if (!touched) return;
      nextState.refresh?.();
    });
    nextState.observer.observe(cycleItem, {
      attributes: true,
      attributeFilter: ["data-value"],
    });

    cycleStateMetaBindings.set(cycleItem, nextState);
    cycleStateMetaBoundElements.add(cycleItem);
    return nextState;
  }

  function applyAdvancedCycleStateMeta({ doc, ui }) {
    __cleanupStaleCycleMetaBindings(doc);

    // Before applying each variant, restore default text first,
    // then overlay current-device config to avoid text bleed between devices.
    cycleStateMetaBoundElements.forEach((cycleItem) => {
      if (!doc.contains(cycleItem)) return;
      const state = cycleStateMetaBindings.get(cycleItem);
      if (!state) return;
      state.valuesByState = null;
      state.refresh?.();
    });

    const advancedCycleStateMeta = (ui?.advancedCycleStateMeta && typeof ui.advancedCycleStateMeta === "object")
      ? ui.advancedCycleStateMeta
      : null;
    if (!advancedCycleStateMeta) return;

    Object.entries(advancedCycleStateMeta).forEach(([itemKey, itemConfig]) => {
      const valuesByState = __resolveCycleStateValues(itemConfig);
      if (!itemKey || !valuesByState) return;
      const region = String(itemConfig?.region || "").trim().toLowerCase();
      const cycleItem = queryAdvancedContainer(doc, itemKey, {
        region,
        control: "cycle",
      }) || queryAdvancedContainer(doc, itemKey, { control: "cycle" });
      if (!cycleItem) return;
      const state = __ensureCycleStateMetaBinding(cycleItem);
      if (!state) return;
      state.valuesByState = valuesByState;
      state.refresh?.();
    });
  }

  function applyOrder(el, key, advancedOrders) {
    if (!el) return;
    if (el.dataset.__orig_order == null) el.dataset.__orig_order = String(el.style.order ?? "");
    if (!Object.prototype.hasOwnProperty.call(advancedOrders, key)) {
      el.style.order = el.dataset.__orig_order || "";
      return;
    }
    const raw = Number(advancedOrders[key]);
    el.style.order = Number.isFinite(raw) ? String(raw) : String(advancedOrders[key]);
  }

  function resolveLandingReadyText(ui) {
    const explicitText = String(ui?.landingReadyText || "").trim();
    if (explicitText) return explicitText;
    const landingTitle = String(ui?.landingTitle || "").trim();
    if (landingTitle) return `${landingTitle} READY`;
    return "SYSTEM READY";
  }

  function applyLandingTexts({ doc, ui }) {
    const landingLayer = doc.getElementById("landing-layer");
    if (!landingLayer) return;
    const landingCaption = doc.getElementById("landingCaption") || landingLayer.querySelector(".center-caption");
    const verticalTitle = landingLayer.querySelector(".vertical-title");
    const flashText = doc.getElementById("landingReadyText") || landingLayer.querySelector(".flash-text");
    const landingTitle = String(ui?.landingTitle || "").trim();
    const landingCaptionText = String(ui?.landingCaption || "").trim();
    const landingReadyText = resolveLandingReadyText(ui);
    landingLayer.dataset.readyText = landingReadyText;
    applyTextWithRestore(verticalTitle, landingTitle || null);
    applyTextWithRestore(landingCaption, landingCaptionText || null);
    applyTextWithRestore(flashText, landingReadyText);
  }

  // ============================================================
  // applyVariant main flow
  // ============================================================

  /**
   * Apply full device visual variant to DOM.
   *
   * This is the rendering entrypoint used by app.js after device selection/handshake/readback.
   * Keep the function deterministic and profile-driven:
   * - Prefer adapter.ui/features metadata over hardcoded branches.
   * - Use semantic data-adv-* queries only.
   * - Use cached display/text/order restoration helpers for reversible updates.
   *
   * New feature/device UI extension sequence:
   * 1) Declare metadata in profile.ui/features.
   * 2) Add semantic DOM slot if current cards cannot represent the feature.
   * 3) Add rendering rules here; avoid protocol logic.
   * 4) Keep write/read behavior in app.js + profiles/core.
   */
  function applyVariant({ deviceId, adapter, root, deviceName = "", keymapOnly = false }) {
    const doc = root || document;
    const cfg = adapter?.ranges || window.AppConfig?.ranges?.[FALLBACK_DEVICE_ID];
    const ui = adapter?.ui || {};
    const features = adapter?.features || {};
    applyLandingTexts({ doc, ui });
    if (keymapOnly) {
      applyAdvancedPanelDensity({ doc, ui });
      applyKeymapVariant({ doc, ui, deviceName });
      return;
    }

    const hostDoc = doc?.nodeType === 9 ? doc : (doc?.ownerDocument || document);
    const bodyEl = hostDoc?.body || document.body;
    if (bodyEl) {
      const resolvedDeviceClass = `device-${String(adapter?.id || deviceId || "").trim().toLowerCase()}`;
      const requestedSkin = String(ui?.skinClass || "").trim().toLowerCase();
      const requestedSkinClass = requestedSkin ? `device-${requestedSkin}` : "";
      const prevSkinClass = String(bodyEl.dataset.variantSkinClass || "");
      if (prevSkinClass && prevSkinClass !== resolvedDeviceClass) {
        bodyEl.classList.remove(prevSkinClass);
      }
      if (requestedSkinClass && requestedSkinClass !== resolvedDeviceClass) {
        bodyEl.classList.add(requestedSkinClass);
        bodyEl.dataset.variantSkinClass = requestedSkinClass;
      } else {
        bodyEl.removeAttribute("data-variant-skin-class");
      }
    }
    const effectivePerfModes = resolveEffectivePerfModes({ ui, features });
    const selectedPerfMode = syncPerfModeRadios(doc, effectivePerfModes);

    const wiredPollingRates =
      (Array.isArray(cfg?.polling?.wiredHz) && cfg.polling.wiredHz.length)
        ? cfg.polling.wiredHz
        : (Array.isArray(cfg?.polling?.basicHz) && cfg.polling.basicHz.length ? cfg.polling.basicHz : null);
    const wirelessPollingRates =
      (Array.isArray(cfg?.polling?.wirelessHz) && cfg.polling.wirelessHz.length)
        ? cfg.polling.wirelessHz
        : (Array.isArray(cfg?.polling?.basicHz) && cfg.polling.basicHz.length ? cfg.polling.basicHz : wiredPollingRates);

    const pollingSelect = doc.getElementById("pollingSelect");
    const pollingWirelessSelect = doc.getElementById("pollingSelectWireless");
    if (pollingSelect) cacheInnerHtml(pollingSelect, "pollingSelect");
    if (pollingWirelessSelect) cacheInnerHtml(pollingWirelessSelect, "pollingSelectWireless");
    if (pollingSelect && Array.isArray(wiredPollingRates)) {
      applySelectOptions(pollingSelect, wiredPollingRates, (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)));
    } else if (pollingSelect) {
      restoreInnerHtml(pollingSelect, "pollingSelect");
    }
    if (pollingWirelessSelect && Array.isArray(wirelessPollingRates)) {
      applySelectOptions(pollingWirelessSelect, wirelessPollingRates, (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)));
    } else if (pollingWirelessSelect) {
      restoreInnerHtml(pollingWirelessSelect, "pollingSelectWireless");
    }

    const basicModeColumn = doc.getElementById("basicModeColumn");
    if (basicModeColumn) cacheInnerHtml(basicModeColumn, "basicModeColumn");
    if (basicModeColumn && features.hasDualPollingRates && Array.isArray(wirelessPollingRates)) {
      const rates = wirelessPollingRates.map(Number).filter(Number.isFinite);
      const selectedHz = Number(pollingWirelessSelect?.value ?? rates[0] ?? 1000);
      basicModeColumn.innerHTML = rates
        .map((hz) => {
          const active = String(hz) === String(selectedHz) ? " active" : "";
          return `<div class="basicItem${active}" role="button" tabindex="0" data-hz="${hz}">${hz} Hz<div class="basicAnchor"></div></div>`;
        })
        .join("");
    } else if (basicModeColumn && renderPerfModeItems(basicModeColumn, effectivePerfModes, selectedPerfMode)) {
      // mode list rendered from unified perf mode resolver
    } else if (basicModeColumn) {
      restoreInnerHtml(basicModeColumn, "basicModeColumn");
    }

    const basicHzColumn = doc.getElementById("basicHzColumn");
    if (basicHzColumn) cacheInnerHtml(basicHzColumn, "basicHzColumn");
    if (basicHzColumn && Array.isArray(wiredPollingRates)) {
      const rates = wiredPollingRates.map(Number).filter(Number.isFinite);
      const selectedHz = Number(pollingSelect?.value ?? rates[0] ?? 1000);
      basicHzColumn.innerHTML = rates
        .map((hz) => {
          const active = String(hz) === String(selectedHz) ? " active" : "";
          return `<div class="basicItem${active}" role="button" tabindex="0" data-hz="${hz}"><div class="basicAnchor"></div> ${hz} Hz</div>`;
        })
        .join("");
    } else if (basicHzColumn) {
      restoreInnerHtml(basicHzColumn, "basicHzColumn");
    }

    const feelCard = queryAdvancedContainer(doc, "surfaceFeel", { region: "dual-left", control: "range" });
    const feelInput = queryAdvancedRangeInput(doc, "surfaceFeel", { region: "dual-left" });
    const feelDisp = feelCard?.querySelector(".value-readout");
    const feelName = feelCard?.querySelector(".slider-name");
    const feelSub = feelCard?.querySelector(".slider-sub");

    if (feelInput && !feelInput.dataset.__orig_min) {
      feelInput.dataset.__orig_min = String(feelInput.min ?? "");
      feelInput.dataset.__orig_max = String(feelInput.max ?? "");
      feelInput.dataset.__orig_step = String(feelInput.step ?? "");
    }
    if (feelName && feelName.dataset.__orig_text == null) feelName.dataset.__orig_text = feelName.textContent ?? "";
    if (feelSub && feelSub.dataset.__orig_text == null) feelSub.dataset.__orig_text = feelSub.textContent ?? "";
    if (feelDisp && feelDisp.dataset.__orig_unit == null) {
      feelDisp.dataset.__orig_unit = String(feelDisp.dataset.unit ?? "");
    }

    const heightBlock = feelCard?.querySelector(".height-block");
    const heightVizWrap = heightBlock?.closest?.(".height-viz") || heightBlock?.parentElement || null;

    const lodItem = queryAdvancedContainer(doc, "surfaceModePrimary", { region: "dual-right", control: "toggle" });
    const dpiEditorHint = doc.querySelector("#dpi .card-dpi-editor .cardhead .sub");
    const ledItem = queryAdvancedContainer(doc, "primaryLedFeature", { region: "dual-right", control: "toggle" });
    const advancedDualLeft = queryAdvancedRegion(doc, "dual-left");
    const legacySectionHeaders = advancedDualLeft
      ? Array.from(advancedDualLeft.querySelectorAll(".advBlock > .advSectionHeader"))
      : [];
    const sectionHeaders = (ui?.advancedSectionHeaders && typeof ui.advancedSectionHeaders === "object")
      ? ui.advancedSectionHeaders
      : null;
    applySectionHeaderText(legacySectionHeaders[0], sectionHeaders?.power);
    applySectionHeaderText(legacySectionHeaders[1], sectionHeaders?.sensor);

    const b6Item = queryAdvancedContainer(doc, "secondarySurfaceToggle", { region: "dual-right", control: "toggle" });
    const sensorAngleSourceRegion = resolveAdvancedSourceRegion(adapter, "sensorAngle", "dual-left");
    const angleCard = queryAdvancedContainer(doc, "sensorAngle", { region: sensorAngleSourceRegion, control: "range" });
    const angleDisp = angleCard?.querySelector(".value-readout");
    const angleName = angleCard?.querySelector(".slider-name");
    const angleSub = angleCard?.querySelector(".slider-sub");
    const angleVisualGroup = angleCard?.querySelector(".horizon-visual");
    const angleCenterMark = angleCard?.querySelector(".center-mark");
    if (angleName && angleName.dataset.__orig_text == null) angleName.dataset.__orig_text = angleName.textContent ?? "";
    if (angleSub && angleSub.dataset.__orig_text == null) angleSub.dataset.__orig_text = angleSub.textContent ?? "";
    if (angleDisp && angleDisp.dataset.__orig_unit == null) {
      angleDisp.dataset.__orig_unit = String(angleDisp.dataset.unit ?? "");
    }

    const keyScanningRateCycle = queryAdvancedContainer(doc, "keyScanningRate", { region: "dual-right", control: "cycle" });
    const dpiAdvancedMeta = doc.getElementById("dpiAdvancedMeta");

    const sleepSourceRegion = resolveAdvancedSourceRegion(adapter, "sleepSeconds", "dual-left");
    const sleepSel = queryAdvancedSelect(doc, "sleepSeconds", { region: sleepSourceRegion });
    const sleepInput = queryAdvancedRangeInput(doc, "sleepSeconds", { region: sleepSourceRegion });
    const debounceSel = queryAdvancedSelect(doc, "debounceMs", { region: "dual-left" });
    const debounceInput = queryAdvancedRangeInput(doc, "debounceMs", { region: "dual-left" });

    if (sleepSel) cacheInnerHtml(sleepSel, "sleepSelect");
    if (debounceSel) cacheInnerHtml(debounceSel, "debounceSelect");

    const feelCfg = cfg?.sensor?.feel;
    if (feelInput && feelCfg) {
      feelInput.min = String(feelCfg.min);
      feelInput.max = String(feelCfg.max);
      feelInput.step = String(feelCfg.step || 1);
      if (feelName) feelName.textContent = feelCfg.name || "";
      if (feelSub) feelSub.textContent = feelCfg.sub || "";
      if (feelDisp) feelDisp.dataset.unit = feelCfg.unit || "";
    } else if (feelInput && feelInput.dataset.__orig_min != null) {
      feelInput.min = feelInput.dataset.__orig_min;
      feelInput.max = feelInput.dataset.__orig_max;
      if (feelInput.dataset.__orig_step != null) feelInput.step = feelInput.dataset.__orig_step;
      if (feelName && feelName.dataset.__orig_text != null) feelName.textContent = feelName.dataset.__orig_text;
      if (feelSub && feelSub.dataset.__orig_text != null) feelSub.textContent = feelSub.dataset.__orig_text;
      if (feelDisp && feelDisp.dataset.__orig_unit != null) feelDisp.dataset.unit = feelDisp.dataset.__orig_unit;
    }

    __setHeightVizVisible({
      heightVizWrap,
      heightBlock,
      feelCard,
      visible: !!features.showHeightViz,
    });

    applyMetaBlockWithRestore(lodItem, ui?.lod);
    applyTextWithRestore(dpiEditorHint, ui?.dpiEditorHint);

    const isRazer = String(adapter?.id || deviceId || "").trim().toLowerCase() === "razer";
    if (isRazer) {
      const configuredDpiStep = Number(cfg?.dpi?.step);
      const dpiStep = Number.isFinite(configuredDpiStep) && configuredDpiStep > 0
        ? String(Math.max(1, Math.trunc(configuredDpiStep)))
        : "1";
      const dpiInputs = doc.querySelectorAll('#dpiList input[type="range"], #dpiList input[type="number"]');
      dpiInputs.forEach((inputEl) => {
        inputEl.step = dpiStep;
      });
    }

    applyMetaBlockWithRestore(ledItem, ui?.led);
    applyMetaBlockWithRestore(b6Item, ui?.secondarySurface);

    __setNodeDisplayByFeature(angleVisualGroup, !!features.hideSensorAngleVisualization);
    __setNodeDisplayByFeature(angleCenterMark, !!features.hideSensorAngleCenterMark);
    if (dpiAdvancedMeta) {
      if (dpiAdvancedMeta.dataset.__orig_display == null) {
        dpiAdvancedMeta.dataset.__orig_display = String(dpiAdvancedMeta.style.display ?? "");
      }
      dpiAdvancedMeta.style.display = features.hasDpiAdvancedAxis
        ? (dpiAdvancedMeta.dataset.__orig_display || "")
        : "none";
    }

    const rapooSwitches = doc.getElementById("basicRapooSwitches");
    if (rapooSwitches) {
      rapooSwitches.style.display = (features.hasWirelessStrategy || features.hasCommProtocol) ? "" : "none";
    }

    const basicSynapseLayer = doc.getElementById("basicSynapseLayer");
    if (basicSynapseLayer) {
      if (basicSynapseLayer.dataset.__orig_display == null) {
        basicSynapseLayer.dataset.__orig_display = String(basicSynapseLayer.style.display ?? "");
      }
      basicSynapseLayer.style.display = features.hideBasicSynapse ? "none" : (basicSynapseLayer.dataset.__orig_display || "");
    }
    applyBasicFooterVariant({ doc, ui, features });
    applyBasicModeTypographyVariant({ doc, ui });

    const dpiLightCycle = queryAdvancedContainer(doc, "dpiLightEffect", { region: "dual-right", control: "cycle" });
    const receiverLightCycle = queryAdvancedContainer(doc, "receiverLightEffect", { region: "dual-right", control: "cycle" });
    applyCycleMeta(dpiLightCycle, ui?.lightCycles?.dpi);
    applyCycleMeta(receiverLightCycle, ui?.lightCycles?.receiver);
    applyAdvancedCycleStateMeta({ doc, ui });
    const advancedOrders = (ui?.advancedOrders && typeof ui.advancedOrders === "object") ? ui.advancedOrders : {};
    applyOrder(lodItem, "surfaceModePrimary", advancedOrders);
    applyOrder(ledItem, "primaryLedFeature", advancedOrders);
    applyOrder(b6Item, "secondarySurfaceToggle", advancedOrders);
    applyOrder(dpiLightCycle, "dpiLightEffect", advancedOrders);
    applyOrder(receiverLightCycle, "receiverLightEffect", advancedOrders);

    const keymapButtons = Array.from(doc.querySelectorAll('#keys .kmPoint'));
    const keymapBtnCount = Number(features.keymapButtonCount);
    if (Number.isFinite(keymapBtnCount)) {
      keymapButtons.forEach((p) => {
        if (!p.dataset.__orig_display) p.dataset.__orig_display = String(p.style.display ?? "");
        const btnId = Number(p.getAttribute("data-btn"));
        p.style.display = (Number.isFinite(btnId) && btnId > keymapBtnCount)
          ? "none"
          : (p.dataset.__orig_display || "");
      });
    } else if (keymapButtons.length) {
      keymapButtons.forEach((p) => {
        if (p.dataset.__orig_display != null) {
          p.style.display = p.dataset.__orig_display || "";
        }
      });
    }
    applyKeymapVariant({ doc, ui, deviceName });

    const sleepSeconds = cfg?.power?.sleepSeconds;
    if (sleepSel && Array.isArray(sleepSeconds)) {
      applySelectOptions(sleepSel, sleepSeconds, (sec) => {
        return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
      });

      if (sleepInput) {
        sleepInput.min = "0";
        sleepInput.max = String(Math.max(0, sleepSeconds.length - 1));
        sleepInput.step = "1";
      }
      const sleepCard = sleepInput?.closest(".slider-card");
      const sub = sleepCard?.querySelector(".slider-sub");
      if (sub && sub.dataset.__orig_text == null) sub.dataset.__orig_text = String(sub.textContent ?? "");
      if (sub) {
        const minS = sleepSeconds[0];
        const maxS = sleepSeconds[sleepSeconds.length - 1];
        const minT = minS < 60 ? `${minS}s` : `${minS / 60}min`;
        const maxT = maxS < 60 ? `${maxS}s` : `${maxS / 60}min`;
        sub.textContent = tr(`范围：${minT} - ${maxT}`, `Range: ${minT} - ${maxT}`);
      }
    } else if (sleepSel) {
      restoreInnerHtml(sleepSel, "sleepSelect");
      const sleepSub = sleepSel?.closest(".slider-card")?.querySelector(".slider-sub");
      if (sleepSub && sleepSub.dataset.__orig_text != null) {
        sleepSub.textContent = sleepSub.dataset.__orig_text;
      }
    }

    const debounceMs = cfg?.power?.debounceMs;
    if (debounceSel && Array.isArray(debounceMs)) {
      applySelectOptions(debounceSel, debounceMs, (ms) => String(ms));
      if (debounceInput) {
        debounceInput.min = "0";
        debounceInput.max = String(Math.max(0, debounceMs.length - 1));
        debounceInput.step = "1";
      }
      const debCard = debounceInput?.closest(".slider-card");
      const sub = debCard?.querySelector(".slider-sub");
      if (sub && sub.dataset.__orig_text == null) sub.dataset.__orig_text = String(sub.textContent ?? "");
      if (sub && debounceMs.length > 0) {
        sub.textContent = tr(
          `范围：${debounceMs[0]}ms - ${debounceMs[debounceMs.length - 1]}ms`,
          `Range: ${debounceMs[0]}ms - ${debounceMs[debounceMs.length - 1]}ms`
        );
      }
    } else if (debounceSel) {
      restoreInnerHtml(debounceSel, "debounceSelect");
      const debounceSub = debounceSel?.closest(".slider-card")?.querySelector(".slider-sub");
      if (debounceSub && debounceSub.dataset.__orig_text != null) {
        debounceSub.textContent = debounceSub.dataset.__orig_text;
      }
    }

    const angleCfg = cfg?.sensor?.angleDeg;
    const angleInput = queryAdvancedRangeInput(doc, "sensorAngle", { region: sensorAngleSourceRegion });
    if (angleInput && angleCfg) {
      angleInput.min = String(angleCfg.min);
      angleInput.max = String(angleCfg.max);
      if (angleCfg.step != null) angleInput.step = String(angleCfg.step);
      const angleCard = queryAdvancedContainer(doc, "sensorAngle", {
        region: sensorAngleSourceRegion,
        control: "range",
      });
      const angleName = angleCard?.querySelector(".slider-name");
      const angleSub = angleCard?.querySelector(".slider-sub");
      if (angleName) {
        const angleNameText = (angleCfg.name != null && String(angleCfg.name).trim() !== "")
          ? String(angleCfg.name)
          : null;
        applyTextWithRestore(angleName, angleNameText);
      }
      if (angleSub) {
        const angleSubText = (angleCfg.sub != null && String(angleCfg.sub).trim() !== "")
          ? String(angleCfg.sub)
          : ((angleCfg.hint != null && String(angleCfg.hint).trim() !== "")
            ? String(angleCfg.hint)
            : null);
        applyTextWithRestore(angleSub, angleSubText);
      }
      const angleDisp = angleCard?.querySelector(".value-readout");
      if (angleDisp) {
        if (angleCfg.unit != null) {
          angleDisp.dataset.unit = String(angleCfg.unit);
        } else if (angleDisp.dataset.__orig_unit != null) {
          angleDisp.dataset.unit = angleDisp.dataset.__orig_unit;
        }
      }
    } else if (angleInput) {
      applyTextWithRestore(angleName, null);
      applyTextWithRestore(angleSub, null);
      if (angleDisp && angleDisp.dataset.__orig_unit != null) angleDisp.dataset.unit = angleDisp.dataset.__orig_unit;
    }

    installAutoTrackInterval(doc);
  }

  window.DeviceUI = { applyVariant, applyAdvancedRuntime, prepareEnterAssets };
})();

