/*
作品名：系统之美 / The Beauty of Systems
模块：分区与填充——泰森镶嵌 / Module: Partitioning & Filling — Voronoi Tessellation
日期：2026.9.3 / Date: 2026.9.3
作者：袁征 / Author: Yuan Zheng

说明：移动站点持续重组空间分区，通过规整度、曲率、墙厚、方向与层级生成蜂巢、泡沫、裂地和皮肤等形态。
/ Description: Moving sites continuously reorganise spatial regions; order, curvature, wall thickness, direction and hierarchy produce honeycomb, foam, cracked-earth and skin-like forms.

操作：使用预设与滑杆探索形态。快捷键：H 显示/隐藏面板，R 重置，T 自动巡演，E 导出，F 切换画质，Q 全屏。
/ Controls: Explore with presets and sliders. Shortcuts: H show/hide panel, R reset, T auto tour, E export, F quality, Q fullscreen.

技术：p5.js；d3-delaunay；qrcode-generator
/ Technologies: p5.js; d3-delaunay; qrcode-generator
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

let /* 模块 III：Voronoi 分区。移动站点通过 Delaunay/Voronoi 关系持续重组空间。
   Module III: Voronoi partitioning. Moving sites continuously reorganise space through Delaunay/Voronoi relationships. */
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


BASE_NUT_COUNT   = 60;
BASE_NUT_RADIUS  = 48;
BASE_NUT_DRIFT   = 0.28;
BASE_NUT_SCATTER = 60;
BASE_GLOW_SIZE   = 14;
BASE_DOT_SIZE    = 6;
nutAmountMin = 34;  nutAmountMax = 64;
nutLifeMin   = 900; nutLifeMax   = 2400;
nutNearBias  = 0.40;
feedBudget = 0.95;
feedDepletion = 0.045; feedCrowdDrain = 0.12;


glowAlpha = 0.42;


maxGlowAlpha = 1.0;

alphaBucketK = 4;


strokeW = 0.62;
inkBlur = 0.80;


depthDim = 0.56;


inkGain = 1.70;

grainMix = 0.55;

trailMs = 320;


nutDotAlphaMin = 0.00; nutDotAlphaMax = 0.16;
birthFadeSpeed = 0.035;
deathFadeSpeed = 0.025;


let bulge = 0.0;


let wall = 0.55;
let wetness = 0.0;


let tee = 0.0;

let equalize = 0.0;
let dela = null;
let voronoiPts = [];

let ordering = 0.0;
let edgeAge = new Map();
let AGE_FULL = 900;


// 定期清扫已经不存在的邻接关系，否则这张表会随周转无限长大。
// Sweeps out adjacencies that no longer exist; otherwise the table grows without bound as sites turn over.
function sweepEdgeAges(seen) {
  if (edgeAge.size < 4000) return;
  for (let k of edgeAge.keys()) if (!seen.has(k)) edgeAge.delete(k);
}

let grainAmt = 0.0;
let grainAngle = 0;
let gS = 1, gCos = 1, gSin = 0;

function grainFwd(x, y) {
  let u =  x * gCos + y * gSin, v = -x * gSin + y * gCos;
  return [u / gS, v];
}

let BASE_MIN_GAP = 12;
let minGap;

let motionDamping = 0.72;
let sepK = 0.92;
let separationPasses = 4;
let BASE_MAX_SITE_SPEED = 0.48;
let BASE_CHEMO  = 0.02;
let maxSiteSpeed, chemo, jitter;

let BASE_SITE_TARGET = 200;
let BASE_MIN_SITES   = 60;
let BASE_MAX_SITES   = 380;
let siteTarget, minSites, maxSites;
let stiffBase = 0.004, stiffScale = 0.018, stiffPower = 1;
let turnoverRate = 1;

let startFood   = 9;
let foodCap     = 38;
let BASE_UPKEEP = 0.09;
let upkeep      = BASE_UPKEEP;
let BASE_FOOD_DRAIN = 0.003;
let foodDecay   = 1 - BASE_FOOD_DRAIN;
let birthThresh = 22;
let deathFloor  = -5;
let maxAgeBase  = 2600;
let minBirthAge = 100;
let maxBirthsPerFrame = 3;
let maxDeathsPerFrame = 3;

const FEED_YIELD = 0.77;


/* 参数轴与预设：把系统条件映射为可交互参数，并提供代表性自然形态作为入口。
   Axes and presets: map system conditions to interactive parameters and provide representative natural forms as starting points. */

