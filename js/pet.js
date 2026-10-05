/**
 * pet.js — 应用内 Live2D 桌宠（显示/置顶/缩放/拖动）
 *
 * 浏览器沙箱下只能做应用内悬浮，「置顶」指盖过应用内弹窗；
 * 位置存 0~1 归一化视觉坐标，style 写入时除以整页 zoom（zoom 会放大 fixed 定位）。
 */

/** 桌宠缩放区间与默认值 */
export const PET_SCALE_MIN = 0.5;
export const PET_SCALE_MAX = 2;
export const DEFAULT_PET_SCALE = 1;
/** scale=1 时桌宠的基准高度（视觉 CSS px） */
export const PET_BASE_HEIGHT = 420;
/** 置顶 / 普通层级：置顶高于设置弹层(60)与提示条(90)，低于开屏(2000)与悬停气泡(3000) */
export const PET_Z_TOPMOST = 1500;
export const PET_Z_NORMAL = 30;
/** 拖动时元素至少保留在视口内的边长 */
const PET_VISIBLE_MARGIN = 48;
/** 未移动过时距右下角的留白 */
const PET_EDGE_GAP = 24;

export function petZIndex(topmost) {
  return topmost ? PET_Z_TOPMOST : PET_Z_NORMAL;
}

/** 缩放归一化：非法回退默认，越界收敛，按 0.05 步进取整 */
export function normalizePetScale(value, fallback = DEFAULT_PET_SCALE) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, n));
  return Math.round(clamped * 20) / 20;
}

/** 桌宠配置归一化；缺失或非法字段回退默认值 */
export function normalizePet(value) {
  const v = value && typeof value === 'object' ? value : {};
  const p = v.position && typeof v.position === 'object' ? v.position : null;
  // 注意不能写成 Number(p && p.x)：p 为 null 时 Number(null)===0 会把「未拖动过」误判成左上角
  const x = p ? Number(p.x) : NaN;
  const y = p ? Number(p.y) : NaN;
  const valid = Number.isFinite(x) && x >= 0 && x <= 1 && Number.isFinite(y) && y >= 0 && y <= 1;
  return {
    visible: v.visible === true,
    topmost: v.topmost === true,
    scale: normalizePetScale(v.scale),
    position: valid ? { x, y } : null, // null = 未拖动过，用默认右下角
  };
}

/**
 * 计算桌宠容器的 style left/top（布局 px）。
 * ratio 为 null 时落在右下角；viewport/size 均为视觉值，返回值除以 zoom 才是 style 坐标。
 */
export function petStylePosition(ratio, viewport, zoom = 1, size = { width: 0, height: 0 }) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const vw = Number(viewport && viewport.width) || 0;
  const vh = Number(viewport && viewport.height) || 0;
  const w = Number(size && size.width) || 0;
  const h = Number(size && size.height) || 0;
  let left;
  let top;
  if (ratio) {
    left = Number(ratio.x) * vw;
    top = Number(ratio.y) * vh;
  } else {
    left = vw - w - PET_EDGE_GAP;
    top = vh - h - PET_EDGE_GAP;
  }
  const maxLeft = Math.max(0, vw - PET_VISIBLE_MARGIN);
  const maxTop = Math.max(0, vh - PET_VISIBLE_MARGIN);
  left = Math.min(maxLeft, Math.max(PET_VISIBLE_MARGIN - w, left));
  top = Math.min(maxTop, Math.max(PET_VISIBLE_MARGIN - h, top));
  return { left: left / z, top: top / z };
}

/** 拖动结果换算为归一化存储值（视觉坐标比例，clamp 到 0~1） */
export function ratioFromVisual(x, y, viewport) {
  const vw = Number(viewport && viewport.width) || 1;
  const vh = Number(viewport && viewport.height) || 1;
  return {
    x: Math.min(1, Math.max(0, Number(x) / vw)),
    y: Math.min(1, Math.max(0, Number(y) / vh)),
  };
}

// ---------- 浏览器侧运行时 ----------

const SCRIPTS = [
  'js/vendor/live2d/pixi.min.js',
  'js/vendor/live2d/live2dcubismcore.min.js',
  'js/vendor/live2d/pixi-live2d-display.cubism4.min.js',
];
const MODEL_URL = 'assets/live2d/Firefly.model3.json';

let containerEl = null;
let canvasEl = null;
let app = null;
let model = null;
let loadPromise = null;
let ready = false;
let naturalSize = { width: 0, height: 0 };
let currentScale = DEFAULT_PET_SCALE;
let onPositionChange = null;
let getConfig = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.appendChild(el);
  });
}

async function ensureRuntime() {
  if (window.PIXI && window.Live2DCubismCore && window.PIXI.live2d) return;
  for (const src of SCRIPTS) {
    if (src.includes('pixi.min') && window.PIXI) continue;
    if (src.includes('cubismcore') && window.Live2DCubismCore) continue;
    if (src.includes('pixi-live2d-display') && window.PIXI && window.PIXI.live2d) continue;
    await loadScript(src);
  }
  if (!window.PIXI.live2d) throw new Error('Live2D 运行时初始化失败');
  window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker);
}

