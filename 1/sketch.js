/*
作品名：系统之美 / The Beauty of Systems
模块：连接与运输——空间殖民 / Module: Connection & Transport — Space Colonization
日期：2026.9.3 / Date: 2026.9.3
作者：袁征 / Author: Yuan Zheng

说明：资源点持续影响分支的生长方向，生成可在叶脉、血管与河网之间变化的连接网络。
/ Description: Resource points guide branching growth, producing connection networks that can shift between leaf venation, vasculature and river-like forms.

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

let /* 模块 I：空间殖民。分支向资源分布生长，形成连接与运输网络。
   Module I: Space colonization. Branches grow toward distributed resources to form connection and transport networks. */
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


BASE_NUT_COUNT   = 900;
BASE_NUT_RADIUS  = 96;
BASE_NUT_DRIFT   = 0;
BASE_GLOW_SIZE   = 11;
BASE_DOT_SIZE    = 6;
nutAmountMin = 24;  nutAmountMax = 40;
nutLifeMin   = 1800; nutLifeMax  = 4000;
nutNearBias  = 0;
nutFadeIn    = 0.05;

nutDotAlphaMin = 0.00; nutDotAlphaMax = 0.16;
glowAlpha    = 0.42;


maxGlowAlpha = 1.0;


grainMix = 0.55;

birthFadeSpeed = 0.045;
deathFadeSpeed = 0.018;


let BASE_BRANCH_LEN = 6;
let branchLen, minDist;


let BASE_MAX_BRANCHES = 5600;
let BASE_REFILL       = 14;
let maxBranches, refillPerFrame;


let startFood  = 12;
let feedGain   = 3.0;
let growGain   = 0.25;
let BASE_UPKEEP = 0.06;
let upkeep     = BASE_UPKEEP;
let foodDecay  = 0.995;
let deathFloor = 0;
let maxAgeBase = 900;


let BASE_TIP_TURNOVER = 0.00008;
let tipTurnoverChance = BASE_TIP_TURNOVER;
let terminalFalloff   = 0.42;
let innerChanceFloor  = 0.035;
let minDeathAge       = 180;
let maxDeathsPerFrame = 2;


let deathCascadeMs = 66;
let maxDeathDelayMs = 6000;


let flowSmoothK = 0.08;
let glowDecay   = 0.94;
let flowRef     = 1;


/* 参数轴与预设：把系统条件映射为可交互参数，并提供代表性自然形态作为入口。
   Axes and presets: map system conditions to interactive parameters and provide representative natural forms as starting points. */

/* ---- §10  参数轴与预设 / AXES & PRESETS --------------------------------- */
const AXES = [

  { k:'abundance', en:'Abundance',   zh:'丰饶', g:0, min:400, max:3000, step:20,   def:1500,
    why:'How much food exists at all', zhy:'这个世界总共有多少养分' },
  { k:'clustering',en:'Clustering',  zh:'聚散', g:0, min:0,   max:1,    step:0.01, def:0.00,
    why:'Food gathers, and the gaps between empty out',   zhy:'养分聚成一片片，缝隙里真的空掉' },
  { k:'relief',    en:'Relief',      zh:'地势', g:0, min:0,   max:1,    step:0.01, def:0.00,
    why:'Those gatherings are blobs, or valleys — a web of lines',
    zhy:'聚集的是团块，还是河谷 —— 一张细线的网' },
  { k:'gathering', en:'Gathering',   zh:'聚拢', g:0, min:0,   max:1,    step:0.01, def:0.35,
    why:'Food concentrates toward the centre', zhy:'养分向中心聚集，边缘渐稀' },


  { k:'openness',  en:'Openness',    zh:'舒展', g:1, min:0,   max:1,    step:0.01, def:0.34,
    why:'How far a branch can hear food from', zhy:'一条枝能"听见"多远的养分' },
  { k:'grain',     en:'Grain',       zh:'顺纹', g:1, min:0,   max:1,    step:0.01, def:0.00,
    why:'Hearing reaches further along one axis', zhy:'沿主轴方向听得更远，视野变成椭圆' },


  { k:'angle',     en:'Grain angle', zh:'纹向', g:1, min:-180,max:180,  step:1,    def:-90, hide:1,
    why:'Which way that axis points', zhy:'那条主轴朝哪个方向' },
  { k:'swirl',     en:'Swirl',       zh:'旋度', g:1, min:0,   max:1,    step:0.01, def:0.00,
    why:'The grain direction itself turns from place to place',
    zhy:'纹向本身逐处旋转 —— 空间不再只有一个方向' },
  { k:'drift',     en:'Drift',       zh:'飘逸', g:1, min:0,   max:1,    step:0.01, def:0.00,
    why:'A slow wandering field bends the growth', zhy:'一层缓慢的流场把生长带偏' },


  { k:'growth',    en:'Growth',      zh:'生长', g:2, min:0.01,max:0.60, step:0.005,def:0.20,
    why:'How fast the growth front advances', zhy:'生长锋面往外推进的速度' },
  { k:'weight',    en:'Hierarchy',   zh:'主次', g:2, min:0,   max:1,    step:0.01, def:0.42,
    why:'The busiest branches run wider, see further and stride longer',
    zhy:'过流量大的枝条画得更粗、看得更远、迈得更大' },
  { k:'flux',      en:'Flux',        zh:'无常', g:2, min:0,   max:1,    step:0.01, def:0.25,
    why:'Branches are abandoned and rerouted', zhy:'枝条不断被放弃、改道' },


  { k:'weave',     en:'Weave',       zh:'成网', g:3, min:0,   max:1,    step:0.01, def:0.18,
    why:'Branches fuse: a tree becomes a network', zhy:'枝条互相吻合，树变成网' }
];

