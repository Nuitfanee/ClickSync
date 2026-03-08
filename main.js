(() => {
  const AU=1000, AU_KM=149597870.7, TIME_SCALE=10, TWO_PI=Math.PI*2;
  const MIN_ZOOM=0.01, MAX_ZOOM=200, G=6.67430e-11, DEG=Math.PI/180;
  const IS_MOBILE = (innerWidth < 900) && ("ontouchstart" in window || navigator.maxTouchPoints > 0);



  const canvas=document.getElementById("sim-canvas");
  const ctx=canvas.getContext("2d");
  const MAX_DPR = IS_MOBILE ? 1.25 : 1.8;
  let W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,MAX_DPR);
  function resize(){
    DPR=Math.min(window.devicePixelRatio||1,MAX_DPR);
    W=canvas.width=Math.floor(innerWidth*DPR);
    H=canvas.height=Math.floor(innerHeight*DPR);
    canvas.style.width=innerWidth+"px";
    canvas.style.height=innerHeight+"px";
    ctx.setTransform(1,0,0,1,0,0);
  }
  addEventListener("resize",resize);resize();

  
  const initialZoom = IS_MOBILE ? 0.30 : 0.18;

  const camera={
    x:0,y:0,
    zoom:initialZoom,
    target:null,
    desiredZoom:initialZoom,
    worldToScreen(wx,wy){return{x:(wx-this.x)*this.zoom+W/2,y:(wy-this.y)*this.zoom+H/2};},
    screenToWorld(sx,sy){return{x:(sx-W/2)/this.zoom+this.x,y:(sy-H/2)/this.zoom+this.y};}
  };

  function makeStars(n){
    const arr=[];
    for(let i=0;i<n;i++)arr.push({x:Math.random()*innerWidth,y:Math.random()*innerHeight,r:Math.random()*1.3+0.2,a:Math.random()*0.5+0.15});
    return arr;
  }
  const starLayers=[
    {depth:0.2,stars:makeStars(240)},
    {depth:0.5,stars:makeStars(180)},
    {depth:0.85,stars:makeStars(120)}
  ];

  let epochDays=0,simElapsedDays=0;
  const simDaysTotal=()=>epochDays+simElapsedDays;

  class Body{
    constructor(o){
      Object.assign(this,o);
      this.isBeltAsteroid=(o.type==="asteroid" && /^mba/.test(o.id));
      const beltMatch=this.isBeltAsteroid?(/^mba(\d+)$/.exec(o.id)||null):null;
      this.isIntroBeltSample=!!(beltMatch && (parseInt(beltMatch[1],10)%6===0));
      this.orientRad=((o.lonNodeDeg||0)+(o.argPeriDeg||0))*DEG;
      this.M0=(o.meanAnomaly0Deg!=null?o.meanAnomaly0Deg*DEG:Math.random()*TWO_PI);
      this.angle0=this.M0;
      this.dist=0;this.x=0;this.y=0;this.spinAngle=Math.random()*TWO_PI;
      this.children=[];this._tex=null;
    }
    update(totalDays,byId){
      const parent=this.parentId?byId.get(this.parentId):null;
      if(!parent){this.x=0;this.y=0;return;}
      const omega=TWO_PI/(this.orbitalPeriodDays||1e9);
      const isMoon=this.type==="moon";
      const moonScale=(isMoon && parent.moonVizScale)?parent.moonVizScale:1;
      if(this.orbitMode==="ellipse"){
        const e=this.eccentricity??0;
        const aAUphys=(this.aAU ?? (this.aKm?this.aKm/AU_KM:0))||0;
        const aAUviz=aAUphys*(isMoon?moonScale:1);
        const M=(this.M0+omega*totalDays)%TWO_PI;
        let E=M;
        for(let i=0;i<6;i++){
          const f=E-e*Math.sin(E)-M;
          const fp=1-e*Math.cos(E);
          E-=f/fp;
        }
        const cosE=Math.cos(E),sinE=Math.sin(E);
        const ftrue=Math.atan2(Math.sqrt(1-e*e)*sinE,cosE-e);
        const rNorm=(1-e*e)/(1+e*Math.cos(ftrue));
        const rAUviz=aAUviz*rNorm;
        const theta=ftrue+this.orientRad;
        this.dist=rAUviz*AU;
        this.x=parent.x+this.dist*Math.cos(theta);
        this.y=parent.y+this.dist*Math.sin(theta);
      }else{
        const baseAU=this.vizDistAU ?? this.aAU ?? (this.aKm?this.aKm/AU_KM:0);
        const aAUviz=baseAU*(isMoon?moonScale:1);
        const ang=(this.angle0+omega*totalDays)%TWO_PI;
        const theta=ang+this.orientRad;
        this.dist=aAUviz*AU;
        this.x=parent.x+this.dist*Math.cos(theta);
        this.y=parent.y+this.dist*Math.sin(theta);
      }
      if(!this.tidallyLocked && this.rotationPeriodHours){
        const spinOmega=TWO_PI/(Math.abs(this.rotationPeriodHours)/24);
        const dir=this.rotationPeriodHours<0?-1:1;
        this.spinAngle=(this.spinAngle+spinOmega*(totalDays-(this._lastDays||0))*dir)%TWO_PI;
      }else if(this.tidallyLocked && parent){
        this.spinAngle=Math.atan2(parent.y-this.y,parent.x-this.x);
      }
      this._lastDays=totalDays;
    }
  }

  // --- Perlin + fBM 噪声 ---
  const Noise=window.Noise;

  const bodies=(window.BODY_DEFS||[]).map(o=>new Body(o));

  const byId=new Map(bodies.map(b=>[b.id,b]));
  bodies.forEach(b=>{if(b.parentId&&byId.has(b.parentId))byId.get(b.parentId).children.push(b);});
  byId.get("earth").moonVizScale=12;
  byId.get("mars").moonVizScale=420;
  byId.get("jupiter").moonVizScale=22;
  byId.get("saturn").moonVizScale=28;
  byId.get("uranus").moonVizScale=18;
  byId.get("neptune").moonVizScale=22;
  byId.get("pluto").moonVizScale=60;

  const TEX={};
  const hex2rgb=hex=>{
    const c=parseInt(hex.slice(1),16);
    return[(c>>16)&255,(c>>8)&255,c&255];
  };

  /* 带更多“特色”的行星纹理 */
  function genPlanetTex(size,type,colorPalette,opts={}){
    const c=document.createElement("canvas");
    c.width=c.height=size;
    const g=c.getContext("2d");
    const img=g.createImageData(size,size);
    const d=img.data;
    const rHalf=size/2;

    for(let y=0;y<size;y++){
      for(let x=0;x<size;x++){
        const dx=(x-rHalf)/rHalf;
        const dy=(y-rHalf)/rHalf;
        const dist=dx*dx+dy*dy;
        if(dist>=1)continue;
        const z=Math.sqrt(1-dist);
        const nx=dx,ny=dy,nz=z;

        let r=0,gc=0,bc=0;

        if(type==="earth"){
          let n=Noise.fbm(nx*2.5,ny*2.5,nz*2.5,6);
          let oceanMask=n>0.05?1:0;
          if(oceanMask){
            let veg=Noise.fbm(nx*9,ny*9,nz*9,4);
            r=35+veg*35;gc=105+veg*90;bc=40+veg*25;
          }else{
            let depth=n+0.5;
            r=8;gc=35*depth;bc=85+110*depth;
          }
          let cloud=Noise.fbm(nx*3+100,ny*3,nz*3,5);
          if(cloud>0.43){
            let cVal=(cloud-0.43)*2.0*255;
            r=cVal;gc=cVal;bc=cVal;
          }
        }else if(type==="gas"){
          let baseLatFreq=opts.kind==="neptune"||opts.kind==="uranus"?6:10;
          let turb=Noise.fbm(nx*2,ny*baseLatFreq,nz*2,5);
          let band=Math.sin(ny*baseLatFreq+turb*3);
          let t=(band+1)/2;
          const c1=colorPalette[0],c2=colorPalette[1];
          r=c1[0]*(1-t)+c2[0]*t;
          gc=c1[1]*(1-t)+c2[1]*t;
          bc=c1[2]*(1-t)+c2[2]*t;


          if(opts.kind==="saturn"){
            const inner=Math.abs(ny);
            const ringBand=Math.max(0,1-inner*4);
            const boost=ringBand*0.2;
            r*=1+boost;gc*=1+boost;bc*=1+boost;
          }
        }else if(type==="rock"){
          let n=Noise.fbm(nx*4,ny*4,nz*4,5);
          let t=(n+1)/2;
          const c1=colorPalette[0],c2=colorPalette[1];
          r=c1[0]*(1-t)+c2[0]*t;
          gc=c1[1]*(1-t)+c2[1]*t;
          bc=c1[2]*(1-t)+c2[2]*t;

          if(opts.kind==="mars"){
            const absLat=Math.abs(ny);
            if(absLat>0.75){
              const cap=(absLat-0.75)/0.25;
              const mix=Math.min(1,cap+0.2);
              const wr=240, wg=240, wb=240;
              r=r*(1-mix)+wr*mix;
              gc=gc*(1-mix)+wg*mix;
              bc=bc*(1-mix)+wb*mix;
            }else{
              let dark=Noise.fbm(nx*7,ny*7,nz*7,4);
              if(dark>0.45){
                const k=0.75;
                r*=k;gc*=k;bc*=k;
              }
            }
          }else if(opts.kind==="mercury"){
            let crater=Noise.fbm(nx*20+50,ny*20-30,nz*20,3);
            if(crater>0.40){
              const f=0.4+(crater-0.4)*0.6;
              r*=f;gc*=f;bc*=f;
            }
          }else if(opts.kind==="pluto"){
            let patch=Noise.fbm(nx*5+30,ny*5-10,nz*5,5);
            const t2=(patch+1)/2;
            if(t2>0.62){
              const mix=t2;
              const br=245,bg=235,bb=225;
              r=r*(1-mix)+br*mix;
              gc=gc*(1-mix)+bg*mix;
              bc=bc*(1-mix)+bb*mix;
            }
          }
        }

        const idx=(y*size+x)*4;
        d[idx]=r;d[idx+1]=gc;d[idx+2]=bc;d[idx+3]=255;
      }
    }
    g.putImageData(img,0,0);

    const lg=g.createRadialGradient(size*0.18,size*0.18,size*0.1,size/2,size/2,size/1.2);
    lg.addColorStop(0,"rgba(255,255,255,0.2)");
    lg.addColorStop(1,"rgba(0,0,0,0.75)");
    g.fillStyle=lg;
    g.fillRect(0,0,size,size);

    return c;
  }

  const PLANET_TEX_SIZE = IS_MOBILE ? 112 : 160;
  const PLANET_TEX_SPECS={
    mercury:{type:"rock",palette:[hex2rgb("#8c8c94"),hex2rgb("#5e5e63")],opts:{kind:"mercury"}},
    venus:{type:"gas",palette:[hex2rgb("#e6c288"),hex2rgb("#d4a355")],opts:{kind:"venus"}},
    earth:{type:"earth",palette:null,opts:{kind:"earth"}},
    mars:{type:"rock",palette:[hex2rgb("#c1440e"),hex2rgb("#8a3213")],opts:{kind:"mars"}},
    jupiter:{type:"gas",palette:[hex2rgb("#c7b68b"),hex2rgb("#9c7c54")],opts:{kind:"jupiter"}},
    saturn:{type:"gas",palette:[hex2rgb("#ead6b8"),hex2rgb("#cba878")],opts:{kind:"saturn"}},
    uranus:{type:"gas",palette:[hex2rgb("#d1f5f7"),hex2rgb("#80d4db")],opts:{kind:"uranus"}},
    neptune:{type:"gas",palette:[hex2rgb("#4b70dd"),hex2rgb("#2848a8")],opts:{kind:"neptune"}},
    pluto:{type:"rock",palette:[hex2rgb("#daccba"),hex2rgb("#a89a8a")],opts:{kind:"pluto"}}
  };
  function assignPlanetTex(id,tex){
    if(!tex)return;
    TEX[id]=tex;
    bodies.forEach(b=>{if(b.id===id)b._tex=tex;});
  }
  function buildPlanetTex(id,size=PLANET_TEX_SIZE){
    const spec=PLANET_TEX_SPECS[id];
    if(!spec)return null;
    return genPlanetTex(size,spec.type,spec.palette,spec.opts);
  }
  const BAKED_TEX_DATA=(window.__BAKED_PLANET_TEX||{});
  function loadBakedTex(id){
    const data=BAKED_TEX_DATA[id];
    if(!data) return false;
    const img=new Image();
    img.decoding="async";
    img.onload=()=>assignPlanetTex(id,img);
    img.src=data;
    return true;
  }
  ["earth","mars","jupiter"].forEach(loadBakedTex);

  const textureWarmupQueue=["mercury","venus","saturn","uranus","neptune","pluto"];
  let textureWarmupStarted=false;
  const queueTextureWarmup = cb => {
    if(typeof window.requestIdleCallback === "function"){
      window.requestIdleCallback(cb,{timeout:240});
      return;
    }
    setTimeout(()=>cb({didTimeout:true,timeRemaining:()=>0}),90);
  };
  function warmupPlanetTextures(){
    if(textureWarmupStarted)return;
    textureWarmupStarted=true;
    const runNext=()=>{
      while(textureWarmupQueue.length && TEX[textureWarmupQueue[0]])textureWarmupQueue.shift();
      if(!textureWarmupQueue.length)return;
      const id=textureWarmupQueue.shift();
      assignPlanetTex(id,buildPlanetTex(id));
      if(textureWarmupQueue.length)queueTextureWarmup(runNext);
    };
    queueTextureWarmup(runNext);
  }

  // === 烘焙贴图数据已拆分到 baked_tex_*.js：运行时不加载参考图 ===
  /*
  const BAKED_TEX_DATA=(window.__BAKED_PLANET_TEX||{});
  function loadBakedTex(id){
    const data=BAKED_TEX_DATA[id];
    if(!data) return;
    const img=new Image();
    img.decoding="async";
    img.src=data;
    img.onload=()=>{
      TEX[id]=img;
      // 热替换到实体上
      bodies.forEach(b=>{ if(b.id===id) b._tex=img; });
    };
  }
  loadBakedTex("earth");
  loadBakedTex("mars");
  loadBakedTex("jupiter");
  loadBakedTex("mercury");
  loadBakedTex("venus");
  loadBakedTex("moon");
  */


  const NAV_ORDER=[
    "sun","mercury","venus","earth","mars","jupiter","saturn","uranus","neptune","pluto",
    "ceres","vesta","pallas","hygiea","haumea","makemake","eris",
    "halley","encke","tempel1","67p","swift-tuttle","hale-bopp"
  ];
  const typeSym={star:"◎",planet:"●",moon:"○",dwarf:"◇",asteroid:"◆",comet:"☄"};
  const navlist=document.getElementById("navlist");
  function makeNav(){
    navlist.innerHTML="";
    const MOON_ORDER={
      earth:["moon"],
      mars:["phobos","deimos"],
      jupiter:["io","europa","ganymede","callisto","himalia"],
      neptune:["triton","nereid"],
      pluto:["charon"]
    };
    const makeItem=(b,isChild=false)=>{
      const d=document.createElement("div");
      d.className="navitem aberr"+(isChild?" child":"");
      d.dataset.id=b.id;
      if(isChild)d.dataset.parent=b.parentId||"";
      d.innerHTML=`<div class="navsym">${typeSym[b.type]||"●"}</div>
      <div class="navnames"><div class="cn">${b.name}</div><div class="en">${b.enName}</div></div>`;
      d.onclick=()=>lockTarget(b);
      return d;
    };

    NAV_ORDER.forEach(id=>{
      const b=byId.get(id);if(!b)return;
      navlist.appendChild(makeItem(b,false));

      // 二级导航：仅对拥有卫星的行星/矮行星展开
      if((b.type==="planet"||b.type==="dwarf") && b.children && b.children.length){
        const wrap=document.createElement("div");
        wrap.className="navchildren";

        const order=MOON_ORDER[b.id] || b.children.map(c=>c.id);
        order.forEach(cid=>{
          const c=byId.get(cid) || b.children.find(x=>x.id===cid);
          if(!c)return;
          wrap.appendChild(makeItem(c,true));
        });

        // 如果 order 列表没覆盖全部 children，把剩余的也补上（保证兼容后续增加卫星）
        b.children.forEach(c=>{
          if(order.includes(c.id))return;
          wrap.appendChild(makeItem(c,true));
        });

        navlist.appendChild(wrap);
      }
    });
  }
  makeNav();
  function updateNavActive(){
    document.querySelectorAll(".navitem").forEach(el=>{
      el.classList.toggle("active",camera.target && el.dataset.id===camera.target.id);
    });
  }

  const readout=document.getElementById("readout");
  const childrenBox=document.getElementById("children");
  const targetText=document.getElementById("targetText");
  const fmt=(n,d=3)=>{
    if(n==null||Number.isNaN(n))return"--";
    if(Math.abs(n)>=10000)return n.toExponential(2);
    return n.toFixed(d);
  };
  function updateTelemetry(b){
    if(!b){
      readout.innerHTML=`<div class="k">TARGET</div><div>NONE</div>`;
      childrenBox.innerHTML="";targetText.textContent="NONE";return;
    }
    targetText.textContent=b.enName;
    const aAU=b.aAU ?? (b.aKm?b.aKm/AU_KM:null);
    const e=b.eccentricity;
    const q=(aAU!=null&&e!=null)?aAU*(1-e):null;
    const Q=(aAU!=null&&e!=null)?aAU*(1+e):null;
    let vOrbit=null,meanMotion=null;
    if(aAU!=null&&b.orbitalPeriodDays){
      const aKm=aAU*AU_KM;
      const T=b.orbitalPeriodDays*86400;
      vOrbit=2*Math.PI*aKm/T/1000;
      meanMotion=360/b.orbitalPeriodDays;
    }
    let gSurf=null,vEsc=null;
    if(b.mass10e24kg!=null&&b.radiusKm){
      const M=b.mass10e24kg*1e24;
      const R=b.radiusKm*1000;
      gSurf=G*M/(R*R);
      vEsc=Math.sqrt(2*G*M/R)/1000;
    }
    const sun=byId.get("sun");
    const rAUcur=Math.hypot(b.x-sun.x,b.y-sun.y)/AU;
    const rKmcur=rAUcur*AU_KM;

    const rows=[
      ["TARGET",`${b.name} / ${b.enName}`],
      ["DESIGNATION",b.id.toUpperCase()],
      ["TYPE",b.type.toUpperCase()],
      ["EPOCH (days)",`T${simDaysTotal()>=0?"+":""}${Math.round(simDaysTotal())} d`],
      ["CURRENT r",`${fmt(rAUcur,4)}AU/${fmt(rKmcur,2)}km`],
      ["SEMIMAJOR AXIS a",aAU!=null?`${fmt(aAU,4)} AU`:"--"],
      ["ECCENTRICITY e",e!=null?fmt(e,4):"--"],
      ["PERIHELION q",q!=null?`${fmt(q,4)} AU`:"--"],
      ["APHELION Q",Q!=null?`${fmt(Q,4)} AU`:"--"],
      ["ORBITAL PERIOD",b.orbitalPeriodDays?`${fmt(b.orbitalPeriodDays,2)} d`:"--"],
      ["MEAN MOTION n",meanMotion!=null?`${fmt(meanMotion,3)} °/day`:"--"],
      ["MEAN ORBIT SPEED",vOrbit!=null?`${fmt(vOrbit,2)} km/s`:"--"],
      ["ROTATION PERIOD",b.rotationPeriodHours!=null?`${fmt(b.rotationPeriodHours,2)} h`:"--"],
      ["INCLINATION i",b.inclinationDeg!=null?`${fmt(b.inclinationDeg,2)} °`:"--"],
      ["Ω (node)",b.lonNodeDeg!=null?`${fmt(b.lonNodeDeg,2)} °`:"--"],
      ["ω (peri)",b.argPeriDeg!=null?`${fmt(b.argPeriDeg,2)} °`:"--"],
      ["EQUATORIAL RADIUS",b.radiusKm?`${fmt(b.radiusKm,1)} km`:"--"],
      ["MASS",b.mass10e24kg!=null?`${fmt(b.mass10e24kg,5)} ×10^24 kg`:"--"],
      ["SURFACE GRAVITY",gSurf!=null?`${fmt(gSurf,2)} m/s²`:"--"],
      ["ESCAPE VELOCITY",vEsc!=null?`${fmt(vEsc,2)} km/s`:"--"],
      ["MEAN TEMP",b.meanTempK!=null?`${fmt(b.meanTempK,1)} K`:"--"],
      ["TIDAL STATE",b.tidallyLocked?"LOCKED":"FREE"],
      ["CHILD COUNT",b.children?b.children.length:0],
    ];
    readout.innerHTML=rows.map(r=>`<div class="k">${r[0]}</div><div>${r[1]}</div>`).join("");
    childrenBox.innerHTML="";
    if(b.children && b.children.length){
      b.children.forEach(c=>{
        const div=document.createElement("div");
        div.className="child aberr";
        div.textContent=`${typeSym[c.type]||"○"} ${c.name} / ${c.enName}`;
        childrenBox.appendChild(div);
      });
    }else{
      childrenBox.innerHTML=`<div class="child dim">-- NO CHILDREN --</div>`;
    }
  }

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
  const lerp=(a,b,t)=>a+(b-a)*t;
  const easeInOutCubic=t=>t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
  const easeInOutSine=t=>-(Math.cos(Math.PI*t)-1)/2;

  const speedSlider=document.getElementById("speedSlider");
  const speedValue=document.getElementById("speedValue");
  const epochSlider=document.getElementById("epochSlider");
  const epochValue=document.getElementById("epochValue");
  const zoomTrack=document.getElementById("zoomTrack");
  const zoomThumb=document.getElementById("zoomThumb");
  const zoomText=document.getElementById("zoomText");
  const uiRoot=document.querySelector(".ui");

  function setSpeed(v){
    speedSlider.value=v.toFixed(2);
    speedValue.textContent=`${v.toFixed(2)}x`;
  }
  function updateEpochUI(){
    epochDays=parseFloat(epochSlider.value);
    simElapsedDays=0;
    epochValue.textContent=`T${epochDays>=0?"+":""}${Math.round(epochDays)} d`;
    updateTelemetry(camera.target);
  }
  epochSlider.addEventListener("input",updateEpochUI);updateEpochUI();
  speedSlider.addEventListener("input",()=>{speedValue.textContent=`${parseFloat(speedSlider.value).toFixed(2)}x`;});

  let barDragging=false;
  const zoomFromNorm=t=>{
    const minL=Math.log(MIN_ZOOM),maxL=Math.log(MAX_ZOOM);
    return Math.exp(minL+(maxL-minL)*t);
  };
  const normFromZoom=z=>{
    const minL=Math.log(MIN_ZOOM),maxL=Math.log(MAX_ZOOM);
    return (Math.log(z)-minL)/(maxL-minL);
  };
  const positionThumb=t=>{
    const r=zoomTrack.getBoundingClientRect();
    zoomThumb.style.left=(r.width*t)+"px";
  };
  const setZoomNorm=t=>{
    t=clamp(t,0,1);
    camera.zoom=zoomFromNorm(t);
    camera.desiredZoom=camera.zoom;
    camera.target=null;
    positionThumb(t);
  };
  const syncZoomBarFromCamera=()=>positionThumb(normFromZoom(camera.zoom));
  syncZoomBarFromCamera();
  zoomThumb.addEventListener("pointerdown",e=>{barDragging=true;zoomThumb.setPointerCapture(e.pointerId);});
  window.addEventListener("pointermove",e=>{
    if(!barDragging)return;
    const r=zoomTrack.getBoundingClientRect();
    setZoomNorm((e.clientX-r.left)/r.width);
  });
  window.addEventListener("pointerup",()=>barDragging=false);
  zoomTrack.addEventListener("pointerdown",e=>{
    const r=zoomTrack.getBoundingClientRect();
    setZoomNorm((e.clientX-r.left)/r.width);
  });
  const updateZoomText=()=>{zoomText.textContent=`${(camera.zoom*100).toFixed(0)}%`;};

  function fitZoomForMoons(parent){
    if(!parent||!parent.children||!parent.children.length)return null;
    let maxAU=0;
    parent.children.forEach(m=>{
      const aAUphys=m.aAU ?? m.vizDistAU ?? (m.aKm?m.aKm/AU_KM:0);
      if(!aAUphys)return;
      const e=m.eccentricity??0;
      const rAUphysMax=aAUphys*(m.orbitMode==="ellipse"?(1+e):1);
      const scale=parent.moonVizScale||1;
      const rAUvizMax=rAUphysMax*scale;
      if(rAUvizMax>maxAU)maxAU=rAUvizMax;
    });
    if(maxAU<=0)return null;
    const Rworld=maxAU*AU;
    const viewRadiusPx=Math.min(W,H)*0.55;
    let fitZoom=viewRadiusPx/Rworld;
    return clamp(fitZoom,MIN_ZOOM,MAX_ZOOM);
  }
  function desiredZoomFor(b){
    if(!b)return camera.zoom;
    // 特殊需求：点击水星/金星时，放大到 1500%
    if(b.id==="mercury"||b.id==="venus")return 15.0;
    // 特殊需求：点击月球 → 放大到 5400%
    if(b.id==="moon")return 54.0;
    if(b.type==="planet"||b.type==="dwarf"){
      const fit=fitZoomForMoons(b);
      if(fit!=null){
        // 特殊处理：地球木星土星缩小一点，保证能看到整条月轨
        if(b.id==="earth")return fit*0.72;
	if(b.id==="jupiter")return fit*1.3;
	if(b.id==="saturn")return fit*1.2;
        if(b.id==="neptune")return fit*3;
        return fit;
      }
    }
    if(b.type==="star")return 0.2;
    if(b.type==="comet")return 2.0;
    if(b.type==="planet"||b.type==="dwarf")return 4.5;
    return 5.0;
  }
  function autoSpeedForTarget(b){
    // 1. 点击太阳 → 速度固定为 1.0x
    if (b.id === "sun") {
      setSpeed(1.0);
      return;
    }

    // 特殊需求：点击水星/金星 → 速度固定为 0.05x
    if (b.id === "mercury" || b.id === "venus") {
      setSpeed(0.05);
      return;
    }

    // 特殊需求：点击月球 → 速度固定为 0.04x
    if (b.id === "moon") {
      setSpeed(0.03);
      return;
    }

    // 特殊需求：点击火卫一/火卫二 → 速度固定为 0.01x
    if (b.id === "phobos" || b.id === "deimos") {
      setSpeed(0.01);
      return;
    }

    // 2. 点击其他没有卫星的天体 → 速度固定为 0.1x
    if (!b.children || b.children.length === 0) {
      setSpeed(0.01);
      return;
    }

    // 3. 其他有卫星的天体 → 使用原来的自动速度算法
    const minP = b.children.reduce((m, c) => Math.min(m, c.orbitalPeriodDays || 1e9), 1e9);
    if (!isFinite(minP)) return;

    const desiredDaysPerSec = minP / 20;
    let speed = desiredDaysPerSec / TIME_SCALE;

    speed = clamp(speed, 0.01, 1.5);
    setSpeed(speed);
  }
  function lockTarget(b){
    camera.target=b;
    camera.desiredZoom=desiredZoomFor(b);
    autoSpeedForTarget(b);
    updateTelemetry(b);
    updateNavActive();
  }

  let userInteracted=false;
  let dragging=false,dragStart=null,camStart=null,moved=false;

  function closeAllDrawers(){
    document.getElementById("nav").classList.remove("open");
    document.getElementById("telemetry").classList.remove("open");
    document.getElementById("controls").classList.remove("open");
    document.getElementById("btnNav")?.classList.remove("active");
    document.getElementById("btnTel")?.classList.remove("active");
    document.getElementById("btnCtl")?.classList.remove("active");
  }

  const introOverlay=document.getElementById("introOverlay");
  const introCaption=document.getElementById("introCaption");
  const capMain=document.getElementById("capMain");
  const capSub=document.getElementById("capSub");
  const capSub2=document.getElementById("capSub2");

  const introDust=Array.from({length:220},()=>({
    x:(Math.random()-0.5)*AU*8,
    y:(Math.random()-0.5)*AU*2,
    s:0.6+Math.random()*1.8
  }));

  const introBgm = new Audio("kplbgm.mp3");
  introBgm.preload = "auto";
  introBgm.loop = false;

  const intro={
    active:false,
    built:false,
    time:0,
    shots:[],
    bgm:introBgm, 
    useAudioClock:true,
    fadeOutSec:2.0,
    _baseVol:1.0,
    _fadingOut:false,
    audioPrimed:false,
    focusBand:"inner",
    currentBody:null,
    captionAlpha:0,
    unskippableUntil:5.0,
    skipMode:false,
    skipTime:0,
    skipStartCam:null,
    finalShot:null,
    camTx:0,camTy:0,camTz:0,
    _captionIndex:-1,

    build(){
      if(this.built)return;
      this.built=true;
      const s=byId.get("sun"),me=byId.get("mercury"),ve=byId.get("venus"),
            ea=byId.get("earth"),ma=byId.get("mars"),ju=byId.get("jupiter"),
            sa=byId.get("saturn"),ur=byId.get("uranus"),ne=byId.get("neptune"),
            pl=byId.get("pluto"),ha=byId.get("halley");
      const beltPos={x:AU*2.8,y:AU*0.35};

      this.shots=[

        {focusId:null,band:"all",pos:{x:s.x,y:s.y,zoom:0.11},travel:0.0,hold:3.0,
        cap:"太阳系 / SOLAR SYSTEM",sub:"FULL SYSTEM ARRAY",sub2:"PLANETS, BELTS, AND PATHS AROUND THE SUN"},

        {focusId:"sun",band:"inner",pos:{x:s.x,y:s.y,zoom:1.7},travel:2.5,hold:2.2,
        cap:"太阳 / SUN",sub:"PHOTOSPHERE GLARE",sub2:"99.8% OF THE SYSTEM’S MASS"},

        {focusId:"mercury",band:"inner",pos:{x:me.x,y:me.y,zoom:12.0},travel:0.1,hold:2.0,
        cap:"水星 / MERCURY",sub:"CRATERED IRON WORLD",sub2:"CLOSEST TO THE SUN / EXTREME TEMPERATURES"},

        {focusId:"venus",band:"inner",pos:{x:ve.x,y:ve.y,zoom:12},travel:0.36,hold:2.2,
        cap:"金星 / VENUS",sub:"OPAQUE CLOUD SHELL",sub2:"RUNAWAY GREENHOUSE / CRUSHING AIR PRESSURE"},

        {focusId:"earth",band:"inner",pos:{x:ea.x,y:ea.y,zoom:12},travel:0.45,hold:2.5,
        cap:"地球 / EARTH",sub:"HABITABLE ZONE",sub2:"RIGHT DISTANCE FOR LIQUID WATER"},

        {focusId:"mars",band:"inner",pos:{x:ma.x,y:ma.y,zoom:16.0},travel:0.25,hold:2.5,
        cap:"火星 / MARS",sub:"POLAR DUST SEAS",sub2:"COLD DESERT / SIGNS OF ANCIENT WATER"},

        {focusId:null,band:"belt",pos:{x:beltPos.x,y:beltPos.y,zoom:1.22},travel:0.55,hold:2.2,
        cap:"主带小行星 / MAIN BELT",sub:"CERES / VESTA / PALLAS",sub2:"LEFTOVER BUILDING BLOCKS OF PLANETS"},

        {focusId:"jupiter",band:"outer",pos:{x:ju.x,y:ju.y,zoom:6.0},travel:0.35,hold:2.6,
        cap:"木星 / JUPITER",sub:"BANDS / GREAT RED SPOT",sub2:"BIGGEST PLANET / STORMS BIGGER THAN EARTH"},

        {focusId:"saturn",band:"outer",pos:{x:sa.x,y:sa.y,zoom:8},travel:0.1,hold:2.7,
        cap:"土星 / SATURN",sub:"RING PLANE",sub2:"RINGS ARE ICE AND ROCK, NOT SOLID"},

        {focusId:"halley",band:"outer",pos:{x:ha.x,y:ha.y,zoom:2.7},travel:0.15,hold:2.4,
        cap:"哈雷彗星 / HALLEY",sub:"COMETARY PASS",sub2:"A DIRTY SNOWBALL THAT GROWS A TAIL"},

        {focusId:"uranus",band:"outer",pos:{x:ur.x,y:ur.y,zoom:9},travel:0.15,hold:2.7,
        cap:"天王星 / URANUS",sub:"TILTED ICE GIANT",sub2:"SPINS ON ITS SIDE / LONG, STRANGE SEASONS"},

        {focusId:"neptune",band:"outer",pos:{x:ne.x,y:ne.y,zoom:8},travel:0.65,hold:2.6,
        cap:"海王星 / NEPTUNE",sub:"DEEP BLUE WINDS",sub2:"FARTHER MEANS COLDER / WINDS CAN GO SUPERSONIC"},

        {focusId:"pluto",band:"outer",pos:{x:pl.x,y:pl.y,zoom:9},travel:0.55,hold:2.7,
        cap:"冥王星 / PLUTO",sub:"KUIPER FRONTIER",sub2:"DWARF PLANET IN THE KUIPER BELT"},

        {focusId:null,band:"all",pos:{x:s.x,y:s.y,zoom:0.11},travel:2.8,hold:3.5,
        cap:"太阳系 / SOLAR SYSTEM",sub:"HELIOCENTRIC TERMINUS",sub2:"BACK TO THE BIG PICTURE"}

      ];


      // 找到哈雷彗星镜头索引（用于字幕节奏与阶段微调）
      this.halleyIndex = this.shots.findIndex(s=>s.focusId==="halley");


      // 让哈雷彗星之后的镜头“保持”略长一些（增加字幕可读时间）
      if(this.halleyIndex != null && this.halleyIndex >= 0){
        for(let i=this.halleyIndex+1;i<this.shots.length;i++){
          const sh=this.shots[i];
          // 仅拉长 hold，不改变 travel，避免镜头移动节奏被破坏
          const extra=Math.min(0.6, Math.max(0.25, (sh.hold||0)*0.18));
          sh.hold=(sh.hold||0)+extra;
        }
      }

      let t=0;
      this.shots.forEach((sh,i)=>{
        sh.index=i;
        sh.start=t;
        sh.travelEnd=t+sh.travel;
        sh.end=sh.travelEnd+sh.hold;
        t=sh.end;
      });
this.timelineLen=t;
      this.finalShot=this.shots[this.shots.length-1];
    },

    _kickBgmFromTimeline(){
      if(!this.bgm) return;
      try{
        // 若已能 seek，则让音频直接追上当前 intro 时间轴
        if(this.bgm.readyState >= 2){
          const t = Math.max(0, this.time||0);
          // 避免在某些浏览器频繁 seek
          if(Math.abs(this.bgm.currentTime - t) > 0.12){
            this.bgm.currentTime = t;
          }
        }
      }catch(e){}
      try{
        const p = this.bgm.play();
        if(p && typeof p.catch === "function"){
          p.catch(()=>{ /* 仍被策略拦截则静默 */ });
        }
      }catch(e){}
    },


    start(){
      this.build();
      this.active=true;
      this.time=0;
      this.skipMode=false;
      this.skipTime=0;
      this.captionAlpha=0;
      this.currentBody=null;
      this.focusBand="all";
      this.unskippableUntil=5.0;
      this._captionIndex=-1;
      setSpeed(0.25);
      camera.target=null;
      updateTelemetry(null);
      updateNavActive();

      // 摄像机初始位置
      const firstPos=this._getShotPos(this.shots[0]);
      camera.x=this.camTx=firstPos.x;
      camera.y=this.camTy=firstPos.y;
      camera.zoom=this.camTz=firstPos.zoom;
      syncZoomBarFromCamera();      // 播放 BGM（与 intro 同步启动）
      // 注意：移动端/部分浏览器会在无用户手势时拦截 autoplay，甚至延迟下载音频。
      // 为避免部署后卡死：intro 先照常推进时间轴；一旦用户产生手势，就把音频 seek 到当前时间轴并开始播放。
      if(this.bgm){
        try{
          this._fadingOut=false;
          this._baseVol=1.0;
          if(this.bgm.readyState===0)this.bgm.load();
          this.bgm.volume = this._baseVol;
          this.bgm.currentTime = 0;

          const markReady = () => { this.audioPrimed = true; };
          this.bgm.addEventListener("canplay", markReady, { once:true });
          this.bgm.addEventListener("canplaythrough", markReady, { once:true });

          const p = this.bgm.play();
          if(p && typeof p.catch === "function"){
            p.catch(()=>{
              // autoplay 被拦截：绑定一次性手势启动
              if(!this._gestureBound){
                this._gestureBound = true;
                const resume = () => this._kickBgmFromTimeline();
                window.addEventListener("pointerdown", resume, { once:true });
                window.addEventListener("keydown", resume, { once:true });
              }
            });
          }
        }catch(e){}
      }
      introOverlay.style.opacity=1;
      introCaption.style.opacity=0;
      uiRoot.classList.add("intro-hidden");
      uiRoot.classList.remove("intro-visible");
      document.body.classList.add("intro-active");
    },


    requestSkip(){
      if(!this.active||this.skipMode)return;
      if(this.time<this.unskippableUntil)return;
      this.skipMode=true;
      this.skipTime=0;
      this.skipStartCam={x:camera.x,y:camera.y,z:camera.zoom};
      capMain.textContent="SKIP TRANSITION";
      capSub.textContent="NAVIGATION OVERRIDE";
      capSub2.textContent="RETURN TO SYSTEM VIEW";
      introCaption.style.opacity=1;
      introOverlay.style.opacity=1;
      this.currentBody=null;
      this.focusBand="all";
    },

    finish(){
      this.active=false;
      this.currentBody=null;
      this.captionAlpha=0;
      introCaption.style.opacity=0;
      introOverlay.style.opacity=0;

      // 停止 BGM
      if(this.bgm){
        try{
          this.bgm.volume = 0;
          this.bgm.pause();
          this.bgm.currentTime = 0;
        }catch(e){}
      }

      setSpeed(1.0);
      camera.target=null;
      camera.desiredZoom=camera.zoom;
      syncZoomBarFromCamera();
      uiRoot.classList.remove("intro-hidden");
      uiRoot.classList.add("intro-visible");
      document.body.classList.remove("intro-active");
      try{localStorage.setItem("solarTapeIntroPlayed","1");}catch(e){}
    },

    update(dt){
      if(!this.active)return;

      // 时间轴默认按 dt 推进（保证任何环境都不会“卡死在 intro”）
      this.time += dt;

      // 若音频已在播放：用音频时间校准画面；若 autoplay 被拦截，则画面继续跑，等待用户手势启动音频
      if(this.useAudioClock && this.bgm){
        const ready = (this.bgm.readyState >= 2); // HAVE_CURRENT_DATA
        if(ready){
          // 音频已播放时：用音频作为主时钟，并处理可能的微小漂移
          if(!this.bgm.paused){
            const drift = this.time - this.bgm.currentTime;
            if(Math.abs(drift) > 0.12){
              try{ this.bgm.currentTime = Math.max(0, this.time); }catch(e){}
            }
            this.time = this.bgm.currentTime;
          }
        }
      }

      // 结尾 2s 音量渐出（自然播放结束）
      if(!this.skipMode && this.bgm){
        const fade = this.fadeOutSec || 2.0;
        const base = (this._baseVol==null?1.0:this._baseVol);
        const rem = (this.timelineLen||0) - (this.time||0);
        const k = clamp(rem / fade, 0, 1);
        this.bgm.volume = base * k;
      }


      if(this.skipMode){
        const dur=3.0;
        this.skipTime+=dt;

        // skip 过渡末尾也做音量渐出
        if(this.bgm){
          const fade = this.fadeOutSec || 2.0;
          const base = (this._baseVol==null?1.0:this._baseVol);
          const rem = dur - this.skipTime;
          const k = clamp(rem / fade, 0, 1);
          this.bgm.volume = base * k;
        }
        const t=clamp(this.skipTime/dur,0,1);
        const e=easeInOutCubic(t);
        const dPos=this._getShotPos(this.finalShot);
        this.camTx=lerp(this.skipStartCam.x,dPos.x,e);
        this.camTy=lerp(this.skipStartCam.y,dPos.y,e);
        this.camTz=lerp(this.skipStartCam.z,dPos.zoom,e);
        this.captionAlpha=1-t;
        this.currentBody=null;
        this.focusBand="all";
        introCaption.style.opacity=this.captionAlpha.toFixed(3);
        setSpeed(0.4);
        if(t>=1)this.finish();
        return;
      }

      const t=this.time;
      let shot=this.shots[this.shots.length-1];
      for(let i=0;i<this.shots.length;i++){
        const sh=this.shots[i];
        if(t>=sh.start && t<=sh.end){shot=sh;break;}
      }
      const prev=shot.index>0?this.shots[shot.index-1]:shot;
      const prevPos=this._getShotPos(prev);
      const curPos=this._getShotPos(shot);

      let rawX,rawY,rawZ;
      if(t<shot.travelEnd && shot.travel>0){
        const lt=clamp((t-shot.start)/shot.travel,0,1);
        const e=easeInOutSine(lt);
        rawX=lerp(prevPos.x,curPos.x,e);
        rawY=lerp(prevPos.y,curPos.y,e);
        rawZ=lerp(prevPos.zoom,curPos.zoom,e);
      }else{
        rawX=curPos.x;rawY=curPos.y;rawZ=curPos.zoom;
      }
      this.camTx=rawX;this.camTy=rawY;this.camTz=rawZ;
      this.focusBand=shot.band||"all";

      const holdDuration=shot.hold;
      const holdStart=shot.travelEnd;
      const holdEnd=shot.end;
      const tLocalHold=t-holdStart;
      let alpha=0;
      if(t>=holdStart && t<=holdEnd && holdDuration>0.1){
        // 字幕节奏控制：
// - 哈雷彗星之前：字幕也略微延后，避免镜头未收敛就抢跑
// - 哈雷彗星之后：字幕更晚出现、渐入更慢（并配合 hold 拉长增加可读时间）
        const slowCaptions = (this.halleyIndex != null && this.halleyIndex >= 0 && shot.index > this.halleyIndex);
        const preHalleySlightDelay = (this.halleyIndex != null && this.halleyIndex >= 0 && shot.index > 0 && shot.index <= this.halleyIndex);

        let captionDelay = 0;
        let fadeInDur = Math.min(0.8, holdDuration*0.45);
        let fadeOutDur = Math.min(0.6, holdDuration*0.35);

        if(preHalleySlightDelay){
          captionDelay = Math.min(0.18, holdDuration*0.08);
        }

        if(slowCaptions){
          captionDelay = Math.min(0.55, holdDuration*0.22);
          fadeInDur = Math.min(1.25, holdDuration*0.62);
          fadeOutDur = Math.min(0.65, holdDuration*0.30);
        }

        // 把 delay 也算进去，确保总和不超过 holdDuration
        const total = captionDelay + fadeInDur + fadeOutDur;
        if(total > holdDuration){
          const scale = holdDuration / total;
          captionDelay *= scale;
          fadeInDur *= scale;
          fadeOutDur *= scale;
        }

        const plateauEnd = holdDuration - fadeOutDur;
        const plateauEndCaption = plateauEnd - captionDelay;
        const tCaption = tLocalHold - captionDelay;

        if(tCaption <= 0){
          alpha = 0;
        }else if(tCaption < fadeInDur){
          alpha = easeInOutCubic(clamp(tCaption / fadeInDur, 0, 1));
        }else if(tCaption < plateauEndCaption){
          alpha = 1;
        }else{
          const tt = (tCaption - plateauEndCaption) / fadeOutDur;
          alpha = 1 - easeInOutCubic(clamp(tt, 0, 1));
        }
      }else{
        alpha=0;
      }
      this.captionAlpha=alpha;
      introCaption.style.opacity=this.captionAlpha.toFixed(3);

      if(alpha>0.02){
        if(this._captionIndex!==shot.index){
          capMain.textContent=shot.cap||"";
          capSub.textContent=shot.sub||"";
          capSub2.textContent=shot.sub2||"";
          this._captionIndex=shot.index;
        }
        this.currentBody=shot.focusId?byId.get(shot.focusId):null;
      }else{
        this.currentBody=null;
      }

      setSpeed(0.25);
      if(t>=this.timelineLen-0.01)this.finish();
    },

    _getShotPos(sh){
      const sun=byId.get("sun");

      // 🔹基础 zoom
      const baseZoom = sh.pos.zoom;
      // 🔹手机端整体放大一点，让行星更大
      const zoom = IS_MOBILE ? baseZoom * 1.5 : baseZoom;

      if(sh.focusId){
        const b=byId.get(sh.focusId);if(b)return{x:b.x,y:b.y,zoom};
      }
      if(sh.band==="belt")return{x:AU*2.8,y:AU*0.35,zoom};
      return{x:sun.x,y:sun.y,zoom};
    }
  };

  const introDustArr=introDust;
  function drawIntroVFX(){
    if(!intro.active)return;
    ctx.save();ctx.setTransform(1,0,0,1,0,0);

    if(intro.focusBand==="belt"){
      const cx=W/2,cy=H/2;
      ctx.globalAlpha=0.22;
      introDustArr.forEach(d=>{
        const px=cx+(d.x-camera.x)*camera.zoom*0.12;
        const py=cy+(d.y-camera.y)*camera.zoom*0.12;
        const r=d.s*DPR*(0.6+camera.zoom*0.04);
        if(px<-50||px>W+50||py<-50||py>H+50)return;
        ctx.fillStyle="rgba(255,255,255,0.8)";
        ctx.beginPath();ctx.arc(px,py,r,0,TWO_PI);ctx.fill();
      });
      ctx.globalAlpha=1;
    }
    if(intro.currentBody && intro.currentBody.type==="comet"){
      const b=intro.currentBody;
      const p=camera.worldToScreen(b.x,b.y);
      ctx.globalAlpha=0.20;
      const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,220*DPR);
      g.addColorStop(0,"rgba(255,210,140,0.55)");
      g.addColorStop(1,"rgba(255,210,140,0)");
      ctx.fillStyle=g;
      ctx.beginPath();ctx.arc(p.x,p.y,220*DPR,0,TWO_PI);ctx.fill();
      ctx.globalAlpha=1;
    }
    if(intro.focusBand==="inner"||intro.focusBand==="all"){
      const sun=byId.get("sun");
      const p=camera.worldToScreen(sun.x,sun.y);
      const pulse=(Math.sin(performance.now()/1000*1.4)+1)/2;
      const radius=480;
      ctx.globalAlpha=0.10+0.18*pulse;
      const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,radius*DPR);
      g.addColorStop(0,"rgba(255,176,0,0.9)");
      g.addColorStop(0.45,"rgba(255,176,0,0.22)");
      g.addColorStop(1,"rgba(255,176,0,0)");
      ctx.fillStyle=g;
      ctx.beginPath();ctx.arc(p.x,p.y,radius*DPR,0,TWO_PI);ctx.fill();
      ctx.globalAlpha=1;
    }
    ctx.restore();
  }

  function tryInterruptIntro(){
    if(!intro.active)return false;
    intro.requestSkip();
    return true;
  }

  canvas.addEventListener("pointerdown",e=>{
    userInteracted=true;
    if(tryInterruptIntro())return;
    closeAllDrawers();
    dragging=true;moved=false;canvas.setPointerCapture(e.pointerId);
    dragStart={x:e.clientX,y:e.clientY};camStart={x:camera.x,y:camera.y};
  });
  canvas.addEventListener("pointermove",e=>{
    if(!dragging||intro.active)return;
    const dx=e.clientX-dragStart.x,dy=e.clientY-dragStart.y;
    if(Math.hypot(dx,dy)>2)moved=true;
    camera.x=camStart.x-dx*DPR/camera.zoom;
    camera.y=camStart.y-dy*DPR/camera.zoom;
    camera.target=null;
  });
  canvas.addEventListener("pointerup",e=>{
    if(intro.active)return;
    dragging=false;
    if(!moved){
      const pick=pickBodyOrLabel(e.clientX*DPR,e.clientY*DPR);
      if(pick)lockTarget(pick);
      else{camera.target=null;updateTelemetry(null);updateNavActive();}
    }
  });
  canvas.addEventListener("wheel",e=>{
    if(intro.active){tryInterruptIntro();return;}
    e.preventDefault();userInteracted=true;
    const delta=Math.sign(e.deltaY);
    const zoomFactor=Math.pow(1.12,-delta);
    // 需求：当已 lockTarget 时，滚轮缩放不应释放锁定。
    // 锁定状态下：以目标为中心缩放（避免“鼠标点缩放”与自动跟随打架）。
    if(camera.target){
      camera.zoom=clamp(camera.zoom*zoomFactor,MIN_ZOOM,MAX_ZOOM);
      camera.desiredZoom=camera.zoom;
      camera.x=camera.target.x;
      camera.y=camera.target.y;
      syncZoomBarFromCamera();
      return;
    }

    // 未锁定：保持原来的“以鼠标为中心缩放”行为
    const mouse={x:e.clientX*DPR,y:e.clientY*DPR};
    const before=camera.screenToWorld(mouse.x,mouse.y);
    camera.zoom=clamp(camera.zoom*zoomFactor,MIN_ZOOM,MAX_ZOOM);
    camera.desiredZoom=camera.zoom;
    const after=camera.screenToWorld(mouse.x,mouse.y);
    camera.x+=(before.x-after.x);camera.y+=(before.y-after.y);
    syncZoomBarFromCamera();
  },{passive:false});

  let touchMode=null,lastTouches=[],touchPinchStartDist=0,touchPinchStartZoom=0,touchPinchWorldCenter=null;
  canvas.addEventListener("touchstart",e=>{
    userInteracted=true;
    if(tryInterruptIntro()){e.preventDefault();return;}
    closeAllDrawers();
    if(e.touches.length===1){
      touchMode="pan";
      lastTouches=[...e.touches].map(t=>({id:t.identifier,x:t.clientX,y:t.clientY}));
      camStart={x:camera.x,y:camera.y};
    }else if(e.touches.length===2){
      touchMode="pinch";
      lastTouches=[...e.touches].map(t=>({id:t.identifier,x:t.clientX,y:t.clientY}));
      const dx=lastTouches[0].x-lastTouches[1].x,dy=lastTouches[0].y-lastTouches[1].y;
      touchPinchStartDist=Math.hypot(dx,dy);
      touchPinchStartZoom=camera.zoom;
      const cx=(lastTouches[0].x+lastTouches[1].x)/2;
      const cy=(lastTouches[0].y+lastTouches[1].y)/2;
      touchPinchWorldCenter=camera.screenToWorld(cx*DPR,cy*DPR);
    }
  },{passive:false});
  canvas.addEventListener("touchmove",e=>{
    if(intro.active){e.preventDefault();return;}
    e.preventDefault();
    if(touchMode==="pan"&&e.touches.length===1){
      const t=e.touches[0];
      const dx=t.clientX-lastTouches[0].x;
      const dy=t.clientY-lastTouches[0].y;
      camera.x=camStart.x-dx*DPR/camera.zoom;
      camera.y=camStart.y-dy*DPR/camera.zoom;
      camera.target=null;
    }else if(touchMode==="pinch"&&e.touches.length===2){
      const t0=e.touches[0],t1=e.touches[1];
      const dx=t0.clientX-t1.clientX,dy=t0.clientY-t1.clientY;
      const dist=Math.hypot(dx,dy);
      const factor=dist/touchPinchStartDist;
      let newZoom=clamp(touchPinchStartZoom*factor,MIN_ZOOM,MAX_ZOOM);
      const cx=(t0.clientX+t1.clientX)/2;
      const cy=(t0.clientY+t1.clientY)/2;
      camera.zoom=newZoom;camera.desiredZoom=newZoom;
      const after=camera.screenToWorld(cx*DPR,cy*DPR);
      camera.x+=(touchPinchWorldCenter.x-after.x);
      camera.y+=(touchPinchWorldCenter.y-after.y);
      camera.target=null;syncZoomBarFromCamera();
    }
  },{passive:false});
  canvas.addEventListener("touchend",()=>{touchMode=null;});

  let lastLabels=[];
  function pickBodyOrLabel(sx,sy){
    let best=null,bestD=1e9;
    lastLabels.forEach(l=>{
      const d=Math.hypot(sx-l.sx,sy-l.sy);
      if(d<bestD&&d<22*DPR){best=l.body;bestD=d;}
    });
    bodies.forEach(b=>{
      if(!b._visible)return;
      const p=camera.worldToScreen(b.x,b.y);
      const d=Math.hypot(sx-p.x,sy-p.y);
      const thresh=(b._screenR||6)*1.4+8*DPR;
      if(d<thresh&&d<bestD){best=b;bestD=d;}
    });
    return best;
  }

  function screenCircleVisible(x,y,r){
    return(x+r>-80*DPR && x-r<W+80*DPR && y+r>-80*DPR && y-r<H+80*DPR);
  }

  function drawStarfield(){
    ctx.save();ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle="#050507";ctx.fillRect(0,0,W,H);
    starLayers.forEach(layer=>{
      const dx=-camera.x*camera.zoom*layer.depth;
      const dy=-camera.y*camera.zoom*layer.depth;
      ctx.fillStyle="rgba(200,210,220,0.8)";
      layer.stars.forEach(s=>{
        let x=(s.x*DPR+dx)%W;if(x<0)x+=W;
        let y=(s.y*DPR+dy)%H;if(y<0)y+=H;
        ctx.globalAlpha=s.a*0.7;
        ctx.beginPath();ctx.arc(x,y,s.r*DPR,0,TWO_PI);ctx.fill();
      });
    });
    ctx.globalAlpha=1;
    ctx.restore();
  }
  function beginWorld(){
    ctx.save();ctx.translate(W/2,H/2);ctx.scale(camera.zoom,camera.zoom);
    ctx.translate(-camera.x,-camera.y);
  }
  function endWorld(){ctx.restore();}

  function orbitIntroAlpha(b){
    if(!intro.active)return 1;
    const f=intro.focusBand;
    const a=b.aAU ?? (b.aKm?b.aKm/AU_KM:0);
    if(b.type==="moon")return (camera.zoom>0.12)?1:0;
    if(f==="inner")return a<=2.4?1:0.15;
    if(f==="belt")return(a>=2.0&&a<=3.8)?1:0.12;
    if(f==="outer")return a>=4.0?1:0.12;
    return 0.8;
  }
  function orbitStrokeFor(b,alpha){
    if(b.type==="planet"||b.type==="dwarf")return`rgba(0,163,163,${0.25*alpha})`;
    if(b.type==="comet")return`rgba(255,176,0,${0.12*alpha})`;
    if(b.type==="moon")return`rgba(160,170,180,${0.22*alpha})`;
    return`rgba(120,120,120,${0.10*alpha})`;
  }
  function drawOrbit(b){
    if(!b.parentId)return;
    const p=byId.get(b.parentId);
    const isMoon=b.type==="moon";
    const e=b.eccentricity||0;
    let alpha=orbitIntroAlpha(b);
    if(isMoon && camera.zoom<0.12)return;

    if(b.isBeltAsteroid){
      const zFade=smoothstep(0.035,0.12,camera.zoom);
      alpha*=zFade;
      if(alpha<0.02)return;
    }else if(b.type==="asteroid" && camera.zoom<0.06){
      alpha*=smoothstep(0.03,0.06,camera.zoom);
      if(alpha<0.02)return;
    }

    const moonScale=(isMoon&&p.moonVizScale)?p.moonVizScale:1;
    const aAUphys=b.aAU ?? b.vizDistAU ?? (b.aKm?b.aKm/AU_KM:0);
    const aAUviz=aAUphys*(isMoon?moonScale:1);
    const aWorld=aAUviz*AU;
    if(aWorld<=0)return;

    ctx.strokeStyle=orbitStrokeFor(b,alpha);
    ctx.lineWidth=1/camera.zoom;

    const approxCirc=TWO_PI*aWorld;
    const baseSeg=(b.type==="comet"?6:8)*DPR;
    let steps=Math.round(approxCirc*camera.zoom/baseSeg);
    const eBoost=1+3*e;
    steps=Math.round(steps*eBoost);
    const maxSteps=(b.type==="comet"||e>0.6)?1200:300;
    const minSteps=(b.type==="comet"||e>0.6)?140:50;
    steps=clamp(steps,minSteps,maxSteps);
    if(intro.active){
      const isFocusOrbit=!!(intro.currentBody && (b.id===intro.currentBody.id || b.parentId===intro.currentBody.id));
      const introStepScale=isFocusOrbit?0.82:0.48;
      const introMax=(b.type==="comet"||e>0.6)?420:180;
      const introMin=isFocusOrbit?40:24;
      steps=clamp(Math.round(steps*introStepScale),introMin,introMax);
    }
    const orient=b.orientRad||0;

    if(b.orbitMode==="ellipse"&&e>0){
      ctx.beginPath();
      for(let i=0;i<=steps;i++){
        const f=i/steps*TWO_PI;
        const rNorm=(1-e*e)/(1+e*Math.cos(f));
        const r=aWorld*rNorm;
        const theta=f+orient;
        const x=p.x+r*Math.cos(theta),y=p.y+r*Math.sin(theta);
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }else{
      ctx.beginPath();ctx.arc(p.x,p.y,aWorld,0,TWO_PI);ctx.stroke();
    }
  }

  function drawRingsSaturn(sat, baseR, front=true){
    // baseR：调用方用于绘制土星本体的半径（世界坐标）
    // 环的真实外半径大约 ~2.25R，内半径 ~1.20R（这里稍微艺术化）
    const ringInner = baseR*1.22;
    const ringOuter = baseR*2.32;

    // 环平面“俯视压扁”程度：越小越扁（更接近你截图里的透视）
    const tilt = 0.33;

    // 固定一个视角方向，避免跟随自转造成“上下摆动/摇头”
    const ringAngle = -0.40;

    ctx.save();
    // 这里假设调用方已 ctx.translate 到土星中心
    ctx.rotate(ringAngle);
    ctx.scale(1, tilt);

    // 只绘制前半环 / 后半环
    ctx.beginPath();
    if(front) ctx.rect(-1e6, 0, 2e6, 1e6);
    else      ctx.rect(-1e6,-1e6,2e6, 1e6);
    ctx.clip();

    // 主环：用轻薄的“填充甜甜圈”，避免遮住卫星轨道线
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "rgba(240,222,190,0.95)";
    ctx.beginPath();
    ctx.arc(0,0,ringOuter,0,TWO_PI,false);
    ctx.arc(0,0,ringInner,0,TWO_PI,true);
    ctx.fill("evenodd");

    // 分层纹理（A/B/C 环的感觉）+ 卡西尼缝隙（稍暗）
    const band = (r0,r1,a,clr)=>{
      ctx.globalAlpha = a;
      ctx.fillStyle = clr;
      ctx.beginPath();
      ctx.arc(0,0,r1,0,TWO_PI,false);
      ctx.arc(0,0,r0,0,TWO_PI,true);
      ctx.fill("evenodd");
    };
    // 内部稍亮
    band(baseR*1.22, baseR*1.55, 0.18, "rgba(255,245,225,0.9)");
    // 中段主体
    band(baseR*1.55, baseR*2.05, 0.14, "rgba(235,215,185,0.9)");
    // 卡西尼空隙
    band(baseR*1.95, baseR*2.02, 0.18, "rgba(20,18,16,0.9)");
    // 外缘略暗
    band(baseR*2.05, baseR*2.32, 0.10, "rgba(210,190,165,0.9)");

    // 边缘描线（很细，增加清晰度）
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "rgba(250,240,220,0.9)";
    ctx.lineWidth = Math.max(0.12*baseR, 0.9);
    ctx.beginPath();ctx.arc(0,0,ringOuter,0,TWO_PI);ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "rgba(60,55,50,0.9)";
    ctx.lineWidth = Math.max(0.06*baseR, 0.6);
    ctx.beginPath();ctx.arc(0,0,ringInner,0,TWO_PI);ctx.stroke();

    ctx.restore();
  }


  function brighten(hex,amt){
    const c=parseInt(hex.slice(1),16);
    let r=(c>>16)&255,g=(c>>8)&255,b=c&255;
    r=clamp(r+amt*255,0,255);g=clamp(g+amt*255,0,255);b=clamp(b+amt*255,0,255);
    return`rgb(${r|0},${g|0},${b|0})`;
  }

  function drawBody(b){
    const p=camera.worldToScreen(b.x,b.y);
    const importance=(b.type==="star"||b.type==="planet"||b.type==="dwarf"||b.type==="comet");
    const lodHideMinor=camera.zoom<0.08 && !importance;
    if(lodHideMinor){b._visible=false;return;}
    let rWorld=b.size*(b.type==="star"?1.3:1.0);
    if(b.id==="saturn") rWorld*=0.78;
    if(b.parentId==="saturn") rWorld*=0.82;
    const rScreen=rWorld*camera.zoom;
    b._screenR=rScreen;
    const vis=screenCircleVisible(p.x,p.y,rScreen+8*DPR);
    b._visible=vis;
    if(!vis)return;

    const sun=byId.get("sun");
    const lx=(sun.x-b.x),ly=(sun.y-b.y);
    const lnorm=Math.hypot(lx,ly)||1;
    const ldx=lx/lnorm,ldy=ly/lnorm;

    ctx.save();ctx.translate(b.x,b.y);
    if(b.id==="saturn")drawRingsSaturn(b,rWorld,false);

    const grad=ctx.createRadialGradient(-ldx*rWorld*0.6,-ldy*rWorld*0.6,rWorld*0.25,0,0,rWorld*1.2);
    const base=b.color||"#9aa";
    grad.addColorStop(0,brighten(base,0.35));
    grad.addColorStop(0.55,base);
    grad.addColorStop(1,"#040406");
    ctx.fillStyle=grad;
    ctx.beginPath();ctx.arc(0,0,rWorld,0,TWO_PI);ctx.fill();

    if(b._tex){
      ctx.save();
      ctx.beginPath();ctx.arc(0,0,rWorld,0,TWO_PI);ctx.clip();
      ctx.translate(-rWorld,-rWorld);
      ctx.globalAlpha=0.98;
      ctx.drawImage(b._tex,0,0,b._tex.width,b._tex.height,0,0,2*rWorld,2*rWorld);
      ctx.restore();
    }

    // 大气层边缘光：让星球更立体
    if(b.type==="planet" && b.id!=="mercury"){
      ctx.save();
      ctx.globalCompositeOperation="screen";
      const rgb=hex2rgb(b.color||"#ffffff");
      const rimGrad=ctx.createRadialGradient(0,0,rWorld*0.8,0,0,rWorld*1.15);
      rimGrad.addColorStop(0,"rgba(0,0,0,0)");
      rimGrad.addColorStop(0.8,`rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.4)`);
      rimGrad.addColorStop(1,"rgba(0,0,0,0)");
      ctx.fillStyle=rimGrad;
      ctx.beginPath();ctx.arc(0,0,rWorld*1.2,0,TWO_PI);ctx.fill();
      ctx.restore();
    }

    if(b.id==="earth"||b.id==="venus"){
      const ag=ctx.createRadialGradient(0,0,rWorld*0.9,0,0,rWorld*1.25);
      ag.addColorStop(0,"rgba(120,180,255,0)");
      ag.addColorStop(1,b.id==="earth"?"rgba(80,170,255,0.35)":"rgba(255,230,180,0.25)");
      ctx.fillStyle=ag;
      ctx.beginPath();ctx.arc(0,0,rWorld*1.25,0,TWO_PI);ctx.fill();
    }

    // ⚠ 删除原来的“自转时针”，避免行星内部有顺时针转动的指针
    // （保留代码位置，方便以后如果你想再加别的 HUD）

    if(b.id==="saturn")drawRingsSaturn(b,rWorld,true);
    ctx.restore();

    if(b.type==="comet"){
      ctx.save();
      ctx.globalAlpha=0.16;
      ctx.strokeStyle="rgba(255,176,0,0.12)";
      ctx.lineWidth=2/camera.zoom;
      ctx.beginPath();ctx.moveTo(b.x,b.y);
      ctx.lineTo(b.x-ldx*rWorld*12,b.y-ldy*rWorld*12);
      ctx.stroke();
      ctx.restore();
    }

    if(b.type==="star"){
      ctx.save();ctx.translate(b.x,b.y);
      const pulse=(Math.sin(performance.now()/1000*1.4)+1)/2;
      const g2=ctx.createRadialGradient(0,0,rWorld*0.8,0,0,rWorld*3.8);
      g2.addColorStop(0,"rgba(255,176,0,0.38)");
      g2.addColorStop(0.4,"rgba(255,176,0,0.14)");
      g2.addColorStop(1,"rgba(255,176,0,0)");
      ctx.globalAlpha=0.25+0.2*pulse;
      ctx.fillStyle=g2;
      ctx.beginPath();ctx.arc(0,0,rWorld*3.8,0,TWO_PI);ctx.fill();
      ctx.restore();
    }
  }

  function rectsOverlap(a,b){
    return!(a.x+a.w<b.x||b.x+b.w<a.x||a.y+a.h<b.y||b.y+b.h<a.y);
  }
  function roundRect(c,x,y,w,h,r){
    c.beginPath();c.moveTo(x+r,y);
    c.arcTo(x+w,y,x+w,y+h,r);
    c.arcTo(x+w,y+h,x,y+h,r);
    c.arcTo(x,y+h,x,y,r);
    c.arcTo(x,y,x+w,y,r);
    c.closePath();
  }

  function drawLabels(){
    lastLabels=[];
    if(intro.active)return;
    const cands=[];
    bodies.forEach(b=>{
      if(!b._visible)return;
      const p=camera.worldToScreen(b.x,b.y);
      const imp=(b.type==="star"?4:b.type==="planet"?3:b.type==="dwarf"||b.type==="moon"?2:b.type==="comet"?1:0);
      let fs=10;
      if(imp>=3)fs=12;
      if(camera.target===b)fs=14;
      if(b.isBeltAsteroid)fs=8;
      let alpha=1;
      if(b.isBeltAsteroid){
        const zFade=smoothstep(0.06,0.16,camera.zoom);
        const sFade=smoothstep(0.7,1.4,b.size);
        alpha=zFade*sFade;
        if(alpha<0.05)return;
      }else if(camera.zoom<0.12 && imp<2){
        return;
      }
      cands.push({body:b,sx:p.x,sy:p.y+(b._screenR||6)+10*DPR,text:b.enName,textCN:b.name,pr:imp+(camera.target===b?10:0),fs,alpha});
    });
    cands.sort((a,b)=>b.pr-a.pr);
    const accepted=[];
    ctx.save();ctx.setTransform(1,0,0,1,0,0);

    cands.forEach(c=>{
      ctx.font = `${c.fs * DPR}px "Orbitron","Space Mono","Noto Sans SC",sans-serif`;
      const w=ctx.measureText(c.text).width;
      const h=c.fs*DPR*1.2;
      const pad=4*DPR;
      const x=c.sx-w/2-pad,y=c.sy-h/2-pad;
      const box={x,y,w:w+pad*2,h:h+pad*2};
      if(!screenCircleVisible(c.sx,c.sy,10*DPR))return;
      if(accepted.some(bx=>rectsOverlap(bx,box)))return;
      accepted.push(box);
      lastLabels.push({body:c.body,sx:c.sx,sy:c.sy});

      ctx.globalAlpha=0.55*c.alpha;
      ctx.fillStyle="rgba(0,0,0,0.55)";
      roundRect(ctx,box.x,box.y,box.w,box.h,2*DPR);ctx.fill();

      let col="rgba(200,200,200,0.9)";
      if(c.body.type==="star")col="rgba(255,176,0,0.95)";
      if(c.body.type==="planet"||c.body.type==="dwarf")col="rgba(0,163,163,0.95)";
      if(c.body.type==="comet")col="rgba(255,200,120,0.95)";
      if(c.body.type==="moon")col="rgba(170,180,190,0.95)";
      if(c.body.type==="asteroid")col="rgba(140,140,150,0.9)";

      ctx.globalAlpha=c.alpha;
      ctx.fillStyle=col;
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.shadowColor="rgba(0,255,255,0.7)";
      ctx.shadowBlur=0;ctx.shadowOffsetX=1*DPR;ctx.shadowOffsetY=0;
      ctx.fillText(c.text,c.sx,c.sy);
      ctx.shadowColor="rgba(255,160,0,0.7)";
      ctx.shadowOffsetX=-1*DPR;
      ctx.fillText(c.text,c.sx,c.sy);
      ctx.shadowOffsetX=0;ctx.shadowColor="transparent";

      if(c.pr>=3 && c.body.type!=="asteroid"){
        ctx.font=`${(c.fs-2)*DPR}px "Noto Sans SC"`;
        ctx.fillStyle="rgba(224,224,224,0.9)";
        ctx.fillText(c.textCN,c.sx,c.sy+(c.fs*0.9)*DPR);
      }
      ctx.globalAlpha=1;
    });
    ctx.restore();
  }

  const INTRO_RENDER_IDS={
    inner:new Set(["sun","mercury","venus","earth","mars"]),
    belt:new Set(["sun","mercury","venus","earth","mars","jupiter","ceres","vesta","pallas","hygiea"]),
    outer:new Set(["sun","jupiter","saturn","uranus","neptune","pluto","halley"]),
    all:new Set(["sun","mercury","venus","earth","mars","jupiter","saturn","uranus","neptune","pluto","halley"])
  };
  function introRenderSet(){
    return INTRO_RENDER_IDS[intro.focusBand]||INTRO_RENDER_IDS.all;
  }
  function isIntroMoonCandidate(b){
    return b.type==="moon" && !!intro.currentBody && b.parentId===intro.currentBody.id;
  }
  function shouldDrawOrbitInIntro(b){
    if(!intro.active)return true;
    if(b.isBeltAsteroid)return false;
    if(b.type==="moon")return isIntroMoonCandidate(b);
    const set=introRenderSet();
    return set.has(b.id) || !!(intro.currentBody && b.id===intro.currentBody.id);
  }
  function shouldDrawBodyInIntro(b){
    if(!intro.active)return true;
    if(b.isBeltAsteroid)return intro.focusBand==="belt" && b.isIntroBeltSample;
    if(b.type==="moon")return isIntroMoonCandidate(b);
    const set=introRenderSet();
    return set.has(b.id) || !!(intro.currentBody && b.id===intro.currentBody.id);
  }
  function shouldUpdateBodyInIntro(b){
    if(!intro.active)return true;
    return shouldDrawOrbitInIntro(b) || shouldDrawBodyInIntro(b);
  }

  const navPanel=document.getElementById("nav");
  const telPanel=document.getElementById("telemetry");
  const ctlPanel=document.getElementById("controls");
  const btnNav=document.getElementById("btnNav");
  const btnTel=document.getElementById("btnTel");
  const btnCtl=document.getElementById("btnCtl");
  const btnSkip=document.getElementById("btnSkip");
  const btnIntroDesktop=document.getElementById("btnIntroDesktop");
  const btnIntroMobile=document.getElementById("btnIntroMobile");

  function toggleDrawer(panel,btn){
    const open=panel.classList.contains("open");
    closeAllDrawers();
    if(!open){panel.classList.add("open");btn.classList.add("active");}
  }
  btnNav?.addEventListener("click",()=>toggleDrawer(navPanel,btnNav));
  btnTel?.addEventListener("click",()=>toggleDrawer(telPanel,btnTel));
  btnCtl?.addEventListener("click",()=>toggleDrawer(ctlPanel,btnCtl));
  btnSkip?.addEventListener("click",()=>{intro.requestSkip();});
  const playIntroFromButton=()=>{intro.start();};
  btnIntroDesktop?.addEventListener("click",playIntroFromButton);
  btnIntroMobile?.addEventListener("click",playIntroFromButton);

  bodies.forEach(b=>b.update(simDaysTotal(),byId));
  intro.build();
  requestAnimationFrame(()=>requestAnimationFrame(warmupPlanetTextures));

  const bootSeqEl=document.getElementById("bootSeq");
  const bootTextEl=document.getElementById("bootText");
  const bootLines=[
    "[USCSS // SOLAR TAPE TERMINAL]",
    "[LINK] DSN NODE: KEPLER-09.A  ............. OK",
    "[CHK ] ORBITAL SOLVER / J2000  ............ OK",
    "[UPLK] HELIOCENTRIC TELEMETRY  ............ OK"
  ];
  function startBoot(playedBefore){
    bootTextEl.textContent=bootLines.join("\n");
    bootSeqEl.classList.remove("hidden");
    setTimeout(()=>{
      bootSeqEl.classList.add("hidden");
      setTimeout(()=>{
        if(!playedBefore){
          intro.start();
        }else{
          uiRoot.classList.remove("intro-hidden");
          uiRoot.classList.add("intro-visible");
          document.body.classList.remove("intro-active");
          setSpeed(1.0);
        }
      },320);
    },700);
  }

  let playedBefore=false;
  try{playedBefore=localStorage.getItem("solarTapeIntroPlayed")==="1";}catch(e){}
  startBoot(playedBefore);

  let last=performance.now();
  function tick(now){
    const realDt=(now-last)/1000;last=now;
    const speed=parseFloat(speedSlider.value);
    const timeFactor=intro.active?0.12:1.0;
    const dtDays=realDt*speed*TIME_SCALE*timeFactor;
    simElapsedDays+=dtDays;
    const totalDays=simDaysTotal();
    if(intro.active){
      for(const b of bodies){
        if(shouldUpdateBodyInIntro(b))b.update(totalDays,byId);
      }
    }else{
      bodies.forEach(b=>b.update(totalDays,byId));
    }
    intro.update(realDt);

    if(intro.active){
      const k=clamp(realDt*3.0,0,1);
      camera.x=lerp(camera.x,intro.camTx,k);
      camera.y=lerp(camera.y,intro.camTy,k);
      camera.zoom=lerp(camera.zoom,intro.camTz,k);
      camera.zoom=clamp(camera.zoom,MIN_ZOOM,MAX_ZOOM);
      camera.desiredZoom=camera.zoom;

      if(intro.currentBody && (intro.currentBody.id==="jupiter"||intro.currentBody.id==="saturn")){
        const s=0.003*camera.zoom;
        camera.x+=(Math.random()-0.5)*s;
        camera.y+=(Math.random()-0.5)*s;
      }
      syncZoomBarFromCamera();
    }else if(camera.target){
      camera.x+=(camera.target.x-camera.x)*0.05;
      camera.y+=(camera.target.y-camera.y)*0.05;
      camera.zoom+=(camera.desiredZoom-camera.zoom)*0.04;
      camera.zoom=clamp(camera.zoom,MIN_ZOOM,MAX_ZOOM);
      syncZoomBarFromCamera();
    }

    updateZoomText();
    drawStarfield();
    beginWorld();
    if(intro.active){
      for(const b of bodies){
        if(shouldDrawOrbitInIntro(b))drawOrbit(b);
      }
      for(const b of bodies){
        if(shouldDrawBodyInIntro(b))drawBody(b);
        else b._visible=false;
      }
    }else{
      bodies.forEach(drawOrbit);
      bodies.forEach(drawBody);
    }
    endWorld();
    drawLabels();
    drawIntroVFX();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