function zoomFactor() {
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** 按当前 scale 与基准高度重设模型尺寸与画布 */
function resizeToScale() {
  if (!app || !model || !naturalSize.width || !naturalSize.height) return;
  const targetH = PET_BASE_HEIGHT * currentScale;
  const s = targetH / naturalSize.height;
  model.scale.set(s);
  const w = Math.round(naturalSize.width * s);
  const h = Math.round(naturalSize.height * s);
  app.renderer.resize(w, h);
  containerEl.style.width = `${w}px`;
  containerEl.style.height = `${h}px`;
}

/** 应用位置（含 zoom 换算与拖动后 clamp） */
function applyPosition(position) {
  if (!containerEl) return;
  const rect = containerEl.getBoundingClientRect();
  const { left, top } = petStylePosition(
    position,
    { width: window.innerWidth, height: window.innerHeight },
    zoomFactor(),
    { width: rect.width, height: rect.height }
  );
  containerEl.style.left = `${Math.round(left)}px`;
  containerEl.style.top = `${Math.round(top)}px`;
}

/**
 * 初始化桌宠容器：绑定拖动。main.js 启动时调用一次。
 * opts: { container, canvas, getConfig, onPosition }
 */
export function initPet(opts) {
  containerEl = opts.container;
  canvasEl = opts.canvas;
  getConfig = opts.getConfig || null;
  onPositionChange = opts.onPosition || null;
  if (!containerEl) return;

  let grab = null;
  containerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = containerEl.getBoundingClientRect();
    grab = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, x0: e.clientX, y0: e.clientY, moved: false };
    containerEl.setPointerCapture(e.pointerId);
  });
  containerEl.addEventListener('pointermove', (e) => {
    if (!grab) return;
    if (!grab.moved && Math.hypot(e.clientX - grab.x0, e.clientY - grab.y0) < 4) return;
    grab.moved = true;
    // 视觉坐标直接写 style（再除以 zoom）
    const z = zoomFactor();
    containerEl.style.left = `${(e.clientX - grab.dx) / z}px`;
    containerEl.style.top = `${(e.clientY - grab.dy) / z}px`;
  });
  const finish = (e) => {
    if (!grab) return;
    const moved = grab.moved;
    grab = null;
    if (!moved) return;
    try {
      containerEl.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针可能已释放 */
    }
    const rect = containerEl.getBoundingClientRect();
    const ratio = ratioFromVisual(rect.left, rect.top, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (onPositionChange) onPositionChange(ratio);
  };
  containerEl.addEventListener('pointerup', finish);
  containerEl.addEventListener('pointercancel', finish);
}

/** 显示桌宠（首次会加载运行时与模型，返回 Promise） */
export async function showPet({ scale, position } = {}) {
  if (!containerEl) return;
  currentScale = normalizePetScale(scale);
  if (!app) {
    if (!loadPromise) {
      loadPromise = (async () => {
        await ensureRuntime();
        app = new window.PIXI.Application({
          view: canvasEl,
          backgroundAlpha: 0,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
          width: 300,
          height: PET_BASE_HEIGHT,
        });
        app.stop(); // 加载期间不空转
        model = await window.PIXI.live2d.Live2DModel.from(MODEL_URL);
        model.anchor.set(0, 0);
        app.stage.addChild(model);
        naturalSize = { width: model.width / model.scale.x, height: model.height / model.scale.y };
        ready = true;
        resizeToScale();
        app.start();
      })().catch((e) => {
        loadPromise = null; // 允许下次重试
        model = null;
        if (app) {
          try {
            app.destroy(true, { children: true });
          } catch {
            /* 销毁失败也继续抛原错误 */
          }
          app = null;
        }
        throw e;
      });
    }
    await loadPromise;
    if (!ready) return;
  } else {
    resizeToScale();
    app.start();
  }
  const cfg = getConfig ? getConfig() : null;
  // 加载期间用户可能已关掉开关，完成后以最新配置为准
  if (cfg && cfg.visible === false) return;
  containerEl.hidden = false;
  applyPosition(position !== undefined ? position : cfg ? cfg.position : null);
}

/** 隐藏桌宠（保留实例，停止渲染） */
export function hidePet() {
  if (!containerEl) return;
  containerEl.hidden = true;
  if (app) app.stop();
}

/** 应用缩放（未加载时仅记录，加载时生效） */
export function petApplyScale(scale) {
  currentScale = normalizePetScale(scale);
  if (ready) {
    resizeToScale();
    const cfg = getConfig ? getConfig() : null;
    applyPosition(cfg ? cfg.position : null);
  }
}

/** 应用层级 */
export function petApplyTopmost(topmost) {
  if (!containerEl) return;
  containerEl.style.zIndex = String(petZIndex(topmost === true));
}

/** 应用位置 */
export function petApplyPosition(position) {
  applyPosition(position);
}

/** 供 main.js 判断加载失败时清理 */
export function petIsReady() {
  return ready;
}

/** 桌宠是否正在加载中 */
export function petIsLoading() {
  return !!loadPromise && !ready;
}