/* ---- §10  参数轴与预设 / AXES & PRESETS --------------------------------- */
const AXES = [
  { k:'abundance', en:'Abundance',   zh:'丰饶', g:0, min:0.30, max:2.20, step:0.01, def:1.00,
    why:'How much food the world holds',              zhy:'这个世界有多少养分' },
  { k:'clustering',en:'Clustering',  zh:'聚散', g:0, min:0,    max:0.90, step:0.01, def:0.40,
    why:'Food gathers where cells already are',        zhy:'养分往已有格子旁边聚' },
  { k:'reach',     en:'Reach',       zh:'视野', g:0, min:0,    max:1,    step:0.01, def:0.36,
    why:'How far a cell competes for food',            zhy:'一个格子跟多远的邻居抢食' },

  { k:'order',     en:'Order',       zh:'规整', g:1, min:0,    max:1,    step:0.01, def:0.38,
    why:'Quenched and ragged, or annealed toward hexagons', zhy:'淬火的杂乱 ↔ 退火的六边形' },
  { k:'stratify',  en:'Stratify',    zh:'分层', g:1, min:-1,   max:1,    step:0.01, def:0.20,
    why:'Which cells relax: the large ones, or the small', zhy:'大格子松弛还是小格子松弛' },
  { k:'bulge',     en:'Bulge',       zh:'鼓胀', g:1, min:0,    max:1,    step:0.01, def:0.35,
    why:'Pressure bows each wall toward the larger cell',  zhy:'压差把墙鼓向更大的那一格' },
  { k:'tee',       en:'Right angles',zh:'直角', g:1, min:0,    max:1,    step:0.01, def:0.00,
    why:'Cracks arrive square onto earlier ones, not at 120', zhy:'后裂的缝垂直撞上先裂的，而不是交于 120 度' },
  { k:'grain',     en:'Grain',       zh:'顺纹', g:1, min:0,    max:1,    step:0.01, def:0.00,
    why:'Space itself is stretched along one axis',    zhy:'空间被沿一个方向拉长' },
  { k:'angle',     en:'Grain angle', zh:'纹向', g:1, min:-180, max:180,  step:1,    def:0,
    why:'Which way that axis points',                  zhy:'那条主轴朝哪个方向' },

  { k:'weight',    en:'Weight',      zh:'粗细', g:2, min:0,    max:1,    step:0.01, def:0.38,
    why:'How heavy the walls are drawn',               zhy:'墙画得多粗' },
  { k:'wetness',   en:'Wetness',     zh:'湿润', g:2, min:0,    max:1,    step:0.01, def:0.15,
    why:'Liquid collects at the junctions and swells them', zhy:'液体汇到顶点，把交汇处撑粗' },
  { k:'ordering',  en:'Ordering',    zh:'层级', g:2, min:0,    max:1,    step:0.01, def:0.25,
    why:'Old walls run wide, young ones fine',         zhy:'老缝粗亮，新缝细暗' },

  { k:'growth',    en:'Growth',      zh:'生长', g:3, min:0,    max:1,    step:0.01, def:0.30,
    why:'How fast new cells appear',                   zhy:'新格子出现得多快' },
  { k:'flux',      en:'Flux',        zh:'无常', g:3, min:0,    max:1,    step:0.01, def:0.28,
    why:'Cells are lost and the mesh re-tiles',        zhy:'格子不断消失，网格重排' }
];

const GROUPS = [
  { en:'The world', zh:'这个世界' },
  { en:'The form',  zh:'长成什么样' },
  { en:'The wall',  zh:'墙' },
  { en:'The life',  zh:'怎么活着' }
];

let P = {};
for (let i = 0; i < AXES.length; i++) P[AXES[i].k] = AXES[i].def;


const PRESETS = [


  { k:'honey', en:'Honeycomb',   zh:'蜂巢',   n:0.62, depth:0.14, fill:0.30,
    p:{ abundance:1.0, clustering:0.15, reach:0.36, order:1.00, stratify:0, tee:0, bulge:0,
        grain:0, angle:0, weight:0.42, wetness:0, ordering:0, growth:0.12, flux:0.05 } },
  { k:'dry',   en:'Dry foam',    zh:'干泡沫', n:1.60, depth:1.00, fill:0,
    p:{ abundance:1.0, clustering:0.4, reach:0.36, order:0.42, stratify:0.2, tee:0, bulge:1.0,
        grain:0, angle:0, weight:0.20, wetness:0, ordering:0, growth:0.30, flux:0.28 } },
  { k:'wet',   en:'Wet foam',    zh:'湿泡沫', n:0.90, depth:1.00, fill:0.38,
    p:{ abundance:1.0, clustering:0.4, reach:0.36, order:0.34, stratify:0.2, tee:0, bulge:1.0,
        grain:0, angle:0, weight:0.46, wetness:0.90, ordering:0, growth:0.30, flux:0.24 } },
  { k:'crack', en:'Cracked earth',zh:'干裂土地', n:0.55, depth:0.55, fill:0,
    p:{ abundance:1.0, clustering:0.5, reach:0.30, order:0.18, stratify:0.55, tee:0.85, bulge:0,
        grain:0, angle:0, weight:0.58, wetness:0, ordering:1.0, growth:0.22, flux:0.34 } },


  { k:'skin',  en:'Skin',        zh:'皮肤肌理', n:2.60, depth:0.12, fill:0,
    p:{ abundance:1.0, clustering:0.30, reach:0.36, order:0.86, stratify:0, tee:0, bulge:0.30,
        grain:0.90, angle:0, weight:0.34, wetness:0.10, ordering:0.20, growth:0.14, flux:0.06 } },

  { k:'random', en:'Random',      zh:'随机',     rand:true, n:1.0, depth:0.9, fill:0.16, p:{} }
];
let PRESET = 'honey';
let presetDirty = false;

