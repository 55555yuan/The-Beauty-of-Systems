/*
作品名：系统之美 / The Beauty of Systems
模块：扩张与折叠——差分增长 / Module: Expansion & Folding — Differential Growth
日期：2026.9.3 / Date: 2026.9.3
作者：袁征 / Author: Yuan Zheng

说明：相连节点形成可生长的柔性边界，并在排斥、刚度与空间约束作用下产生褶皱形态。
/ Description: Connected nodes form a growing flexible boundary that folds through repulsion, stiffness and spatial constraints.

操作：使用预设与滑杆探索形态。快捷键：H 显示/隐藏面板，R 重置，T 自动巡演，E 导出，F 切换画质，Q 全屏。
/ Controls: Explore with presets and sliders. Shortcuts: H show/hide panel, R reset, T auto tour, E export, F quality, Q fullscreen.

技术：p5.js；qrcode-generator
/ Technologies: p5.js; qrcode-generator
*/

/* 共享系统：处理画布缩放、视觉参数与跨模块通用状态。
   Shared system: handles canvas scaling, visual parameters and common module state. */

/* 本文件由四段拼成：
     §1–§9    共享内核 —— 三个模块逐字相同，改动请三份同步
     §10–§13  本模块的参数轴、生命周期、模拟与渲染
     §14–§15  控制面板，以及预设之间的连续过渡
     §16      与外壳（根目录 index.html）的对接

   This file is assembled from four parts:
     §1–§9    the shared kernel — byte-identical in all three modules, keep them in sync
     §10–§13  this module's axes, lifecycle, simulation and rendering
     §14–§15  the control panel and the continuous transitions between presets
     §16      the link to the shell (index.html in the repository root) */
let REF_EDGE = 700;

const LITE_MODE = /(^|[?&])lite\b/.test(location.search);

let DENSITY  = LITE_MODE ? 0.36 : 0.50;

let sizeRatio  = 1;
let geoScale   = 1;
let countScale = 1;

/* ---- §1  画布与缩放 / CANVAS & SCALE ------------------------------------ */

// 参考画布 700×700 到当前画布的两条缩放律：几何量按边长开方，数量按面积。
// Two scaling laws from the 700×700 reference canvas: geometry by the square root of the edge, counts by area.
function computeScale() {
  sizeRatio  = Math.sqrt(width * height) / REF_EDGE;
  geoScale   = Math.sqrt(sizeRatio);
  countScale = (sizeRatio * sizeRatio) / (geoScale * geoScale) * DENSITY;
}

function gs(v) { return v * geoScale; }
function cs(v) { return Math.max(1, Math.round(v * countScale)); }


let MAX_EDGE = LITE_MODE ? 1200 : 1400;

// 渲染分辨率封顶。每一笔开销都正比于像素数，画布却是照着窗口开的。
// Caps the render resolution: every cost here is proportional to pixel count, while the canvas follows the window.
function canvasSize() {
  let w = windowWidth, h = windowHeight;
  let k = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
}


// 用 CSS 把画布拉满窗口——渲染分辨率与显示分辨率从此是两件事。
// CSS stretches the canvas to the window, so render resolution and display resolution become independent.
function stretchCanvas() {
  let c = drawingContext && drawingContext.canvas;
  if (!c) return;
  c.style.width  = '100vw';
  c.style.height = '100vh';
  c.style.display = 'block';
}

function fitCanvas() {
  let s = canvasSize();
  createCanvas(s.w, s.h);
  pixelDensity(1);
  stretchCanvas();
  computeScale();
}

function windowResized() {
  let s = canvasSize();
  resizeCanvas(s.w, s.h);
  stretchCanvas();
  computeScale();
  applyScale();

  grainPat = null;
}


let glow, grain;

let GLOW_TEX   = 48;


let GRAIN_TEX  = 512;
let GRAIN_BLOCK = 2;
let grainPeak  = 0.075;
let grainMix   = 0.55;
let grainPat   = null;


let grainBite  = 0.50;
let grainMul   = 0.60;

let BASE_GLOW_SIZE = 14;
let BASE_DOT_SIZE  = 7;
let glowSize, dotSize;

let glowAlpha     = 0.15;
let maxGlowAlpha  = 1.0;

let structureBlend;


let birthFadeSpeed = 0.045;
let deathFadeSpeed = 0.025;

/* ---- §2  生灭过渡 / BIRTH & DEATH FADE ---------------------------------- */

// 三段式生灭：dying → fade → 移除，绝不直接 splice。
// Birth and death always run dying → fade → removal; nothing is ever spliced out directly.
function advanceFade(e) {
  if (e.dying) e.fade = Math.max(0, e.fade - deathFadeSpeed);
  else         e.fade = Math.min(1, e.fade + birthFadeSpeed);
}


// 衰退不是原地变暗，而是回缩：位置、亮度、宽度各走一条曲线。
// Dying is a retraction rather than a dimming: position, brightness and width each follow their own curve.
function retractK(f) { return f; }
function retractA(f) { return Math.sqrt(f); }
function retractW(f) { return 0.30 + 0.70 * f; }


let SIM_STEPS = 2;


/* 资源与邻域：资源点提供局部驱动力，空间哈希用于加速邻域查询。
   Resources and neighbourhoods: resource points provide local forces; spatial hashing accelerates neighbour queries. */

/* ---- §3  空间哈希网格 / SPATIAL HASH ------------------------------------ */

// 16 位打包坐标，避免为每次插入分配字符串键。
// Packed 16-bit coordinates, so no string key is allocated per insertion.
function gridKey(x, y) { return ((x & 0xffff) << 16) ^ (y & 0xffff); }


let gridPool = [], gridPoolStamp = -1, gridPoolCursor = 0;

// 邻域查询一律走哈希网格，全系列不写 O(n²)。帧局部缓存避免每帧重新分配桶。
// All neighbour queries go through this grid — no O(n²) loops anywhere. A frame-local pool keeps the buckets alive.
function buildGrid(cell, items) {
  let stamp = (typeof frameCount === 'number') ? frameCount : 0;
  if (stamp !== gridPoolStamp) { gridPoolStamp = stamp; gridPoolCursor = 0; }
  let cache = gridPool[gridPoolCursor++];
  if (!cache) {
    cache = { map: new Map(), buckets: [], used: 0 };
    gridPool.push(cache);
  }
  for (let i = 0; i < cache.used; i++) cache.buckets[i].length = 0;
  cache.used = 0;
  let g = cache.map;
  g.clear();
  for (let i = 0; i < items.length; i++) {
    let k = gridKey(Math.floor(items[i].x / cell), Math.floor(items[i].y / cell));
    let arr = g.get(k);
    if (!arr) {
      arr = cache.buckets[cache.used] || (cache.buckets[cache.used] = []);
      cache.used++;
      g.set(k, arr);
    }
    arr.push(i);
  }
  return g;
}


let nutrients = [];

let /* 模块 II：差分增长。闭合边界在生长、弹簧、排斥、刚度与约束共同作用下产生褶皱。
   Module II: Differential growth. Closed boundaries fold through growth, springs, repulsion, stiffness and confinement. */
BASE_NUT_COUNT   = 60;
let BASE_NUT_RADIUS  = 48;
let BASE_NUT_DRIFT   = 0.28;
let BASE_NUT_SCATTER = 60;
let nutCount, nutRadius, nutDrift, nutScatter;

let nutAmountMin = 34, nutAmountMax = 64;
let nutLifeMin   = 900, nutLifeMax  = 2400;
let nutNearBias  = 0.40;
let nutFadeIn    = 0.05;

let nutDotAlphaMin = 0.05, nutDotAlphaMax = 0.50;

let feedBudget     = 0.95;
let feedDepletion  = 0.045;
let feedCrowdDrain = 0.12;


let NUT_SAMPLER = null;

/* ---- §4  养分场 / NUTRIENT FIELD ---------------------------------------- */

// 养分有限、会枯竭、需要抢——稀缺是三个板块共同的形态成因。
// Nutrients are finite, they deplete, and they must be competed for: scarcity is what all three modules have in common.
function spawnNutrient(anchors) {
  let x, y;
  if (anchors && anchors.length > 0 && random() < nutNearBias) {
    let a = anchors[floor(random(anchors.length))];
    x = a.x + random(-nutScatter, nutScatter);
    y = a.y + random(-nutScatter, nutScatter);
    if (x < 0) x = -x; else if (x > width)  x = 2 * width  - x;
    if (y < 0) y = -y; else if (y > height) y = 2 * height - y;
  } else if (NUT_SAMPLER) {
    let p = NUT_SAMPLER();
    x = p.x; y = p.y;
  } else {
    x = random(width);
    y = random(height);
  }
  let ang = random(TWO_PI);
  let spd = random(0.3, 1) * nutDrift;
  return {
    x: constrain(x, 2, width - 2),
    y: constrain(y, 2, height - 2),
    vx: cos(ang) * spd, vy: sin(ang) * spd,
    amount: random(nutAmountMin, nutAmountMax),
    age: 0, life: random(nutLifeMin, nutLifeMax),
    fade: 0,
    spent: false
  };
}

function updateNutrients(anchors) {
  for (let i = 0; i < nutrients.length; i++) {
    let nt = nutrients[i];
    if (nt.spent) continue;

    nt.fade += (1 - nt.fade) * nutFadeIn;
    nt.age++;
    nt.x += nt.vx;
    nt.y += nt.vy;
    if (nt.x < 2 || nt.x > width  - 2) nt.vx *= -1;
    if (nt.y < 2 || nt.y > height - 2) nt.vy *= -1;
    nt.x = constrain(nt.x, 2, width  - 2);
    nt.y = constrain(nt.y, 2, height - 2);

    if (nt.amount <= 0 || nt.age > nt.life) nutrients[i] = spawnNutrient(anchors);
  }
  while (nutrients.length < nutCount) nutrients.push(spawnNutrient(anchors));
  if (nutrients.length > nutCount) nutrients.length = nutCount;
}

function refillSpent(maxPerFrame, anchors) {
  let n = 0;
  for (let i = 0; i < nutrients.length && n < maxPerFrame; i++) {
    if (nutrients[i].spent) { nutrients[i] = spawnNutrient(anchors); n++; }
  }
}


let feedScratch = [];

// 竞争性喂养：每颗养分把固定预算按距离权重分给邻域，并给出一个指向自己的梯度。
// Competitive feeding: each nutrient splits a fixed budget among its neighbours by distance weight and returns a gradient towards itself.
function feedByBudget(consumers) {
  for (let i = 0; i < consumers.length; i++) {
    consumers[i].pullx = 0;
    consumers[i].pully = 0;
    consumers[i].intake = 0;
  }

  let grid = buildGrid(nutRadius, consumers);
  let radius2 = nutRadius * nutRadius;
  let invRadius = 1 / nutRadius;

  for (let p = 0; p < nutrients.length; p++) {
    let nt = nutrients[p];
    if (nt.spent) continue;

    let cx = Math.floor(nt.x / nutRadius);
    let cy = Math.floor(nt.y / nutRadius);

    feedScratch.length = 0;
    let sumFall = 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        let arr = grid.get(gridKey(cx + ox, cy + oy));
        if (!arr) continue;
        for (let a = 0; a < arr.length; a++) {
          let idx = arr[a], c = consumers[idx];
          if (c.dying) continue;
          let dx = c.x - nt.x, dy = c.y - nt.y;
          let d2 = dx * dx + dy * dy;
          if (d2 <= 0 || d2 >= radius2) continue;
          let d = Math.sqrt(d2), fall = 1 - d * invRadius;
          feedScratch.push(idx, dx, dy, 1 / d, fall);
          sumFall += fall;
        }
      }
    }

    if (sumFall > 0) {
      let give = Math.min(feedBudget, nt.amount);
      for (let k = 0; k < feedScratch.length; k += 5) {
        let c = consumers[feedScratch[k]];
        let fall = feedScratch[k + 4];
        c.intake += give * fall / sumFall;
        c.pullx -= feedScratch[k + 1] * feedScratch[k + 3] * fall;
        c.pully -= feedScratch[k + 2] * feedScratch[k + 3] * fall;
      }
      nt.amount -= give * feedDepletion * (1 + (feedScratch.length / 5) * feedCrowdDrain);
    }
  }
}


/* 渲染：结构先写入低分辨率墨层，再结合密度、颗粒、景深与色调处理形成最终画面。
   Rendering: structure is written to reduced-resolution ink layers, then combined with density, grain, depth and tone processing. */
let inkScale   = 0.5;
let strokeW    = 0.78;
let strokeMinW = 0.85;
let inkBlur    = 0.95;
let inkLift    = 1.0;


let inkLayers = 3;
let inkLayersMax = 3;


let depthAmt = 1;


let layerScaleFar = 0.58;
let layerBlurFar  = 2.05;
let layerGainFar  = 0.80;
let layerOccl     = 0.42;


let depthDim   = 0.44;
let depthCurve = 0.80;

/* ---- §5  深度场 / DEPTH FIELD ------------------------------------------- */
function depthGain(z) {
  let dim = 1 - (1 - depthDim) * depthAmt;
  return dim + (1 - dim) * (z <= 0 ? 0 : z >= 1 ? 1 : Math.pow(z, depthCurve));
}


let zCell  = 210;
let zDrift = 0.010;