const GROUPS = [
  { en:'The world', zh:'这个世界' },
  { en:'The form',  zh:'长成什么样' },
  { en:'The life',  zh:'怎么活着' },
  { en:'The weave', zh:'怎么连接' }
];

let P = {};
for (let i = 0; i < AXES.length; i++) P[AXES[i].k] = AXES[i].def;


const PRESETS = [
  { k:'pinnate', en:'Pinnate',    zh:'羽状叶脉', sink:'line',   seeds:1, depth:0.12,
    p:{ abundance:1700, clustering:0, relief:0, gathering:0.62, openness:0.30, grain:0.62, angle:-90,
        swirl:0, drift:0, growth:0.20, weight:0.52, flux:0.20, weave:0.34 } },

  { k:'parallel',en:'Parallel',   zh:'平行叶脉', sink:'line',   seeds:9, depth:0.10,
    p:{ abundance:1800, clustering:0, relief:0, gathering:0.70, openness:0.24, grain:0.95, angle:-90,
        swirl:0, drift:0, growth:0.20, weight:0.26, flux:0.18, weave:0.04 } },


  { k:'vessel',  en:'Vasculature',zh:'血管网',   sink:'center', seeds:1, depth:1.00,
    p:{ abundance:2600, clustering:0, relief:0, gathering:0.12, openness:0.22, grain:0, angle:-90,
        swirl:0, drift:0, growth:0.20, weight:0.20, flux:0.14, weave:1.00 } },

  { k:'basin',   en:'River basin',zh:'河流域',   sink:'outlet', seeds:1, depth:0.30,
    p:{ abundance:1900, clustering:0.55, relief:0.85, gathering:0.60, openness:0.42,
        grain:0, angle:-90, swirl:0, drift:0.10, growth:0.20, weight:0.92, flux:0.55,
        weave:0 } },


  { k:'ridges',  en:'Ridges',     zh:'分水岭',   sink:'edge',   seeds:8, depth:0.85,
    p:{ abundance:2200, clustering:0.20, relief:0, gathering:0.00, openness:0.34, grain:0.90, angle:0,
        swirl:0.60, drift:0, growth:0.20, weight:0.22, flux:0.16, weave:0.05 } },

  { k:'random',  en:'Random',     zh:'随机',     rand:true, sink:'center', seeds:1, depth:0.80, p:{} }
];
let PRESET = 'pinnate';
let presetDirty = false;

function presetDef() {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === PRESET) return PRESETS[i];
  return PRESETS[0];
}


let cosA, sinA;


const DIRW = 32, DIRH = 20;
let dirCos = new Float32Array(DIRW * DIRH);
let dirSin = new Float32Array(DIRW * DIRH);
let aSwirl = 0, swirlSeed = 0;
let dirFieldAngle = NaN, dirFieldSwirl = NaN;

// 方向场：让“谁离我最近”这件事在不同区域朝不同方向拉长。
// A direction field stretches the “who is nearest” metric differently in different regions.
function buildDirField() {
  let base = radians(P.angle);
  cosA = Math.cos(base); sinA = Math.sin(base);
  aSwirl = P.swirl;

  if (P.angle === dirFieldAngle && P.swirl === dirFieldSwirl) return;
  dirFieldAngle = P.angle;
  dirFieldSwirl = P.swirl;

  let k = 3.2;
  for (let j = 0; j < DIRH; j++) {
    for (let i = 0; i < DIRW; i++) {
      let a = base;
      if (aSwirl > 0.001) {
        let n = noise((i / DIRW) * k, (j / DIRH) * k, swirlSeed) - 0.5;
        a += n * aSwirl * Math.PI * 2.2;
      }
      dirCos[j * DIRW + i] = Math.cos(a);
      dirSin[j * DIRW + i] = Math.sin(a);
    }
  }
}


function dirIdx(x, y) {
  let i = x * DIRW / width;   i = i < 0 ? 0 : (i > DIRW - 1 ? DIRW - 1 : i | 0);
  let j = y * DIRH / height;  j = j < 0 ? 0 : (j > DIRH - 1 ? DIRH - 1 : j | 0);
  return j * DIRW + i;
}
let patchK, patchSeed = 0;
let maxReachMul = 1;
let aPatch = 0, aRelief = 0, aEnvelope = 0, aAspect = 1, aEdge = 0.25;

let outletX = -1, outletY = -1;
let aStretch = 1, aTropism = 0, aWander = 0;
let aGreed = 0, aStride = 0, aPower = 1, aGirth = 0.55;
let aGrowth = 0.09, aFuse = 0;


let settleBoost = 0;


const RESHAPE = { gathering: 1.0, clustering: 1.0, relief: 1.0, swirl: 0.9, angle: 0.8,
                  grain: 0.8, abundance: 0.6, openness: 0.5, drift: 0.4 };

let reapDebt = 0;
const REAP_GAIN     = 2.4;
const REAP_CEIL     = 0.28;
const REAP_PER_FRAME = 8;

function nudge(k, amt) {

  let a = (typeof amt === 'number' && isFinite(amt)) ? Math.min(1, amt) : 1;
  settleBoost = Math.min(1, settleBoost + 0.35 + a * 2.5);
  let w = (k && RESHAPE[k]) || 0;
  if (w > 0) {
    reapDebt = Math.min(countAlive() * REAP_CEIL, reapDebt + a * w * countAlive() * REAP_GAIN);
  }
}