function presetDef() {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === PRESET) return PRESETS[i];
  return PRESETS[0];
}


let cellFill = 0;
let zSpread = 0.44;
let zArea   = 0.26;
let zPull   = 0.10;

function sampleDepths() {


  let spread = zSpread * depthAmt * Math.min(1, Math.max(0.30, sites.length / 90));
  let mean = 0, n = 0;
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    if (s.area > 0) { mean += s.area; n++; }
  }
  mean = n > 0 ? mean / n : 1;
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];

    let r = mean > 0 ? (s.area - mean) / (mean * 1.6) : 0;
    r = r < -1 ? -1 : (r > 1 ? 1 : r);
    let zt = 0.5 + (zField(s.x, s.y) - 0.5) * 2 * spread + zArea * r * (spread / zSpread);
    s.z += (zt - s.z) * zPull;
    s.z = s.z < 0.04 ? 0.04 : (s.z > 0.99 ? 0.99 : s.z);
  }
}

const WALL_STEP = 6;
let settleBoost = 0;


function nudge(k, amt) {
  let a = (typeof amt === 'number' && isFinite(amt)) ? Math.min(1, amt) : 1;
  settleBoost = Math.min(1, settleBoost + 0.35 + a * 2.5);
}

let sites = [];
let nextSiteId = 1;

function applyScale() {
  applyCoreScale();
  minGap = gs(BASE_MIN_GAP);
  maxSiteSpeed = gs(BASE_MAX_SITE_SPEED);
  chemo  = gs(BASE_CHEMO);
  applyAxes();
}

// 面板的十几根轴在这里翻译成引擎变量。推一下滑杆只重跑这一个函数。
// The axes are resolved into engine variables here; moving a slider re-runs this one function and nothing else.
function applyAxes() {


  let pd = presetDef();

  depthAmt = (typeof pd.depth === 'number') ? pd.depth : 1;
  cellFill = (typeof pd.fill  === 'number') ? pd.fill  : 0;
  let pn = pd.n || 1;
  siteTarget = cs(BASE_SITE_TARGET * pn);
  minSites   = cs(BASE_MIN_SITES   * pn);
  maxSites   = cs(BASE_MAX_SITES   * pn);


  nutNearBias = P.clustering;
  nutRadius   = minGap * (1.5 + P.reach * 7.5);


  let k = 0.035 * Math.pow(P.order, 2.2);
  stiffBase  = k * 0.22;
  stiffScale = k * 0.78;


  equalize = P.order;


  stiffPower = P.stratify < 0 ? P.stratify * 1.4 : P.stratify * 2.6;

  bulge      = P.bulge;
  tee        = P.tee;
  grainAmt   = P.grain;
  grainAngle = P.angle;
  let nextGS = 1 + grainAmt * 2.2;
  let nextCos = Math.cos(grainAngle * Math.PI / 180);
  let nextSin = Math.sin(grainAngle * Math.PI / 180);
  gS = nextGS; gCos = nextCos; gSin = nextSin;


  wall     = P.weight;
  wetness  = P.wetness;
  ordering = P.ordering;


  let turn = 0.2 + P.flux * 2.8;
  let surge = 1 + settleBoost * 3;
  upkeep            = BASE_UPKEEP * turn;
  foodDecay         = 1 - BASE_FOOD_DRAIN * turn;
  maxBirthsPerFrame = Math.max(1, Math.round((1 + P.growth * 6) * surge));
  maxDeathsPerFrame = Math.max(1, Math.round((1 + P.growth * 6) * surge));
  birthFadeSpeed    = 0.035 * Math.sqrt(turn);
  deathFadeSpeed    = 0.025 * Math.sqrt(turn);
  turnoverRate      = turn;

  let cool = (1 - P.order) * (1 - P.order);
  chemo  = gs(BASE_CHEMO) * (0.06 + 0.94 * cool);

  jitter = gs(0.02) * 2.2 * cool * (0.10 + 0.90 * cool);


  let kTyp = stiffBase + stiffScale;
  motionDamping = constrain(map(kTyp, 0, 0.05, 0.85, 0.55), 0.50, 0.88);
}

/* 生命周期：应用参数、初始化模拟并在每帧推进系统与渲染。
   Lifecycle: applies parameters, initialises the simulation and advances the system and rendering each frame. */