function zHash(i, j) {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 深度场：一张缓慢漂移的值噪声给每一段一个 z，远层更小、更糊、更暗。
// A slowly drifting value-noise field gives every segment a depth; far layers are drawn smaller, blurred more and dimmed.
function zField(x, y) {
  let o = frameCount * zDrift;
  let gx = x / zCell + o, gy = y / zCell - o * 0.37;
  let i = Math.floor(gx), j = Math.floor(gy);
  let fx = gx - i, fy = gy - j;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  let a = zHash(i, j), b = zHash(i + 1, j);
  let c = zHash(i, j + 1), d = zHash(i + 1, j + 1);
  let top = a + (b - a) * fx;
  return top + ((c + (d - c) * fx) - top) * fy;
}


let inkBase = null;


let strokeBatch = null;
let bucketK = 7;
let alphaBucketK = 7;

/* ---- §6  墨纸渲染管线 / INK PIPELINE ------------------------------------ */
function batchBegin() { strokeBatch = new Map(); densBegin(); }


// 成批描边。逐段描边会让相邻两段共用的端点被盖两次，节点因此比线身亮。
// Strokes are batched: drawn segment by segment, a shared endpoint is covered twice and the joints come out brighter than the line.
function batchSeg(ax, ay, bx, by, alpha, size, z) {
  if (alpha <= 0.002) return;
  let s = size || glowSize;
  if (!(s > 0)) return;


  let mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
  let dx = bx - ax, dy = by - ay;
  densAdd(mx, my, s * Math.sqrt(dx * dx + dy * dy));
  let d = (typeof z === 'number' && z === z) ? (z < 0 ? 0 : z > 1 ? 1 : z) : 0.5;
  let a = alpha * depthGain(d)
        * inkQuant((densAmt > 0 ? 1 + densAmt * (densAt(mx, my) * 2 - 1) : 1) * grainAt(mx, my));
  a = Math.min(maxGlowAlpha, a);
  if (a <= 0.002) return;

  let L = inkLayers > 1 ? Math.min(inkLayers - 1, (d * inkLayers) | 0) : 0;
  let ks = Math.round(Math.log(s) * bucketK);
  let ka = Math.round(Math.log(a) * alphaBucketK);
  let key = L + '_' + ks + '_' + ka;
  let rec = strokeBatch.get(key);
  if (!rec) {
    rec = { L: L, s: Math.exp(ks / bucketK), a: Math.exp(ka / alphaBucketK), p: new Path2D() };
    strokeBatch.set(key, rec);
  }
  rec.p.moveTo(ax, ay);
  rec.p.lineTo(bx, by);
}


let inkGain = 0.95;


let densAmt   = 0.50;
let densCell  = 28;
let densGamma = 0.70;
let densGrid = null, densNext = null, densGW = 0, densGH = 0, densRef = 0;

function densBegin() {
  let gw = Math.max(3, Math.ceil(width / densCell) + 2);
  let gh = Math.max(3, Math.ceil(height / densCell) + 2);
  if (!densGrid || densGW !== gw || densGH !== gh) {
    densGW = gw; densGH = gh;
    densGrid = new Float32Array(gw * gh);
    densNext = new Float32Array(gw * gh);
    densRef = 0;
  } else {
    let t = densGrid; densGrid = densNext; densNext = t;
    densNext.fill(0);
  }
}

// 疏密场：写下一帧的密度、读上一帧的，一趟走完。
// The density field is written for the next frame and read from the last one, in a single pass.
function densAdd(x, y, wgt) {
  let gx = x / densCell, gy = y / densCell;
  let i = gx | 0, j = gy | 0;
  if (i < 0 || j < 0 || i >= densGW - 1 || j >= densGH - 1) return;
  let fx = gx - i, fy = gy - j, o = j * densGW + i;
  densNext[o]             += wgt * (1 - fx) * (1 - fy);
  densNext[o + 1]         += wgt * fx       * (1 - fy);
  densNext[o + densGW]    += wgt * (1 - fx) * fy;
  densNext[o + densGW + 1]+= wgt * fx       * fy;
}

function densEnd() {
  let sum = 0, n = 0;
  for (let i = 0; i < densNext.length; i++) { let v = densNext[i]; if (v > 0) { sum += v; n++; } }
  let mean = n > 0 ? sum / n : 0;
  let target = mean * 1.9;
  densRef = densRef > 0 ? densRef + (target - densRef) * 0.08 : target;
}


function densAt(x, y) {
  if (!densGrid || densRef <= 0) return 0.5;
  let gx = x / densCell, gy = y / densCell;
  let i = gx | 0, j = gy | 0;
  if (i < 0 || j < 0 || i >= densGW - 1 || j >= densGH - 1) return 0.5;
  let fx = gx - i, fy = gy - j, o = j * densGW + i;
  let v = densGrid[o]              * (1 - fx) * (1 - fy)
        + densGrid[o + 1]          * fx       * (1 - fy)
        + densGrid[o + densGW]     * (1 - fx) * fy
        + densGrid[o + densGW + 1] * fx       * fy;
  let u = v / densRef;
  return u <= 0 ? 0 : (u >= 1 ? 1 : Math.pow(u, densGamma));
}


const INK_STEPS = 5, INK_LO = 0.42, INK_HI = 1.70;
const INK_LG = Math.log(INK_HI / INK_LO);

// 调制必须离散，否则每一段都成为一次新的绘制状态。
// Modulation has to be quantised, or every segment becomes a new draw state.
function inkQuant(m) {
  let q = Math.round(Math.log(m / INK_LO) / INK_LG * (INK_STEPS - 1));
  return INK_LO * Math.exp(INK_LG * (q < 0 ? 0 : q > INK_STEPS - 1 ? INK_STEPS - 1 : q) / (INK_STEPS - 1));
}


let inkGrain = 0;
let inkGrainCell = 14;


function grainAt(x, y) {
  if (inkGrain <= 0) return 1;
  let i = (x / inkGrainCell) | 0, j = (y / inkGrainCell) | 0;
  let h = (i * 73856093) ^ (j * 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  let u = h / 4294967296;
  return u < 0.34 ? 1 - inkGrain : (u < 0.67 ? 1 : 1 + inkGrain);
}


let farDim  = 0.45;


let poreAmt   = 0.70;
let poreBias  = 0.34;
let poreTex   = 192;


let poreBlock = 1;
let poreDrift = 0.34;

let inkPlate = null, inkSheet = [], poreTile = null, porePat = null;


function ensurePlate(pw, ph) {
  if (inkPlate && inkPlate.width === pw && inkPlate.height === ph) return;
  inkPlate = document.createElement('canvas');
  inkPlate.width = pw; inkPlate.height = ph;
  porePat = null;
}


function ensureSheet(L, w, h) {
  let s = inkSheet[L];
  if (s && s.a.width === w && s.a.height === h) return s;
  s = { a: document.createElement('canvas'), b: document.createElement('canvas') };
  s.a.width = w; s.a.height = h;
  s.b.width = w; s.b.height = h;
  inkSheet[L] = s;
  return s;
}

// 空隙在纸上，不在笔上——笔只能更细或更淡，画不出洞。
// Porosity belongs to the paper, not the brush: a brush can only be thinner or fainter, it cannot draw a hole.
function makePore() {
  let s = Math.max(16, poreTex | 0), block = Math.max(1, poreBlock | 0);
  let cv = document.createElement('canvas');
  cv.width = s; cv.height = s;
  let x = cv.getContext('2d');
  let img = x.createImageData(s, s), d = img.data;
  for (let by = 0; by < s; by += block) {
    for (let bx = 0; bx < s; bx += block) {
      let u = Math.random();

      let a = u < poreBias ? 0
            : Math.pow((u - poreBias) / (1 - poreBias), 1.5) * poreAmt;
      let aa = Math.round(255 * a);
      let yh = Math.min(block, s - by), xw = Math.min(block, s - bx);
      for (let yy = 0; yy < yh; yy++) {
        let o = ((by + yy) * s + bx) * 4;
        for (let xx = 0; xx < xw; xx++, o += 4) { d[o + 3] = aa; }
      }
    }
  }
  x.putImageData(img, 0, 0);
  porePat = null;
  return cv;
}


// 一帧的墨：加法描进半分辨率的墨纸 → 咬出空隙 → 模糊一次 → 整张放大铺回画布。
// One frame of ink: composited additively into a half-resolution sheet, bitten with pores, blurred once, then laid back over the canvas whole.
function inkPaint(ctx) {
  let c = ctx.canvas;
  let pw = Math.max(2, Math.round(c.width  * inkScale));
  let ph = Math.max(2, Math.round(c.height * inkScale));
  ensurePlate(pw, ph);

  let P2 = inkPlate.getContext('2d');
  P2.setTransform(1, 0, 0, 1, 0, 0);
  P2.filter = 'none';
  P2.globalAlpha = 1;
  P2.globalCompositeOperation = 'copy';
  P2.fillStyle = 'rgba(0,0,0,0)';
  P2.fillRect(0, 0, pw, ph);


  if (inkBase && inkBase.canvas) {
    P2.globalCompositeOperation = 'lighter';
    P2.globalAlpha = (typeof inkBase.alpha === 'number') ? inkBase.alpha : 1;
    P2.imageSmoothingEnabled = true;
    P2.drawImage(inkBase.canvas, 0, 0, pw, ph);
    P2.globalAlpha = 1;
  }


  let byLayer = [], maxS = 0;
  for (let i = 0; i < inkLayers; i++) byLayer.push(null);
  strokeBatch.forEach(function (r) {
    if (r.s > maxS) maxS = r.s;
    let L = r.L < inkLayers ? r.L : inkLayers - 1;
    if (!byLayer[L]) byLayer[L] = [];
    byLayer[L].push(r);
  });

  if (!poreTile && poreAmt > 0.01) poreTile = makePore();
  if (!porePat && poreTile) porePat = P2.createPattern(poreTile, 'repeat');

  for (let L = 0; L < inkLayers; L++) {
    let list = byLayer[L];
    if (!list || !list.length) continue;


    let u = inkLayers > 1 ? L / (inkLayers - 1) : 1;

    let scF = 1 - (1 - layerScaleFar) * depthAmt;
    let blF = 1 + (layerBlurFar - 1) * depthAmt;
    let gnF = 1 - (1 - layerGainFar) * depthAmt;
    let sc = scF + (1 - scF) * u;
    let bl = inkBlur * (blF + (1 - blF) * u);
    let gn = gnF + (1 - gnF) * u;

    let w = Math.max(2, Math.round(pw * sc));
    let h = Math.max(2, Math.round(ph * sc));
    let sh = ensureSheet(L, w, h);
    let g = sh.a.getContext('2d');
    let sx = w / width, sy = h / height;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = 'none';
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'copy';
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, w, h);


    g.setTransform(sx, 0, 0, sy, 0, 0);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.globalCompositeOperation = 'lighter';
    let minW = strokeMinW / sx;

    for (let i = 0; i < list.length; i++) {
      let r = list[i];

      let t = maxS > 0 ? Math.pow(Math.min(1, r.s / maxS), 0.6) : 1;
      let v = r.a * inkGain * (farDim + (1 - farDim) * t);
      if (v <= 0.002) continue;
      g.strokeStyle = inkOf(v);
      g.lineWidth = Math.max(minW, r.s * strokeW);
      g.stroke(r.p);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);


    if (porePat && poreAmt > 0.01) {
      let ox = poreDrift > 0 ? Math.round(frameCount * poreDrift + L * 37) % poreTex : (L * 37) % poreTex;
      let oy = poreDrift > 0 ? Math.round(frameCount * poreDrift * 0.61 + L * 61) % poreTex : (L * 61) % poreTex;
      g.save();

      g.translate(-ox, -oy);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = porePat;
      g.fillRect(ox, oy, w, h);
      g.restore();
    }


    let src = sh.a;
    if (bl > 0.05) {
      let t2 = sh.b.getContext('2d');
      t2.setTransform(1, 0, 0, 1, 0, 0);
      t2.globalAlpha = 1;
      t2.globalCompositeOperation = 'copy';
      t2.filter = 'blur(' + bl.toFixed(2) + 'px)';
      t2.drawImage(sh.a, 0, 0);
      t2.filter = 'none';
      src = sh.b;
    }


    P2.imageSmoothingEnabled = true;
    if (L > 0 && layerOccl * depthAmt > 0.01) {
      P2.globalCompositeOperation = 'destination-out';
      P2.globalAlpha = layerOccl * depthAmt;
      P2.drawImage(src, 0, 0, pw, ph);
    }
    P2.globalCompositeOperation = 'lighter';
    P2.globalAlpha = gn;
    P2.drawImage(src, 0, 0, pw, ph);
  }
  P2.globalAlpha = 1;


  let prevOp = ctx.globalCompositeOperation;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = inkLift;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(inkPlate, 0, 0, c.width, c.height);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prevOp;
}

function batchFlush() {
  if (!strokeBatch) return;
  inkPaint(drawingContext);
  strokeBatch = null;
  densEnd();
}


// 影调：压暗部、提亮，烤进墨色本身而不是事后再合成一遍。
// The tone curve is baked into the ink colour instead of costing another full-frame pass.
function toneCurve(v) {
  let a = v * (1 - toneCrush + toneCrush * v);
  return a * (1 + toneLift * (1 - a));
}

function inkOf(v) {
  let n = Math.round(255 * toneCurve(Math.min(1, Math.max(0, v))));
  return 'rgb(' + n + ',' + n + ',' + n + ')';
}


let nutLayer = null, nutStamp = -9999;
let nutEvery = 10;

function drawNutrients() {
  let ctx = drawingContext, c = ctx.canvas;
  if (!nutLayer || nutLayer.width !== c.width || nutLayer.height !== c.height) {
    nutLayer = document.createElement('canvas');
    nutLayer.width = c.width; nutLayer.height = c.height;
    nutStamp = -9999;
  }

  if (frameCount - nutStamp >= nutEvery) {
    nutStamp = frameCount;
    let g = nutLayer.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,0)';
    g.fillRect(0, 0, nutLayer.width, nutLayer.height);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < nutrients.length; i++) {
      let nt = nutrients[i];
      if (nt.spent) continue;
      g.globalAlpha =
        map(nt.amount, 0, nutAmountMax, nutDotAlphaMin, nutDotAlphaMax, true) * nt.fade;
      g.drawImage(glow.elt, nt.x - dotSize / 2, nt.y - dotSize / 2, dotSize, dotSize);
    }
    g.globalAlpha = 1;
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(nutLayer, 0, 0);
  ctx.restore();
}


let frameBudgetMs = 30;


let qualityCeil = 1;
let quality = 0.62;
let smoothMs = 16.7;
let bloomBase = -1, grainBase = -1, rimBase = -1, grainMulBase = -1;


let renderStepMul = 1;


const READ_SCALE = 3;
let readBuf = null, readStamp = -1;

function sampleFrame() {
  let c = drawingContext.canvas;
  let w = Math.max(2, Math.round(c.width / READ_SCALE));
  let h = Math.max(2, Math.round(c.height / READ_SCALE));
  if (!readBuf || readBuf.width !== w || readBuf.height !== h) {
    readBuf = document.createElement('canvas');
    readBuf.width = w; readBuf.height = h;
    readStamp = -1;
  }
  if (readStamp === frameCount) return readBuf;
  let x = readBuf.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.filter = 'none';
  x.globalCompositeOperation = 'copy';
  x.globalAlpha = 1;
  x.drawImage(c, 0, 0, w, h);
  readStamp = frameCount;
  return readBuf;
}


/* 性能与画质：根据运行状态调整渲染开销，保证展览环境中的稳定性。
   Performance and quality: adjusts rendering cost to keep the installation stable. */
const FAST = /(^|[?&])fast\b/.test(location.search);
const RICH = /(^|[?&])rich\b/.test(location.search);

/* ---- §7  自适应画质 / ADAPTIVE QUALITY ---------------------------------- */

// 追着帧率走的自适应降级；F 键给出上限挡位，?perf 打开分段读数。
// Quality follows the frame rate; F sets the ceiling and ?perf opens per-stage timings.
function adaptQuality() {
  if (bloomBase < 0) {
    bloomBase = bloomAmt; grainBase = grainMix; rimBase = rimAmt;
    grainMulBase = grainMul;
    if (FAST) { qStep = 0; applyQualityStep(); }
    else if (RICH) { qStep = 1; applyQualityStep(); }
    else applyQualityStep();
  }
  let dt = (typeof deltaTime === 'number' && deltaTime > 0) ? Math.min(deltaTime, 400) : 16.7;

  smoothMs += (dt - smoothMs) * (dt > smoothMs ? 0.16 : 0.05);

  let over = smoothMs / frameBudgetMs;
  if (over > 1.80)      quality = Math.max(0, quality - 0.040);
  else if (over > 1.12) quality = Math.max(0, quality - 0.012);
  else if (over < 0.86) quality = Math.min(qualityCeil, quality + 0.006);


  if (inkScale > 0.45)      { if (quality < 0.26) inkScale = 0.40; }
  else if (inkScale > 0.36) { if (quality > 0.34) inkScale = 0.50;
                              else if (quality < 0.09) inkScale = 0.32; }
  else                      { if (quality > 0.16) inkScale = 0.40; }


  if (inkLayersMax >= 3)      { if (quality < 0.20) inkLayersMax = 2; }
  else if (inkLayersMax === 2) { if (quality > 0.30) inkLayersMax = 3;
                                 else if (quality < 0.07) inkLayersMax = 1; }
  else                         { if (quality > 0.13) inkLayersMax = 2; }


  inkLayers = depthAmt < 0.28 ? 1 : inkLayersMax;


  let tier = qStep;


  bloomAmt  = bloomBase * constrain((quality - 0.05) / 0.45, 0, 1);

  rimAmt    = tier >= 1 ? rimBase * constrain((quality - 0.10) / 0.40, 0, 1) : 0;

  grainMix  = grainBase;
  grainMul  = grainMulBase;
  let low = constrain((0.70 - quality) / 0.70, 0, 1);
  renderStepMul = 1 + low * 1.4;
  nutEvery = Math.round(10 + low * 14);

  perfInit();
  perfTick();
}