// 改完参数后顶起周转，让旧结构朝新规则的方向被换掉，而不是随机换掉。
// After an axis changes, turnover is raised so the old structure is replaced in the direction of the new rule rather than at random.
function reappraise(topo) {
  if (reapDebt < 1 || topo.active.length < 40) return;

  let subCap = Math.max(16, topo.active.length * 0.06);
  let cand = [];
  for (let i = 0; i < topo.active.length; i++) {
    let b = topo.active[i];
    if (!b.parent || b.onTrunk || b.sub > subCap) continue;
    cand.push(b);
  }
  if (cand.length === 0) { reapDebt = 0; return; }


  let score = new Map();
  for (let i = 0; i < cand.length; i++) score.set(cand[i], nutWeight(cand[i].x, cand[i].y));
  cand.sort(function (p, q) { return score.get(p) - score.get(q); });

  let sel = [];
  for (let i = 0; i < cand.length && sel.length < REAP_PER_FRAME && reapDebt >= 1; i++) {
    let c = cand[i], clash = false;
    for (let j = 0; j < sel.length; j++) {
      if (isAncestor(sel[j], c) || isAncestor(c, sel[j])) { clash = true; break; }
    }
    if (clash) continue;
    sel.push(c);
    reapDebt -= (c.sub || 1);
  }
  for (let i = 0; i < sel.length; i++) markSubtreeDying(sel[i]);
  if (reapDebt < 1) reapDebt = 0;
}