/* ---- §11  生命周期 / LIFECYCLE ------------------------------------------ */
function setup() {
  fitCanvas();
  applyScale();
  structureBlend = ADD;
  glow  = makeGlow(GLOW_TEX);
  grain = makeGrain(GRAIN_TEX);

  for (let i = 0; i < siteTarget; i++) {
    sites.push(makeSite(random(width), random(height), startFood, false));
  }
  for (let i = 0; i < nutCount; i++) nutrients.push(spawnNutrient(sites));

  separateSites(minGap, separationPasses);
  updateVoronoi();
  buildPanel();
}

function reseed() {
  sites = []; nutrients = []; nextSiteId = 1;
  edgeAge.clear();
  for (let i = 0; i < siteTarget; i++) {
    sites.push(makeSite(random(width), random(height), startFood, false));
  }
  for (let i = 0; i < nutCount; i++) nutrients.push(spawnNutrient(sites));
  separateSites(minGap, separationPasses);
  updateVoronoi();
}

function draw() {
  adaptQuality();
  stepMorph();
  for (let s = 0; s < SIM_STEPS; s++) grow();
  render(); syncPanel();
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

/* 生长模型：更新站点的资源竞争、出生、死亡、松弛与位置。
   Growth model: updates site competition, birth, death, relaxation and movement. */

/* ---- §12  模拟 / SIMULATION --------------------------------------------- */
function grow() {


  if (!morph && settleBoost > 0) { settleBoost = Math.max(0, settleBoost - 0.008); applyAxes(); }
  let alive = countAlive();
  let perSite = upkeep + foodCap * 0.45 * (1 - foodDecay);
  feedBudget = constrain(
    P.abundance * FEED_YIELD * siteTarget * perSite / Math.max(1, nutrients.length),
    0, 14);

  updateNutrients(sites);
  feedByBudget(sites);

  let meanArea  = (width * height) / Math.max(1, alive);
  let flowScale = 0.004 / geoScale;

  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    s.food = Math.min(foodCap, s.food + s.intake);
    s.food = s.food * foodDecay - upkeep;
    s.age++;
    advanceFade(s);

    let rel = constrain((s.area > 0 ? s.area : meanArea) / meanArea, 0.05, 4);
    let k = constrain(stiffBase + stiffScale * Math.pow(rel, stiffPower), 0, 0.06);

    let ct = polygonCentroidSafe(s.poly, s.x, s.y, s.centroid);
    let ang = noise(s.x * flowScale, s.y * flowScale, frameCount * 0.0015) * TWO_PI * 2;
    let fx = (ct.x - s.x) * k + s.pullx * chemo + cos(ang) * jitter;
    let fy = (ct.y - s.y) * k + s.pully * chemo + sin(ang) * jitter;


    if (equalize > 0.001 && dela && s.area > 1) {
      let nb = dela.neighbors(i);
      let ex = 0, ey = 0, cnt = 0;
      for (let j of nb) {
        let t = sites[j];
        if (!t || t.dying || !(t.area > 1)) continue;
        let dx = s.x - t.x, dy = s.y - t.y;
        let L = Math.sqrt(dx * dx + dy * dy);
        if (L < 1e-6) continue;
        let rel = constrain((s.area - t.area) / meanArea, -1.5, 1.5);
        ex += dx / L * rel; ey += dy / L * rel; cnt++;
      }
      if (cnt > 0) {
        let g = equalize * maxSiteSpeed * 0.55 / cnt;
        fx += ex * g; fy += ey * g;
      }
    }

    s.vx = s.vx * motionDamping + fx;
    s.vy = s.vy * motionDamping + fy;
    let sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (sp > maxSiteSpeed) { let k2 = maxSiteSpeed / sp; s.vx *= k2; s.vy *= k2; }
    s.x = constrain(s.x + s.vx, 2, width - 2);
    s.y = constrain(s.y + s.vy, 2, height - 2);
  }

  separateSites(minGap, separationPasses);
  let inserted = birthSites();
  markDeaths();
  let write = 0;
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    if (!(s.dying && s.fade <= 0)) sites[write++] = s;
  }
  sites.length = write;

  let after = countAlive();
  let filled = 0;
  while (after < minSites) {
    sites.push(makeSite(random(width), random(height), startFood, true));
    after++; filled++;
  }


  if (inserted + filled > 0) separateSites(minGap, 1);
  updateVoronoi();
}

function birthSites() {
  let active = countAlive();
  if (active >= maxSites) return 0;
  let elig = [];
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    if (!s.dying && s.age > minBirthAge && s.food > birthThresh) elig.push(i);
  }
  shuffle(elig, true);
  let allowed = Math.min(maxBirthsPerFrame, maxSites - active);
  let born = [];
  for (let k = 0; k < elig.length && born.length < allowed; k++) {
    let par = sites[elig[k]];
    par.food *= 0.5;
    let bp = findBirthPosition(par);
    born.push(makeSite(bp.x, bp.y, par.food, true));
  }
  for (let i = 0; i < born.length; i++) sites.push(born[i]);
  return born.length;
}