const QUALITY_STEPS = [
  { name: 'LIGHT', zh: '轻',   ceil: 0.45, edge: 1400, dens: 0.50 },
  { name: 'RICH',  zh: '厚',   ceil: 1.00, edge: 1600, dens: 1.00 }
];
let qStep = 0;

function cycleQuality() {
  qStep = (qStep + 1) % QUALITY_STEPS.length;
  applyQualityStep();
}

function applyQualityStep() {
  let q = QUALITY_STEPS[qStep];
  qualityCeil = q.ceil;
  quality = Math.min(quality, qualityCeil);
  let nextDensity = q.dens * (LITE_MODE ? 0.72 : 1);
  let nextEdge = LITE_MODE ? Math.min(q.edge, 1200) : q.edge;
  let changed = DENSITY !== nextDensity || MAX_EDGE !== nextEdge;
  DENSITY = nextDensity;
  MAX_EDGE = nextEdge;
  if (changed && typeof windowResized === 'function') windowResized();
  let cap = document.getElementById('axhint');
  if (cap) {
    clearTimeout(cap._t);
    cap.classList.remove('tour');
    cap.innerHTML = '<b>' + q.name + '</b><em>press F to change</em><cite>' + q.zh + ' · 按 F 切换</cite>';
    cap.classList.add('on');
    cap._t = setTimeout(function () { cap.classList.remove('on'); }, 1800);
  }
}


const PERF_ON = /(^|[?&])perf\b/.test(location.search);
let PERF = null;

function perfInit() {
  if (!PERF_ON || PERF) return;
  PERF = { n: 0, frame: 0, grow: 0, ink: 0, grade: 0, grain: 0, nut: 0, field: 0, el: null };
  let wrap = function (name, key) {
    let f = window[name];
    if (typeof f !== 'function') return;
    window[name] = function () {
      let t = performance.now();
      let r = f.apply(this, arguments);
      PERF[key] += performance.now() - t;
      return r;
    };
  };
  wrap('grow', 'grow'); wrap('batchFlush', 'ink'); wrap('applyTone', 'grade');
  wrap('drawGrain', 'grain'); wrap('drawNutrients', 'nut');

  let d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:15px;bottom:13px;z-index:40;pointer-events:none;'
    + 'font:400 11px/1.65 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;'
    + 'color:#f4f4f4;opacity:.6;letter-spacing:.08em;white-space:pre';
  document.body.appendChild(d);
  PERF.el = d;
}

function perfTick() {
  if (!PERF || !PERF.el) return;
  PERF.n++;
  PERF.frame += (typeof deltaTime === 'number' && deltaTime > 0) ? Math.min(deltaTime, 400) : 16.7;
  if (PERF.n < 30) return;
  let n = PERF.n;
  let f = function (v) { return (v / n).toFixed(1).padStart(6); };
  PERF.el.textContent =
      'FRAME ' + f(PERF.frame) + '  ' + (1000 * n / PERF.frame).toFixed(0) + ' fps\n'
    + 'sim   ' + f(PERF.grow)  + '\n'
    + 'ink   ' + f(PERF.ink)   + '\n'
    + 'grade ' + f(PERF.grade) + '\n'
    + 'grain ' + f(PERF.grain) + '\n'
    + 'field ' + f(PERF.field) + '\n'
    + 'dust  ' + f(PERF.nut)   + '\n'
    + 'q     ' + quality.toFixed(2).padStart(6);
  PERF.n = 0; PERF.frame = 0; PERF.grow = 0; PERF.ink = 0;
  PERF.grade = 0; PERF.grain = 0; PERF.nut = 0; PERF.field = 0;
}


let toneCrush = 0.30;
let toneLift  = 0.24;
let bloomAmt  = 0.11;
let bloomScale = 6;
let bloomBlur = 3.4;
let bloomBuf  = null;


let rimAmt    = 0.14;
let rimRatio  = 0.30;
let rimBuf    = null;


let vignette   = 0.30;
let mottle     = 0.055;
let vignetteBuf = null;


/* ---- §8  影调 · 颗粒 · 暗角 / TONE, GRAIN & VIGNETTE -------------------- */

// 暗角烤成一张小图——径向渐变是逐像素求值的，而它一百帧也不变一下。
// The vignette is baked once: a radial gradient is evaluated per pixel, and this one does not change for a hundred frames.
function vignetteTile(w, h) {
  if (vignetteBuf && vignetteBuf.w === w && vignetteBuf.h === h
      && vignetteBuf.v === vignette && vignetteBuf.m === mottle) {
    return vignetteBuf.c;
  }
  let sw = Math.max(16, Math.round(w / 8)), sh = Math.max(16, Math.round(h / 8));
  let cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  let x = cv.getContext('2d');
  let r = Math.sqrt(sw * sw + sh * sh) * 0.5;
  let g = x.createRadialGradient(sw / 2, sh / 2, r * 0.42, sw / 2, sh / 2, r);
  g.addColorStop(0.00, 'rgba(0,0,0,0)');
  g.addColorStop(0.62, 'rgba(0,0,0,' + (vignette * 0.30).toFixed(3) + ')');
  g.addColorStop(1.00, 'rgba(0,0,0,' + vignette.toFixed(3) + ')');
  x.fillStyle = g;
  x.fillRect(0, 0, sw, sh);


  if (mottle > 0) {
    let n = 13;
    for (let i = 0; i < n; i++) {
      let bx = hash01(i * 7.11 + 1) * sw;
      let by = hash01(i * 3.77 + 2) * sh;
      let br = (0.22 + hash01(i * 5.31 + 3) * 0.30) * Math.max(sw, sh);
      let ba = mottle * (0.45 + hash01(i * 9.13 + 4) * 0.55);
      let bg = x.createRadialGradient(bx, by, 0, bx, by, br);
      bg.addColorStop(0.0, 'rgba(0,0,0,' + ba.toFixed(4) + ')');
      bg.addColorStop(1.0, 'rgba(0,0,0,0)');
      x.fillStyle = bg;
      x.fillRect(0, 0, sw, sh);
    }
  }

  vignetteBuf = { w: w, h: h, v: vignette, m: mottle, c: cv };
  return cv;
}

function applyTone() {
  let ctx = drawingContext, c = ctx.canvas;
  if (!c.width || !c.height) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';


  if (bloomAmt > 0.004 || rimAmt > 0.004) {
    let bw = Math.max(2, Math.round(c.width / bloomScale));
    let bh = Math.max(2, Math.round(c.height / bloomScale));
    if (!bloomBuf || bloomBuf.width !== bw || bloomBuf.height !== bh) {
      bloomBuf = document.createElement('canvas');
      bloomBuf.width = bw; bloomBuf.height = bh;
      rimBuf = document.createElement('canvas');
      rimBuf.width = bw; rimBuf.height = bh;
    }
    let b = bloomBuf.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'copy';
    b.globalAlpha = 1;

    let src = sampleFrame();
    b.filter = 'blur(' + bloomBlur + 'px)';
    if (src) b.drawImage(src, 0, 0, bw, bh); else b.drawImage(c, 0, 0, bw, bh);
    b.filter = 'none';


    if (rimAmt > 0.004) {
      let r = rimBuf.getContext('2d');
      r.setTransform(1, 0, 0, 1, 0, 0);
      r.globalCompositeOperation = 'copy';
      r.globalAlpha = 1;
      let src2 = sampleFrame();
      r.filter = 'blur(' + (bloomBlur * rimRatio).toFixed(2) + 'px)';
      if (src2) r.drawImage(src2, 0, 0, bw, bh); else r.drawImage(c, 0, 0, bw, bh);
      r.filter = 'none';
      r.globalCompositeOperation = 'difference';
      r.drawImage(bloomBuf, 0, 0);
    }


    let carry = null, carryAmt = 0;
    if (bloomAmt > 0.004 && rimAmt > 0.004) {
      if (rimAmt >= bloomAmt) {
        let r = rimBuf.getContext('2d');
        r.setTransform(1, 0, 0, 1, 0, 0);
        r.globalCompositeOperation = 'lighter';
        r.globalAlpha = bloomAmt / rimAmt;
        r.drawImage(bloomBuf, 0, 0);
        r.globalAlpha = 1;
        carry = rimBuf; carryAmt = rimAmt;
      } else {
        let g2 = bloomBuf.getContext('2d');
        g2.setTransform(1, 0, 0, 1, 0, 0);
        g2.globalCompositeOperation = 'lighter';
        g2.globalAlpha = rimAmt / bloomAmt;
        g2.drawImage(rimBuf, 0, 0);
        g2.globalAlpha = 1;
        carry = bloomBuf; carryAmt = bloomAmt;
      }
    } else if (bloomAmt > 0.004) { carry = bloomBuf; carryAmt = bloomAmt; }
    else if (rimAmt   > 0.004) { carry = rimBuf;   carryAmt = rimAmt; }

    if (carry) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = carryAmt;
      ctx.drawImage(carry, 0, 0, c.width, c.height);
    }
  }

  if (vignette > 0 && qStep >= 1) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(vignetteTile(c.width, c.height), 0, 0, c.width, c.height);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  blendMode(BLEND);
}

function grainPass(ctx, c, pat) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;


  let ox = Math.floor(Math.random() * GRAIN_TEX);
  let oy = Math.floor(Math.random() * GRAIN_TEX);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = pat;
  ctx.fillRect(ox, oy, c.width, c.height);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawGrain() {
  let ctx = drawingContext, c = ctx.canvas;
  if (grain && (grainMix > 0.01 || grainMul > 0.01)) {
    if (!grainPat) grainPat = ctx.createPattern(grain, 'repeat');
    if (grainPat) grainPass(ctx, c, grainPat);
  }
  blendMode(BLEND);
}


/* ---- §9  纹理与工具 / TEXTURES & UTILITIES ------------------------------ */
function makeGlow(size) {
  let g = createGraphics(size, size);
  g.clear();
  let ctx = g.drawingContext, r = size / 2;
  let grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return g;
}


// 一张 RGBA 瓦片同时做亮粒与暗粒，把两次全幅合成折成一次。
// One RGBA tile carries both the light and the dark grain, folding two full-frame passes into one.
function makeGrain(size) {
  let cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  let x = cv.getContext('2d');
  let img = x.createImageData(size, size);
  let d = img.data, block = Math.max(1, GRAIN_BLOCK | 0);
  for (let by = 0; by < size; by += block) {
    for (let bx = 0; bx < size; bx += block) {
      let va = Math.random(), vd = Math.random();
      va *= va; vd *= vd;
      let light = va * grainPeak * grainMix;
      let bite = vd * grainBite * grainMul;
      let alpha = Math.min(0.95, light + bite);
      let gray = alpha > 1e-6 ? Math.round(255 * light / alpha) : 0;
      let aa = Math.round(255 * alpha);
      let yh = Math.min(block, size - by), xw = Math.min(block, size - bx);
      for (let yy = 0; yy < yh; yy++) {
        let o = ((by + yy) * size + bx) * 4;
        for (let xx = 0; xx < xw; xx++, o += 4) {
          d[o] = gray; d[o + 1] = gray; d[o + 2] = gray; d[o + 3] = aa;
        }
      }
    }
  }
  x.putImageData(img, 0, 0);
  grainPat = null;
  return cv;
}

function hash01(n) {
  let v = Math.sin(n * 12.9898) * 43758.5453123;
  return v - Math.floor(v);
}

function applyCoreScale() {
  glowSize   = gs(BASE_GLOW_SIZE);
  dotSize    = gs(BASE_DOT_SIZE);
  nutCount   = cs(BASE_NUT_COUNT);
  nutRadius  = gs(BASE_NUT_RADIUS);
  nutDrift   = gs(BASE_NUT_DRIFT);
  nutScatter = gs(BASE_NUT_SCATTER);
}


strokeW = 0.92;
inkBlur = 1.25;


depthDim     = 0.62;
layerBlurFar = 1.50;


BASE_NUT_COUNT   = 220;
BASE_NUT_RADIUS  = 36;
BASE_NUT_DRIFT   = 0;
BASE_NUT_SCATTER = 130;


BASE_GLOW_SIZE   = 10;
BASE_DOT_SIZE    = 6;
nutAmountMin = 20;  nutAmountMax = 40;
nutLifeMin   = 600; nutLifeMax   = 1500;
nutNearBias  = 0.30;
nutDotAlphaMin = 0.00; nutDotAlphaMax = 0.16;
feedDepletion = 0.05; feedCrowdDrain = 0.12;


let BASE_TARGET_CELLS = 900;
let targetCells;
let abundance = 1.0;


let FEED_YIELD = 3.0;
glowAlpha = 0.42;


maxGlowAlpha = 1.0;

grainMix = 0.55;

trailMs = 380;
birthFadeSpeed = 0.045;
deathFadeSpeed = 0.022;

let BASE_REST = 9;


let wavelength = 1.8;


const BOUNDS = ['disc', 'slot', 'free', 'box', 'ring', 'clump'];
const BOX_ASPECT = 1.35;
let bound = 'disc';

let BASE_EDGE_MARGIN = 90;
let BASE_SEED_RADIUS = 230;
let rest, sep, edgeMargin, seedRadius, cleaveDone;

let springK = 0.16;


let bendK = 0.16;


let grainAmt = 0.0;
let grainAngle = 0;
let grainMode = 'axis';
let grainS = 1, cosG = 1, sinG = 0;


let turgor = 1.10;
let pressureK = 0.14;
let statExcess = 1;
let motionDamping = 0.62;
let edgeK = 0.055;
let BASE_SEP_K  = 0.42;
let BASE_CHEMO  = 0.09;
let BASE_MAX_FORCE = 1.2;
let BASE_MAX_SPEED = 1.4;
let sepK, chemo, maxForce, maxSpeed;
let chemoHunger = 0.8;

let BASE_MAX_NODES = 2600;
let BASE_MAX_RINGS = 14;
let BASE_MIN_RING  = 26;
let maxNodes, maxRings, minRingNodes;

let threshold  = 14;
let absorb     = 0.35;
let upkeep     = 0.07;
let nutrientDecay = 0.85;
let deathFloor = -12;
let maxAgeBase = 1400;
let startFood  = threshold * 0.35;
let birthProb  = 0.12;


let marginal = 0.0;

let growthRate = 0.0045;
let deathRate  = 0.0035;

let transitionRest = 0.42;


let division = 0.35;
let BASE_MITOSIS_SIZE = 165;
let mitosisSize;
let mitosisFood   = -1.2;
let mitosisAge    = 260;
let mitosisProbe  = 16;
let cleaveBand    = 8;
let BASE_CLEAVE_K = 0.24;
let cleaveK;
let cleaveTimeout = 700;
let cleaveCooldown = 420;

let rings = [];
let flat  = [];
let spawnedScratch = [];
let nextRingId = 1;


let statCleaveStart = 0, statCleaveDone = 0, statCleaveAbort = 0;


let tissueLayer = null;
let memory = 0.75;
let tissueInk = 0.35;


const TISSUE_EVERY = 3;
const FADE_EVERY   = 12;


let TISSUE_CEIL = 104;


let weightAxis = 0.55;
let shading = 0.5;


/* 参数轴与预设：把系统条件映射为可交互参数，并提供代表性自然形态作为入口。
   Axes and presets: map system conditions to interactive parameters and provide representative natural forms as starting points. */