function retireRoots(list) {
  let topo = analyzeTopology();


  let all = [];
  for (let i = 0; i < list.length; i++) {
    let stack = [list[i]];
    while (stack.length > 0) {
      let b = stack.pop();
      if (b.dying) continue;
      all.push(b);
      let kids = b.children;
      for (let j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
  }
  if (all.length === 0) return;


  all.sort(function (a, b) { return (a.td || 0) - (b.td || 0); });

  let n = all.length - 1;
  for (let i = 0; i < all.length; i++) {
    let b = all[i];
    b.dying = true;
    b.glowPulse = 0;
    b.deathDelay = GRAFT_LEAD_MS + (n > 0 ? i / n : 0) * GRAFT_SPAN_MS;
  }
}


const GRAFT_LEAD_MS = 1200;
const GRAFT_SPAN_MS = 10000;

// 嫁接：种子布局没有中间态，所以老脉从末梢枯回、新脉同时长出，两代同框十几秒。
// Grafting: seed layouts have no in-between state, so the old veins retreat from the tips while the new ones grow, two generations on screen at once.
function onTopologyFlip(a, b) {
  if (!a || !b || (a.sink === b.sink && a.seeds === b.seeds)) return;
  let old = roots;
  roots = [];
  plantSeeds();
  retireRoots(old);
}


let branches = [];
let roots = [];
let loops = [];
let nextRootId = 1;
let seedPending = false;


let liveScratch = [], sproutEligScratch = [], newbornScratch = [];
let topologyScratch = { active: [] }, deepestScratch = new Map();
let forcedScratch = [], naturalScratch = [], deathCandScratch = [], deathSelectedScratch = [];


function applyScale() {
  applyCoreScale();
  branchLen = gs(BASE_BRANCH_LEN);
  maxBranches = cs(BASE_MAX_BRANCHES);
  applyAxes();
}


// 面板的十几根轴在这里翻译成引擎变量。推一下滑杆只重跑这一个函数。
// The axes are resolved into engine variables here; moving a slider re-runs this one function and nothing else.
function applyAxes() {
  syncDepthAmt();


  nutCount = cs(P.abundance);

  aPatch    = P.clustering;
  aRelief   = P.relief;

  patchK    = 0.9 / ((1.6 - P.clustering * 0.9) * Math.sqrt(width * height) * 0.25);

  aEnvelope = P.gathering;

  aEdge     = 0.14 + P.gathering * 0.30;


  aAspect   = 1 / (1 + P.grain * 1.1);


  nutRadius = branchLen * (4 + P.openness * 18);


  let spacing = Math.sqrt(width * height / Math.max(1, nutCount));
  minDist = constrain(spacing * 0.45, branchLen * 1.0, branchLen * 3.0);


  aStretch = 1 + P.grain * 1.8;
  aTropism = P.grain * 0.5;
  aWander  = P.drift * 1.2;

  buildDirField();


  aGrowth = P.growth;


  birthFadeSpeed = constrain(0.05 + P.growth * 0.55, 0.05, 0.38);


  aGreed  = P.weight * 0.55;
  aStride = P.weight * 0.90;
  aPower  = 1;
  maxReachMul = 1 + aGreed;

  aGirth = P.weight * 1.4;


  let turn = P.flux * 4;

  let surge = 1 + settleBoost * 4;
  upkeep            = BASE_UPKEEP * turn;
  tipTurnoverChance = BASE_TIP_TURNOVER * Math.max(turn, 0.35) * surge;
  maxDeathsPerFrame = Math.max(1, Math.round(2 * turn * surge));
  deathFadeSpeed    = 0.018 * Math.sqrt(Math.max(0.05, turn));


  aFuse = P.weave;
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

  NUT_SAMPLER = sampleNutrient;
  patchSeed = random(1000);
  noiseSeed(floor(random(100000)));

  for (let i = 0; i < nutCount; i++) nutrients.push(spawnNutrient(null));
  reseed();
  buildPanel();
}

function draw() {
  adaptQuality();
  stepMorph();
  if (seedPending) { seedPending = false; reseed(); }

  if (!morph && settleBoost > 0) { settleBoost = Math.max(0, settleBoost - 0.008); applyAxes(); }
  for (let s = 0; s < SIM_STEPS; s++) grow();
  render();
  syncPanel();
}

/* 键盘交互：提供展陈与调试所需的面板、重置、巡演、导出、画质和全屏控制。
   Keyboard interaction: provides panel, reset, tour, export, quality and fullscreen controls for exhibition and testing. */
function keyPressed() {
  if (key === 'h' || key === 'H') {
    let el = document.getElementById('axes');

    if (el && el.classList.toggle('hidden') === false && panelReveal) panelReveal();
  }
  if (key === 'r' || key === 'R') seedPending = true;
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


function nutWeight(x, y) {
  let w = 1;


  if (aPatch > 0) {
    let n = noise(x * patchK, y * patchK, patchSeed);

    if (aRelief > 0.001) {
      let ridged = 1 - Math.abs(2 * n - 1);
      n = n * (1 - aRelief) + ridged * aRelief;
    }


    let lo = aPatch * 0.46, hi = lo + 0.34;
    let t = constrain((n - lo) / (hi - lo), 0, 1);
    t = t * t * (3 - 2 * t);
    w *= (1 - aPatch) + aPatch * t;
  }

  if (aEnvelope > 0) {


    let ecx = width * 0.5, ecy = height * 0.5;
    if (outletX >= 0) {
      ecx = width  * (0.5 + (0.5 - outletX) * 0.85);
      ecy = height * (0.5 + (0.5 - outletY) * 0.85);
    }
    let dx = (x - ecx) / (width  * 0.5);
    let dy = (y - ecy) / (height * 0.5);
    let c = cosA, sn = sinA;
    if (aSwirl > 0.001) { let q = dirIdx(x, y); c = dirCos[q]; sn = dirSin[q]; }
    let u = ( dx * c + dy * sn) / aAspect;
    let v = (-dx * sn + dy * c) * aAspect;
    let r = Math.sqrt(u * u + v * v);

    let n = 1.6 + aEdge * aEdge * 22;
    let fall = 1 / (1 + Math.pow(r / 0.78, n));
    w *= (1 - aEnvelope) + aEnvelope * fall;
  }

  return constrain(w, 0, 1);
}


function sampleNutrient() {
  let x, y;
  for (let attempt = 0; attempt < 18; attempt++) {
    x = random(width);
    y = random(height);
    if (nutWeight(x, y) >= random()) return { x: x, y: y };
  }

  return { x: x, y: y };
}


function makeSeeds() {
  let s = [];
  let W = presetDef();
  let n = W.seeds;
  let SEED_MODE = W.sink;
  let cx = width * 0.5, cy = height * 0.5;
  if (SEED_MODE !== 'outlet') { outletX = -1; outletY = -1; }

  if (SEED_MODE === 'center') {
    for (let i = 0; i < n; i++) {
      let a = random(TWO_PI), r = n === 1 ? 0 : gs(40) * Math.sqrt(random());
      s.push({ x: cx + cos(a) * r, y: cy + sin(a) * r, ang: random(TWO_PI) });
    }
  } else if (SEED_MODE === 'scatter') {
    for (let i = 0; i < n; i++) {
      let p = sampleNutrient();
      s.push({ x: p.x, y: p.y, ang: random(TWO_PI) });
    }
  } else if (SEED_MODE === 'outlet') {


    let e = floor(random(4));
    if (e === 0) { outletX = 0.5; outletY = 1.0; s.push({ x: cx,          y: height - 3, ang: -HALF_PI }); }
    if (e === 1) { outletX = 0.5; outletY = 0.0; s.push({ x: cx,          y: 3,          ang:  HALF_PI }); }
    if (e === 2) { outletX = 0.0; outletY = 0.5; s.push({ x: 3,           y: cy,         ang:  0 }); }
    if (e === 3) { outletX = 1.0; outletY = 0.5; s.push({ x: width - 3,   y: cy,         ang:  PI }); }
  } else if (SEED_MODE === 'edge') {

    for (let i = 0; i < n; i++) {
      let t = random(), e = floor(random(4));
      if (e === 0) s.push({ x: t * width, y: 3,          ang:  HALF_PI });
      if (e === 1) s.push({ x: t * width, y: height - 3, ang: -HALF_PI });
      if (e === 2) s.push({ x: 3,         y: t * height, ang:  0 });
      if (e === 3) s.push({ x: width - 3, y: t * height, ang:  PI });
    }
  } else {
    let ax = -sinA, ay = cosA;
    let half = Math.min(width, height) * 0.40;
    for (let i = 0; i < n; i++) {
      let t = n === 1 ? 0 : map(i, 0, n - 1, -1, 1);
      s.push({ x: cx + ax * half * t - cosA * half * 0.85,
               y: cy + ay * half * t - sinA * half * 0.85,
               ang: Math.atan2(sinA, cosA) });
    }
  }
  return s;
}

function reseed() {
  branches = [];
  loops = [];
  roots = [];
  nextRootId = 1;
  flowRef = 1;
  for (let i = 0; i < nutrients.length; i++) nutrients[i] = spawnNutrient(null);
  plantSeeds();
}


function plantSeeds() {
  let seeds = makeSeeds();
  for (let i = 0; i < seeds.length; i++) {
    let sd = seeds[i];
    let r = new Branch(null, sd.x, sd.y, cos(sd.ang), sin(sd.ang), false);
    r.rootId = nextRootId++;
    branches.push(r);
    roots.push(r);


    let cur = r, found = false, guard = 0;
    while (!found && guard++ < 260) {
      for (let k = 0; k < nutrients.length; k++) {
        let dx = nutrients[k].x - cur.x, dy = nutrients[k].y - cur.y;
        if (dx * dx + dy * dy < nutRadius * nutRadius) { found = true; break; }
      }
      if (!found) {
        if (cur.x < -50 || cur.x > width + 50 || cur.y < -50 || cur.y > height + 50) break;
        let next = cur.next(false, branchLen);
        branches.push(next);
        cur = next;
      }
    }
  }
}


/* 生长模型：根据资源方向生成新分支，并更新代谢、流量、拓扑与退场。
   Growth model: creates branches from resource directions and updates metabolism, flow, topology and retreat. */

/* ---- §12  模拟 / SIMULATION --------------------------------------------- */
function grow() {
  advanceBranchFades();
  let write = 0;
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (!(b.dying && b.fade <= 0)) branches[write++] = b;
  }
  branches.length = write;
  write = 0;
  for (let i = 0; i < loops.length; i++) {
    let l = loops[i];
    if (!l.a.dying && !l.b.dying && l.a.fade > 0 && l.b.fade > 0) loops[write++] = l;
  }
  loops.length = write;

  for (let i = 0; i < loops.length; i++) if (loops[i].age < 60) loops[i].age++;

  for (let i = 0; i < branches.length; i++) {
    branches[i].harvest = 0;
    branches[i].glowPulse *= glowDecay;
  }

  let live = liveScratch;
  live.length = 0;
  for (let i = 0; i < branches.length; i++) if (!branches[i].dying) live.push(branches[i]);
  colonize(live);


  let spent = 0;
  for (let i = 0; i < nutrients.length; i++) if (nutrients[i].spent) spent++;
  refillPerFrame = Math.max(cs(BASE_REFILL), Math.ceil(spent * 0.14));
  refillSpent(refillPerFrame, null);
  updateNutrients(null);

  sproutBranches(live);

  let topo = analyzeTopology();
  metabolize(topo);
  reappraise(topo);
  startBranchDeaths(topo);
  propagateFlow();
}

function advanceBranchFades() {
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (b.dying && b.deathDelay > 0) {
      b.deathDelay -= (typeof deltaTime === 'number' && deltaTime > 0) ? Math.min(deltaTime, 120) : 16.7;
      continue;
    }
    advanceFade(b);
  }
}


function viewDist2(dx, dy, x, y) {
  let c = cosA, sn = sinA;

  if (aSwirl > 0.001 && x !== undefined) { let q = dirIdx(x, y); c = dirCos[q]; sn = dirSin[q]; }
  let u = ( dx * c + dy * sn) / aStretch;
  let v = -dx * sn + dy * c;
  return u * u + v * v;
}


// 空间殖民核心：每颗养分把方向投给影响半径内最近的枝条。最近者独占，不能改成瓜分。
// Space colonisation: each nutrient votes for the nearest branch within its radius. Nearest-takes-all — this one cannot be shared out.
function colonize(live) {
  if (live.length === 0) return;

  let maxSearch = nutRadius * maxReachMul * Math.max(1, aStretch);


  let cell = Math.max(branchLen * 3, minDist * 1.5, maxSearch * 0.50);
  let grid = buildGrid(cell, live);


  let maxRing = Math.min(64, Math.ceil(maxSearch / cell));
  let minDist2 = minDist * minDist;

  let ringToDist = 1 / (Math.max(1, aStretch) * nutRadius * maxReachMul);

  for (let n = 0; n < nutrients.length; n++) {
    let nt = nutrients[n];
    if (nt.spent) continue;

    let cx = Math.floor(nt.x / cell);
    let cy = Math.floor(nt.y / cell);
    let bestScore2 = 1, bestIdx = -1, eaten = false;

    for (let ring = 0; ring <= maxRing && !eaten; ring++) {
      let lower = (ring - 1) * cell * ringToDist;
      if (bestIdx >= 0 && lower * lower > bestScore2) break;

      for (let ox = -ring; ox <= ring && !eaten; ox++) {
        for (let oy = -ring; oy <= ring && !eaten; oy++) {

          if (ring > 0 && Math.abs(ox) !== ring && Math.abs(oy) !== ring) continue;
          let arr = grid.get(gridKey(cx + ox, cy + oy));
          if (!arr) continue;

          for (let a = 0; a < arr.length; a++) {
            let b = live[arr[a]];
            let dx = nt.x - b.x, dy = nt.y - b.y;


            if (dx * dx + dy * dy < minDist2) {
              b.food += feedGain;
              b.harvest += feedGain;
              b.glowPulse = 1;
              nt.spent = true;
              eaten = true;
              break;
            }


            let score2 = viewDist2(dx, dy, b.x, b.y) / (b.reach * b.reach);
            if (score2 < bestScore2) { bestScore2 = score2; bestIdx = arr[a]; }
          }
        }
      }
    }

    if (!eaten && bestIdx >= 0) {
      let b = live[bestIdx];
      let dx = nt.x - b.x, dy = nt.y - b.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0) { b.dx += dx / d; b.dy += dy / d; b.count++; }
    }
  }
}

