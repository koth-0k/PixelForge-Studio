export type BrushTip = 'round' | 'pencil' | 'soft' | 'texture';
export type BrushEngineSettings = {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  smoothing: number;
  blend: GlobalCompositeOperation;
  tip: BrushTip;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureFlow: boolean;
};

export type BrushPoint = { x: number; y: number; pressure: number };
export type BrushSpacingState = { distanceSinceStamp: number };

export const DEFAULT_BRUSH_SETTINGS: BrushEngineSettings = {
  size: 28, hardness: 80, opacity: 100, flow: 100, spacing: 12, smoothing: 25,
  blend: 'source-over', tip: 'round', pressureSize: false, pressureOpacity: false, pressureFlow: false,
};

export function brushStampInterval(size: number, spacing: number): number {
  return Math.max(0.5, size * Math.max(1, spacing) / 100);
}

function stamp(ctx: CanvasRenderingContext2D, p: BrushPoint, settings: BrushEngineSettings, color: string, eraser: boolean) {
  const pressure = Math.max(0.05, Math.min(1, p.pressure || 1));
  const size = Math.max(0.5, settings.size * (settings.pressureSize ? pressure : 1));
  const radius = size / 2;
  const pressureAlpha = settings.pressureOpacity ? pressure : 1;
  const pressureFlow = settings.pressureFlow ? pressure : 1;
  const textureJitter = settings.tip === 'texture' ? 0.55 + ((Math.sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.45 : 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, settings.opacity / 100 * settings.flow / 100 * pressureAlpha * pressureFlow * textureJitter));
  ctx.globalCompositeOperation = eraser ? 'destination-out' : settings.blend;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  if (settings.tip === 'pencil') {
    ctx.fill();
  } else {
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    const hardEdge = Math.min(settings.hardness / 100, Math.max(0, 1 - 1 / Math.max(1, radius)));
    if (settings.tip === 'soft') {
      gradient.addColorStop(0, color);
      gradient.addColorStop(Math.max(0.01, hardEdge * 0.45), color);
      gradient.addColorStop(1, `${color}00`);
    } else {
      gradient.addColorStop(0, color);
      gradient.addColorStop(hardEdge, color);
      gradient.addColorStop(1, `${color}00`);
    }
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.restore();
}

export function drawBrushDot(ctx: CanvasRenderingContext2D, point: BrushPoint, settings: BrushEngineSettings, color: string, eraser = false): void {
  stamp(ctx, point, settings, color, eraser);
}

/** Places consistently spaced stamps along a pointer segment and carries spacing across events. */
export function drawBrushSegment(
  ctx: CanvasRenderingContext2D,
  from: BrushPoint,
  to: BrushPoint,
  spacingState: BrushSpacingState,
  settings: BrushEngineSettings,
  color: string,
  eraser = false,
): void {
  forEachBrushStamp(from, to, spacingState, settings, point => stamp(ctx, point, settings, color, eraser));
}

export function forEachBrushStamp(
  from: BrushPoint,
  to: BrushPoint,
  spacingState: BrushSpacingState,
  settings: BrushEngineSettings,
  visit: (point: BrushPoint) => void,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  const interval = brushStampInterval(settings.size, settings.spacing);
  let distance = interval - spacingState.distanceSinceStamp;
  while (distance <= length) {
    const t = distance / length;
    visit({
      x: from.x + dx * t,
      y: from.y + dy * t,
      pressure: from.pressure + (to.pressure - from.pressure) * t,
    });
    distance += interval;
  }
  spacingState.distanceSinceStamp = (spacingState.distanceSinceStamp + length) % interval;
}

export function smoothBrushPoint(previous: BrushPoint, next: BrushPoint, smoothing: number): BrushPoint {
  const amount = Math.max(0, Math.min(0.9, smoothing / 100 * 0.9));
  return {
    x: next.x * (1 - amount) + previous.x * amount,
    y: next.y * (1 - amount) + previous.y * amount,
    pressure: next.pressure * (1 - amount) + previous.pressure * amount,
  };
}