/* ---- §10  参数轴与预设 / AXES & PRESETS --------------------------------- */
const AXES = [
  { k:'abundance', en:'Abundance',   zh:'丰饶', g:0, min:0.30, max:2.50, step:0.01, def:1.00 },
  { k:'division',  en:'Division',    zh:'分裂', g:0, min:0,    max:1,    step:0.01, def:0.30 },

  { k:'wave',      en:'Wavelength',  zh:'褶距', g:1, min:0,    max:1,    step:0.01, def:0.30 },
  { k:'stiff',     en:'Stiffness',   zh:'韧劲', g:1, min:0,    max:1,    step:0.01, def:0.34 },
  { k:'turgorA',   en:'Turgor',      zh:'鼓胀', g:1, min:0,    max:1,    step:0.01, def:0.35 },
  { k:'margin',    en:'Margin',      zh:'缘生', g:1, min:0,    max:1,    step:0.01, def:0.00 },
  { k:'grain',     en:'Grain',       zh:'顺纹', g:1, min:0,    max:1,    step:0.01, def:0.00 },
  { k:'angle',     en:'Grain angle', zh:'纹向', g:1, min:-180, max:180,  step:1,    def:0    },

  { k:'growth',    en:'Growth',      zh:'生长', g:2, min:0,    max:1,    step:0.01, def:0.30 },
  { k:'flux',      en:'Flux',        zh:'无常', g:2, min:0,    max:1,    step:0.01, def:0.28 },
  { k:'weight',    en:'Weight',      zh:'粗细', g:2, min:0,    max:1,    step:0.01, def:0.46 },
  { k:'shade',     en:'Shading',     zh:'明暗', g:2, min:0,    max:1,    step:0.01, def:0.50 },

  { k:'memoryA',   en:'Memory',      zh:'记忆', g:3, min:0,    max:1,    step:0.01, def:0.75 },
  { k:'tissue',    en:'Tissue',      zh:'组织', g:3, min:0,    max:1,    step:0.01, def:0.45 }
];

const GROUPS = [
  { en:'The world', zh:'这个世界' },
  { en:'The form',  zh:'长成什么样' },
  { en:'The life',  zh:'怎么活着' },
  { en:'The past',  zh:'留下什么' }
];

let P = {};
for (let i = 0; i < AXES.length; i++) P[AXES[i].k] = AXES[i].def;


const PRESETS = [


  { k:'cortex', en:'Cortex',  zh:'脑回',   b:'disc', gm:'axis', seeds:1, depth:0.85,
    p:{ abundance:1.0, division:0,   wave:0.45, stiff:0.46, turgorA:0.46, margin:0,
        grain:0.55, angle:0,  growth:0.30, flux:0.20, weight:0.46, shade:0.55,
        memoryA:0.82, tissue:0.48 } },


  { k:'villi',  en:'Villi',   zh:'肠绒毛', b:'ring', gm:'radial', seeds:3, depth:1.00, fillOut:1,
    cells:3.4,
    p:{ abundance:2.1, division:0.30, wave:0.42, stiff:0.40, turgorA:0.26, margin:0.15,
        grain:0,    angle:0,  growth:0.28, flux:0.10, weight:0.36, shade:0.52,
        memoryA:0.86, tissue:0.62 } },

  { k:'coral',  en:'Coral',   zh:'珊瑚',   b:'free', gm:'radial', seeds:1, depth:1.00,
    p:{ abundance:1.0, division:0,   wave:0.50, stiff:0.34, turgorA:0.50, margin:0.85,
        grain:0.30, angle:0,  growth:0.30, flux:0.16, weight:0.42, shade:0.56,
        memoryA:1.00, tissue:0.58 } },

  { k:'kale',   en:'Kale',    zh:'羽衣甘蓝', b:'free', gm:'axis', seeds:1, depth:0.90,
    p:{ abundance:1.0, division:0,   wave:0.14, stiff:0.12, turgorA:0.36, margin:1.00,
        grain:0,    angle:0,  growth:0.36, flux:0.14, weight:0.32, shade:0.50,
        memoryA:0.90, tissue:0.42 } },


  { k:'colony', en:'Colony',  zh:'菌落',   b:'clump', gm:'axis', seeds:6, depth:1.00,
    cells:0.95,
    p:{ abundance:1.0, division:0.10, wave:0.40, stiff:0.52, turgorA:0.60, margin:0.30,
        grain:0,    angle:0,  growth:0.34, flux:0.30, weight:0.40, shade:0.50,
        memoryA:0.70, tissue:0.44 } },

  { k:'random', en:'Random',  zh:'随机',   rand:true, b:'box', gm:'axis', seeds:1, depth:0.95, p:{} }
];
let PRESET = 'cortex';
let presetDirty = false;

function presetDef() {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === PRESET) return PRESETS[i];
  return PRESETS[0];
}


let settleBoost = 0;


function nudge(k, amt) {
  let a = (typeof amt === 'number' && isFinite(amt)) ? Math.min(1, amt) : 1;
  settleBoost = Math.min(1, settleBoost + 0.35 + a * 2.5);
}

function applyScale() {
  applyCoreScale();

  if (tissueLayer && (tissueLayer.width !== tissueW() || tissueLayer.height !== tissueH())) makeTissue();
  rest       = gs(BASE_REST);
  edgeMargin = gs(BASE_EDGE_MARGIN);
  ringBand   = gs(52);
  clumpBand  = gs(15);
  clumpMax   = gs(92);
  seedRadius = gs(BASE_SEED_RADIUS);
  cleaveDone = rest * 0.9;
  sepK     = gs(BASE_SEP_K);
  chemo    = gs(BASE_CHEMO);
  maxForce = gs(BASE_MAX_FORCE);
  maxSpeed = gs(BASE_MAX_SPEED);
  cleaveK  = gs(BASE_CLEAVE_K);


  targetCells  = cs(BASE_TARGET_CELLS * (presetDef().cells || 1));
  maxNodes     = cs(BASE_MAX_NODES);
  maxRings     = cs(BASE_MAX_RINGS);
  minRingNodes = BASE_MIN_RING;
  applyAxes();
}


// 面板的十几根轴在这里翻译成引擎变量。推一下滑杆只重跑这一个函数。
// The axes are resolved into engine variables here; moving a slider re-runs this one function and nothing else.
function applyAxes() {
  abundance = P.abundance;
  division  = P.division;

  wavelength = 1.1 + P.wave * 2.6;
  sep        = rest * wavelength;
  bendK      = P.stiff * 0.5;
  turgor     = 0.75 + P.turgorA * 1.10;
  marginal   = P.margin;

  grainAmt   = P.grain;
  grainAngle = P.angle;
  grainS     = 1 + grainAmt * 1.6;
  cosG = Math.cos(grainAngle * Math.PI / 180);
  sinG = Math.sin(grainAngle * Math.PI / 180);


  let surge = 1 + settleBoost * 2.2;
  growthRate = (0.0012 + P.growth * 0.0115) * surge;
  deathRate  = (0.0010 + P.flux   * 0.0105) * surge;
  maxAgeBase = 1400 / Math.max(0.15, 0.3 + P.flux * 1.6);

  weightAxis = P.weight * 1.2;
  shading    = P.shade;
  memory     = P.memoryA;
  tissueInk  = P.tissue;

  let d = presetDef();
  bound = d.b;

  depthAmt = (typeof d.depth === 'number') ? d.depth : 1;
  fillOutside = !!d.fillOut;
  grainMode = d.gm;


  mitosisSize = division <= 0.02 ? Infinity
              : minRingNodes * 2.4 + (1 - division) * 900;
}

/* 生命周期：应用参数、初始化模拟并在每帧推进系统与渲染。
   Lifecycle: applies parameters, initialises the simulation and advances the system and rendering each frame. */

/* ---- §11  生命周期 / LIFECYCLE ------------------------------------------ */
function setup() {
  fitCanvas();
  applyScale();


  structureBlend = SCREEN;
  glow  = makeGlow(GLOW_TEX);
  grain = makeGrain(GRAIN_TEX);
  makeTissue();
  buildPanel();
  plantRings();
  for (let i = 0; i < nutCount; i++) nutrients.push(spawnNutrient(null));
}


const TISSUE_SCALE = 0.5;
function tissueW() { return Math.max(2, Math.round(width  * TISSUE_SCALE)); }
function tissueH() { return Math.max(2, Math.round(height * TISSUE_SCALE)); }

function makeTissue() {
  tissueLayer = createGraphics(tissueW(), tissueH());
  tissueLayer.pixelDensity(1);
  tissueLayer.clear();
}


let tissueWash = 0;
let fillOutside = false;
let fillFalloff = 0.62;

function onTopologyFlip(a, b) {
  if (!a || !b || (a.b === b.b && a.gm === b.gm)) return;
  tissueWash = 120;
}

// 组织层。稳态灰度 = 落笔率 ÷ 衰减率——任何只累加、没有出口的层都会一路爬向纯白。
// The tissue layer. Steady state is deposit rate ÷ decay rate: any layer that only accumulates climbs to white.
function drawTissue() {
  if (tissueInk <= 0.01 || !tissueLayer) return;
  let g = tissueLayer;


  let r = 0.0025 + (1 - memory) * 0.022;
  let ceil255 = tissueInk * TISSUE_CEIL;


  let washing = tissueWash > 0;
  if (washing) { tissueWash--; r = Math.max(r, 0.040); }

  if (frameCount % FADE_EVERY === 0) {
    g.push(); g.noStroke();
    g.fill(0, Math.min(60, r * FADE_EVERY * 255));
    g.rect(0, 0, g.width, g.height); g.pop();
  }

  if (frameCount % TISSUE_EVERY !== 0) return;
  let ink = Math.max(0.8, ceil255 * r * TISSUE_EVERY);


  if (fillOutside) {


    let gc = g.drawingContext;
    let ord = [];
    for (let k = 0; k < rings.length; k++) {
      let nd = rings[k].nodes;
      if (nd.length < 6) continue;
      ord.push({ nodes: nd, R: rings[k].R || 0 });
    }
    ord.sort(function (a, b) { return b.R - a.R; });

    gc.save();
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.globalCompositeOperation = 'copy';
    gc.globalAlpha = 1;

    gc.fillStyle = 'rgba(255,255,255,' + Math.min(0.95, ceil255 / 255).toFixed(3) + ')';
    gc.fillRect(0, 0, g.width, g.height);

    gc.setTransform(TISSUE_SCALE, 0, 0, TISSUE_SCALE, 0, 0);
    let path = function (nd) {
      gc.beginPath();
      let started = false;
      for (let i2 = 0; i2 < nd.length; i2++) {
        if (nd[i2].fade <= 0.02) continue;
        if (!started) { gc.moveTo(nd[i2].x, nd[i2].y); started = true; }
        else gc.lineTo(nd[i2].x, nd[i2].y);
      }
      if (started) gc.closePath();
      return started;
    };

    for (let k = 0; k < ord.length; k++) {

      let inner = (k === ord.length - 1);
      let lv = inner ? 0 : (ceil255 / 255) * Math.pow(fillFalloff, k + 1);
      if (!path(ord[k].nodes)) continue;
      gc.globalCompositeOperation = 'destination-out';
      gc.fillStyle = '#fff';
      gc.fill();
      if (lv > 0.004) {
        gc.globalCompositeOperation = 'source-over';
        gc.fillStyle = 'rgba(255,255,255,' + lv.toFixed(3) + ')';
        gc.fill();
      }
    }
    gc.restore();
    return;
  }

  g.push();
  g.noStroke();
  g.scale(TISSUE_SCALE);
  g.fill(255, ink);
  for (let k = 0; k < rings.length; k++) {
    let n = rings[k].nodes;
    if (n.length < 6) continue;
    g.beginShape();
    for (let i = 0; i < n.length; i++) if (n[i].fade > 0.02) g.vertex(n[i].x, n[i].y);
    g.endShape(CLOSE);
  }
  g.pop();
}


function plantRings() {
  let d0 = presetDef();
  let ns = Math.max(1, Math.round(d0.seeds || 1));
  if (bound === 'ring') {
    let half = Math.min(width, height) * 0.5 - edgeMargin * 0.2;
    for (let i = 0; i < ns; i++) {
      let u = ns > 1 ? i / (ns - 1) : 0.62;
      let R = half * (ringInner + (ringOuter - ringInner) * u);
      let ring = makeRing(width / 2, height / 2, seedRingNodes(R), R, startFood, false);
      ring.R = R;
      for (let j = 0; j < ring.nodes.length; j++) ring.nodes[j].ringR = R;
      rings.push(ring);
    }
    return;
  }
  if (ns > 1) {

    let rad = Math.min(seedRadius * 0.42, clumpMax * 0.55);
    for (let i = 0; i < ns; i++) {
      let a = TWO_PI * i / ns + random(-0.35, 0.35);
      let d = Math.min(width, height) * random(0.16, 0.34);
      rings.push(makeRing(width / 2 + cos(a) * d, height / 2 + sin(a) * d,
                          seedRingNodes(rad), rad, startFood, false));
    }
    return;
  }
  rings.push(makeRing(width / 2, height / 2, seedRingNodes(seedRadius), seedRadius, startFood, false));
}

function reseed() {
  rings = []; flat = []; nutrients = []; nextRingId = 1;
  if (tissueLayer) tissueLayer.clear();
  tissueWash = 0;
  statCleaveStart = statCleaveDone = statCleaveAbort = 0;
  plantRings();
  for (let i = 0; i < nutCount; i++) nutrients.push(spawnNutrient(null));
}

function draw() {
  adaptQuality();
  stepMorph();

  if (!morph && settleBoost > 0) { settleBoost = Math.max(0, settleBoost - 0.008); applyAxes(); }
  for (let s = 0; s < SIM_STEPS; s++) grow();
  drawTissue(); render(); syncPanel();
}


/* 键盘交互：提供展陈与调试所需的面板、重置、巡演、导出、画质和全屏控制。
   Keyboard interaction: provides panel, reset, tour, export, quality and fullscreen controls for exhibition and testing. */
function keyPressed() {
  if (key === 'h' || key === 'H') {
    let el = document.getElementById('axes');

    if (el && el.classList.toggle('hidden') === false && panelReveal) panelReveal();
  }
  if (key === 'r' || key === 'R') reseed();
  if (key === 't' || key === 'T') setTour(!tour);
  if (key === 'e' || key === 'E') exportNow();
  if (key === 'f' || key === 'F') cycleQuality();
  if (key === 'q' || key === 'Q') toggleFullscreen();
}


function toggleFullscreen() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'sys:fullscreen' }, '*');
    return;
  }
  goFullscreen();
}

function goFullscreen() {
  let d = document;
  let on = d.fullscreenElement || d.webkitFullscreenElement;
  try {
    if (on) {
      let ex = d.exitFullscreen || d.webkitExitFullscreen;
      if (ex) ex.call(d);
    } else {
      let e = d.documentElement;
      let req = e.requestFullscreen || e.webkitRequestFullscreen;
      if (req) {
        let p = req.call(e);
        if (p && p.catch) p.catch(function () {});
      }
    }
  } catch (err) {}
}

/* 生长模型：更新营养、弹簧力、膨压、弯曲、分裂与细胞生命周期。
   Growth model: updates feeding, spring forces, turgor, bending, division and cell lifecycle. */