function sproutBranches(live) {
  let eligible = sproutEligScratch;
  eligible.length = 0;
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (!b.dying && b.count > 0) eligible.push(i);
  }
  shuffle(eligible, true);


  let fuseGrid = null, fuseDist = 0;
  if (aFuse > 0 && live.length > 0) {
    fuseDist = branchLen * (1.8 + aFuse * 4.2);
    fuseGrid = buildGrid(fuseDist, live);
    buildLoopGrid(fuseDist);
  }


  let room = Math.max(1, Math.round(eligible.length * aGrowth));

  let newborns = newbornScratch;
  newborns.length = 0;
  for (let i = 0;
       i < eligible.length &&
       newborns.length < room &&
       branches.length + newborns.length < maxBranches * 1.15;


       i++) {
    let b = branches[eligible[i]];


    if (aTropism > 0) {

      let tc = cosA, ts = sinA;
      if (aSwirl > 0.001) { let q = dirIdx(b.x, b.y); tc = dirCos[q]; ts = dirSin[q]; }
      b.dx += tc * aTropism * b.count;
      b.dy += ts * aTropism * b.count;
    }
    if (aWander > 0) {
      let wa = noise(b.x * 0.0022, b.y * 0.0022, 17.3) * TWO_PI * 2;
      b.dx += Math.cos(wa) * aWander * b.count;
      b.dy += Math.sin(wa) * aWander * b.count;
    }

    let m = Math.sqrt(b.dx * b.dx + b.dy * b.dy);
    if (m === 0) { b.dx = b.odx; b.dy = b.ody; m = 1; }
    b.dx /= m; b.dy /= m;

    let nx = b.x + b.dx * b.step;
    let ny = b.y + b.dy * b.step;


    let fused = false;
    if (fuseGrid && !b.hasLoop && random() < 0.35 + aFuse * 0.65) {
      let t = findFuseTarget(nx, ny, b, live, fuseGrid, fuseDist);


      if (t) { loops.push({ a: b, b: t, age: 0 }); b.hasLoop = true; t.hasLoop = true;

               addLoopToGrid((b.x + t.x) * 0.5, (b.y + t.y) * 0.5);
               b.reset(); fused = true; }
    }
    if (fused) continue;

    let child = b.next(true, b.step);
    child.food = startFood * 0.8;
    child.glowPulse = 0.8;
    b.food += growGain;
    b.harvest += growGain;
    newborns.push(child);
  }

  for (let i = 0; i < branches.length; i++) branches[i].reset();
  for (let i = 0; i < newborns.length; i++) branches.push(newborns[i]);
}


