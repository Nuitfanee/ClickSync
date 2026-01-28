(function(){
  const isTestToolsActive = () => document.body.classList.contains('page-testtools');
  const tr = (typeof window !== 'undefined' && window.tr) ? window.tr : ((zh,en)=>zh);

  const navMain = document.getElementById('navMain');
  const navPoll = document.getElementById('navPoll');
  const navMatch = document.getElementById('navMatch');
  const navRot = document.getElementById('navRot');
  const pageMain = document.getElementById('pageMain');
  const pagePoll = document.getElementById('pagePoll');
  const pageMatch = document.getElementById('pageMatch');
  const pageRot = document.getElementById('pageRot');

  const pageTitle = document.getElementById('pageTitle');

  const lockTarget = document.getElementById('lockTarget');
  const matchLockState = document.getElementById('matchLockState');
  const matchLockPill = document.getElementById('matchLockPill');

  function isMatchActive(){ return pageMatch.classList.contains('active'); }
  function isPollActive(){ return pagePoll.classList.contains('active'); }

  function setPage(which){
    const isMain = which === 'main';
    const isPoll = which === 'poll';
    const isMatch = which === 'match';
    const isRot  = which === 'rot';

    navMain.classList.toggle('active', isMain);
    navPoll.classList.toggle('active', isPoll);
    navMatch.classList.toggle('active', isMatch);
    navRot.classList.toggle('active', isRot);

    // 更新滑块位置 (Ultra-Liquid Glider)
    const ttTabs = document.querySelector('#testtools .ttTabs');
    if (ttTabs) {
      const index = isMain ? 0 : (isPoll ? 1 : (isMatch ? 2 : 3));
      ttTabs.style.setProperty('--glider-index', index);
    }

    pageMain.classList.toggle('active', isMain);
    pagePoll.classList.toggle('active', isPoll);
    pageMatch.classList.toggle('active', isMatch);
    pageRot.classList.toggle('active', isRot);

    if(pageTitle){
      pageTitle.textContent =
        isMain ? tr('双击检测','Double-click') :
        (isPoll ? tr('轮询率检测','Polling rate') :
         (isMatch ? tr('灵敏度匹配','Sensitivity match') : tr('鼠标角度校准','Rotation calibration')));
    }
    // 页面切换时：若处于任何 PointerLock，优先退出，避免“无光标/误吞输入”
    if(document.pointerLockElement){
      document.exitPointerLock();
    }

    // 角度校准页：首次进入时强制绘制一次仪表（避免隐藏态尺寸为 0 导致不显示）
    if(isRot){
      try{
        requestAnimationFrame(()=>{ try{ if(typeof refreshRotOutputsNow==='function') refreshRotOutputsNow(); }catch(_){}
          try{ if(typeof drawGauge==='function') drawGauge(performance.now()); }catch(_){}
        });
        // 再补一帧：给布局/字体渲染一点时间，确保 canvas 有正确尺寸
        setTimeout(()=>{ try{ if(typeof drawGauge==='function') drawGauge(performance.now()); }catch(_){} }, 60);
      }catch(_){}
    }
}

  navMain.addEventListener('click', ()=>setPage('main'));
  navPoll.addEventListener('click', ()=>setPage('poll'));
  navMatch.addEventListener('click', ()=>setPage('match'));
  navRot.addEventListener('click', ()=>setPage('rot'));

  // ========= 阻止主面板的 window 级监听在匹配页生效 =========
  // 主面板把 mousedown/mouseup/wheel 绑在 window；事件在 bubble 时会先到 document 再到 window。
  // 这里在 document(bubble) 阶段 stopPropagation，从而不冒泡到 window。
  document.addEventListener('wheel', (e)=>{
    if(!isTestToolsActive()) return;
    // 非主页：阻止事件冒泡到 window，避免触发双击检测页的全局统计
    if(pageMain.classList.contains('active')) return;
    e.stopPropagation();
  }, {passive:true});

  document.addEventListener('mousedown', (e)=>{
    if(!isTestToolsActive()) return;
    if(pageMain.classList.contains('active')) return;
    e.stopPropagation();
  }, false);

  document.addEventListener('mouseup', (e)=>{
    if(!isTestToolsActive()) return;
    if(pageMain.classList.contains('active')) return;
    e.stopPropagation();
  }, false);

  // ========= PointerLock 状态（匹配页只关心 lockTarget） =========
  function setMatchLockUI(){
    const locked = (document.pointerLockElement === lockTarget);
    if(matchLockState) matchLockState.textContent = locked ? tr('已锁定','Locked') : tr('未锁定','Unlocked');
    if(matchLockPill) matchLockPill.style.borderColor = locked ? 'rgba(48,209,88,.55)' : 'rgba(255,255,255,.14)';

    // 如果用户已经按下左键，但锁定稍后才生效：锁定生效后自动进入记录状态（不需要反复点击）
    if(locked && match && match.activeMouse && match.waitingPress && match.pendingStart){
      match.pendingStart = false;
      match.waitingPress = false;
      match.recording = true;
      match.deltas = [];
      detachMove();
      attachMove();

      const arr = (match.activeMouse === 'm1') ? match.m1 : match.m2;
      const stepTxt = (match.replaceIndex !== null) ? tr(`替换第 ${match.replaceIndex+1} 次`, `Replace #${match.replaceIndex+1}`) : tr(`第 ${arr.length+1} 次`, `Trial #${arr.length+1}`);
      setStatus(tr(`状态：<span class="ok">正在记录</span>（${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} ${stepTxt}）。保持按住左键，推到终点后松开。`, `Status: <span class="ok">Recording</span> (${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} ${stepTxt}). Keep holding the left button, push to the end, then release.`));
    }
  }
  document.addEventListener('pointerlockchange', setMatchLockUI);
  setMatchLockUI();

  // Keep lock label in sync when UI language toggles
  window.addEventListener('uilangchange', ()=>{
    try{ setMatchLockUI(); }catch(_){ }
  });

  // ========= 灵敏度匹配 =========
  const dpi1Input = document.getElementById('dpi1Input');
  const startM1 = document.getElementById('startM1');
  const startM2 = document.getElementById('startM2');
  const resetBtn = document.getElementById('resetMatch');
  const statusEl = document.getElementById('matchStatus');

  const m1TrialsEl = document.getElementById('m1Trials');
  const m2TrialsEl = document.getElementById('m2Trials');
  const c1MedEl = document.getElementById('c1Med');
  const c2MedEl = document.getElementById('c2Med');
  const dpi2Out = document.getElementById('dpi2Out');
  const dpi2Range = document.getElementById('dpi2Range');
  const qualityHint = document.getElementById('qualityHint');

  dpi1Input.addEventListener('wheel', (e)=>{ if(document.activeElement === dpi1Input) e.preventDefault(); }, {passive:false});

  const MATCH_TRIALS = 3;

  function median(a){
    if(!a.length) return NaN;
    const s=a.slice().sort((x,y)=>x-y);
    const m=(s.length-1)/2;
    const lo=Math.floor(m), hi=Math.ceil(m);
    return (s[lo]+s[hi])/2;
  }
  function medianAbsDev(arr, med){
    const dev = arr.map(x=>Math.abs(x - med)).sort((a,b)=>a-b);
    const m=(dev.length-1)/2;
    const lo=Math.floor(m), hi=Math.ceil(m);
    return (dev[lo]+dev[hi])/2;
  }
  function setStatus(html){ statusEl.innerHTML = html; }

  const match = {
    activeMouse: null,   // 'm1'|'m2'
    replaceIndex: null,  // number|null
    waitingPress: false,
    pendingStart: false, // 已按下左键但尚未拿到 PointerLock
    recording: false,
    deltas: [],          // [[dx,dy], ...]
    m1: [],
    m2: [],
  };

  function reset(){
    match.activeMouse=null;
    match.replaceIndex=null;
    match.waitingPress=false;
    match.pendingStart=false;
    match.recording=false;
    match.deltas=[];
    match.m1=[];
    match.m2=[];
    m1TrialsEl.innerHTML='';
    m2TrialsEl.innerHTML='';
    c1MedEl.textContent='C1 = --';
    c2MedEl.textContent='C2 = --';
    dpi2Out.textContent='--';
    dpi2Out.style.color = 'rgb(0, 200, 130)';
    dpi2Range.textContent=tr('误差范围：--','Error range: --');
    qualityHint.textContent='';
    setStatus(tr('状态：等待开始。','Status: Ready.'));
  }

  resetBtn.addEventListener('click', ()=>{
    reset();
    if(document.pointerLockElement === lockTarget) document.exitPointerLock();
  });

  function ensureLock(){
    if(document.pointerLockElement === lockTarget) return true;
    try{ lockTarget.requestPointerLock({unadjustedMovement:true}); }
    catch(_){ lockTarget.requestPointerLock(); }
    return false;
  }

  // —— 方向投影计数（对不完全直线更鲁棒）——
  function estimateCounts(deltas){
    if(deltas.length < 40) return { ok:false, reason:tr('样本太少（请移动更远/更快）','Too few samples (move farther/faster)') };

    let sumX=0,sumY=0;
    for(const [dx,dy] of deltas){ sumX+=dx; sumY+=dy; }
    const net = Math.hypot(sumX,sumY);
    if(net < 30) return { ok:false, reason:tr('有效位移太小（请移动更远）','Effective travel too small (move farther)') };

    const ux=sumX/net, uy=sumY/net;
    const px=-uy, py=ux;

    let fwd=0, ortho=0, revBig=0;
    const POS_NOISE=0.15;
    const REV_BIG_TH=8.0;

    for(const [dx,dy] of deltas){
      const proj = dx*ux + dy*uy;
      const ort  = dx*px + dy*py;
      ortho += Math.abs(ort);
      if(proj > POS_NOISE) fwd += proj;
      else if(proj < -REV_BIG_TH) revBig += -proj;
    }

    if(fwd < 80) return { ok:false, reason:tr('有效计数太小（请做更长距离）','Effective samples too few (use a longer stroke)') };
    const wobble = ortho / fwd;
    if(wobble > 0.65) return { ok:false, reason:tr('轨迹偏离过大（建议贴胶带导轨）','Path deviates too much (use a taped guide)') };
    const reverseRatio = revBig / fwd;
    if(reverseRatio > 0.10) return { ok:false, reason:tr('回拉过多（请避免来回/回拉）','Too much pull-back (avoid backtracking)') };

    return { ok:true, counts:fwd, wobble, reverseRatio };
  }

  function computeOutliers(arr){
    if(arr.length < 2) return new Set();
    const med = median(arr);
    const mad = medianAbsDev(arr, med);
    const thr = Math.max(med * 0.03, 3 * mad);
    const out = new Set();
    arr.forEach((v,i)=>{ if(Math.abs(v - med) > thr) out.add(i); });
    return out;
  }

  function updateResult(){
    const dpi1 = parseFloat(dpi1Input.value);
    const hasDpi1 = Number.isFinite(dpi1) && dpi1 > 50 && dpi1 < 50000;
    const ok = (match.m1.length===MATCH_TRIALS) && (match.m2.length===MATCH_TRIALS) && hasDpi1;

    if(!ok){
      dpi2Out.textContent='--';
      dpi2Range.textContent=tr('误差范围：--','Error range: --');
      qualityHint.textContent='';
      return;
    }

    const c1 = median(match.m1);
    const c2 = median(match.m2);
    const dpi2 = dpi1 * (c2 / c1);

    const mad1 = medianAbsDev(match.m1, c1);
    const mad2 = medianAbsDev(match.m2, c2);
    const sigma1 = 1.4826 * mad1;
    const sigma2 = 1.4826 * mad2;

    const rel1 = sigma1 / Math.max(1e-9, c1);
    const rel2 = sigma2 / Math.max(1e-9, c2);

    let rel95 = 2 * Math.sqrt(rel1*rel1 + rel2*rel2);
    rel95 = Math.max(rel95, 0.02);

    const lo = dpi2 * (1 - rel95);
    const hi = dpi2 * (1 + rel95);

    dpi2Out.textContent = `${Math.round(dpi2)} DPI`;
    dpi2Range.textContent = tr(`误差范围：±${Math.round(rel95*100)}%（约 ${Math.round(lo)} ~ ${Math.round(hi)}）`, `Error range: ±${Math.round(rel95*100)}% (~${Math.round(lo)}–${Math.round(hi)})`);

    const worst = Math.max(rel1, rel2);
    if(worst < 0.01) qualityHint.textContent = tr('质量：很好（轨迹稳定，偏差小）','Quality: Great (stable path, low deviation)');
    else if(worst < 0.02) qualityHint.textContent = tr('质量：良好（建议再做 1 组确认）','Quality: Good (do one more set to confirm)');
    else qualityHint.textContent=tr('质量：一般（建议贴导轨、做更远距离、匀速直推）','Quality: Fair (use a guide, go farther, push steadily)');
  }

  function renderTrials(){
    const out1 = computeOutliers(match.m1);
    const out2 = computeOutliers(match.m2);

    function renderOne(arr, container, outSet, label){
      container.innerHTML='';
      arr.forEach((v,i)=>{
        const div=document.createElement('div');
        div.className='trial-card' + (outSet.has(i) ? ' outlier' : '');
        div.innerHTML = `
          <div class="meta">
            <b>${Math.round(v)}</b>
            <span>${tr(`第 ${i+1} 次`, `Trial ${i+1}`)}</span>
          </div>
          ${outSet.has(i) ? `<span class="note">${tr('偏差较大','Large deviation')}</span>` : ``}
          <button class="redo" type="button" data-mouse="${label}" data-idx="${i}">${tr("重测","Redo")}</button>
        `;
        container.appendChild(div);
      });
    }

    renderOne(match.m1, m1TrialsEl, out1, 'm1');
    renderOne(match.m2, m2TrialsEl, out2, 'm2');

    const c1 = (match.m1.length===MATCH_TRIALS) ? median(match.m1) : NaN;
    const c2 = (match.m2.length===MATCH_TRIALS) ? median(match.m2) : NaN;
    c1MedEl.textContent = Number.isFinite(c1) ? `C1 = ${Math.round(c1)}` : 'C1 = --';
    c2MedEl.textContent = Number.isFinite(c2) ? `C2 = ${Math.round(c2)}` : 'C2 = --';

    updateResult();
  }

  function begin(mouse, replaceIndex){
    const dpi1 = parseFloat(dpi1Input.value);
    if(!(Number.isFinite(dpi1) && dpi1 > 50 && dpi1 < 50000)){
      setStatus(tr('状态：<span class="bad">请先输入有效 DPI1（例如 400/800/1600/3200）。</span>', 'Status: <span class="bad">Please enter a valid DPI1 (e.g., 400/800/1600/3200).</span>'));
      return;
    }

    const arr = (mouse === 'm1') ? match.m1 : match.m2;
    if(arr.length >= MATCH_TRIALS && (replaceIndex === null || replaceIndex === undefined)){
      setStatus(tr(`状态：<span class="warn">${mouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} 已完成 3 次。</span>如需修改请点击对应记录的“重测”。`, `Status: <span class="warn">${mouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} finished 3 trials.</span> Click “Redo” on a trial to replace it.`));
      return;
    }

    setPage('match');

    match.activeMouse = mouse;
    match.replaceIndex = (replaceIndex === undefined) ? null : replaceIndex;
    match.waitingPress = true;
    match.pendingStart = false;
    match.recording = false;
    match.deltas = [];

    ensureLock();

    const targetTxt = (match.replaceIndex !== null)
      ? tr(`替换第 ${match.replaceIndex+1} 次`, `Replace #${match.replaceIndex+1}`)
      : tr(`第 ${arr.length+1} 次`, `Trial #${arr.length+1}`);

    setStatus(tr(`状态：准备测 <b>${mouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')}</b>（${targetTxt}）。<br>
      <span class="ok">按住左键不松开后开始移动</span>，推到终点后松开左键结束。`, `Status: Ready for <b>${mouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')}</b> (${targetTxt}).<br>
      <span class="ok">Hold left button, then start moving</span>; release at the end point to finish.`));
  }

  startM1.addEventListener('click', ()=>begin('m1', null));
  startM2.addEventListener('click', ()=>begin('m2', null));

  pageMatch.addEventListener('click', (e)=>{
    const btn = e.target && e.target.closest && e.target.closest('button.redo');
    if(!btn) return;
    const mouse = btn.getAttribute('data-mouse');
    const idx = parseInt(btn.getAttribute('data-idx'), 10);
    if(!(mouse === 'm1' || mouse === 'm2') || !Number.isFinite(idx)) return;
    begin(mouse, idx);
  });

  const supportsRaw = ('onpointerrawupdate' in document);

  function moveHandler(e){
    if(!match.recording) return;
    const list = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    if(list && list.length){
      for(const ev of list) match.deltas.push([ev.movementX || 0, ev.movementY || 0]);
    }else{
      match.deltas.push([e.movementX || 0, e.movementY || 0]);
    }
  }
  function attachMove(){
    if(supportsRaw) document.addEventListener('pointerrawupdate', moveHandler, {passive:true});
    else document.addEventListener('pointermove', moveHandler, {passive:true});
  }
  function detachMove(){
    document.removeEventListener('pointerrawupdate', moveHandler);
    document.removeEventListener('pointermove', moveHandler);
  }

  document.addEventListener('mousedown', (e)=>{
    if(!isTestToolsActive()) return;
    if(!isMatchActive()) return;
    if(e.button !== 0) return;
    if(!match.activeMouse || !match.waitingPress) return;

    if(document.pointerLockElement !== lockTarget){
      // 有些浏览器 PointerLock 需要一次额外的用户手势/或锁定生效有延迟：
      // 这里记下“已按下左键”，并立刻再次请求锁定；锁定生效后自动开始记录，避免反复点击。
      match.pendingStart = true;
      ensureLock();
      setStatus(tr('状态：<span class="warn">正在请求锁定光标…</span>请<strong>保持按住左键</strong>，锁定成功后会自动开始记录。', 'Status: <span class="warn">Requesting cursor lock…</span> Please <strong>keep holding the left button</strong>; recording will start automatically after lock.'));
      return;
    }

    match.waitingPress = false;
    match.recording = true;
    match.deltas = [];
    detachMove();
    attachMove();

    const arr = (match.activeMouse === 'm1') ? match.m1 : match.m2;
    const stepTxt = (match.replaceIndex !== null) ? tr(`替换第 ${match.replaceIndex+1} 次`, `Replace #${match.replaceIndex+1}`) : tr(`第 ${arr.length+1} 次`, `Trial #${arr.length+1}`);
    setStatus(tr(`状态：<span class="ok">正在记录</span>（${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} ${stepTxt}）。保持按住左键，推到终点后松开。`, `Status: <span class="ok">Recording</span> (${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')} ${stepTxt}). Keep holding the left button, push to the end, then release.`));
  }, false);

  document.addEventListener('mouseup', (e)=>{
    if(!isTestToolsActive()) return;
    if(!isMatchActive()) return;
    if(e.button !== 0) return;
    if(!match.activeMouse) return;

    // 如果还在等待 PointerLock（pendingStart=true），用户松开左键则视为取消这次“按住开始”
    if(match.pendingStart && match.waitingPress && !match.recording){
      match.pendingStart = false;
      setStatus(tr('状态：已取消（未开始记录）。请再次点击“开始测量”，然后按住左键开始移动。', 'Status: Canceled (recording did not start). Click “Start” again, then hold left button and begin moving.'));
      return;
    }

    if(!match.recording) return;

    match.recording = false;
    detachMove();

    const est = estimateCounts(match.deltas);
    if(!est.ok){
      match.waitingPress = true;
      match.deltas = [];
      setStatus(tr(`状态：<span class="warn">本次无效</span>（原因：${est.reason}）。请重新做这一次。`, `Status: <span class="warn">Invalid</span> (Reason: ${est.reason}). Please redo this trial.`));
      return;
    }

    const arr = (match.activeMouse === 'm1') ? match.m1 : match.m2;

    if(match.replaceIndex !== null && match.replaceIndex !== undefined){
      arr[match.replaceIndex] = est.counts;
    }else{
      arr.push(est.counts);
      if(arr.length > MATCH_TRIALS) arr.length = MATCH_TRIALS;
    }

    renderTrials();

    if(arr.length >= MATCH_TRIALS){
      if(document.pointerLockElement === lockTarget) document.exitPointerLock();

      if(match.activeMouse === 'm1'){
        setStatus(tr(`状态：<span class="ok">鼠标1 已完成</span>（已记录 3 次）。<br>请点击“开始测鼠标2（3次）”继续。`, 'Status: <span class="ok">Mouse 1 complete</span> (3 trials).<br>Click “Measure mouse 2 (3 trials)” to continue.'));
      }else{
        setStatus(tr(`状态：<span class="ok">鼠标2 已完成</span>（已记录 3 次）。<br>已自动计算建议 DPI2。`, 'Status: <span class="ok">Mouse 2 complete</span> (3 trials).<br>Suggested DPI2 has been calculated.'));
      }

      match.activeMouse = null;
      match.replaceIndex = null;
      match.waitingPress = false;
      match.deltas = [];
      return;
    }

    match.waitingPress = true;
    match.deltas = [];
    setStatus(tr(`状态：已记录 <b>${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')}</b> 第 ${arr.length} 次。<br>继续第 ${arr.length+1} 次：<span class="ok">按住左键开始移动</span>，到终点后松开结束。`, `Status: Recorded <b>${match.activeMouse==='m1'?tr('鼠标1','Mouse 1'):tr('鼠标2','Mouse 2')}</b> trial #${arr.length}.<br>Next (#${arr.length+1}): <span class="ok">hold left button and start moving</span>; release at the end point.`));
  }, false);

  document.addEventListener('pointerlockchange', ()=>{
    if(!isMatchActive()) return;
    if(document.pointerLockElement !== lockTarget){
      if(match.recording){
        match.recording = false;
        detachMove();
        match.waitingPress = true;
        match.deltas = [];
        setStatus(tr('状态：<span class="warn">已退出锁定（ESC）。</span>请重新点击开始测量。', 'Status: <span class="warn">Exited lock (ESC).</span> Please click Start again.'));
      }
    }
  });

  dpi1Input.addEventListener('input', updateResult);

  reset();
})();