/* ---- §12  模拟 / SIMULATION --------------------------------------------- */
function grow() {
  layoutRings();
  rebuildFlat();

  for (let i = 0; i < flat.length; i++) {
    let c = flat[i];
    advanceFade(c);
    c.fx = 0; c.fy = 0;
    c.cleaveTag = 0;
  }

  for (let r = 0; r < rings.length; r++) {
    let nodes = rings[r].nodes, L = nodes.length;
    if (L < 2) continue;
    for (let i = 0; i < L; i++) {
      springPair(nodes[i], nodes[(i + 1) % L]);
    }
    analyzeFolds(nodes, L);
    if (bendK > 0) bendRing(nodes, L);
    applyTurgor(nodes, L);
  }

  for (let r = 0; r < rings.length; r++) {
    rings[r].age++;
    if (rings[r].cooldown > 0) rings[r].cooldown--;
    tryStartMitosis(rings[r]);
    applyCleavage(rings[r]);
  }

  separateCells();


  let perCell = upkeep / absorb * (1 - nutrientDecay);
  feedBudget = constrain(
    abundance * FEED_YIELD * targetCells * perCell / Math.max(1, nutrients.length),
    0, 20);

  updateNutrients(flat);
  feedByBudget(flat);
  for (let i = 0; i < flat.length; i++) {
    let c = flat[i];
    c.nutrient += c.intake;
    let hunger = constrain(1 - c.food / c.divThresh, 0, 1);
    let k = chemo * (1 + chemoHunger * hunger);
    c.fx += c.pullx * k;
    c.fy += c.pully * k;
  }

  integrate();

  for (let i = 0; i < flat.length; i++) {
    let c = flat[i];
    c.food += c.nutrient * absorb - upkeep;
    c.nutrient *= nutrientDecay;
    c.age++;
  }

  let total = flat.length;
  for (let r = 0; r < rings.length; r++) {
    markDeaths(rings[r]);
    total += divideCells(rings[r], total);
  }

  for (let r = 0; r < rings.length; r++) {
    let nodes = rings[r].nodes, write = 0;
    for (let i = 0; i < nodes.length; i++) {
      let c = nodes[i];
      if (!(c.dying && c.fade <= 0)) nodes[write++] = c;
    }
    nodes.length = write;
  }

  spawnedScratch.length = 0;
  for (let r = 0; r < rings.length; r++) tryFinishMitosis(rings[r], spawnedScratch);
  for (let i = 0; i < spawnedScratch.length; i++) rings.push(spawnedScratch[i]);

  cullRings();
}

function rebuildFlat() {
  flat.length = 0;
  for (let r = 0; r < rings.length; r++) {
    let nodes = rings[r].nodes;
    for (let i = 0; i < nodes.length; i++) flat.push(nodes[i]);
  }
}

// 环上的弹簧。过渡期用静默长度，让插入与移除变成长度的连续变化。
// The springs along the ring, with a muted rest length during transitions so insertion and removal become continuous.
function springPair(a, b) {
  let dx = b.x - a.x, dy = b.y - a.y;
  let L = Math.sqrt(dx * dx + dy * dy);
  if (L <= 0) return;
  let f = Math.min(a.fade, b.fade);
  let restLen = rest * (transitionRest + (1 - transitionRest) * f);
  let m = (L - restLen) * springK / L;
  let px = dx * m, py = dy * m;
  a.fx += px; a.fy += py;
  b.fx -= px; b.fy -= py;
}


// 膨压。真实的膜靠它顶着，褶皱才是“鼓着的膜挤不下”，而不是“泄了气的膜皱起来”。
// Turgor. A real membrane is held out by it, so folding is a swollen sheet running out of room rather than a deflated one creasing.
function applyTurgor(nodes, L) {
  if (L < 8) return;

  let per = nodes._perimeter || 0, A2 = nodes._area2 || 0;
  let area = Math.abs(A2) / 2;
  if (area < 1) return;
  statExcess += (per / (2 * Math.sqrt(Math.PI * area)) - statExcess) * 0.05;


  let want = L * (rest * turgor) * (rest * turgor);
  if (area >= want) return;
  let deficit = constrain(1 - area / want, 0, 1);
  let sgn = (A2 > 0 ? 1 : -1);
  let mag = pressureK * deficit * rest;

  for (let i = 0; i < L; i++) {
    let c = nodes[i];
    let a = nodes[(i - 1 + L) % L], b = nodes[(i + 1) % L];
    let tx = b.x - a.x, ty = b.y - a.y;
    let tl = Math.hypot(tx, ty);
    if (tl < 1e-6) continue;
    c.fx += (ty / tl) * mag * sgn * c.fade;
    c.fy += (-tx / tl) * mag * sgn * c.fade;
  }
}


const COARSE = 8;

// 褶级。闭合曲线没有拓扑等级，改用尺度：偏离粗尺度平滑位置越远，越属于次级褶。
// Fold order. A closed curve has no topological hierarchy, so scale stands in: the further from the coarse-smoothed position, the finer the fold.
function analyzeFolds(nodes, L) {
  let per = 0, A2 = 0;
  for (let i = 0; i < L; i++) {
    let a = nodes[i], b = nodes[(i + 1) % L];
    per += Math.hypot(b.x - a.x, b.y - a.y);
    A2 += a.x * b.y - b.x * a.y;
  }
  nodes._perimeter = per;
  nodes._area2 = A2;

  if (L < COARSE * 2 + 3) {
    for (let i = 0; i < L; i++) { nodes[i].coarse = 0.6; nodes[i].curv = 0; }
    return;
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < L; i++) { cx += nodes[i].x; cy += nodes[i].y; }
  cx /= L; cy /= L;

  let devSum = 0;
  let wind = A2 > 0 ? 1 : -1;


  let sx = 0, sy = 0;
  for (let k = -COARSE; k <= COARSE; k++) {
    let n = nodes[((k % L) + L) % L];
    sx += n.x; sy += n.y;
  }
  let m = COARSE * 2 + 1;
  for (let i = 0; i < L; i++) {
    let smx = sx / m, smy = sy / m;
    let c = nodes[i];
    c._dev = Math.hypot(c.x - smx, c.y - smy);
    devSum += c._dev;


    c.rCoarse = Math.hypot(smx - cx, smy - cy);


    let p = nodes[(i - 1 + L) % L], q = nodes[(i + 1) % L];
    let e1x = c.x - p.x, e1y = c.y - p.y, e2x = q.x - c.x, e2y = q.y - c.y;
    let l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
    c.curv = (l1 > 0 && l2 > 0)
      ? wind * (e1x * e2y - e1y * e2x) / (l1 * l2) : 0;


    if (grainMode === 'radial') {
      let rx = c.x - cx, ry = c.y - cy, rl = Math.hypot(rx, ry);
      if (rl > 1e-6) { c.gx = rx / rl; c.gy = ry / rl; } else { c.gx = 1; c.gy = 0; }
    } else { c.gx = cosG; c.gy = sinG; }

    let leaving = nodes[((i - COARSE) % L + L) % L];
    let entering = nodes[(i + COARSE + 1) % L];
    sx += entering.x - leaving.x;
    sy += entering.y - leaving.y;
  }


  let devMean = Math.max(1e-6, devSum / L);
  for (let i = 0; i < L; i++) {
    let r = nodes[i]._dev / devMean;
    nodes[i].coarse = 1 / (1 + r * r);
  }
}

// 抗弯刚度。它是波长的主控，也是均匀性的守门人——接近 0 时养分的不匀会被放大成结块。
// Bending stiffness sets the wavelength and also guards uniformity: near zero, an uneven nutrient field is amplified into clumps.
function bendRing(nodes, L) {
  for (let i = 0; i < L; i++) {
    let c = nodes[i], a = nodes[(i - 1 + L) % L], b = nodes[(i + 1) % L];
    let f = Math.min(c.fade, Math.min(a.fade, b.fade));
    if (f <= 0) continue;
    c.fx += ((a.x + b.x) * 0.5 - c.x) * bendK * f;
    c.fy += ((a.y + b.y) * 0.5 - c.y) * bendK * f;
  }
}

// 互斥。各向异性时网格必须按最长的半轴开，否则该互斥的一对会掉出扫描范围。
// Repulsion. Under anisotropy the grid must be sized to the longest semi-axis, or pairs that should repel fall outside the scan.
function separateCells() {


  let cell = sep;
  let sep2 = sep * sep;
  let aniso = grainS > 1.001;
  let grid = buildGrid(cell, flat);
  for (let i = 0; i < flat.length; i++) {
    let ci = flat[i];
    let cx = Math.floor(ci.x / cell), cy = Math.floor(ci.y / cell);


    let rx = 1, ry = 1;
    if (aniso) {
      let gx = ci.gx, gy = ci.gy, g2 = grainS * grainS;
      rx = Math.ceil(Math.sqrt(g2 * gx * gx + gy * gy));
      ry = Math.ceil(Math.sqrt(g2 * gy * gy + gx * gx));
    }
    for (let ox = -rx; ox <= rx; ox++) {
      for (let oy = -ry; oy <= ry; oy++) {
        let arr = grid.get(gridKey(cx + ox, cy + oy));
        if (!arr) continue;
        for (let a = 0; a < arr.length; a++) {
          let j = arr[a];
          if (j <= i) continue;
          let cj = flat[j];
          if (ci.cleaveTag !== 0 && ci.cleaveTag === cj.cleaveTag) continue;
          let dx = ci.x - cj.x, dy = ci.y - cj.y;
          let d2 = dx * dx + dy * dy;
          if (d2 <= 0) continue;

          let dv2 = d2;
          if (aniso) {
            let ax = ci.gx, ay = ci.gy;
            let u = ( dx * ax + dy * ay) / grainS;
            let v = -dx * ay + dy * ax;
            dv2 = u * u + v * v;
          }
          if (dv2 < sep2) {
            let d = Math.sqrt(d2), dv = Math.sqrt(dv2);
            let soft = Math.min(ci.fade, cj.fade);
            let m = (1 - dv / sep) * sepK * soft / d;
            ci.fx += dx * m; ci.fy += dy * m;
            cj.fx -= dx * m; cj.fy -= dy * m;
          }
        }
      }
    }
  }
}

function integrate() {
  for (let i = 0; i < flat.length; i++) {
    let c = flat[i];
    edgeForce(c);
    let f = Math.sqrt(c.fx * c.fx + c.fy * c.fy);
    if (f > maxForce) { let k = maxForce / f; c.fx *= k; c.fy *= k; }
    c.vx = c.vx * motionDamping + c.fx;
    c.vy = c.vy * motionDamping + c.fy;
    let s = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
    if (s > maxSpeed) { let k = maxSpeed / s; c.vx *= k; c.vy *= k; }
    c.x += c.vx;
    c.y += c.vy;
  }
}


function edgeForce(c) {
  let t;
  if (bound === 'free') {


    let m = edgeMargin * 0.5;
    if (c.x < m)          { t = (m - c.x) / m;          c.fx += edgeK * m * t * t * 0.35; }
    if (c.x > width - m)  { t = (c.x - (width - m)) / m; c.fx -= edgeK * m * t * t * 0.35; }
    if (c.y < m)          { t = (m - c.y) / m;          c.fy += edgeK * m * t * t * 0.35; }
    if (c.y > height - m) { t = (c.y - (height - m)) / m; c.fy -= edgeK * m * t * t * 0.35; }
    return;
  }

  if (bound === 'disc') {

    let cx = width * 0.5, cy = height * 0.5;
    let R = Math.min(width, height) * 0.5 - edgeMargin * 0.35;
    let dx = c.x - cx, dy = c.y - cy;
    let r = Math.hypot(dx, dy);
    if (r > R && r > 0) {
      t = (r - R) / edgeMargin;
      let f = edgeK * edgeMargin * Math.min(1, t) * Math.min(1, t);
      c.fx -= dx / r * f; c.fy -= dy / r * f;
    }
    return;
  }

  if (bound === 'ring' || bound === 'clump') {


    let cx = (c.ringCX !== undefined) ? c.ringCX : width * 0.5;
    let cy = (c.ringCY !== undefined) ? c.ringCY : height * 0.5;
    let R = c.ringR > 0 ? c.ringR : Math.min(width, height) * 0.30;
    let dx = c.x - cx, dy = c.y - cy;
    let r = Math.hypot(dx, dy);
    if (r < 1e-4) { c.fx += edgeK * edgeMargin * 0.5; return; }


    let d = r - R;


    let band = (bound === 'clump')
             ? (d > 0 ? clumpBand : clumpBand * 0.30)
             : (d > 0 ? ringBand * 0.22 : ringBand);

    if (bound === 'clump') {
      let m = edgeMargin * 0.8;
      if (c.x < m)          { let s = (m - c.x) / m;          c.fx += edgeK * m * s * s * 1.4; }
      if (c.x > width - m)  { let s = (c.x - (width - m)) / m; c.fx -= edgeK * m * s * s * 1.4; }
      if (c.y < m)          { let s = (m - c.y) / m;          c.fy += edgeK * m * s * s * 1.4; }
      if (c.y > height - m) { let s = (c.y - (height - m)) / m; c.fy -= edgeK * m * s * s * 1.4; }
    }
    if (Math.abs(d) > band) {
      t = Math.min(1, (Math.abs(d) - band) / edgeMargin);
      let f = edgeK * edgeMargin * t * t * 2.6 * (d > 0 ? 1 : -1);
      c.fx -= dx / r * f; c.fy -= dy / r * f;
    }
    return;
  }

  if (bound === 'slot') {

    let cy = height * 0.5, H = height * 0.16;
    let dy = c.y - cy;
    if (Math.abs(dy) > H) {
      t = (Math.abs(dy) - H) / edgeMargin;
      c.fy -= Math.sign(dy) * edgeK * edgeMargin * Math.min(1, t) * Math.min(1, t) * 2.2;
    }
    if (c.x < edgeMargin)         { t = (edgeMargin - c.x) / edgeMargin;          c.fx += edgeK * edgeMargin * t * t; }
    if (c.x > width - edgeMargin) { t = (c.x - (width - edgeMargin)) / edgeMargin; c.fx -= edgeK * edgeMargin * t * t; }
    return;
  }


  let availW = width - 2 * edgeMargin, availH = height - 2 * edgeMargin;
  let bw = Math.min(availW, availH * BOX_ASPECT), bh = bw / BOX_ASPECT;
  let bx0 = (width - bw) * 0.5, bx1 = bx0 + bw;
  let by0 = (height - bh) * 0.5, by1 = by0 + bh;

  if (c.x < bx0) { t = Math.min(1, (bx0 - c.x) / edgeMargin); c.fx += edgeK * edgeMargin * t * t; }
  if (c.x > bx1) { t = Math.min(1, (c.x - bx1) / edgeMargin); c.fx -= edgeK * edgeMargin * t * t; }
  if (c.y < by0) { t = Math.min(1, (by0 - c.y) / edgeMargin); c.fy += edgeK * edgeMargin * t * t; }
  if (c.y > by1) { t = Math.min(1, (c.y - by1) / edgeMargin); c.fy -= edgeK * edgeMargin * t * t; }
}

// 分级死亡。硬阈值会让一整片细胞同时跨过同一条线，人口因此振荡。
// Graded death: a hard threshold makes a whole stretch cross the same line at once, and the population oscillates.
function markDeaths(ring) {
  let nodes = ring.nodes, L = nodes.length;
  if (L === 0) return;
  let elig = ring._deathElig || (ring._deathElig = []);
  elig.length = 0;
  for (let i = 0; i < L; i++) {
    let c = nodes[i];
    if (c.dying) continue;
    if (c.cleaveTag !== 0) continue;
    if (nodes[(i - 1 + L) % L].dying || nodes[(i + 1) % L].dying) continue;


    if (c.age > c.maxAge) { elig.push(i); continue; }
    if (c.food < 0) {
      let deficit = constrain(c.food / deathFloor, 0, 1);
      if (random() < deficit * deficit * 0.03) elig.push(i);
    }
  }
  shuffle(elig, true);


  let cap = Math.max(1, Math.round(L * deathRate));
  let take = Math.min(cap, elig.length);
  for (let k = 0; k < take; k++) nodes[elig[k]].dying = true;
}