const FUSE_SEP = 9;

function ancestorsOf(b, n) {
  let s = new Set(), cur = b;
  for (let i = 0; i <= n && cur; i++) { s.add(cur); cur = cur.parent; }
  return s;
}


const FUSE_COS = 0.5;

// 融合（吻合支）。一根滑杆从纯树走到全网：河系 → 叶脉 → 血管。
// Anastomosis. One fader runs from a pure tree to a full network: river system → leaf venation → vasculature.
function findFuseTarget(nx, ny, b, live, grid, fuseDist) {
  let hx = nx - b.x, hy = ny - b.y;
  let hl = Math.sqrt(hx * hx + hy * hy);
  if (hl < 1e-6) return null;
  hx /= hl; hy /= hl;

  let cx = Math.floor(nx / fuseDist), cy = Math.floor(ny / fuseDist);
  let mine = ancestorsOf(b, FUSE_SEP);
  let best = null, bestD = fuseDist * fuseDist;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      let arr = grid.get(gridKey(cx + ox, cy + oy));
      if (!arr) continue;
      for (let a = 0; a < arr.length; a++) {
        let t = live[arr[a]];
        if (t === b || t.parent === b || b.parent === t || t.hasLoop) continue;
        let dx = t.x - nx, dy = t.y - ny;
        let d2 = dx * dx + dy * dy;
        if (d2 >= bestD) continue;

        let d = Math.sqrt(d2);
        if (d > 1e-6 && (dx * hx + dy * hy) / d < FUSE_COS) continue;

        let far = true, cur = t;
        for (let i = 0; i <= FUSE_SEP && cur; i++) {
          if (mine.has(cur)) { far = false; break; }
          cur = cur.parent;
        }
        if (!far) continue;

        bestD = d2; best = t;
      }
    }
  }
  if (best && loopCrowded((b.x + best.x) * 0.5, (b.y + best.y) * 0.5, fuseDist)) return null;
  return best;
}


let loopGrid = null, loopCell = 1;

function buildLoopGrid(cell) {
  loopCell = Math.max(1, cell);
  loopGrid = new Map();
  for (let i = 0; i < loops.length; i++) {
    let l = loops[i];
    let mx = (l.a.x + l.b.x) * 0.5, my = (l.a.y + l.b.y) * 0.5;
    let k = gridKey(Math.floor(mx / loopCell), Math.floor(my / loopCell));
    let arr = loopGrid.get(k);
    if (!arr) { arr = []; loopGrid.set(k, arr); }
    arr.push(mx, my);
  }
}

function addLoopToGrid(mx, my) {
  if (!loopGrid) return;
  let k = gridKey(Math.floor(mx / loopCell), Math.floor(my / loopCell));
  let arr = loopGrid.get(k);
  if (!arr) { arr = []; loopGrid.set(k, arr); }
  arr.push(mx, my);
}

function loopCrowded(mx, my, minSep) {
  if (!loopGrid) return false;
  let cx = Math.floor(mx / loopCell), cy = Math.floor(my / loopCell);
  let s2 = minSep * minSep;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      let arr = loopGrid.get(gridKey(cx + ox, cy + oy));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 2) {
        let dx = arr[i] - mx, dy = arr[i + 1] - my;
        if (dx * dx + dy * dy < s2) return true;
      }
    }
  }
  return false;
}

function metabolize(topo) {
  for (let i = 0; i < topo.active.length; i++) {
    let b = topo.active[i];
    b.age++;
    b.food *= foodDecay;
    if (!b.parent) continue;


    let td = b.td || 0;
    let load = 0.18 + 0.82 / (1 + td);
    if (b.onTrunk) load *= 0.12;
    b.food -= upkeep * load;


    b.food += (b.nf || 0) * upkeep * 1.35;
  }
}


// 过流量沿父链累加。亮度与粗细都读它，所以主干是“流”出来的，不是画出来的。
// Throughput accumulates along the parent chain. Brightness and width both read it, so the trunk is a consequence of flow rather than something drawn.
function propagateFlow() {


  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    b.flow = b.dying ? 0 : b.harvest;
  }
  for (let i = branches.length - 1; i >= 0; i--) {
    let b = branches[i];
    if (!b.dying && b.parent && !b.parent.dying) b.parent.flow += b.flow;
  }

  let maxFlow = 0;
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    b.flowSmooth += (b.flow - b.flowSmooth) * flowSmoothK;
    if (!b.dying && b.flowSmooth > maxFlow) maxFlow = b.flowSmooth;
  }
  flowRef += (Math.log(1 + maxFlow) - flowRef) * 0.05;
  if (flowRef < 0.001) flowRef = 0.001;


  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    b.nf = constrain(Math.log(1 + b.flowSmooth) / flowRef, 0, 1);
    let g = Math.pow(b.nf, aPower);
    b.step  = branchLen * (1 + aStride * g);
    b.reach = nutRadius * (1 + aGreed  * g);
  }
}


