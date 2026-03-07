/* ===== Rotation Calibration: raw path + real-time fit line + angle smoothing ===== */
(function(){
  // Keep behavior consistent with other test-tool pages:
  // determine whether we are currently in the test-tools page.
  const isTestToolsActive = () => document.body.classList.contains('page-testtools');
  const tr = (zh, en) => (typeof window !== 'undefined' && window.tr) ? window.tr(zh, en) : zh;

  const pageRot = document.getElementById('pageRot');
  const navRot = document.getElementById('navRot');

  const rotLockTarget = document.getElementById('rotLockTarget');

  const rotBox = document.getElementById('rotBox');
  const rotCanvas = document.getElementById('rotCanvas');
const rotResetBtn = document.getElementById('rotResetBtn');
const rotCopyBtn = document.getElementById('rotCopyBtn');
const rotWriteAngleBtn = document.getElementById('rotWriteAngleBtn');
const rotAngleFinalEl = document.getElementById('rotAngleFinal');

  const rotSwipeCountEl = document.getElementById('rotSwipeCount');
  
  const rotSwipePill = document.getElementById('rotSwipePill');
const rotSampleCountEl = document.getElementById('rotSampleCount');
  const rotStabilityEl = document.getElementById('rotStability');
  const rotTopHint = document.getElementById('rotTopHint');

  function applyRotBrand(theta){
    if(theta === null || !isFinite(theta)) return null;
    return clamp(wrap180(theta), -90, 90);
  }

  function computeDisplayTheta(){
    if(!rot || rot.swipeCount < 10) return null;

    // Prefer split-axis bisection angle because it uses all valid trajectory history.
    const fitTheta = computeThetaFromFitStats();
    if(fitTheta !== null && isFinite(fitTheta)) return wrap180(fitTheta);

    if(rot.thetaTarget !== null && isFinite(rot.thetaTarget)) return wrap180(rot.thetaTarget);
    if(rot.thetaRaw !== null && isFinite(rot.thetaRaw)) return wrap180(rot.thetaRaw);

    const med = median(rot.thetaStable.map(o=>o.v));
    if(med !== null && isFinite(med)) return wrap180(med);

    return (rot.thetaSmooth !== null && isFinite(rot.thetaSmooth)) ? wrap180(rot.thetaSmooth) : null;
  }

  function renderAngleText(){
    const thetaNow = computeDisplayTheta();
    if(thetaNow === null){
      rotAngleFinalEl.textContent = '--';
      return;
    }
    const thetaDisp = applyRotBrand(thetaNow);
    rotAngleFinalEl.textContent = fmtDeg(thetaDisp);
  }

  function refreshRotOutputsNow(){
    // Refresh only result text and gauge; do not touch sampling/path state.
    renderAngleText();
  }

  // Keep brand/lock labels in sync when UI language toggles
  window.addEventListener('uilangchange', ()=>{
    try{ refreshRotOutputsNow(); }catch(_){ }
  });


  // ===== Constants (aligned with existing windowing/throttling style) =====
  const WINDOW_MS = 300;                 // Time window for angle fitting
  const UI_UPDATE_MS = 80;               // Text refresh throttle
  const HIST_SAMPLE_MS = 33;             // Trend sampling (~30fps)
  const FINAL_WINDOW_MS = 1200;          // Window for end-state stability stats
  const MIN_VEC = 20;                    // Skip target-angle update when vector is too small
  const FIT_MIN_SEG = 1.5;              // Ignore very short segments in fitting (anti-jitter)
  const FIT_W_CAP = 40;                  // Per-segment weight cap (limit jump outliers)
  const FIT_MAX_ACUTE = 35;              // Drop near-vertical segments during fitting (> 35deg from horizontal)
  const FIT_MIN_H_RATIO = 0.80;          // Treat low |dx|/len as near-vertical (reduce start/end bias)
  const SNAP_EPS = 0.06;                 // Angle snap threshold (degrees)
  const SMOOTH_LAMBDA = 16;              // Angle smoothing strength
  const FLIP_MIN_PROJ = 220;             // Minimum axis advance to count a direction flip (counts)
  const FLIP_MIN_DT = 90;                // Minimum interval between flips (ms)
  const MAX_STROKES_DRAW = 24;           // Number of recent strokes to render
  const FIT_WARMUP_SAMPLES = 800;
  const FIT_CORE_CFG = {
    minSegmentLength: FIT_MIN_SEG,
    maxAcuteDeg: FIT_MAX_ACUTE,
    minHorizontalRatio: FIT_MIN_H_RATIO,
    weightCap: FIT_W_CAP,
    minSamples: 3,
    minWeight: 1
  };

  function createFitStats(){
    return { Sxx:0, Syy:0, Sxy:0, W:0, N:0 };
  }

  function shouldAcceptFitSegment(dx, dy, cfg){
    const conf = cfg || FIT_CORE_CFG;
    const len = Math.hypot(dx, dy);
    if(!isFinite(len) || len < conf.minSegmentLength) return false;

    const ax = Math.abs(dx), ay = Math.abs(dy);
    if(ax < 1e-9) return false;

    const acute = Math.atan2(ay, ax) * 180 / Math.PI;
    if(acute > conf.maxAcuteDeg) return false;
    if((ax / len) < conf.minHorizontalRatio) return false;
    return true;
  }

  function addFitSampleToStats(fit, dx, dy, cfg){
    if(!fit || typeof fit !== 'object') return false;
    const conf = cfg || FIT_CORE_CFG;
    if(!shouldAcceptFitSegment(dx, dy, conf)) return false;

    const len = Math.hypot(dx, dy);
    const w = Math.min(len, conf.weightCap);
    const ux = dx / len, uy = dy / len;

    // Distance-weighted directional covariance:
    // each segment contributes linearly with traveled length and is packet-size invariant.
    fit.Sxx += w * ux * ux;
    fit.Syy += w * uy * uy;
    fit.Sxy += w * ux * uy;
    fit.W   += w;
    fit.N   += 1;
    return true;
  }

  function computeThetaFromStats(fit, cfg){
    const conf = cfg || FIT_CORE_CFG;
    if(!fit || fit.N < conf.minSamples || fit.W < conf.minWeight) return null;

    const Sxx = fit.Sxx, Syy = fit.Syy, Sxy = fit.Sxy;
    const diff = Sxx - Syy;
    const root = Math.sqrt(diff*diff + 4*Sxy*Sxy);

    let vx = 1, vy = 0;
    if(root > 1e-9){
      const lambda1 = (Sxx + Syy + root) / 2;
      vx = Sxy;
      vy = lambda1 - Sxx;
      if(Math.abs(vx) + Math.abs(vy) < 1e-9){
        vx = lambda1 - Syy;
        vy = Sxy;
      }
    }

    const mag = Math.hypot(vx, vy);
    if(mag < 1e-9) return null;
    vx /= mag; vy /= mag;

    const acute = Math.atan2(Math.abs(vy), Math.abs(vx)) * 180 / Math.PI;

    let sign = 0;
    if(Math.abs(vx) < 1e-6){
      sign = (vy >= 0) ? -1 : 1;
    }else{
      sign = (vx * vy) < 0 ? 1 : -1;
    }
    return clamp(sign * acute, -90, 90);
  }

  // ===== State =====
  const rot = {
    locked:false,
    recording:false,
    endRequested:false,

// Window samples: {dx,dy,ts}
    win: [],
    lastIngestTs: 0,

    // Split-axis fit stats (dx<0 / dx>0) reduce one-sided ergonomic bias.
    fitLeft: createFitStats(),
    fitRight: createFitStats(),
    sampleTotal: 0,
    warmupLeft: FIT_WARMUP_SAMPLES,

    // Path points stored in accumulated coordinates
    curPts: [],
    strokes: [],     // array of arrays of pts {x,y}
    x: 0, y: 0,

    // View state (smoothed scale/center)
    view: { scale: 1, cx: 0, cy: 0, tx:0, ty:0, ts:1 },

    // Angle values
    thetaTarget: null,   // degrees
    thetaRaw: null,      // degrees
    thetaSmooth: 0,      // degrees
    thetaStable: [],     // {v, ts}

    // Swipe count based on projection-sign flips
    swipeCount: 0,
    lastSign: 0,
    accumProj: 0,
    lastFlipTs: 0,

    // UI/render cadence
    lastUiAt: 0,
    lastHistAt: 0,
    
    lastTickAt: 0,
hist: [],          // {v,ts}
    rafId: 0,
    dirty: true
  };

  function isRotActive(){ return pageRot && pageRot.classList.contains('active'); }

  // ===== Utilities =====
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function nowMs(){ return performance.now(); }
  function fmtDeg(v){
    if(v === null || !isFinite(v)) return tr('--','--');
    const s = (Math.round(v*10)/10).toFixed(1);
    return s;
  }
  function wrap180(deg){
    let d = deg;
    while(d > 180) d -= 360;
    while(d < -180) d += 360;
    return d;
  }
  function angDiff(a,b){ return wrap180(a-b); }

  function median(arr){
    if(!arr.length) return null;
    const s = arr.slice().sort((x,y)=>x-y);
    const mid = (s.length-1)/2;
    const lo = Math.floor(mid), hi = Math.ceil(mid);
    return (s[lo] + s[hi]) / 2;
  }
  function stdev(arr){
    if(arr.length < 2) return null;
    const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
    let v=0;
    for(const x of arr){ const d=x-mean; v += d*d; }
    v/= (arr.length-1);
    return Math.sqrt(v);
  }

  function resizeCanvasToCSS(canvas, ctx, maxDpr=2){
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(r.width * dpr));
    const h = Math.max(2, Math.round(r.height * dpr));
    if(canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return { cssW: r.width, cssH: r.height };
  }

  // ===== PointerLock =====
  function requestLock(){
    if(!isRotActive()) return;
    rot.endRequested = false;
    try{
      rotLockTarget.requestPointerLock({ unadjustedMovement:true });
    }catch(err){
      try{ rotLockTarget.requestPointerLock(); }catch(_e){}
    }
  }
  function rotHasData(){
    return (rot.win && rot.win.length) || (rot.strokes && rot.strokes.length) || (rot.hist && rot.hist.length) || (rot.thetaRaw !== null) || (rot.swipeCount > 0);
  }

  function pauseSession(){
    if(document.pointerLockElement === rotLockTarget){
      document.exitPointerLock();
    }
  }

  document.addEventListener('pointerlockchange', ()=>{
    if(!isRotActive()) return;
    const locked = (document.pointerLockElement === rotLockTarget);
    rot.locked = locked;

    if(locked){
      rot.recording = true;
      rotTopHint.textContent = tr('已开始：左右来回滑动 ≥ 10 次。右键暂停。','Started: swipe left/right ≥ 10 times. Right-click to pause.');
      /* rotTopHint text is already set above. */
      attachRotMove();
      attachRotFocusBlock();
      startRAF();
    
      // Start compute loop for real-time angle and trend updates.
      rot.lastTickAt = 0;
      requestAnimationFrame(tick);
}else{
      detachRotMove();
      detachRotFocusBlock();

      // If reset just ran, data is already cleared; do not override resetAll() initial text.
      if(!rotHasData()){
        rot.recording = false;
        rot.endRequested = false;
        return;
      }

      // Paused state: keep path and result.
      rot.recording = false;
      rot.endRequested = false;

      if(computeDisplayTheta() !== null){
        finalize();
      }else{
        rotTopHint.textContent = tr('已暂停（点击继续）','Paused (click to continue)');
        renderAngleText();
      }
}
  });

  // ===== Input interception (avoid cross-page interference) =====
  let rotOnly = false;
  function blockIfRotOnly(e){
  if(!isTestToolsActive()) return;
    if(!rotOnly) return;
    // Right click: pause (exit lock but keep collected data)
    if(e.type === 'mousedown' && e.button === 2){
      e.preventDefault();
      e.stopImmediatePropagation();
      pauseSession();
      return;
    }
    if(e.type === 'contextmenu'){
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function attachRotFocusBlock(){
    rotOnly = true;
    document.addEventListener('mousedown', blockIfRotOnly, true);
    document.addEventListener('mouseup', blockIfRotOnly, true);
    document.addEventListener('wheel', blockIfRotOnly, true);
    document.addEventListener('contextmenu', blockIfRotOnly, true);
    document.addEventListener('keydown', blockIfRotOnly, true);
  }
  function detachRotFocusBlock(){
    rotOnly = false;
    document.removeEventListener('mousedown', blockIfRotOnly, true);
    document.removeEventListener('mouseup', blockIfRotOnly, true);
    document.removeEventListener('wheel', blockIfRotOnly, true);
    document.removeEventListener('contextmenu', blockIfRotOnly, true);
    document.removeEventListener('keydown', blockIfRotOnly, true);
  }

  // ===== Sampling =====
let rotMoveEvt = null;
const rotSupportsRaw = ('onpointerrawupdate' in document);

function attachRotMove(){
  if(rotMoveEvt) return;
  rotMoveEvt = rotSupportsRaw ? 'pointerrawupdate' : 'pointermove';
  // Under PointerLock, relative movement events are more reliably dispatched on document
  // (aligned with current match-page and polling-page behavior).
  document.addEventListener(rotMoveEvt, rotMoveHandler, { passive:true });
}
function detachRotMove(){
  if(!rotMoveEvt) return;
  document.removeEventListener(rotMoveEvt, rotMoveHandler);
  rotMoveEvt = null;
}


  function ingest(dx, dy, ts){
    rot.lastIngestTs = ts;

    // Update accumulated coordinates.
    rot.x += dx;
    rot.y += dy;

    if(!rot.curPts.length){
      rot.curPts.push({x: rot.x, y: rot.y});
    }else{
      const last = rot.curPts[rot.curPts.length-1];
      // Avoid oversampling: skip points with zero movement.
      if(last.x !== rot.x || last.y !== rot.y){
        rot.curPts.push({x: rot.x, y: rot.y});
      }
    }

    // Windowed samples.
    rot.win.push({dx, dy, ts});
    const cutoff = ts - WINDOW_MS;
    while(rot.win.length > 2 && rot.win[0].ts < cutoff){
      rot.win.shift();
    }

    // Split-axis fit: accumulate stroke segments into left/right stats in real time.
    addFitSample(dx, dy);

    rot.dirty = true;
  }

  function rotMoveHandler(e){
    if(!isRotActive() || !rot.locked || !rot.recording) return;

    const list = (e.getCoalescedEvents ? e.getCoalescedEvents() : null);
    if(list && list.length){
      for(const ce of list){
        ingest(ce.movementX || 0, ce.movementY || 0, ce.timeStamp || nowMs());
      }
    }else{
      ingest(e.movementX || 0, e.movementY || 0, e.timeStamp || nowMs());
    }
  }

  // ===== Angle calculation and swipe counting =====
function addFitSample(dx, dy){
  if(!shouldAcceptFitSegment(dx, dy, FIT_CORE_CFG)) return;

  // Count valid segments first (UI still shows total valid sample count).
  rot.sampleTotal += 1;

  // Warm-up: ignore the first 800 valid segments for recommended-angle fitting.
  if(rot.warmupLeft > 0){
    rot.warmupLeft -= 1;
    return;
  }

  if(dx < 0){
    addFitSampleToStats(rot.fitLeft, dx, dy, FIT_CORE_CFG);
  }else if(dx > 0){
    addFitSampleToStats(rot.fitRight, dx, dy, FIT_CORE_CFG);
  }
}

function computeThetaFromFitStats(){
  const thetaLeft = computeThetaFromStats(rot.fitLeft, FIT_CORE_CFG);
  const thetaRight = computeThetaFromStats(rot.fitRight, FIT_CORE_CFG);
  if(thetaLeft === null || !isFinite(thetaLeft)) return null;
  if(thetaRight === null || !isFinite(thetaRight)) return null;

  const thetaBisect = wrap180(thetaLeft + angDiff(thetaRight, thetaLeft) / 2);
  return clamp(thetaBisect, -90, 90);
}

function computeThetaTarget(){
  // Do not use short-window estimation anymore;
  // only start computing/showing recommended angle after at least 10 swipes.
  if(rot.swipeCount < 10) return null;

  // Split-axis TLS/PCA fit + bisection based on full valid trajectory history.
  const fitTheta = computeThetaFromFitStats();
  if(fitTheta === null || !isFinite(fitTheta)) return null;
  return fitTheta;
}


  function updateSwipeCount(ts){
    // Prefer fit angle as principal axis to reduce smoothing-lag bias.
    const axisDeg = (rot.thetaTarget !== null && isFinite(rot.thetaTarget)) ? rot.thetaTarget : rot.thetaSmooth;
    const rad = axisDeg * Math.PI / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad);

    // Use the last window sample as approximate delta direction for better responsiveness.
    const s = rot.win.length ? rot.win[rot.win.length-1] : null;
    if(!s) return;

    const proj = s.dx*ux + s.dy*uy;
    const sign = proj > 0 ? 1 : (proj < 0 ? -1 : 0);
    if(sign === 0) return;

    // Accumulate principal-axis travel (absolute value to filter jitter).
    rot.accumProj += Math.abs(proj);

    if(rot.lastSign === 0){
      rot.lastSign = sign;
      rot.accumProj = 0;
      return;
    }

    const dt = ts - rot.lastFlipTs;
    if(sign !== rot.lastSign && rot.accumProj >= FLIP_MIN_PROJ && dt >= FLIP_MIN_DT){
      rot.swipeCount += 1;
      rot.lastSign = sign;
      rot.accumProj = 0;
      rot.lastFlipTs = ts;

      // Direction flip: finalize current stroke and start a new stroke segment.
      if(rot.curPts.length > 2){
        rot.strokes.push(rot.curPts.slice());
        if(rot.strokes.length > MAX_STROKES_DRAW) rot.strokes.shift();
        rot.curPts = [{x: rot.x, y: rot.y}];
      }
    }
  }

  function updateAngleSmoothing(dt){
    const target = rot.thetaTarget;
    if(target === null || !isFinite(target)) return;

    // Exponential smoothing (use wrap180 for angle deltas).
    const k = 1 - Math.exp(-dt * (SMOOTH_LAMBDA/1000));
    const diff = angDiff(target, rot.thetaSmooth);
    rot.thetaSmooth = wrap180(rot.thetaSmooth + diff * k);

    if(Math.abs(angDiff(target, rot.thetaSmooth)) < SNAP_EPS){
      rot.thetaSmooth = target;
    }
  }

  function pruneStable(ts){
    const cutoff = ts - FINAL_WINDOW_MS;
    while(rot.thetaStable.length && rot.thetaStable[0].ts < cutoff){
      rot.thetaStable.shift();
    }
  }

  // ===== Rendering (path + gauge) =====
  const ctx = rotCanvas.getContext('2d');

  function computeBBox(){
    let minX=0,maxX=0,minY=0,maxY=0;
    let inited = false;

    const considerPts = (pts)=>{
      for(const p of pts){
        if(!inited){
          inited = true;
          minX=maxX=p.x; minY=maxY=p.y;
        }else{
          if(p.x<minX) minX=p.x;
          if(p.x>maxX) maxX=p.x;
          if(p.y<minY) minY=p.y;
          if(p.y>maxY) maxY=p.y;
        }
      }
    };

    for(const s of rot.strokes) considerPts(s);
    considerPts(rot.curPts);

    if(!inited){
      // Default bounding box.
      minX=-200; maxX=200; minY=-80; maxY=80;
      inited = true;
    }
    return {minX,maxX,minY,maxY};
  }

  function updateViewSmooth(dt, cssW, cssH){
    const pad = 26;
    const bb = computeBBox();
    const spanX = Math.max(1, bb.maxX - bb.minX);
    const spanY = Math.max(1, bb.maxY - bb.minY);

    // Target scale: fit the content into the canvas as much as possible.
    const s = Math.min((cssW - pad*2)/spanX, (cssH - pad*2)/spanY);
    const targetScale = clamp(s, 0.08, 1.8);

    const targetCx = (bb.minX + bb.maxX)/2;
    const targetCy = (bb.minY + bb.maxY)/2;

    // Smooth scale and center updates to avoid zoom jitter.
    const k = 1 - Math.exp(-dt * 10/1000);
    rot.view.scale += (targetScale - rot.view.scale) * k;
    rot.view.cx += (targetCx - rot.view.cx) * k;
    rot.view.cy += (targetCy - rot.view.cy) * k;

    return {bb, pad};
  }

  function toScreen(p, cssW, cssH, pad){
    const s = rot.view.scale;
    const x = (p.x - rot.view.cx) * s + cssW/2;
    const y = (p.y - rot.view.cy) * s + cssH/2;
    return {x, y};
  }

  

  function strokeLine(pts, cssW, cssH, pad, alpha){
    if(pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(128,128,128,1)'; // gray trajectory
    ctx.beginPath();
    const p0 = toScreen(pts[0], cssW, cssH, pad);
    ctx.moveTo(p0.x, p0.y);
    for(let i=1;i<pts.length;i++){
      const p = toScreen(pts[i], cssW, cssH, pad);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  

  function draw(){
    const t = nowMs();
    const dt = rot.lastFrameAt ? (t - rot.lastFrameAt) : 16;
    rot.lastFrameAt = t;

    // Stop rendering when tab is inactive
    // (RAF can be restarted by pointerlockchange).
    if(!isRotActive()){
      rot.rafId = 0;
      return;
    }

    const {cssW, cssH} = resizeCanvasToCSS(rotCanvas, ctx, 2);
    ctx.clearRect(0,0,cssW,cssH);

    updateViewSmooth(dt, cssW, cssH);

    // Historical strokes (fainter).
    for(const s of rot.strokes){
      strokeLine(s, cssW, cssH, 0, 0.22);
    }
    // Current stroke (brighter).
    strokeLine(rot.curPts, cssW, cssH, 0, 0.55);

    // Keep animating while locked, or while angle is still converging / data is dirty.
    if(rot.locked || rot.dirty){
      rot.rafId = requestAnimationFrame(draw);
    }else{
      rot.rafId = 0;
    }
  }

  function startRAF(){
    if(rot.rafId) return;
    rot.lastFrameAt = 0;
    rot.rafId = requestAnimationFrame(draw);
  }

  // ===== Main loop: update angle and UI =====
  function tick(){
    if(!isRotActive()) return;

    const t = nowMs();
    const dt = rot.lastTickAt ? (t - rot.lastTickAt) : 16;
    rot.lastTickAt = t;
    // Without input, the window naturally becomes "vector too small";
    // angle is kept but no longer jumps.
    const target = computeThetaTarget();
    if(target !== null){
      // First time becoming computable: align immediately to avoid slow sweep from 0 deg.
      if(rot.thetaRaw === null) rot.thetaSmooth = target;
      rot.thetaTarget = target;
      rot.thetaRaw = target;
    }else{
      rot.thetaTarget = null;
    }

    // Smoothing.
    updateAngleSmoothing(dt);

    // Swipe counting.
    if(rot.locked && rot.recording && rot.win.length){
      updateSwipeCount(rot.lastIngestTs || t);
    }

    // Stable window (used for final output).
    if(rot.locked && rot.recording && rot.thetaRaw !== null){
      const stableV = (rot.thetaTarget !== null && isFinite(rot.thetaTarget)) ? rot.thetaTarget : rot.thetaSmooth;
      rot.thetaStable.push({v: stableV, ts: t});
      pruneStable(t);
    }

    // Trend sampling.
    if(rot.thetaRaw !== null && (t - rot.lastHistAt) >= HIST_SAMPLE_MS){
      const histV = (rot.thetaTarget !== null && isFinite(rot.thetaTarget)) ? rot.thetaTarget : rot.thetaSmooth;
      rot.hist.push({v: histV, ts: t});
      const cutoff = t - 2200;
      while(rot.hist.length && rot.hist[0].ts < cutoff) rot.hist.shift();
      rot.lastHistAt = t;
      rot.dirty = true;
    }

    // UI refresh throttle.
    if((t - rot.lastUiAt) >= UI_UPDATE_MS){
      rotSwipeCountEl.textContent = String(rot.swipeCount);
      
      rotSwipePill.classList.toggle('okpill', rot.swipeCount >= 10);
rotSampleCountEl.textContent = String(rot.sampleTotal);

      // Stability: standard deviation (degrees) over the stable window.
      const vals = rot.thetaStable.map(o=>o.v);
      const sd = stdev(vals);
      rotStabilityEl.textContent = sd===null ? '--' : ('±' + (Math.round(sd*10)/10).toFixed(1) + '°');


      // Live result: prefer global-fit estimate to reduce lag and end-tail bias.
      renderAngleText();
      rot.lastUiAt = t;
      rot.dirty = true;
    }

    if(rot.locked){
      requestAnimationFrame(tick);
    }
  }

  // ===== finalize =====
  function finalize(){
    // Final output prefers split-axis bisection fit over short-window smoothed values.
    let thetaFinal = computeDisplayTheta();
    if(thetaFinal === null) thetaFinal = wrap180(rot.thetaSmooth);

    // Recommended angle: negate observed tilt to bring movement back to horizontal.
    const thetaDisp = applyRotBrand(thetaFinal);
    const txt = fmtDeg(thetaDisp);

    rotAngleFinalEl.textContent = txt;
    if(isFinite(thetaFinal)){
      rot.thetaTarget = thetaFinal;
      rot.thetaRaw = thetaFinal;
      rot.thetaSmooth = thetaFinal;
    }
    rotTopHint.textContent = tr('推荐角已可用：继续滑动可更准确；右键暂停','Result ready: more swipes improves accuracy; right-click to pause.');

    // After finalization, stop exclusive input interception.
    rot.recording = false;
    rot.locked = false;
    rotOnly = false;

    // Stop accumulating window samples, but keep visualization.
    rot.win = [];
    rot.thetaStable = rot.thetaStable.slice(-60);

    rot.dirty = true;
    startRAF();
  }

  function resetAll(){
    rot.locked = false;
    rot.recording = false;
    rot.endRequested = false;

    rot.win = [];
    rot.lastIngestTs = 0;

    rot.fitLeft = createFitStats();
    rot.fitRight = createFitStats();
    rot.sampleTotal = 0;
    rot.warmupLeft = FIT_WARMUP_SAMPLES;

    rot.curPts = [];
    rot.strokes = [];
    rot.x = 0; rot.y = 0;

    rot.thetaTarget = null;
    rot.thetaRaw = null;
    rot.thetaSmooth = 0;
    rot.thetaStable = [];

    rot.swipeCount = 0;
    rot.lastSign = 0;
    rot.accumProj = 0;
    rot.lastFlipTs = 0;

    rot.lastUiAt = 0;
    rot.lastHistAt = 0;
    rot.hist = [];
    rotAngleFinalEl.textContent = '--';
    rotSwipeCountEl.textContent = '0';
    
    rotSwipePill.classList.remove('okpill');
rotSampleCountEl.textContent = '0';
    rotStabilityEl.textContent = '--';

    
    rotTopHint.textContent = tr('点击下面区域开始；右键暂停。','Click the area to start; right-click to pause.');

    rot.dirty = true;
    startRAF();
  }

  // ===== UI events =====
  rotBox.addEventListener('click', ()=>{
    if(!isRotActive()) return;
    if(document.pointerLockElement){
      // If rotLockTarget is currently locked, treat click as pause/resume.
      if(document.pointerLockElement === rotLockTarget){
        document.exitPointerLock();
      }else{
        // Other locks: leave handling to setPage/other pages.
      }
      return;
    }
    // If data already exists, continue current session;
    // otherwise start a new one (auto-clear).
    if(!rotHasData()){
      resetAll();
    }
    requestLock();
  });

  rotBox.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      rotBox.click();
    }
  });

rotResetBtn.addEventListener('click', ()=>{
    if(!isRotActive()) return;
    if(document.pointerLockElement) document.exitPointerLock();
    resetAll();
  });

  rotCopyBtn.addEventListener('click', async ()=>{
    const v = rotAngleFinalEl.textContent;
    if(!v || v==='--') return;
    const text = `${v}°`;
    try{
      await navigator.clipboard.writeText(text);
    }catch(err){
    }
  });

  // Write recommended angle to "Advanced Parameters -> Sensor Angle Correction".
  rotWriteAngleBtn?.addEventListener('click', ()=>{
    const raw = (rotAngleFinalEl?.textContent || '').trim();
    const v = Number.parseFloat(raw);
    if(!Number.isFinite(v)) return;

    const angleInput = document.getElementById('angleInput');
    if(!angleInput) return;

    const min = Number.parseFloat(angleInput.min ?? '-100');
    const max = Number.parseFloat(angleInput.max ?? '100');
    const stepRaw = Number.parseFloat(angleInput.step ?? '1');
    const step = (Number.isFinite(stepRaw) && stepRaw > 0) ? stepRaw : 1;

    const vv0 = clamp(v, Number.isFinite(min) ? min : -100, Number.isFinite(max) ? max : 100);
    // Adapt to step (default 1 deg): round by step before writing.
    const vv = Math.round(vv0 / step) * step;

    angleInput.value = String(vv);
    // Trigger app.js write path (hidApi.setSensorAngle).
    angleInput.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Initial draw.
  resetAll();
  // Expose a few helpers for the embedded navigation (optional)
  try{
    window.refreshRotOutputsNow = refreshRotOutputsNow;
  }catch(_){ }

})();