// 增生看的是相对于本环平均值的富裕程度，不是绝对食物量——否则整条膜会变成“结块 + 光杆”。
// Division reads wealth relative to the ring's own mean, not absolute food; absolute food gives clumps joined by bare arcs.
function divideCells(ring, totalSoFar) {
  if (totalSoFar >= maxNodes) return 0;
  let nodes = ring.nodes, L = nodes.length;
  if (L < 2) return 0;


  let meanFood = 0;
  for (let i = 0; i < L; i++) meanFood += nodes[i].food;
  meanFood = meanFood / L;
  let ringDrive = constrain(0.35 + meanFood / threshold, 0, 1.6);


  let mcx = 0, mcy = 0;
  for (let i = 0; i < L; i++) { mcx += nodes[i].x; mcy += nodes[i].y; }
  mcx /= L; mcy /= L;
  let rMean = 0;
  for (let i = 0; i < L; i++) rMean += (nodes[i].rCoarse !== undefined
    ? nodes[i].rCoarse : Math.hypot(nodes[i].x - mcx, nodes[i].y - mcy));
  rMean = Math.max(1e-6, rMean / L);
  let marginPow = marginal * 5;

  let elig = ring._birthElig || (ring._birthElig = []);
  elig.length = 0;
  for (let i = 0; i < L; i++) {
    let a = nodes[i], b = nodes[(i + 1) % L];
    if (a.dying || b.dying) continue;
    if (a.fade < 1) continue;
    if (a.cleaveTag !== 0 || b.cleaveTag !== 0) continue;
    let dx = a.x - b.x, dy = a.y - b.y;
    if (a.food > meanFood * 0.55 && (dx * dx + dy * dy) > (rest * 0.8) * (rest * 0.8)) elig.push(i);
  }
  shuffle(elig, true);

  let chosen = ring._birthChosen || (ring._birthChosen = []);
  chosen.length = 0;

  let room = Math.min(Math.max(1, Math.round(L * growthRate * ringDrive)), maxNodes - totalSoFar);
  for (let k = 0; k < elig.length && chosen.length < room; k++) {
    let a = nodes[elig[k]];

    let w = 1;
    if (marginPow > 0) {
      let rel = (a.rCoarse !== undefined ? a.rCoarse
                 : Math.hypot(a.x - mcx, a.y - mcy)) / rMean;
      w = Math.min(3.5, Math.pow(rel, marginPow));
    }
    if (random() < birthProb * ringDrive * w) chosen.push(elig[k]);
  }
  chosen.sort(function (p, q) { return q - p; });

  for (let k = 0; k < chosen.length; k++) {
    let i = chosen[k];
    let a = nodes[i], b = nodes[(i + 1) % nodes.length];
    a.food *= 0.5;
    let baby = makeCell((a.x + b.x) / 2, (a.y + b.y) / 2, a.food, true);
    baby.vx = (a.vx + b.vx) * 0.5;
    baby.vy = (a.vy + b.vy) * 0.5;
    baby.z  = (a.z + b.z) * 0.5;
    baby.ringR = a.ringR; baby.ringCX = a.ringCX; baby.ringCY = a.ringCY;
    nodes.splice(i + 1, 0, baby);
  }
  return chosen.length;
}

// 颈缩分裂（一）：在环上挑一条最窄的腰作为分裂面。
// Cleavage, part 1: choose the narrowest waist on the ring as the division plane.
function tryStartMitosis(ring) {
  if (ring.cleaveA || ring.cooldown > 0) return;
  if (rings.length >= maxRings) return;
  if (ring.age < mitosisAge) return;
  let L = ring.nodes.length;
  if (L < mitosisSize) return;
  let sum = 0;
  for (let i = 0; i < L; i++) sum += ring.nodes[i].food;
  if (sum / L < mitosisFood) return;

  let half = Math.floor(L / 2);
  let jitter = Math.max(1, Math.floor(L * 0.12));
  let bestA = null, bestB = null, bestD = Infinity;
  for (let t = 0; t < mitosisProbe; t++) {
    let a = Math.floor(random(L));
    let b = (a + half + Math.floor(random(-jitter, jitter)) + L) % L;
    let arc = Math.abs(a - b);
    arc = Math.min(arc, L - arc);
    if (arc < minRingNodes || L - arc < minRingNodes) continue;
    let ca = ring.nodes[a], cb = ring.nodes[b];
    if (ca.dying || cb.dying) continue;
    let d = Math.sqrt((ca.x - cb.x) * (ca.x - cb.x) + (ca.y - cb.y) * (ca.y - cb.y));
    if (d < bestD) { bestD = d; bestA = ca; bestB = cb; }
  }
  if (bestA) { ring.cleaveA = bestA; ring.cleaveB = bestB; ring.cleaveAge = 0; statCleaveStart++; }
}

// 颈缩分裂（二）：收缩带成对相吸，带内互免互斥力，带上的细胞本帧不死也不增生。
// Cleavage, part 2: the band pulls together, exempts itself from repulsion, and its cells neither die nor divide this frame.
function applyCleavage(ring) {
  if (!ring.cleaveA) return;
  let nodes = ring.nodes, L = nodes.length;
  let ai = nodes.indexOf(ring.cleaveA);
  let bi = nodes.indexOf(ring.cleaveB);
  if (ai < 0 || bi < 0 || L < minRingNodes * 2) { abortCleavage(ring); return; }
  ring.cleaveAge++;
  if (ring.cleaveAge > cleaveTimeout) { abortCleavage(ring); return; }
  for (let k = -cleaveBand; k <= cleaveBand; k++) {
    let p = nodes[((ai + k) % L + L) % L];
    let q = nodes[((bi - k) % L + L) % L];
    if (p === q) continue;
    let dx = q.x - p.x, dy = q.y - p.y;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.001) continue;
    let w = cleaveK * (1 - Math.abs(k) / (cleaveBand + 1));
    p.fx += dx / d * w; p.fy += dy / d * w;
    q.fx -= dx / d * w; q.fy -= dy / d * w;
    p.cleaveTag = ring.id; q.cleaveTag = ring.id;
  }
}

function abortCleavage(ring) {
  ring.cleaveA = null; ring.cleaveB = null;
  ring.cleaveAge = 0;
  ring.cooldown = cleaveCooldown;
  statCleaveAbort++;
}

// 颈缩分裂（三）：腰闭合后做拓扑剖分，两条新的闭合边都取紧邻分裂点的节点。
// Cleavage, part 3: once the waist closes, the ring is split; both new closing edges join nodes adjacent to the division plane.
function tryFinishMitosis(ring, out) {
  if (!ring.cleaveA) return;
  let a = ring.cleaveA, b = ring.cleaveB;
  let d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  if (d > cleaveDone) return;
  let nodes = ring.nodes;
  let ai = nodes.indexOf(a), bi = nodes.indexOf(b);
  if (ai < 0 || bi < 0) { abortCleavage(ring); return; }
  let i = Math.min(ai, bi), j = Math.max(ai, bi);
  let partA = nodes.slice(i + 1, j + 1);
  let partB = nodes.slice(j + 1).concat(nodes.slice(0, i + 1));
  if (partA.length < minRingNodes || partB.length < minRingNodes) { abortCleavage(ring); return; }

  ring.nodes = partA;
  ring.cleaveA = null; ring.cleaveB = null; ring.cleaveAge = 0;
  ring.cooldown = cleaveCooldown;
  ring.age = 0;
  statCleaveDone++;

  out.push({ id: nextRingId++, nodes: partB, age: 0,
             cleaveA: null, cleaveB: null, cleaveAge: 0, cooldown: cleaveCooldown });

  let ca = centroidOf(partA), cb = centroidOf(partB);
  let dx = ca.x - cb.x, dy = ca.y - cb.y;
  let len = Math.sqrt(dx * dx + dy * dy) || 1;
  let kick = gs(0.55);
  for (let k = 0; k < partA.length; k++) { partA[k].vx += dx / len * kick; partA[k].vy += dy / len * kick; }
  for (let k = 0; k < partB.length; k++) { partB[k].vx -= dx / len * kick; partB[k].vy -= dy / len * kick; }
}

function centroidOf(list) {
  let x = 0, y = 0;
  for (let i = 0; i < list.length; i++) { x += list[i].x; y += list[i].y; }
  return { x: x / list.length, y: y / list.length };
}

function cullRings() {
  for (let r = 0; r < rings.length; r++) {
    let ring = rings[r];
    if (ring.nodes.length > 0 && ring.nodes.length < minRingNodes) {
      for (let i = 0; i < ring.nodes.length; i++) ring.nodes[i].dying = true;
    }
  }
  let write = 0;
  for (let r = 0; r < rings.length; r++) {
    if (rings[r].nodes.length > 0) rings[write++] = rings[r];
  }
  rings.length = write;
  if (rings.length === 0) {
    rings.push(makeRing(
      random(edgeMargin, width - edgeMargin),
      random(edgeMargin, height - edgeMargin),
      seedRingNodes(seedRadius), seedRadius, startFood, true));
  }
}

/* 模块渲染：将生长边界与组织记忆合成为连续的折叠表面。
   Module rendering: combines the growing boundary with tissue memory into a continuous folded surface. */

/* ---- §13  渲染 / RENDER ------------------------------------------------- */
function render() {
  background(0);
  let ctx = drawingContext;


  if (tissueLayer && tissueInk > 0.01) inkBase = { canvas: tissueLayer.elt, alpha: 1 };
  else inkBase = null;

  blendMode(structureBlend);
  drawRings();
  drawNutrients();
  ctx.globalAlpha = 1;
  blendMode(BLEND);
  applyTone();
  drawGrain();
}


let ringBand  = 52;
let clumpBand = 15;
let clumpMax  = 92;
let clumpExcess = 0.16;
let ringInner = 0.32;
let ringOuter = 0.99;

// 多环布局：同心环与团。分裂出来的子环在这里各自拿到自己的半径与中心。
// Ring layout, concentric or clumped: each ring born from a division gets its own radius and centre here.
function layoutRings() {
  if (rings.length === 0) return;


  if (bound === 'clump') {
    for (let i = 0; i < rings.length; i++) {
      let ring = rings[i], nd = ring.nodes, L = nd.length;
      if (!L) continue;
      let cx = 0, cy = 0, per = 0;
      for (let j = 0; j < L; j++) {
        cx += nd[j].x; cy += nd[j].y;
        let k = (j + 1) % L;
        per += Math.hypot(nd[k].x - nd[j].x, nd[k].y - nd[j].y);
      }
      cx /= L; cy /= L;


      let R = Math.min(clumpMax, per / (TWO_PI * (1 + clumpExcess)));

      ring.R  = ring.R > 0 ? ring.R + (R - ring.R) * 0.06 : R;
      ring.cx = ring.cx !== undefined ? ring.cx + (cx - ring.cx) * 0.15 : cx;
      ring.cy = ring.cy !== undefined ? ring.cy + (cy - ring.cy) * 0.15 : cy;
      ring.zBase = undefined;
      for (let j = 0; j < L; j++) {
        nd[j].ringR = ring.R; nd[j].ringCX = ring.cx; nd[j].ringCY = ring.cy;
      }
    }
    return;
  }

  if (bound !== 'ring') return;
  let half = Math.min(width, height) * 0.5 - edgeMargin * 0.2;
  let lo = half * ringInner, hi = half * ringOuter;
  let cx = width * 0.5, cy = height * 0.5;


  let order = [];
  for (let i = 0; i < rings.length; i++) {
    let nd = rings[i].nodes;
    if (!nd.length) continue;
    let rr = 0;
    for (let j = 0; j < nd.length; j++) rr += Math.hypot(nd[j].x - cx, nd[j].y - cy);
    order.push({ ring: rings[i], r: rr / nd.length });
  }
  order.sort(function (a, b) { return a.r - b.r; });

  for (let i = 0; i < order.length; i++) {
    let u = order.length > 1 ? i / (order.length - 1) : 0.62;
    let R = lo + (hi - lo) * u;
    let ring = order[i].ring;
    ring.R = R;
    ring.zBase = 0.10 + 0.90 * u;
    for (let j = 0; j < ring.nodes.length; j++) {
      ring.nodes[j].ringR = R;
      ring.nodes[j].ringCX = cx; ring.nodes[j].ringCY = cy;
    }
  }
}

function seedRingNodes(radius) {
  return Math.max(minRingNodes + 2, Math.round(TWO_PI * radius / Math.max(1, rest)));
}

function makeRing(cx, cy, count, radius, food, newborn) {
  let ring = { id: nextRingId++, nodes: [], age: 0,
               cleaveA: null, cleaveB: null, cleaveAge: 0, cooldown: cleaveCooldown };
  for (let i = 0; i < count; i++) {
    let a = TWO_PI * i / count;
    ring.nodes.push(makeCell(cx + cos(a) * radius, cy + sin(a) * radius, food, newborn));
  }
  return ring;
}

function makeCell(x, y, food, newborn) {
  return {
    x: x, y: y, vx: 0, vy: 0, fx: 0, fy: 0,
    pullx: 0, pully: 0, intake: 0,
    nutrient: 0, food: food, age: 0,
    divThresh: threshold * random(0.8, 1.2),
    maxAge: maxAgeBase * random(0.6, 1.4),
    coarse: 0.6, curv: 0, gx: 1, gy: 0, rCoarse: undefined,
    z: zSeed(x, y),
    ringR: 0, ringCX: undefined, ringCY: undefined,
    dying: false, fade: newborn ? 0 : 1, cleaveTag: 0
  };
}

function countAlive() {
  let n = 0;
  for (let i = 0; i < flat.length; i++) if (!flat[i].dying) n++;
  return n;
}


let zSpread = 0.46;


let zCurv   = 0.20;
let zPull   = 0.055;
let zSmooth = 0.55;

function zSeed(x, y) {
  return 0.5 + (zField(x, y) - 0.5) * 2 * zSpread * depthAmt;
}

const CURVE_STEP = 6;

let vsmooth = 0.85;