// 拓扑分析：子树大小、到末端的距离、当前主干。等级信号由此而来。
// Topology: subtree size, distance to the tips, and the current trunk — the hierarchy signal comes from here.
function analyzeTopology() {
  let active = topologyScratch.active;
  active.length = 0;
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (!b.dying) {
      active.push(b);
      b.children.length = 0;
      b.td = 0; b.sub = 1; b.leaf = true; b.onTrunk = false;
    }
  }
  for (let i = 0; i < active.length; i++) {
    let b = active[i];
    if (b.parent && !b.parent.dying) {
      b.parent.children.push(b);
      b.parent.leaf = false;
    }
  }


  for (let i = active.length - 1; i >= 0; i--) {
    let b = active[i];
    let kids = b.children;
    let maxD = 0, size = 1;
    for (let j = 0; j < kids.length; j++) {
      maxD = Math.max(maxD, kids[j].td + 1);
      size += kids[j].sub;
    }
    b.td  = kids.length > 0 ? maxD : 0;
    b.sub = size;
    b.leaf = kids.length === 0;
  }


  let deepest = deepestScratch;
  deepest.clear();
  for (let i = 0; i < active.length; i++) {
    let b = active[i];
    if (!b.leaf) continue;
    let cur = deepest.get(b.rootId);
    if (!cur || b.depth > cur.depth) deepest.set(b.rootId, b);
  }
  for (let tip of deepest.values()) {
    let node = tip, guard = 0;
    while (node && !node.dying && guard++ < 6000) { node.onTrunk = true; node = node.parent; }
  }


  let maxSub = 1;
  for (let i = 0; i < active.length; i++) if (active[i].sub > maxSub) maxSub = active[i].sub;
  girthRef += (Math.pow(maxSub, 1 / 2.6) - girthRef) * 0.03;

  return topologyScratch;
}


// 支流改道（河流袭夺）：退的是哪一条始终带着偶然性，看上去才像改道而不是定时清理。
// Stream capture: which branch retreats stays partly random, so it reads as rerouting rather than scheduled tidying.
function startBranchDeaths(topo) {
  if (P.flux <= 0) return;
  let forced = forcedScratch, natural = naturalScratch;
  forced.length = 0; natural.length = 0;


  let subCap = Math.max(24, topo.active.length * 0.10);

  for (let i = 0; i < topo.active.length; i++) {
    let b = topo.active[i];
    if (!b.parent || b.onTrunk || b.age < minDeathAge) continue;
    if (b.sub > subCap) continue;

    let wTerminal = innerChanceFloor +
                    (1 - innerChanceFloor) * Math.exp(-b.td * terminalFalloff);
    let wSize = 0.18 + 0.82 / Math.sqrt(b.sub);
    let ageRatio = b.age / b.maxAge;
    let wAge = 1 + Math.pow(constrain(ageRatio, 0, 2.5), 2) * 1.8;
    let deficit = constrain((startFood - b.food) / startFood, 0, 2);
    let wFood = 1 + deficit * 2.2;

    let chance = tipTurnoverChance * wTerminal * wSize * wAge * wFood;

    if (b.food <= deathFloor || ageRatio > 2.2) forced.push(b);
    else if (random() < chance) natural.push(b);
  }

  shuffle(forced, true);
  shuffle(natural, true);
  let candidates = deathCandScratch;
  candidates.length = 0;
  for (let i = 0; i < forced.length; i++) candidates.push(forced[i]);
  for (let i = 0; i < natural.length; i++) candidates.push(natural[i]);

  let selected = deathSelectedScratch;
  selected.length = 0;
  for (let i = 0; i < candidates.length && selected.length < maxDeathsPerFrame; i++) {
    let c = candidates[i], overlaps = false;
    for (let j = 0; j < selected.length; j++) {
      if (isAncestor(selected[j], c) || isAncestor(c, selected[j])) { overlaps = true; break; }
    }
    if (!overlaps) selected.push(c);
  }

  for (let i = 0; i < selected.length; i++) markSubtreeDying(selected[i]);
}