// 退场的格子朝邻居的重心收，面积一点点交出去——消失的时候已经小到看不见。
// A retreating cell travels towards its neighbours' centroid, handing over its area as it goes, and is invisible by the time it disappears.
function markDeaths() {
  let elig = [];
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    let lim = maxAgeBase * s.ageFactor / turnoverRate;
    if (!s.dying && (s.food < deathFloor || s.age > lim)) elig.push(i);
  }
  shuffle(elig, true);
  let living = countAlive();
  let take = Math.min(maxDeathsPerFrame, elig.length, Math.max(0, living - minSites));
  for (let k = 0; k < take; k++) {
    let idx = elig[k], s = sites[idx];
    s.dying = true;


    if (dela && idx < dela.points.length / 2) {
      let gx = 0, gy = 0, c = 0;
      for (let j of dela.neighbors(idx)) {
        let t = sites[j];
        if (!t || t.dying) continue;
        gx += t.x; gy += t.y; c++;
      }
      if (c > 0) { s.gx = gx / c; s.gy = gy / c; }
    }
  }
}

function findBirthPosition(par) {
  let bx = par.x, by = par.y, best = -1;
  for (let t = 0; t < 16; t++) {
    let ang = random(TWO_PI), rad = random(minGap * 1.6, minGap * 3.0);
    let x = constrain(par.x + cos(ang) * rad, 2, width - 2);
    let y = constrain(par.y + sin(ang) * rad, 2, height - 2);
    let clear = nearestSiteD2(x, y);
    if (clear > best) { best = clear; bx = x; by = y; }
    if (clear >= minGap * minGap * 1.6) break;
  }
  return { x: bx, y: by };
}

function nearestSiteD2(x, y) {
  let best = Infinity;
  for (let i = 0; i < sites.length; i++) {
    let dx = sites[i].x - x, dy = sites[i].y - y;
    let d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return best;
}

// 最小间距。松弛之后再推开一次，避免站点重合让镶嵌退化。
// Minimum spacing, applied after relaxation so coincident sites cannot degenerate the tessellation.
function separateSites(gap, passes) {
  let gap2 = gap * gap;
  for (let pass = 0; pass < passes; pass++) {
    let grid = buildGrid(gap, sites);
    for (let i = 0; i < sites.length; i++) {
      let si = sites[i];
      let cx = Math.floor(si.x / gap), cy = Math.floor(si.y / gap);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          let arr = grid.get(gridKey(cx + ox, cy + oy));
          if (!arr) continue;
          for (let a = 0; a < arr.length; a++) {
            let j = arr[a];
            if (j <= i) continue;
            let sj = sites[j];
            let dx = sj.x - si.x, dy = sj.y - si.y;
            let d2 = dx * dx + dy * dy;
            if (d2 >= gap2) continue;
            let ux, uy, ov;
            if (d2 < 1e-8) {
              let ang = hash01(si.id * 92821 + sj.id * 68917 + pass * 31) * TWO_PI;
              ux = cos(ang); uy = sin(ang); ov = gap;
            } else {
              let d = Math.sqrt(d2); ux = dx / d; uy = dy / d; ov = gap - d;
            }
            let mv = ov * 0.5 * sepK, px = ux * mv, py = uy * mv;
            si.x -= px; si.y -= py;
            sj.x += px; sj.y += py;
            si.vx *= 0.82; si.vy *= 0.82;
            sj.vx *= 0.82; sj.vy *= 0.82;
          }
        }
      }
    }
    for (let i = 0; i < sites.length; i++) {
      sites[i].x = constrain(sites[i].x, 2, width - 2);
      sites[i].y = constrain(sites[i].y, 2, height - 2);
    }
  }
}

// 重建镶嵌。每帧只建一次——过渡期建两次正好把 Delaunay 的开销翻倍。
// Rebuilds the tessellation once per frame; building it twice doubled the Delaunay cost exactly while presets were morphing.
function updateVoronoi() {
  if (sites.length === 0) return;
  let aniso = gS > 1.001;

  let pts = voronoiPts;
  pts.length = sites.length * 2;
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];

    let sx = s.x, sy = s.y;

    if (s.dying && s.gx !== undefined) {
      let k = retractK(s.fade);
      sx = s.gx + (s.x - s.gx) * k;
      sy = s.gy + (s.y - s.gy) * k;
    }
    let x = sx + (hash01(s.id * 17) - 0.5) * 1e-4;
    let y = sy + (hash01(s.id * 29) - 0.5) * 1e-4;
    if (aniso) {
      let u = (x * gCos + y * gSin) / gS;
      let v = -x * gSin + y * gCos;
      x = u; y = v;
    }
    pts[i * 2] = x; pts[i * 2 + 1] = y;
  }


  let box = [0, 0, width, height];
  if (aniso) {
    let xs = [], ys = [];
    let cs = [[0, 0], [width, 0], [0, height], [width, height]];
    for (let i = 0; i < 4; i++) { let q = grainFwd(cs[i][0], cs[i][1]); xs.push(q[0]); ys.push(q[1]); }
    let m = Math.max(width, height) * 0.05;
    box = [Math.min.apply(null, xs) - m, Math.min.apply(null, ys) - m,
           Math.max.apply(null, xs) + m, Math.max.apply(null, ys) + m];
  }

  let d = new d3.Delaunay(pts);
  dela = d;
  let v = d.voronoi(box);
  for (let i = 0; i < sites.length; i++) {
    let poly = v.cellPolygon(i);
    if (poly && aniso) {
      for (let k = 0; k < poly.length; k++) {
        let u = poly[k][0] * gS, vv = poly[k][1];
        poly[k][0] = u * gCos - vv * gSin;
        poly[k][1] = u * gSin + vv * gCos;
      }
    }
    sites[i].poly = poly;
    sites[i].area = polygonArea(poly);
  }
}

function polygonArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let n = poly.length;
  if (poly[0][0] === poly[n - 1][0] && poly[0][1] === poly[n - 1][1]) n--;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    let j = (i + 1) % n;
    a += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
  }
  a = Math.abs(a) / 2;
  return Number.isFinite(a) ? a : 0;
}

/* 模块渲染：根据格子关系绘制填充与边界，并表达曲率、墙厚、层级和 T 形裂缝。
   Module rendering: draws cell fills and walls, expressing curvature, wall weight, hierarchy and T-junction cracks. */

/* ---- §13  渲染 / RENDER ------------------------------------------------- */
function render() {
  background(0);
  let ctx = drawingContext;

  sampleDepths();
  drawCellFill();
  let edges = collectVoronoiEdges();
  let nominal = Math.sqrt(width * height / Math.max(1, sites.length));


  let wallScale = Math.pow(cs(BASE_SITE_TARGET) / Math.max(6, sites.length), 0.45);
  let lim = Math.min(width * 0.45, Math.max(gs(105), nominal * 3.2));
  let lim2 = lim * lim;

  blendMode(structureBlend);
  batchBegin();

  for (let edge of edges.values()) {
    let a = edge.a, b = edge.b;
    let ex = b[0] - a[0], ey = b[1] - a[1];
    let len2 = ex * ex + ey * ey;
    if (!Number.isFinite(len2) || len2 < 0.04 || len2 > lim2) continue;

    let L = Math.sqrt(len2);
    let sag = bulgeOf(edge, L);


    let nx = -ey / L, ny = ex / L;

    let m = 1 - ordering * (1 - edge.mat);


    let qx = (a[0] + b[0]) * 0.5 + nx * sag * 2;
    let qy = (a[1] + b[1]) * 0.5 + ny * sag * 2;
    let c1x = a[0] + (qx - a[0]) * (2 / 3), c1y = a[1] + (qy - a[1]) * (2 / 3);
    let c2x = b[0] + (qx - b[0]) * (2 / 3), c2y = b[1] + (qy - b[1]) * (2 / 3);


    let td = L * 0.16;
    if (edge.t0) { c1x = a[0] + edge.t0[0] * td; c1y = a[1] + edge.t0[1] * td; }
    if (edge.t1) { c2x = b[0] + edge.t1[0] * td; c2y = b[1] + edge.t1[1] * td; }

    drawWall(a[0], a[1], c1x, c1y, c2x, c2y, b[0], b[1],
             glowAlpha * edge.alpha * (0.45 + 0.55 * m),
             glowSize * (0.30 + wall * 1.5) * (0.28 + 0.72 * m) * wallScale,
             edge.z);
  }

  batchFlush();

  drawNutrients();

  ctx.globalAlpha = 1;
  blendMode(BLEND);
  applyTone();
  drawGrain();
}


// 矢高按 Laplace 压差给：压强取 1/√面积，归一到平均压强，所以这个量是无量纲的。
// Bulge from the Laplace pressure difference: pressure goes as 1/√area, normalised by the mean, so the quantity is dimensionless.
function bulgeOf(edge, len) {
  if (bulge <= 0.001 || !edge.s2) return 0;
  let a1 = edge.s1.area, a2 = edge.s2.area;
  if (!(a1 > 1) || !(a2 > 1)) return 0;
  let p1 = 1 / Math.sqrt(a1), p2 = 1 / Math.sqrt(a2);
  let pm = (p1 + p2) * 0.5;
  if (pm <= 0) return 0;


  let ex = edge.b[0] - edge.a[0], ey = edge.b[1] - edge.a[1];
  let nx = -ey / len, ny = ex / len;
  let mx = (edge.a[0] + edge.b[0]) * 0.5, my = (edge.a[1] + edge.b[1]) * 0.5;
  let toward1 = (edge.s1.x - mx) * nx + (edge.s1.y - my) * ny;
  let dp = (p1 - p2) / pm;
  let sgn = toward1 > 0 ? -1 : 1;
  return dp * sgn * bulge * len * 0.22;
}