function drawRings() {
  batchBegin();
  for (let r = 0; r < rings.length; r++) {
    let ring = rings[r], nodes = ring.nodes, L = nodes.length;
    if (L < 4) continue;


    let xs = ring._drawX || (ring._drawX = []);
    let ys = ring._drawY || (ring._drawY = []);
    xs.length = L; ys.length = L;
    for (let i = 0; i < L; i++) {
      let n = nodes[i];
      if (n.dying) {
        let a = nodes[(i - 1 + L) % L], b = nodes[(i + 1) % L];
        let mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
        let k = retractK(n.fade);
        xs[i] = mx + (n.x - mx) * k;
        ys[i] = my + (n.y - my) * k;
      } else { xs[i] = n.x; ys[i] = n.y; }
    }


    let zs = ring._drawZ || (ring._drawZ = []);
    zs.length = L;
    for (let i = 0; i < L; i++) {
      let n = nodes[i];


      let zt0 = (typeof ring.zBase === 'number' && bound === 'ring')
              ? ring.zBase + (zField(n.x, n.y) - 0.5) * 0.12 * depthAmt
              : zSeed(n.x, n.y) + zCurv * constrain(n.curv, -1, 1);
      n.z += (zt0 - n.z) * zPull;
      zs[i] = n.z;
    }
    if (L > 4) {
      let zt = ring._ztmp || (ring._ztmp = []);
      zt.length = L;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < L; i++) {
          let b = zs[i];
          zt[i] = b + zSmooth * ((zs[(i - 1 + L) % L] + zs[(i + 1) % L]) * 0.5 - b);
        }
        for (let i = 0; i < L; i++) zs[i] = zt[i];
      }
      for (let i = 0; i < L; i++) nodes[i].z = zs[i];
    }

    let vs = ring._drawV || (ring._drawV = []);
    let ws = ring._drawW || (ring._drawW = []);
    vs.length = L; ws.length = L;
    for (let i = 0; i < L; i++) {
      let n = nodes[i];


      let sh = 1 + shading * constrain(n.curv, -1, 1) * 0.85;
      let vit = constrain(0.52 + 0.75 * n.coarse, 0.35, 1.4) * sh;
      if (n.age < 15) vit += 0.12;
      if (n.cleaveTag !== 0) vit += 0.30;

      vs[i] = glowAlpha * vit * (n.dying ? retractA(n.fade) : n.fade);
      ws[i] = glowSize * (0.40 + weightAxis * 1.05 * n.coarse);
    }


    if (vsmooth > 0 && L > 4) {
      let tmp = ring._vtmp || (ring._vtmp = []);
      tmp.length = L;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < L; i++) {
          let b = vs[i];
          tmp[i] = b + vsmooth * ((vs[(i - 1 + L) % L] + vs[(i + 1) % L]) * 0.5 - b);
        }
        for (let i = 0; i < L; i++) vs[i] = tmp[i];
      }
    }

    for (let i = 0; i < L; i++) {
      let i0 = (i - 1 + L) % L, i2 = (i + 1) % L;

      let ax = (xs[i0] + xs[i]) * 0.5, ay = (ys[i0] + ys[i]) * 0.5;
      let bx = (xs[i] + xs[i2]) * 0.5, by = (ys[i] + ys[i2]) * 0.5;
      let p1x = xs[i], p1y = ys[i];
      let va = (vs[i0] + vs[i]) * 0.5, vb = (vs[i] + vs[i2]) * 0.5;
      let wa = (ws[i0] + ws[i]) * 0.5, wb = (ws[i] + ws[i2]) * 0.5;
      let za = (zs[i0] + zs[i]) * 0.5, zb = (zs[i] + zs[i2]) * 0.5;
      if (va <= 0 && vb <= 0 && vs[i] <= 0) continue;

      let approx = Math.hypot(p1x - ax, p1y - ay) + Math.hypot(bx - p1x, by - p1y);
      let K = constrain(Math.ceil(approx / (CURVE_STEP * renderStepMul)), 1, 10);
      let px = ax, py = ay;
      for (let k = 1; k <= K; k++) {
        let t = k / K, u = 1 - t;
        let qx = u * u * ax + 2 * u * t * p1x + t * t * bx;
        let qy = u * u * ay + 2 * u * t * p1y + t * t * by;

        let m = t - 0.5 / K, n2 = 1 - m;
        let al = n2 * n2 * va + 2 * n2 * m * vs[i] + m * m * vb;
        let w  = n2 * n2 * wa + 2 * n2 * m * ws[i] + m * m * wb;
        let zq = n2 * n2 * za + 2 * n2 * m * zs[i] + m * m * zb;
        if (al > 0.012) batchSeg(px, py, qx, qy, al, w, zq);
        px = qx; py = qy;
      }
    }
  }
  batchFlush();
}


/* ---- §14  控制面板 / CONTROL PANEL -------------------------------------- */
const PANEL_CSS = `
#axes{position:fixed;top:0;right:0;width:288px;z-index:9;height:100vh;
  display:flex;flex-direction:column;
  font:400 12.5px/1.5 ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;
  color:#f4f4f4;background:linear-gradient(to left,rgba(0,0,0,.82),rgba(0,0,0,.62));
  -webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);
  -webkit-user-select:none;user-select:none;
  opacity:0;transform:translateX(14px);pointer-events:none;
  transition:opacity .45s ease,transform .45s ease}
#axes.show{opacity:1;transform:none;pointer-events:auto}
#axes.hidden{display:none}
#axes header{display:flex;align-items:flex-start;gap:7px;padding:17px 18px 23px;
  cursor:pointer;flex:0 0 auto}
#axes header b{display:block;font-weight:400;letter-spacing:.2em;font-size:12px}
#axes header i{display:block;font-style:normal;opacity:.28;font-size:9.5px;
  letter-spacing:.26em;margin-top:6px}
#axes header s{margin-left:auto;text-decoration:none;opacity:.5;font-size:13px;line-height:1}
#axes .body{padding:0 18px 10px;overflow-y:auto;flex:1 1 auto;
  scrollbar-width:none}
#axes .body::-webkit-scrollbar{display:none}
#axes.min .body,#axes.min .foot{display:none}
/* 收起来之后剩下的不该还是一个黑方框。上一版只把 .body 和 .foot 藏了，可容器本身还是
   288 × 100vh 的一条，带着渐变底色和背景模糊 —— 于是"收起"收掉的是内容，没收掉那块玻璃，
   而挡住画面的一直是那块玻璃。现在收起时容器自己缩到只剩标题那么高，底色改成一小段
   从上往下淡出的渐变，标题下面就是作品。
   Minimising used to hide the contents but not the panel: a 288 × 100vh sheet of tinted,
   blurred glass stayed exactly where it was, and the glass was what covered the work. Now the
   container collapses to the height of its own header and the tint becomes a short fade, so
   everything below the title is the piece itself. */
#axes.min{height:auto;background:linear-gradient(to bottom,rgba(0,0,0,.60),rgba(0,0,0,0));
  -webkit-backdrop-filter:none;backdrop-filter:none}
#axes.min header{padding-bottom:38px;text-shadow:0 1px 7px rgba(0,0,0,.9)}
#axes .grp{margin:17px 0 10px;letter-spacing:.22em;font-size:9.5px;opacity:.48}
#axes .grp em{font-style:normal;letter-spacing:.06em;opacity:.5;margin-left:6px}
#axes .row{margin:0 0 13px}
#axes .lab{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;
  cursor:ew-resize;white-space:pre}
#axes .lab u{text-decoration:none;letter-spacing:.04em;font-size:13px}
#axes .lab em{font-style:normal;opacity:.32;font-size:10px}
#axes .lab b{margin-left:auto;font-weight:400;font-size:12px;opacity:.84;
  font-variant-numeric:tabular-nums}
#axes input{-webkit-appearance:none;appearance:none;display:block;
  width:100%;height:12px;margin:0;background:transparent;cursor:pointer}
#axes input::-webkit-slider-runnable-track{height:1px;background:rgba(255,255,255,.3)}
#axes input::-moz-range-track{height:1px;background:rgba(255,255,255,.3)}
#axes input::-webkit-slider-thumb{-webkit-appearance:none;width:2px;height:12px;
  margin-top:-5.5px;background:#fff;border:0;border-radius:0}
#axes input::-moz-range-thumb{width:2px;height:12px;background:#fff;border:0;border-radius:0}
#axes input:focus-visible{outline:1px solid rgba(255,255,255,.5);outline-offset:4px}
#axes .mod{display:grid;grid-template-columns:1fr;gap:3px;margin:0 0 16px}
#axes .mod a{display:block;padding:8px 11px;cursor:pointer;color:inherit;
  background:rgba(255,255,255,.045);font-size:11.5px;letter-spacing:.03em;line-height:1.3}
#axes .mod a em{display:block;font-style:normal;font-size:9px;opacity:.3;
  letter-spacing:.08em;margin-top:3px}
#axes .mod a:hover{background:rgba(255,255,255,.12)}
#axes .mod a.on{background:#f4f4f4;color:#000}
#axes .mod a.on em{opacity:.45}
#axes .pre{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 0 4px}
#axes .pre a{display:block;padding:6px 8px;cursor:pointer;color:inherit;
  background:rgba(255,255,255,.05);font-size:12.5px;letter-spacing:.04em;line-height:1.3}
#axes .pre a em{display:block;font-style:normal;font-size:9.5px;opacity:.32;
  letter-spacing:.03em;margin-top:2px}
#axes .pre a:hover{background:rgba(255,255,255,.13)}
#axes .pre a.on{background:#f0f0f0;color:#000}
#axes .pre a.on em{opacity:.44}
#axes.dirty .pre a.on{background:rgba(255,255,255,.28);color:#fff}
/* 导出键是描边的框，不是填色的块 —— 面板里凡是填色的都是"状态"（选中的板块、
   选中的预设），而这是一个**动作**。一个动作不该长得像一个状态。
   The export control is an outline, not a filled tile: everything filled in this panel is a
   *state* — the chosen module, the chosen preset — and this is an *action*. An action should
   not look like a state. */
#axes .foot{flex:0 0 auto;padding:13px 18px 18px}
#axes .foot a{display:block;text-align:center;padding:11px 8px;cursor:pointer;color:inherit;
  border:1px solid rgba(255,255,255,.22);font-size:11.5px;letter-spacing:.2em;line-height:1.3;
  transition:background .2s ease,border-color .2s ease}
#axes .foot a em{display:block;font-style:normal;font-size:9px;opacity:.42;
  letter-spacing:.05em;margin-top:4px}
#axes .foot a:hover,#axes .foot a:focus-visible{background:rgba(255,255,255,.1);
  border-color:rgba(255,255,255,.5)}
#axes .foot p{margin:0 0 11px;text-align:right;letter-spacing:.02em;font-size:10px;
  opacity:.5;font-variant-numeric:tabular-nums}
#axhint{position:fixed;left:0;bottom:0;width:calc(100% - 288px);
  padding:0 0 26px;text-align:center;z-index:8;pointer-events:none;
  font:400 14px/1.6 ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;
  color:#fff;opacity:0;transition:opacity .35s}
#axhint.on{opacity:1}
#axhint b{font-weight:400;letter-spacing:.1em}
#axhint em{font-style:normal;display:block;font-size:11.5px;opacity:.62;
  letter-spacing:.04em;margin-top:3px}
#axhint cite{font-style:normal;display:block;font-size:10.5px;opacity:.34;
  letter-spacing:.02em;margin-top:2px}
@media(prefers-reduced-motion:reduce){#axes{-webkit-backdrop-filter:none;backdrop-filter:none}}
#axshare{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.86);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
  font:400 12.5px/1.6 ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;color:#f4f4f4}
#axshare .sheet{display:flex;gap:26px;align-items:flex-start;max-width:min(1100px,92vw);
  max-height:88vh}
#axshare img{max-width:min(720px,60vw);max-height:80vh;display:block;
  outline:1px solid rgba(255,255,255,.14);outline-offset:0}
#axshare .side{width:230px;flex:0 0 auto;padding-top:2px}
#axshare .side b{display:block;font-weight:400;letter-spacing:.22em;font-size:12px}
#axshare .side em{display:block;font-style:normal;font-size:11px;opacity:.58;
  letter-spacing:.02em;margin:8px 0 0}
#axshare .side cite{display:block;font-style:normal;font-size:10px;opacity:.3;margin-top:3px}
#axshare .qr{margin:18px 0 4px;min-height:0}
#axshare .side u{text-decoration:none;opacity:.85;letter-spacing:.02em}
#axshare .qr canvas{display:block;width:210px;height:210px;image-rendering:pixelated}
#axshare .close{display:inline-block;margin-top:22px;cursor:pointer;
  letter-spacing:.18em;font-size:10.5px;opacity:.6}
#axshare .close:hover{opacity:1}
@media(max-width:820px){#axshare .sheet{flex-direction:column;gap:14px}
  #axshare img{max-width:88vw;max-height:52vh}#axshare .side{width:88vw}}

`;

function axFmt(a, v) { return v.toFixed(a.step < 0.005 ? 4 : (a.step >= 1 ? 0 : 2)); }

/* 交互面板：根据参数表生成滑杆与预设，并保持界面状态与模拟参数同步。
   Interface panel: builds sliders and presets from parameter tables and keeps UI state synchronized with the simulation. */
function buildPanel() {
  if (document.getElementById('axes')) return;

  let st = document.createElement('style');
  st.textContent = PANEL_CSS;
  document.head.appendChild(st);


  let html = '<header><div><b>THE BEAUTY OF SYSTEMS</b><i>系统之美</i></div>'
           + '<s>&minus;</s></header>'
           + '<div class="body">';


  html += '<div class="mod">';
  for (let i = 0; i < MODULES.length; i++) {
    html += '<a data-m="' + MODULES[i].k + '"'
          + (MODULES[i].k === MODULE_ID ? ' class="on"' : '') + '>'
          + MODULES[i].en + '<em>' + MODULES[i].zh + '</em></a>';
  }
  html += '</div><div class="pre">';
  for (let i = 0; i < PRESETS.length; i++) {
    html += '<a data-p="' + PRESETS[i].k + '"'
          + (PRESETS[i].k === PRESET ? ' class="on"' : '') + '>'
          + PRESETS[i].en + '<em>' + PRESETS[i].zh + '</em></a>';
  }
  html += '</div>';

  let g = -1;
  for (let i = 0; i < AXES.length; i++) {
    let a = AXES[i];
    if (a.g !== g) {
      g = a.g;
      html += '<div class="grp">' + GROUPS[g].en.toUpperCase()
            + '<em>' + GROUPS[g].zh + '</em></div>';
    }
    html += '<div class="row" data-k="' + a.k + '">'
          +   '<div class="lab"><u>' + a.en + '</u><em>' + a.zh + '</em><b></b></div>'
          +   '<input type="range" min="' + a.min + '" max="' + a.max
          +     '" step="' + a.step + '" value="' + a.def
          +     '" aria-label="' + a.en + '">'
          + '</div>';
  }

  html += '</div><div class="foot">';
  if (/(^|[?&])stat\b/.test(location.search)) html += '<p id="ax-stat"></p>';
  html +=     '<a id="ax-save" tabindex="0">EXPORT'
        +       '<em>save this form &middot; 存下这一帧</em></a>'
        + '</div>';

  let el = document.createElement('div');
  el.id = 'axes';
  el.innerHTML = html;
  document.body.appendChild(el);


  let cap = document.createElement('div');
  cap.id = 'axhint';
  document.body.appendChild(cap);

  let head = el.querySelector('header');
  head.addEventListener('click', function () {
    el.classList.toggle('min');
    head.querySelector('s').innerHTML = el.classList.contains('min') ? '+' : '&minus;';
  });

  let rows = el.querySelectorAll('.row');
  let setters = {};

  function showCaption(a) {

    cap.innerHTML = '<b>' + a.en + '</b><em>' + a.why + '</em><cite>' + a.zhy + '</cite>';
    cap.classList.add('on');
    clearTimeout(cap._t);
    cap._t = setTimeout(function () { cap.classList.remove('on'); }, 2600);
  }

  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    let a = AXES.find(function (x) { return x.k === row.dataset.k; });
    let inp = row.querySelector('input');
    let out = row.querySelector('b');
    let lab = row.querySelector('.lab');

    let set = function (v, quiet) {
      v = Math.min(a.max, Math.max(a.min, v));

      let step = Math.abs(v - P[a.k]) / Math.max(1e-9, a.max - a.min);
      P[a.k] = v;
      inp.value = v;
      out.textContent = axFmt(a, v);
      applyAxes();
      if (!quiet) {

        cancelMorph();
        nudge(a.k, step);
        showCaption(a);
        el.classList.add('dirty');
        presetDirty = true;
      }
    };
    setters[a.k] = set;

    inp.addEventListener('input', function () { set(parseFloat(inp.value)); });


    let drag = null;
    lab.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, v: P[a.k] };

      try { lab.setPointerCapture(e.pointerId); } catch (err) {}
      showCaption(a); nudge(a.k, 0);
      e.preventDefault();
    });
    lab.addEventListener('pointermove', function (e) {
      if (drag) set(drag.v + (e.clientX - drag.x) * (a.max - a.min) / 320);
    });
    lab.addEventListener('pointerup',     function () { drag = null; });
    lab.addEventListener('pointercancel', function () { drag = null; });
    lab.addEventListener('dblclick',      function () { set(a.def); });

    set(a.def, true);
  }


  let mBtns = el.querySelectorAll('.mod a');
  for (let i = 0; i < mBtns.length; i++) {
    mBtns[i].addEventListener('click', function () {
      let to = this.dataset.m;
      if (to !== MODULE_ID && window.parent !== window) {
        window.parent.postMessage({ type: 'sys:switch', to: to }, '*');
      }
    });
  }


  let pBtns = el.querySelectorAll('.pre a');
  for (let i = 0; i < pBtns.length; i++) {
    pBtns[i].addEventListener('click', function () {
      if (tour) setTour(false);
      morphTo(this.dataset.p);
    });
  }
  axSetters = setters;
  morphTo(PRESET, true);

  if (location.hash) applyRecipe(location.hash);

  el.querySelector('#ax-save').addEventListener('click', exportNow);


  const EXHIBIT = /(^|[?&])exhibit\b/.test(location.search);


  function reveal() {
    if (EXHIBIT) return;
    el.classList.add('show');
  }

  if (!EXHIBIT) setTimeout(reveal, 900);

  else setTimeout(function () { setTour(true); }, 6000);

  if (/(^|[?&])tour\b/.test(location.search)) setTimeout(function () { setTour(true); }, 6000);
  panelReveal = reveal;

}


