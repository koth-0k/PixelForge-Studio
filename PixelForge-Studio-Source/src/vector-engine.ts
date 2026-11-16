import type { LayerModel, ShapeLayerData, TextLayerData } from './editor-model';

function textFont(data: TextLayerData): string {
  return `${data.italic ? 'italic ' : ''}${data.fontWeight} ${data.fontSize}px "${data.fontFamily.replace(/["\\]/g, '')}"`;
}

function spacedWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  let width = 0;
  for (const char of text) width += ctx.measureText(char).width;
  return width + Math.max(0, text.length - 1) * spacing;
}

function splitLongWord(ctx: CanvasRenderingContext2D, word: string, maxWidth: number, spacing: number): string[] {
  const parts: string[] = [];
  let part: string[] = [];
  let partWidth = 0;
  for (const char of word) {
    const charWidth = ctx.measureText(char).width;
    const nextWidth = partWidth + (part.length ? spacing : 0) + charWidth;
    if (part.length && nextWidth > maxWidth) {
      parts.push(part.join(''));
      part = [char];
      partWidth = charWidth;
    } else {
      part.push(char);
      partWidth = nextWidth;
    }
  }
  if (part.length) parts.push(part.join(''));
  return parts;
}

function wrapParagraph(ctx: CanvasRenderingContext2D, paragraph: string, maxWidth: number, spacing: number): string[] {
  const words = paragraph.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let line = '';
  for (const original of words) {
    const chunks = spacedWidth(ctx, original, spacing) > maxWidth ? splitLongWord(ctx, original, maxWidth, spacing) : [original];
    for (const word of chunks) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && spacedWidth(ctx, candidate, spacing) > maxWidth) { lines.push(line); line = word; }
      else line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

export function drawTextContent(ctx: CanvasRenderingContext2D, data: TextLayerData): void {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, data.boxWidth, data.boxHeight); ctx.clip();
  ctx.font = textFont(data); ctx.textBaseline = 'top'; ctx.fillStyle = data.color;
  const lines = data.content.split('\n').flatMap(paragraph => wrapParagraph(ctx, paragraph, data.boxWidth, data.letterSpacing));
  const lineHeight = data.fontSize * data.lineSpacing;
  lines.forEach((line, index) => {
    const width = spacedWidth(ctx, line, data.letterSpacing);
    const left = data.alignment === 'center' ? (data.boxWidth - width) / 2 : data.alignment === 'right' ? data.boxWidth - width : 0;
    let x = left;
    for (const char of line) { ctx.fillText(char, x, index * lineHeight); x += ctx.measureText(char).width + data.letterSpacing; }
    if (data.underline || data.strikethrough) {
      ctx.strokeStyle = data.color; ctx.lineWidth = Math.max(1, data.fontSize / 16); ctx.beginPath();
      const y = index * lineHeight + (data.underline ? data.fontSize * .92 : data.fontSize * .52);
      ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    }
  });
  ctx.restore();
}

export function drawShapeContent(ctx: CanvasRenderingContext2D, data: ShapeLayerData, width: number, height: number): void {
  const inset = data.strokeEnabled ? data.strokeWidth / 2 : 0;
  const x = inset, y = inset, w = Math.max(0, width - inset * 2), h = Math.max(0, height - inset * 2);
  ctx.save(); ctx.beginPath();
  if (data.kind === 'ellipse') ctx.ellipse(width / 2, height / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (data.kind === 'line') { ctx.moveTo(data.lineStart?.x ?? x, data.lineStart?.y ?? y + h / 2); ctx.lineTo(data.lineEnd?.x ?? x + w, data.lineEnd?.y ?? y + h / 2); }
  else if (data.kind === 'polygon' || data.kind === 'star') {
    const count = data.kind === 'star' ? Math.max(2, data.points) * 2 : Math.max(3, data.sides);
    const cx = width / 2, cy = height / 2, rx = w / 2, ry = h / 2;
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / count;
      const radius = data.kind === 'star' && i % 2 ? .45 : 1;
      const px = cx + Math.cos(angle) * rx * radius, py = cy + Math.sin(angle) * ry * radius;
      if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (data.kind === 'roundedRectangle' && 'roundRect' in ctx) {
    ctx.roundRect(x, y, w, h, Math.max(0, Math.min(data.cornerRadius, w / 2, h / 2)));
  } else ctx.rect(x, y, w, h);
  if (data.fillEnabled && data.kind !== 'line') { ctx.fillStyle = data.fill; ctx.fill(); }
  if (data.strokeEnabled) { ctx.strokeStyle = data.stroke; ctx.lineWidth = data.strokeWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); }
  ctx.restore();
}

export function drawVectorLayer(ctx: CanvasRenderingContext2D, layer: LayerModel): void {
  if (layer.type === 'text' && layer.textData) {
    const data = layer.textData, sx = layer.width / Math.max(1, data.boxWidth), sy = layer.height / Math.max(1, data.boxHeight);
    ctx.save(); ctx.scale(sx, sy); drawTextContent(ctx, data); ctx.restore();
  } else if (layer.type === 'shape' && layer.shapeData) drawShapeContent(ctx, layer.shapeData, layer.width, layer.height);
}

export function drawLayerThumbnail(canvas: HTMLCanvasElement, layer: LayerModel): void {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate((layer.rotation || 0) * Math.PI / 180); ctx.translate(-canvas.width / 2, -canvas.height / 2);
  if (layer.type === 'pixel') ctx.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);
  else if (layer.type === 'text' && layer.textData) {
    const scale = canvas.width / Math.max(1, layer.textData.boxWidth);
    ctx.scale(scale, scale); drawTextContent(ctx, layer.textData);
  } else if (layer.type === 'shape' && layer.shapeData) drawShapeContent(ctx, layer.shapeData, canvas.width, canvas.height);
  ctx.restore();
}