const FILL_SCALE = 0.5;
let fillBuf = null;

// 格子填色，作为墨版的底图——底下不再是一块平的板。
// Cell fill, used as the base plate under the ink so the picture no longer sits on a flat slab.
function drawCellFill() {
  if (cellFill <= 0.005) { inkBase = null; return; }
  let w = Math.max(2, Math.round(width  * FILL_SCALE));
  let h = Math.max(2, Math.round(height * FILL_SCALE));
  if (!fillBuf || fillBuf.width !== w || fillBuf.height !== h) {
    fillBuf = document.createElement('canvas');
    fillBuf.width = w; fillBuf.height = h;
  }
  let g = fillBuf.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'copy';
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, w, h);
  g.setTransform(FILL_SCALE, 0, 0, FILL_SCALE, 0, 0);
  g.globalCompositeOperation = 'source-over';

  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    let poly = s.poly;
    if (!poly || poly.length < 3) continue;
    let f = s.dying ? retractA(s.fade) : s.fade;
    if (f <= 0.02) continue;
    let a = cellFill * f * (0.55 + 0.45 * s.z);
    if (a <= 0.004) continue;
    let v = Math.round(255 * Math.min(1, a * 2.2));
    g.globalAlpha = Math.min(0.95, a);
    g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    g.beginPath();
    g.moveTo(poly[0][0], poly[0][1]);
    for (let e = 1; e < poly.length; e++) g.lineTo(poly[e][0], poly[e][1]);
    g.closePath();
    g.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  inkBase = { canvas: fillBuf, alpha: 1 };
}

function collectVoronoiEdges() {
  let edges = new Map(), q = 4;
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i], poly = s.poly;
    if (!poly || poly.length < 2) continue;
    let vit = constrain(map(s.food, deathFloor, birthThresh, 0.15, 1.4), 0.1, 1.5);

    let ca = (s.dying ? retractA(s.fade) : s.fade) * vit;
    for (let e = 0; e < poly.length - 1; e++) {
      let a = poly[e], b = poly[e + 1];
      if (!Number.isFinite(a[0]) || !Number.isFinite(b[0])) continue;
      let ka = Math.round(a[0] * q) + ',' + Math.round(a[1] * q);
      let kb = Math.round(b[0] * q) + ',' + Math.round(b[1] * q);
      let key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      let ex = edges.get(key);
      if (!ex) edges.set(key, { a: a, b: b, alpha: ca, s1: s, s2: null, mat: 1, z: s.z });
      else {
        ex.alpha = Math.min(ex.alpha, ca);

        if (ex.s1 !== s) { ex.s2 = s; ex.z = (ex.s1.z + s.z) * 0.5; }
      }
    }
  }

  if (ordering > 0.001) {
    let seen = new Set();
    for (let e of edges.values()) {
      if (!e.s2) continue;
      let i1 = e.s1.id, i2 = e.s2.id;
      let k = i1 < i2 ? i1 + '_' + i2 : i2 + '_' + i1;
      seen.add(k);
      let born = edgeAge.get(k);
      if (born === undefined) { born = frameCount; edgeAge.set(k, born); }
      e.mat = constrain((frameCount - born) / AGE_FULL, 0, 1);
    }
    sweepEdgeAges(seen);
  }

  computeTees(edges);
  return edges;
}

// 直角轴：把 Voronoi 的顶角连续地推向泡沫里那种 T 型交汇。
// The tee axis pushes Voronoi vertices continuously towards the T-junctions found in foam.
function computeTees(edges) {
  for (let e of edges.values()) { e.t0 = null; e.t1 = null; }
  if (tee <= 0.001) return;

  let refLen = Math.sqrt(width * height / Math.max(1, sites.length));
  let V = new Map(), q = 4;

  for (let e of edges.values()) {
    let L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    if (L < 1e-6) continue;
    let rank = (e.mat || 1) * 2 + L / refLen;
    let ends = [[e.a, e.b, 0], [e.b, e.a, 1]];
    for (let t = 0; t < 2; t++) {
      let pt = ends[t][0], other = ends[t][1];
      let k = Math.round(pt[0] * q) + ',' + Math.round(pt[1] * q);
      let arr = V.get(k);
      if (!arr) { arr = []; V.set(k, arr); }
      arr.push({ e: e, w: ends[t][2],
                 ux: (other[0] - pt[0]) / L, uy: (other[1] - pt[1]) / L, r: rank });
    }
  }

  for (let arr of V.values()) {
    if (arr.length !== 3) continue;
    arr.sort(function (a, b) { return b.r - a.r; });
    let a0 = arr[0], a1 = arr[1], a2 = arr[2];


    let ax = a0.ux - a1.ux, ay = a0.uy - a1.uy;
    let L = Math.hypot(ax, ay);
    if (L < 1e-6) continue;
    ax /= L; ay /= L;


    let px = -ay, py = ax;
    if (a2.ux * px + a2.uy * py < 0) { px = -px; py = -py; }

    setTee(a0,  ax,  ay);
    setTee(a1, -ax, -ay);
    setTee(a2,  px,  py);
  }
}


