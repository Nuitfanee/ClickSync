/* ===== 角度校准：原始轨迹 + 实时拟合线 + 角度缓冲 ===== */
(function(){
  // 与其它测试工具页保持一致：用于判断当前是否处于"测试工具"页
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

  // ===== 不同品牌驱动适配：已移除（仅保留原始角度显示，不做任何偏移） =====
  function applyRotBrand(theta){
    if(theta === null || !isFinite(theta)) return null;
    return clamp(wrap180(theta), -90, 90);
  }

  function refreshRotOutputsNow(){
    // 仅刷新“结果文字 + 仪表”，不影响采样/轨迹
    const readyAngle = (rot && rot.swipeCount >= 10 && rot.thetaRaw !== null && rot.thetaTarget !== null);
    if(readyAngle){
      const thetaNow = wrap180(rot.thetaSmooth);
      const thetaDisp = applyRotBrand(thetaNow);
      const txt = fmtDeg(thetaDisp);
      rotAngleFinalEl.textContent = txt;

    }else{
      rotAngleFinalEl.textContent = '--';
    }
  }

  // Keep brand/lock labels in sync when UI language toggles
  window.addEventListener('uilangchange', ()=>{
    try{ refreshRotOutputsNow(); }catch(_){ }
  });


  // ===== 常量（与现有窗口/节流风格对齐） =====
  const WINDOW_MS = 300;                 // 角度拟合时间窗
  const UI_UPDATE_MS = 80;               // 文本刷新节流
  const HIST_SAMPLE_MS = 33;             // 趋势图采样（~30fps）
  const FINAL_WINDOW_MS = 1200;          // 结束时用于稳态统计的窗口
  const MIN_VEC = 20;                    // 窗口矢量过小不更新目标角
  const FIT_MIN_SEG = 0.35;              // 拟合时忽略太短的段（抗抖）
  const FIT_W_CAP = 60;                 // 单段权重上限（防止偶发大跳影响）
  const FIT_MAX_ACUTE = 80;             // 拟合时剔除近似竖直段（与水平夹角 > 80°）
  const FIT_MIN_H_RATIO = 0.18;        // |dx|/len 过小视为近似竖直（抗开始/结束阶段偏差）
  const SNAP_EPS = 0.06;                 // 角度接近吸附阈值（度）
  const SMOOTH_LAMBDA = 14;              // 角度缓冲强度
  const FLIP_MIN_PROJ = 220;             // 计数往返的最小主轴推进量（counts）
  const FLIP_MIN_DT = 90;                // 方向翻转的最小间隔（ms）
  const MAX_STROKES_DRAW = 24;           // 轨迹显示的最近段数
  const FIT_WARMUP_SAMPLES = 800;

  // ===== 状态 =====
  const rot = {
    locked:false,
    recording:false,
    endRequested:false,

// 窗口样本：{dx,dy,ts}
    win: [],
    lastIngestTs: 0,

    // 全量拟合统计（基于所有轨迹段向量；画得越多越准）
    fit: { Sxx:0, Syy:0, Sxy:0, W:0, N:0 },
    sampleTotal: 0,
    warmupLeft: FIT_WARMUP_SAMPLES,

    // 轨迹（以累积坐标存点）
    curPts: [],
    strokes: [],     // array of arrays of pts {x,y}
    x: 0, y: 0,

    // 视图（缩放/中心缓冲）
    view: { scale: 1, cx: 0, cy: 0, tx:0, ty:0, ts:1 },

    // 角度
    thetaTarget: null,   // 度
    thetaRaw: null,      // 度
    thetaSmooth: 0,      // 度
    thetaStable: [],     // {v, ts}

    // 往返计数（基于投影符号翻转）
    swipeCount: 0,
    lastSign: 0,
    accumProj: 0,
    lastFlipTs: 0,

    // UI/绘制节奏
    lastUiAt: 0,
    lastHistAt: 0,
    
    lastTickAt: 0,
hist: [],          // {v,ts}
    rafId: 0,
    dirty: true
  };

  function isRotActive(){ return pageRot && pageRot.classList.contains('active'); }

  // ===== 工具 =====
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
      /* rotTopHint 已在上方设置 */
      attachRotMove();
      attachRotFocusBlock();
      startRAF();
    
      // 启动计算循环（用于实时角度/趋势更新）
      rot.lastTickAt = 0;
      requestAnimationFrame(tick);
}else{
      detachRotMove();
      detachRotFocusBlock();

      // 若刚刚执行了“重置”，数据已清空：不覆盖 resetAll() 的初始文案
      if(!rotHasData()){
        rot.recording = false;
        rot.endRequested = false;
        return;
      }

      // 暂停态：保留轨迹与结果
      rot.recording = false;
      rot.endRequested = false;
      rotTopHint.textContent = tr('已暂停（点击继续）','Paused (click to continue)');

      // 暂停时也刷新一次结果，避免“结果 --”的观感
      {
        const readyAngle = (rot.swipeCount >= 10 && rot.thetaRaw !== null && rot.thetaTarget !== null);
        if(readyAngle){
          const thetaNow = wrap180(rot.thetaSmooth);
          const thetaDisp = applyRotBrand(thetaNow);
          rotAngleFinalEl.textContent = fmtDeg(thetaDisp);
}else{
          rotAngleFinalEl.textContent = '--';
        }
      }
}
  });

  // ===== 输入拦截（避免串页） =====
  let rotOnly = false;
  function blockIfRotOnly(e){
  if(!isTestToolsActive()) return;
    if(!rotOnly) return;
    // 右键：暂停（退出锁定但保留数据）
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

  // ===== 采样 =====
let rotMoveEvt = null;
const rotSupportsRaw = ('onpointerrawupdate' in document);

function attachRotMove(){
  if(rotMoveEvt) return;
  rotMoveEvt = rotSupportsRaw ? 'pointerrawupdate' : 'pointermove';
  // PointerLock 下的相对位移事件更稳定地派发到 document（与现有匹配页/轮询率页一致）
  document.addEventListener(rotMoveEvt, rotMoveHandler, { passive:true });
}
function detachRotMove(){
  if(!rotMoveEvt) return;
  document.removeEventListener(rotMoveEvt, rotMoveHandler);
  rotMoveEvt = null;
}


  function ingest(dx, dy, ts){
    rot.lastIngestTs = ts;

    // 更新累积坐标点
    rot.x += dx;
    rot.y += dy;

    if(!rot.curPts.length){
      rot.curPts.push({x: rot.x, y: rot.y});
    }else{
      const last = rot.curPts[rot.curPts.length-1];
      // 避免过密：位移为 0 的点不写入
      if(last.x !== rot.x || last.y !== rot.y){
        rot.curPts.push({x: rot.x, y: rot.y});
      }
    }

    // 窗口：写入样本
    rot.win.push({dx, dy, ts});
    const cutoff = ts - WINDOW_MS;
    while(rot.win.length > 2 && rot.win[0].ts < cutoff){
      rot.win.shift();
    }

    // 全量拟合：累积所有轨迹段（实时更新基于全部历史）
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

  // ===== 角度计算与往返计数 =====
function addFitSample(dx, dy){
  const len = Math.hypot(dx, dy);
  if(!isFinite(len) || len < FIT_MIN_SEG) return;

  // 剔除“近似竖直”的偏差段：开始/结束阶段常见，会强烈拉歪拟合
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if(ax < 1e-9) return;
  const acute = Math.atan2(ay, ax) * 180 / Math.PI; // 与水平夹角（锐角）
  if(acute > FIT_MAX_ACUTE) return;
  if((ax / len) < FIT_MIN_H_RATIO) return;

  // 先把"有效样本段"计入样本数（UI 显示仍然是完整样本量）
  rot.sampleTotal += 1;

  // 预热：忽略前 800 个有效样本段对推荐角度拟合的影响
  if(rot.warmupLeft > 0){
    rot.warmupLeft -= 1;
    return;
  }

  const w = Math.min(len, FIT_W_CAP);
  // 向量 TLS / PCA：累积二阶矩阵（权重加和）
  rot.fit.Sxx += w * dx * dx;
  rot.fit.Syy += w * dy * dy;
  rot.fit.Sxy += w * dx * dy;
  rot.fit.W   += w;
  rot.fit.N  += 1;
}

function computeThetaFromFitStats(){
  const Sxx = rot.fit.Sxx, Syy = rot.fit.Syy, Sxy = rot.fit.Sxy;
  const N = rot.fit.N, W = rot.fit.W;
  if(N < 3 || W < 1) return null;

  // 主特征向量（最大方差方向）
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
  }else{
    // 近似各向同性：退化为水平
    vx = 1; vy = 0;
  }

  const mag = Math.hypot(vx, vy);
  if(mag < 1e-9) return null;
  vx /= mag; vy /= mag;

  // 轨迹与水平线夹角的“锐角”（0~90°）
  const acute = Math.atan2(Math.abs(vy), Math.abs(vx)) * 180 / Math.PI;

  // 符号规则（与需求一致）：
  // 左上 → 右下（dx、dy 同号）=> 负
  // 右上 → 左下（dx、dy 异号）=> 正
  let sign = 0;
  if(Math.abs(vx) < 1e-6){
    // 近似竖直：按 vy 方向约定（向下为负、向上为正）
    sign = (vy >= 0) ? -1 : 1;
  }else{
    sign = (vx * vy) < 0 ? 1 : -1;
  }

  return clamp(sign * acute, -90, 90);
}

function computeThetaTarget(){
  // 不再使用短窗口估算；至少完成 10 次往返（有效数据）才开始计算并显示推荐角度
  if(rot.swipeCount < 10) return null;

  // 基于“全部有效轨迹段”的 TLS/PCA 拟合（画得越多越准）
  const fitTheta = computeThetaFromFitStats();
  if(fitTheta === null || !isFinite(fitTheta)) return null;
  return fitTheta;
}


  function updateSwipeCount(ts){
    // 使用缓冲角度作为主轴，投影本次增量
    const rad = rot.thetaSmooth * Math.PI / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad);

    // 取窗口最后一个样本作为近似增量方向（更跟手）
    const s = rot.win.length ? rot.win[rot.win.length-1] : null;
    if(!s) return;

    const proj = s.dx*ux + s.dy*uy;
    const sign = proj > 0 ? 1 : (proj < 0 ? -1 : 0);
    if(sign === 0) return;

    // 累计主轴推进量（用绝对值，过滤抖动）
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

      // 方向翻转：固化一段轨迹并开始新段（形成多条“滑动线”）
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

    // 指数平滑（对角度差用 wrap180）
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

  // ===== 绘制（轨迹 + 仪表） =====
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
      // 默认盒子
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

    // 目标缩放：尽量塞进画布
    const s = Math.min((cssW - pad*2)/spanX, (cssH - pad*2)/spanY);
    const targetScale = clamp(s, 0.08, 1.8);

    const targetCx = (bb.minX + bb.maxX)/2;
    const targetCy = (bb.minY + bb.maxY)/2;

    // 缓冲缩放与中心（避免缩放跳动）
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

    // 如果页面不在当前页，停止绘制（但保留 raf 由 pointerlockchange 重新启动）
    if(!isRotActive()){
      rot.rafId = 0;
      return;
    }

    const {cssW, cssH} = resizeCanvasToCSS(rotCanvas, ctx, 2);
    ctx.clearRect(0,0,cssW,cssH);

    updateViewSmooth(dt, cssW, cssH);

    // 历史轨迹（更淡）
    for(const s of rot.strokes){
      strokeLine(s, cssW, cssH, 0, 0.22);
    }
    // 当前轨迹（更亮）
    strokeLine(rot.curPts, cssW, cssH, 0, 0.55);

    // 持续动画：只要在锁定态或角度还在收敛/有脏数据就继续
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

  // ===== 主循环：更新角度、UI =====
  function tick(){
    if(!isRotActive()) return;

    const t = nowMs();
    const dt = rot.lastTickAt ? (t - rot.lastTickAt) : 16;
    rot.lastTickAt = t;
    // 无输入时：窗口会自然变“矢量过小”，角度保持但不会继续跳
    const target = computeThetaTarget();
    if(target !== null){
      // 第一次进入“可计算”状态：直接对齐，避免从 0° 缓慢扫动
      if(rot.thetaRaw === null) rot.thetaSmooth = target;
      rot.thetaTarget = target;
      rot.thetaRaw = target;
    }else{
      rot.thetaTarget = null;
    }

    // 平滑
    updateAngleSmoothing(dt);

    // 往返计数
    if(rot.locked && rot.recording && rot.win.length){
      updateSwipeCount(rot.lastIngestTs || t);
    }

    // 稳态窗口（用于结束输出）
    if(rot.locked && rot.recording && rot.thetaRaw !== null){
      rot.thetaStable.push({v: rot.thetaSmooth, ts: t});
      pruneStable(t);
    }

    // 趋势采样
    if(rot.thetaRaw !== null && (t - rot.lastHistAt) >= HIST_SAMPLE_MS){
      rot.hist.push({v: rot.thetaSmooth, ts: t});
      const cutoff = t - 2200;
      while(rot.hist.length && rot.hist[0].ts < cutoff) rot.hist.shift();
      rot.lastHistAt = t;
      rot.dirty = true;
    }

    // UI 刷新节流
    if((t - rot.lastUiAt) >= UI_UPDATE_MS){
      rotSwipeCountEl.textContent = String(rot.swipeCount);
      
      rotSwipePill.classList.toggle('okpill', rot.swipeCount >= 10);
rotSampleCountEl.textContent = String(rot.sampleTotal);

      // 稳定度：用稳态窗口的 stdev（度）
      const vals = rot.thetaStable.map(o=>o.v);
      const sd = stdev(vals);
      rotStabilityEl.textContent = sd===null ? '--' : ('±' + (Math.round(sd*10)/10).toFixed(1) + '°');


      // 实时结果：显示当前平滑角度估计（暂停也可保留此结果）
      {
        const readyAngle = (rot.swipeCount >= 10 && rot.thetaRaw !== null && rot.thetaTarget !== null);
        if(readyAngle){
          const thetaNow = wrap180(rot.thetaSmooth);
          const thetaDisp = applyRotBrand(thetaNow);
          const txt = fmtDeg(thetaDisp);
          rotAngleFinalEl.textContent = txt;
        }else{

          rotAngleFinalEl.textContent = '--';
        }
      }
      rot.lastUiAt = t;
      rot.dirty = true;
    }

    if(rot.locked){
      requestAnimationFrame(tick);
    }
  }

  // ===== finalize =====
  function finalize(){
    // 输出 θ_final：取稳态窗口的中位数（抗异常）
    const vals = rot.thetaStable.map(o=>o.v);
    let thetaFinal = median(vals);
    if(thetaFinal === null){
      thetaFinal = rot.thetaSmooth;
    }
    thetaFinal = wrap180(thetaFinal);

    // 推荐角度：为了让“观测到的偏斜”回到水平，建议取相反数
    const thetaDisp = applyRotBrand(thetaFinal);
    const txt = fmtDeg(thetaDisp);

    rotAngleFinalEl.textContent = txt;
    rotTopHint.textContent = tr('推荐角已可用：继续滑动可更准确；右键暂停','Result ready: more swipes improves accuracy; right-click to pause.');

    // 结束后：停止专注吞输入
    rot.recording = false;
    rot.locked = false;
    rotOnly = false;

    // 停止继续累积窗口（但保留可视化）
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


    rot.fit = { Sxx:0, Syy:0, Sxy:0, W:0, N:0 };
    rot.sampleTotal = 0;

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

  // ===== UI 事件 =====
  rotBox.addEventListener('click', ()=>{
    if(!isRotActive()) return;
    if(document.pointerLockElement){
      // 若当前锁定的是 rotLockTarget，则点击视为暂停/继续
      if(document.pointerLockElement === rotLockTarget){
        document.exitPointerLock();
      }else{
        // 其他锁定：交给 setPage/其他页处理
      }
      return;
    }
    // 若已有数据：继续之前的测量；否则新开一轮（自动清空）
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

  // 将推荐角度写入“高级参数 → 传感器角度修正”
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
    // 适配步进（默认 1°）：写入前按 step 四舍五入
    const vv = Math.round(vv0 / step) * step;

    angleInput.value = String(vv);
    // 触发 app.js 里的写入逻辑（hidApi.setSensorAngle）
    angleInput.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 初始绘制
  resetAll();
  // Expose a few helpers for the embedded navigation (optional)
  try{
    window.refreshRotOutputsNow = refreshRotOutputsNow;
  }catch(_){ }

})();