function syncPanel() {
  if (frameCount % 15 !== 0) return;
  let el = document.getElementById('ax-stat');
  if (!el) return;
  let per = 0, cells = 0, A2 = 0, flips = 0;
  for (let r = 0; r < rings.length; r++) {
    let n = rings[r].nodes, L = n.length;
    if (L < 8) continue;
    for (let i = 0; i < L; i++) {
      let a = n[i], b = n[(i + 1) % L], c = n[(i + 2) % L];
      per += Math.hypot(b.x - a.x, b.y - a.y);
      A2  += a.x * b.y - b.x * a.y;
      let s = ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 0 ? 1 : -1;
      a._s2 = s;
    }
    for (let i = 0; i < L; i++) if (n[i]._s2 !== n[(i + 1) % L]._s2) flips++;
    cells += L;
  }
  let area = Math.abs(A2) / 2;
  let e = area > 1 ? per / (2 * Math.sqrt(Math.PI * area)) : 1;
  let lam = flips > 0 ? 2 * cells / flips : 0;


  el.innerHTML = countAlive() + ' · e ' + e.toFixed(1) + ' · &lambda; ' + lam.toFixed(1);
}


let SHARE_BASE = '';

function recipeOf() {
  let v = [];
  for (let i = 0; i < AXES.length; i++) {
    let a = AXES[i], x = P[a.k];
    if (!isFinite(x)) x = a.def;
    v.push(a.step >= 1 ? String(Math.round(x))
                       : String(+(+x).toFixed(3)));
  }

  let d = presetDef(), t = {};
  for (let key in d) {
    if (key === 'k' || key === 'en' || key === 'zh' || key === 'p' || key === 'rand') continue;
    t[key] = d[key];
  }
  return 'm=' + MODULE_ID + '&p=' + encodeURIComponent(PRESET)
       + '&t=' + encodeURIComponent(JSON.stringify(t))
       + '&v=' + v.join(',');
}

function applyRecipe(hash) {
  if (!hash) return false;
  let q = {};
  hash.replace(/^#/, '').split('&').forEach(function (kv) {
    let i = kv.indexOf('=');
    if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  if (!q.v) return false;
  let v = q.v.split(',');
  if (v.length !== AXES.length) return false;

  if (q.p && presetByKey(q.p)) {
    PRESET = q.p;
    if (q.t) {
      try {
        let t = JSON.parse(q.t), d = presetByKey(q.p);
        for (let key in t) d[key] = t[key];
      } catch (e) {}
    }
  }
  for (let i = 0; i < AXES.length; i++) {
    let a = AXES[i], x = parseFloat(v[i]);
    if (isFinite(x)) P[a.k] = Math.min(a.max, Math.max(a.min, x));
  }
  applyAxes();
  syncFaders();
  let btns = document.querySelectorAll('#axes .pre a');
  for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.p === PRESET);
  return true;
}


function syncFaders() {
  for (let i = 0; i < AXES.length; i++) {
    let a = AXES[i];
    let row = document.querySelector('#axes .row[data-k="' + a.k + '"]');
    if (!row) continue;
    row.querySelector('input').value = P[a.k];
    row.querySelector('b').textContent = axFmt(a, P[a.k]);
  }
}

function shareURL() {
  let base = SHARE_BASE;
  if (!base && /^https?:$/.test(location.protocol)) {
    base = location.origin + location.pathname;
  }
  return base ? base + '#' + recipeOf() : null;
}


function drawQR(text, px) {
  if (typeof qrcode !== 'function') return null;
  let q;
  for (let type = 4; type <= 20; type++) {
    try { q = qrcode(type, 'M'); q.addData(text); q.make(); break; }
    catch (e) { q = null; }
  }
  if (!q) return null;
  let n = q.getModuleCount(), quiet = 3, cell = Math.max(2, Math.floor(px / (n + quiet * 2)));
  let size = cell * (n + quiet * 2);

  let cv = document.createElement('canvas');
  cv.width = cv.height = size;
  let x = cv.getContext('2d');
  x.fillStyle = '#f0f0f0'; x.fillRect(0, 0, size, size);
  x.fillStyle = '#0a0a0a';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) x.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
  return cv;
}


/* 导出与分享：保存当前画面，并在服务器可用时生成可由手机访问的二维码链接。
   Export and sharing: saves the current frame and, when the server is available, creates a mobile-accessible QR link. */
function exportNow() {
  let cv = document.querySelector('canvas');
  if (!cv) return;

  let d = presetDef();
  let name = 'beauty-of-systems_' + MODULE_ID + '_' + (d.en || PRESET).toLowerCase().replace(/\W+/g, '-');
  let png = cv.toDataURL('image/png');


  let a = document.createElement('a');
  a.href = png; a.download = name + '.png';
  document.body.appendChild(a); a.click(); a.remove();

  showExport(png);
  offerPicture(cv);
}


function offerPicture(cv) {
  if (!/^https?:$/.test(location.protocol) || !cv.toBlob) return;
  cv.toBlob(function (blob) {
    if (!blob) return;
    fetch('/save', { method: 'POST', body: blob })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.url) setShareQR(new URL(j.url, location.href).href, true);
      })
      .catch(function () {});
  }, 'image/png');
}

function setShareQR(url, isPicture) {
  let box = document.getElementById('axshare');
  if (!box) return;
  let slot = box.querySelector('.qr'), cap = box.querySelector('.qrcap');
  if (!slot || !cap) return;
  let cv = drawQR(url, 210);
  if (!cv) return;
  slot.innerHTML = '';
  slot.appendChild(cv);
  cap.innerHTML = isPicture
    ? 'scan, then press and hold to save<cite>扫码，长按存进相册</cite>'
    : 'scan to grow this form on your phone<cite>扫码在手机上重新长出这个形态</cite>';
}

function showExport(png) {
  let old = document.getElementById('axshare');
  if (old) old.remove();

  let url = shareURL();
  let box = document.createElement('div');
  box.id = 'axshare';

  let html = '<div class="sheet"><img src="' + png + '" alt="">'
           + '<div class="side"><b>SAVED</b>'
           + '<em>the picture is in this machine&rsquo;s downloads</em>'
           + '<div class="qr"></div><em class="qrcap"></em>';
  if (!url) {
    html += '<em>to let visitors take one away, run <u>python3 serve.py</u> in this folder'
          + '<cite>想让观众扫码带走，在文件夹里跑一句 python3 serve.py</cite></em>';
  }
  html += '<a class="close">CLOSE</a></div></div>';
  box.innerHTML = html;
  document.body.appendChild(box);


  if (url) setShareQR(url, false);

  let shut = function () { box.remove(); window.removeEventListener('keydown', esc); };
  let esc = function (e) { if (e.key === 'Escape') shut(); };
  box.addEventListener('click', function (e) {
    if (e.target === box || e.target.className === 'close') shut();
  });
  window.addEventListener('keydown', esc);
}


/* ---- §15  预设之间的连续过渡 / CONTINUOUS TRANSITIONS ------------------- */
const MORPH_MS     = 5000;
const MORPH_FLIP_T = 0.32;
const TOUR_HOLD_MS = 12000;
const MORPH_UI_EVERY = 3;

let panelReveal = null;
let morph = null;
let axSetters = null;
let tour = false, tourWait = 0;


function randomiseInto(rec) {
  let pool = [];
  for (let i = 0; i < PRESETS.length; i++) if (!PRESETS[i].rand) pool.push(PRESETS[i]);
  if (!pool.length) return;


  let host = pool[Math.floor(random(pool.length))];
  for (let key in host) {
    if (key === 'k' || key === 'en' || key === 'zh' || key === 'p' || key === 'rand') continue;
    rec[key] = host[key];
  }


  let p = {};
  for (let key in pool[0].p) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      let v = pool[i].p[key];
      if (typeof v !== 'number') continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo)) continue;
    let pad = (hi - lo) * 0.18;
    lo -= pad; hi += pad;
    let a = axDef(key);
    if (a) { lo = Math.max(a.min, lo); hi = Math.min(a.max, hi); }
    let v = lo + random() * (hi - lo);
    if (a && a.step >= 1) v = Math.round(v / a.step) * a.step;
    p[key] = v;
  }
  rec.p = p;
}

function presetByKey(k) {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === k) return PRESETS[i];
  return null;
}


function morphDt() {
  return (typeof deltaTime === 'number' && deltaTime > 0) ? Math.min(deltaTime, 120) : 16.7;
}


function morphTo(k, instant) {
  let to = presetByKey(k);
  if (!to || !axSetters) return;

  if (to.rand) randomiseInto(to);

  let from = {};
  for (let key in to.p) from[key] = P[key];
  morph = { key: k, from: from, to: to.p, fromDef: presetDef(), t: 0, flipped: false };


  let btns = document.querySelectorAll('#axes .pre a');
  for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.p === k);
  let panel = document.getElementById('axes');
  if (panel) panel.classList.remove('dirty');
  presetDirty = false;

  if (instant) stepMorph(true);
  else morphCaption(morph.fromDef, to);
}


function stepMorph(force) {
  if (!morph) { tourTick(); autoIdleTick(); return; }

  morph.t = force ? 1 : Math.min(1, morph.t + morphDt() / MORPH_MS);
  let u = morph.t, e = u * u * (3 - 2 * u);

  for (let key in morph.to) {
    let a = morph.from[key], b = morph.to[key];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    P[key] = a + (b - a) * e;
  }
  settleBoost = 1;
  applyAxes();
  if (force || morph.t >= 1 || frameCount % MORPH_UI_EVERY === 0) syncFaders();

  if (!morph.flipped && morph.t >= MORPH_FLIP_T) { morph.flipped = true; flipTopology(morph); }

  if (morph.t >= 1) {
    if (!morph.flipped) flipTopology(morph);
    PRESET = morph.key;
    morph = null;
    morphClear();
    tourWait = TOUR_HOLD_MS;
  }
}


function flipTopology(m) {
  let before = m.fromDef;
  PRESET = m.key;
  applyAxes();
  if (typeof onTopologyFlip === 'function') onTopologyFlip(before, presetByKey(m.key));
}


function morphClear() {

  morph = null;
  morphCaptionEnd();
}


function cancelMorph() {
  if (morph) morphClear();
  if (tour) setTour(false);
}


function morphCaption(a, b) {}

function morphCaptionEnd() {
  let cap = document.getElementById('axhint');
  if (!cap) return;
  clearTimeout(cap._t);
  cap.classList.remove('on');
  cap.classList.remove('tour');
}


const AUTO_IDLE_MS = 300000;
let lastActiveMs = 0;

function markActive() {
  lastActiveMs = (typeof performance !== 'undefined' && performance.now)
               ? performance.now() : Date.now();
}
markActive();
if (typeof window !== 'undefined') {
  let evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
  for (let i = 0; i < evs.length; i++) {
    window.addEventListener(evs[i], markActive, { passive: true });
  }
}

function autoIdleTick() {

  if (tour || morph || !axSetters) return;
  let now = (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
  if (now - lastActiveMs < AUTO_IDLE_MS) return;
  markActive();

  let pool = [], rnd = null;
  for (let i = 0; i < PRESETS.length; i++) {
    let p = PRESETS[i];
    if (p.rand) { rnd = p.k; continue; }
    if (p.k === PRESET) continue;
    pool.push(p.k);
  }
  let k = (rnd && (!pool.length || Math.random() < 0.34))
        ? rnd : pool[Math.floor(Math.random() * pool.length)];
  if (k) morphTo(k);
}


function tourTick() {
  if (!tour || morph) return;
  tourWait -= morphDt();
  if (tourWait > 0) return;
  let i = 0;
  for (let j = 0; j < PRESETS.length; j++) if (PRESETS[j].k === PRESET) i = j;
  morphTo(PRESETS[(i + 1) % PRESETS.length].k);
}

function setTour(on) {
  tour = !!on;
  tourWait = tour ? 1200 : 0;
  let a = document.getElementById('ax-tour');
  if (a) a.classList.toggle('on', tour);
}


/* 模块联动：共享参数按各自量程归一化传递，使三个系统保持相同的概念含义。
   Module linking: shared parameters are transferred by normalized range so their conceptual meaning remains consistent across all three systems. */

/* ---- §16  与外壳的对接 / SHELL LINK ------------------------------------- */
const MODULES = [
  { k:'I',   zh:'连接与运输', en:'Connection & Transport' },
  { k:'II',  zh:'扩张与折叠', en:'Expansion & Folding' },
  { k:'III', zh:'分区与填充', en:'Partitioning & Filling' }
];
const MODULE_ID = 'II';
const SHARED_KEYS = ['abundance', 'growth', 'flux', 'weight', 'grain', 'angle'];

function axDef(k) {
  for (let i = 0; i < AXES.length; i++) if (AXES[i].k === k) return AXES[i];
  return null;
}

function readShared() {
  let out = {};
  for (let i = 0; i < SHARED_KEYS.length; i++) {
    let k = SHARED_KEYS[i], a = axDef(k);
    if (!a || !(k in P)) continue;
    out[k] = (P[k] - a.min) / (a.max - a.min);
  }
  return out;
}

function writeShared(vals) {
  if (!vals) return;
  for (let k in vals) {
    let a = axDef(k);
    if (!a || !(k in P)) continue;
    let v = a.min + constrain(vals[k], 0, 1) * (a.max - a.min);
    if (a.step >= 1) v = Math.round(v / a.step) * a.step;
    P[k] = v;

    let row = document.querySelector('#axes .row[data-k="' + k + '"]');
    if (row) {
      row.querySelector('input').value = v;
      row.querySelector('b').textContent = axFmt(a, v);
    }
  }
  applyAxes();

  if (typeof morphClear === 'function') morphClear();
  if (typeof settleBoost !== 'undefined') settleBoost = 1;
}

window.addEventListener('message', function (e) {
  let m = e.data;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'sys:pause')  { noLoop(); }
  if (m.type === 'sys:resume') { loop(); }
  if (m.type === 'sys:setShared') writeShared(m.vals);
  if (m.type === 'sys:getShared' && window.parent !== window) {
    window.parent.postMessage({ type: 'sys:shared', id: MODULE_ID, vals: readShared() }, '*');
  }
});


function announceReady() {
  if (typeof width === 'undefined' || !width) { setTimeout(announceReady, 60); return; }
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'sys:ready', id: MODULE_ID }, '*');
  }
}
setTimeout(announceReady, 80);