function setTee(rec, ux, uy) {
  let mx = rec.ux + (ux - rec.ux) * tee;
  let my = rec.uy + (uy - rec.uy) * tee;
  let L = Math.hypot(mx, my);
  if (L < 1e-6) return;
  let v = [mx / L, my / L];
  if (rec.w === 0) rec.e.t0 = v; else rec.e.t1 = v;
}


// 一堵墙画成三次贝塞尔，控制点由矢高与目标切向共同决定。
// Each wall is a cubic Bézier whose control points come from the bulge and the target tangent.
function drawWall(x0, y0, c1x, c1y, c2x, c2y, x1, y1, alpha, w, z) {
  let a = Math.min(maxGlowAlpha, alpha);
  if (a <= 0.002) return;


  let approx = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y)
             + Math.hypot(x1 - c2x, y1 - c2y);
  let K = constrain(Math.ceil(approx / (WALL_STEP * renderStepMul)), 2, 40);
  let px = x0, py = y0;
  for (let i = 1; i <= K; i++) {
    let t = i / K, u = 1 - t;
    let qx = u*u*u*x0 + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*x1;
    let qy = u*u*u*y0 + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*y1;
    let m = t - 0.5 / K;


    let ww = w * (1 + wetness * 0.55 * (1 - sin(m * PI)));
    batchSeg(px, py, qx, qy, a, ww, z);
    px = qx; py = qy;
  }
}

// Lloyd 松弛读的重心。退化多边形回退到顶点平均，避免除以零。
// The centroid Lloyd relaxation moves towards; degenerate polygons fall back to the vertex mean.
function polygonCentroidSafe(poly, fx, fy, out) {
  out = out || { x: fx, y: fy };
  if (!poly || poly.length < 3) { out.x = fx; out.y = fy; return out; }
  let count = poly.length;
  if (poly[0][0] === poly[count - 1][0] && poly[0][1] === poly[count - 1][1]) count--;
  if (count < 3) { out.x = fx; out.y = fy; return out; }
  let area2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < count; i++) {
    let j = (i + 1) % count;
    let x0 = poly[i][0], y0 = poly[i][1], x1 = poly[j][0], y1 = poly[j][1];
    let cr = x0 * y1 - x1 * y0;
    area2 += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
  }
  if (Math.abs(area2) < 1e-6 || !Number.isFinite(area2)) {
    let ax = 0, ay = 0;
    for (let i = 0; i < count; i++) { ax += poly[i][0]; ay += poly[i][1]; }
    out.x = ax / count; out.y = ay / count;
    return out;
  }
  out.x = cx / (3 * area2); out.y = cy / (3 * area2);
  return out;
}

function makeSite(x, y, food, newborn) {
  return {
    id: nextSiteId++,
    x: x, y: y, vx: 0, vy: 0,
    pullx: 0, pully: 0, intake: 0,
    food: food, age: 0,
    ageFactor: random(0.6, 1.5),
    poly: null, area: 0, centroid: { x: x, y: y },
    z: 0.5,
    dying: false, fade: newborn ? 0 : 1, gx: undefined, gy: undefined
  };
}

function countAlive() {
  let n = 0;
  for (let i = 0; i < sites.length; i++) if (!sites[i].dying) n++;
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
#axes header s{text-decoration:none;opacity:.5;font-size:13px;line-height:1}
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
  if (frameCount % 20 !== 0) return;
  let e = document.getElementById('ax-stat');
  if (!e) return;
  let ns = [], as = [];
  for (let i = 0; i < sites.length; i++) {
    let s = sites[i];
    if (s.dying || !s.poly || s.poly.length < 4) continue;
    let n = s.poly.length;
    if (s.poly[0][0] === s.poly[n - 1][0] && s.poly[0][1] === s.poly[n - 1][1]) n--;
    ns.push(n); as.push(s.area);
  }
  if (!ns.length) return;
  let hex = ns.filter(function (n) { return n === 6; }).length / ns.length;
  let mA = as.reduce(function (a, b) { return a + b; }, 0) / as.length;
  let cv = Math.sqrt(as.reduce(function (a, b) { return a + (b - mA) * (b - mA); }, 0) / as.length) / mA;
  e.innerHTML = ns.length + ' · hex ' + (hex * 100).toFixed(0) + '% · CV ' + cv.toFixed(2);
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
  if (!tour) {
    let cap = document.getElementById('axhint');
    if (cap) { cap.classList.remove('tour'); cap.classList.remove('on'); }
  }
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
const MODULE_ID = 'III';
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