function markSubtreeDying(start) {
  let stack = [start];
  while (stack.length > 0) {
    let b = stack.pop();
    if (b.dying) continue;
    b.dying = true;
    b.glowPulse = 0;
    b.deathDelay = Math.min(maxDeathDelayMs, (b.td || 0) * deathCascadeMs);
    let kids = b.children;
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
}

function isAncestor(ancestor, node) {
  let cur = node, guard = 0;
  while (cur && guard++ < 6000) { if (cur === ancestor) return true; cur = cur.parent; }
  return false;
}


let girthRef = 1;

// 线宽按 Murray / 达芬奇律：正比于所供养子树大小的 1/n 次方。
// Width follows the da Vinci / Murray law: proportional to the subtree it feeds, raised to 1/n.
function girthOf(b) {
  if (aGirth <= 0) return glowSize * 0.62;
  let t = (Math.pow(b.sub || 1, 1 / 2.6) - 1) / Math.max(0.001, girthRef - 1);
  return glowSize * (0.42 + aGirth * 1.9 * constrain(t, 0, 1.15));
}

/* 模块渲染：线宽与亮度根据结构层级和流量变化。
   Module rendering: line weight and brightness follow structural hierarchy and flow. */

/* ---- §13  渲染 / RENDER ------------------------------------------------- */
function render() {
  background(0);
  let ctx = drawingContext;

  blendMode(structureBlend);


  for (let i = 0; i < branches.length; i++) branches[i].forks = 0;
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (!b.dying && b.parent && !b.parent.dying) {
      b.parent.forks++;
    }
  }

  batchBegin();
  for (let i = 0; i < branches.length; i++) {
    let b = branches[i];
    if (!b.parent || b.fade <= 0) continue;


    let vitality = constrain(0.52 + 0.75 * (b.nf || 0) + 0.25 * b.glowPulse, 0.35, 1.4);


    let edgeFade = Math.min(b.dying ? retractA(b.fade) : b.fade,
                            b.parent.dying ? retractA(b.parent.fade) : b.parent.fade);

    let junction = 1 / Math.pow(Math.max(1, b.parent.forks || 1), 0.22);


    let w = girthOf(b);

    let al = glowAlpha * vitality * edgeFade * junction;
    if (al < 0.012) continue;


    let ex = b.x, ey = b.y;
    if (b.dying) {
      let k = retractK(b.fade);
      ex = b.parent.x + (b.x - b.parent.x) * k;
      ey = b.parent.y + (b.y - b.parent.y) * k;
      w *= retractW(b.fade);
    }
    batchSeg(b.parent.x, b.parent.y, ex, ey, al, w, (b.z + b.parent.z) * 0.5);
  }


  for (let i = 0; i < loops.length; i++) {
    let l = loops[i], A = l.a, B = l.b;
    let f = Math.min(A.fade, B.fade);
    if (f <= 0) continue;
    let mat = Math.min(1, (l.age || 0) / 60);
    let w = Math.min(girthOf(A), girthOf(B)) * (0.45 + 0.4 * mat);
    let al = glowAlpha * 0.7 * f * (0.35 + 0.65 * mat);
    if (al < 0.012) continue;

    let ex = B.x - A.x, ey = B.y - A.y;
    let L = Math.sqrt(ex * ex + ey * ey);
    if (L < 0.5) continue;


    let ax = A.parent ? A.x - A.parent.x : ex, ay = A.parent ? A.y - A.parent.y : ey;
    let al2 = Math.hypot(ax, ay) || 1; ax /= al2; ay /= al2;

    let bx = B.parent ? B.x - B.parent.x : -ex, by = B.parent ? B.y - B.parent.y : -ey;
    let bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
    if (bx * -ex + by * -ey < 0) { bx = -bx; by = -by; }


    let zl = (A.z + B.z) * 0.5;
    let k = L * 0.38;
    let c1x = A.x + ax * k, c1y = A.y + ay * k;
    let c2x = B.x + bx * k, c2y = B.y + by * k;

    let K = constrain(Math.ceil(L / (6 * renderStepMul)), 2, 24);
    let px = A.x, py = A.y;
    for (let j = 1; j <= K; j++) {
      let t = j / K, u = 1 - t;
      let qx = u*u*u*A.x + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*B.x;
      let qy = u*u*u*A.y + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*B.y;
      batchSeg(px, py, qx, qy, al, w, zl);
      px = qx; py = qy;
    }
  }
  batchFlush();

  drawNutrients();

  ctx.globalAlpha = 1;
  blendMode(BLEND);
  applyTone();
  drawGrain();
}


let zWander = 0.052;
let zPull   = 0.055;
let zSpread = 0.46;


function syncDepthAmt() {
  let d = presetDef().depth;
  depthAmt = (typeof d === 'number') ? d : 1;
}

function zSeed(x, y) {
  return 0.5 + (zField(x, y) - 0.5) * 2 * zSpread * depthAmt;
}

function zStep(z0, x, y) {

  let g = (Math.random() + Math.random() + Math.random() - 1.5) * 0.9;
  let z = z0 + g * zWander;
  z += (zSeed(x, y) - z) * zPull;
  return z < 0.04 ? 0.04 : (z > 0.99 ? 0.99 : z);
}

class Branch {
  constructor(parent, x, y, dx, dy, newborn) {
    this.parent = parent;
    this.x = x; this.y = y;
    this.dx = dx; this.dy = dy;
    this.odx = dx; this.ody = dy;
    this.depth  = parent ? parent.depth + 1 : 0;
    this.rootId = parent ? parent.rootId : 0;


    this.z = parent ? zStep(parent.z, x, y) : zSeed(x, y);
    this.count = 0;

    this.food = startFood;
    this.age = 0;
    this.maxAge = maxAgeBase * random(0.6, 1.5);

    this.harvest = 0;
    this.flow = 0;
    this.flowSmooth = 0;
    this.nf = 0;
    this.glowPulse = 0;

    this.step  = branchLen;
    this.reach = nutRadius;
    this.td = 0; this.sub = 1; this.leaf = true;
    this.children = [];
    this.onTrunk = false;
    this.forks = 0;

    this.hasLoop = false;

    this.dying = false;
    this.fade = newborn ? 0 : 1;
    this.deathDelay = 0;
  }

  reset() { this.dx = this.odx; this.dy = this.ody; this.count = 0; }

  next(newborn, len) {
    return new Branch(this,
      this.x + this.dx * len,
      this.y + this.dy * len,
      this.dx, this.dy, newborn);
  }
}

function countAlive() {
  let n = 0;
  for (let i = 0; i < branches.length; i++) if (!branches[i].dying) n++;
  return n;
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
    if (a.hide) continue;
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
  let e = document.getElementById('ax-stat');
  if (!e) return;
  let spacing = Math.sqrt(width * height / Math.max(1, nutrients.length));

  e.innerHTML = countAlive() + ' · R/&Delta; ' + (nutRadius / spacing).toFixed(1);
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
const MODULE_ID = 'I';
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
