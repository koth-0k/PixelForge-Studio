import { assertRgbaBufferLength, rgbaByteLength } from './resource-limits';

export type EffectKind =
  | 'brightnessContrast'
  | 'exposure'
  | 'hueSaturation'
  | 'levels'
  | 'colorBalance'
  | 'grayscale'
  | 'invert'
  | 'sepia'
  | 'blur'
  | 'sharpen';

export type EffectParameters = Record<string, number | boolean>;
export type LayerEffect = { id: string; kind: EffectKind; enabled: boolean; params: EffectParameters };
export type EffectParameterSpec = { key: string; label: string; min: number; max: number; step: number; unit?: string };
export type AdjustmentBlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'soft-light';

const adjustmentBlendModes: AdjustmentBlendMode[] = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'soft-light'];
export function isAdjustmentBlendMode(value: unknown): value is AdjustmentBlendMode {
  return typeof value === 'string' && adjustmentBlendModes.includes(value as AdjustmentBlendMode);
}

const parameterSpecs: Record<EffectKind, EffectParameterSpec[]> = {
  brightnessContrast: [
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  ],
  exposure: [
    { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: .1, unit: 'EV' },
    { key: 'offset', label: 'Offset', min: -1, max: 1, step: .01 },
    { key: 'gamma', label: 'Gamma', min: .1, max: 3, step: .01 },
  ],
  hueSaturation: [
    { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, unit: 'deg' },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
    { key: 'lightness', label: 'Lightness', min: -100, max: 100, step: 1 },
  ],
  levels: [
    { key: 'inputBlack', label: 'Input black', min: 0, max: 254, step: 1 },
    { key: 'inputWhite', label: 'Input white', min: 1, max: 255, step: 1 },
    { key: 'gamma', label: 'Gamma', min: .1, max: 10, step: .01 },
    { key: 'outputBlack', label: 'Output black', min: 0, max: 255, step: 1 },
    { key: 'outputWhite', label: 'Output white', min: 0, max: 255, step: 1 },
  ],
  colorBalance: [
    { key: 'shadowsR', label: 'Shadows R', min: -100, max: 100, step: 1 },
    { key: 'shadowsG', label: 'Shadows G', min: -100, max: 100, step: 1 },
    { key: 'shadowsB', label: 'Shadows B', min: -100, max: 100, step: 1 },
    { key: 'midtonesR', label: 'Midtones R', min: -100, max: 100, step: 1 },
    { key: 'midtonesG', label: 'Midtones G', min: -100, max: 100, step: 1 },
    { key: 'midtonesB', label: 'Midtones B', min: -100, max: 100, step: 1 },
    { key: 'highlightsR', label: 'Highlights R', min: -100, max: 100, step: 1 },
    { key: 'highlightsG', label: 'Highlights G', min: -100, max: 100, step: 1 },
    { key: 'highlightsB', label: 'Highlights B', min: -100, max: 100, step: 1 },
  ],
  grayscale: [],
  invert: [],
  sepia: [{ key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' }],
  blur: [{ key: 'radius', label: 'Radius', min: 0, max: 16, step: .5, unit: 'px' }],
  sharpen: [
    { key: 'amount', label: 'Amount', min: 0, max: 200, step: 1, unit: '%' },
    { key: 'radius', label: 'Radius', min: 1, max: 5, step: 1, unit: 'px' },
  ],
};

const defaults: Record<EffectKind, EffectParameters> = {
  brightnessContrast: { brightness: 0, contrast: 0 },
  exposure: { exposure: 0, offset: 0, gamma: 1 },
  hueSaturation: { hue: 0, saturation: 0, lightness: 0 },
  levels: { inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
  colorBalance: {
    shadowsR: 0, shadowsG: 0, shadowsB: 0,
    midtonesR: 0, midtonesG: 0, midtonesB: 0,
    highlightsR: 0, highlightsG: 0, highlightsB: 0,
    preserveLuminosity: true,
  },
  grayscale: {},
  invert: {},
  sepia: { amount: 100 },
  blur: { radius: 2 },
  sharpen: { amount: 50, radius: 1 },
};

export function effectParameterSpecs(kind: EffectKind): EffectParameterSpec[] {
  return parameterSpecs[kind].map(spec => ({ ...spec }));
}

export function effectName(kind: EffectKind): string {
  return {
    brightnessContrast: 'Brightness / Contrast',
    exposure: 'Exposure',
    hueSaturation: 'Hue / Saturation',
    levels: 'Levels',
    colorBalance: 'Color Balance',
    grayscale: 'Black & White',
    invert: 'Invert',
    sepia: 'Sepia',
    blur: 'Gaussian Blur',
    sharpen: 'Sharpen',
  }[kind];
}

export function createEffect(kind: EffectKind, id = `effect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): LayerEffect {
  return { id, kind, enabled: true, params: { ...defaults[kind] } };
}

export function cloneEffect(effect: LayerEffect): LayerEffect {
  return { ...effect, params: { ...effect.params } };
}

export function validateEffectStack(value: unknown): LayerEffect[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('The layer effect stack is invalid.');
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Layer effect ${index + 1} is invalid.`);
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 128 || ids.has(raw.id)) {
      throw new Error('Layer effect IDs must be unique non-empty strings.');
    }
    if (typeof raw.enabled !== 'boolean') throw new Error(`Layer effect ${raw.id} has an invalid enabled state.`);
    if (typeof raw.kind !== 'string' || !Object.prototype.hasOwnProperty.call(defaults, raw.kind)) {
      throw new Error(`Layer effect ${raw.id} uses an unsupported effect type.`);
    }
    if (!raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) {
      throw new Error(`Layer effect ${raw.id} has invalid parameters.`);
    }
    const kind = raw.kind as EffectKind;
    const params = raw.params as Record<string, unknown>;
    const expected = defaults[kind];
    if (Object.keys(params).length !== Object.keys(expected).length
      || Object.keys(params).some(key => !Object.prototype.hasOwnProperty.call(expected, key))) {
      throw new Error(`Layer effect ${raw.id} has unsupported or missing parameters.`);
    }
    const normalized: EffectParameters = {};
    for (const spec of parameterSpecs[kind]) {
      const current = params[spec.key];
      if (typeof current !== 'number' || !Number.isFinite(current) || current < spec.min || current > spec.max) {
        throw new Error(`Layer effect ${raw.id} has an invalid ${spec.label.toLowerCase()} value.`);
      }
      normalized[spec.key] = current;
    }
    if (kind === 'colorBalance') {
      if (typeof params.preserveLuminosity !== 'boolean') {
        throw new Error(`Layer effect ${raw.id} has an invalid luminosity setting.`);
      }
      normalized.preserveLuminosity = params.preserveLuminosity;
    }
    if (kind === 'levels' && Number(normalized.inputWhite) <= Number(normalized.inputBlack)) {
      throw new Error(`Layer effect ${raw.id} must have input white above input black.`);
    }
    ids.add(raw.id);
    return { id: raw.id, kind, enabled: raw.enabled, params: normalized };
  });
}

function clamp(value: number, min = 0, max = 255): number {
  return Math.max(min, Math.min(max, value));
}

function luminance(red: number, green: number, blue: number): number {
  return .2126 * red + .7152 * green + .0722 * blue;
}

function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0, saturation = 0;
  const lightness = (max + min) / 2;
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(section % 2 - 1));
  const offset = lightness - chroma / 2;
  const rgb = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return rgb.map(value => (value + offset) * 255) as [number, number, number];
}

function blurPixels(source: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const blurPass = (input: Uint8ClampedArray, horizontal: boolean): Uint8ClampedArray => {
    const output = new Uint8ClampedArray(input.length);
    const lines = horizontal ? height : width, length = horizontal ? width : height, window = radius * 2 + 1;
    for (let line = 0; line < lines; line++) {
      const sums = [0, 0, 0, 0];
      const indexAt = (position: number) => horizontal
        ? (line * width + Math.max(0, Math.min(width - 1, position))) * 4
        : (Math.max(0, Math.min(height - 1, position)) * width + line) * 4;
      const add = (position: number, direction: number) => {
        const index = indexAt(position), alpha = input[index + 3] / 255;
        sums[0] += input[index] * alpha * direction;
        sums[1] += input[index + 1] * alpha * direction;
        sums[2] += input[index + 2] * alpha * direction;
        sums[3] += input[index + 3] * direction;
      };
      for (let position = -radius; position <= radius; position++) add(position, 1);
      for (let position = 0; position < length; position++) {
        const outputIndex = horizontal ? (line * width + position) * 4 : (position * width + line) * 4;
        output[outputIndex + 3] = sums[3] / window;
        if (sums[3]) {
          output[outputIndex] = sums[0] * 255 / sums[3];
          output[outputIndex + 1] = sums[1] * 255 / sums[3];
          output[outputIndex + 2] = sums[2] * 255 / sums[3];
        }
        add(position - radius, -1);
        add(position + radius + 1, 1);
      }
    }
    return output;
  };
  return blurPass(blurPass(source, true), false);
}

function applyOneEffect(source: Uint8ClampedArray, width: number, height: number, effect: LayerEffect): Uint8ClampedArray {
  const { params } = effect;
  if (effect.kind === 'blur') {
    const radius = Math.max(0, Math.round(Number(params.radius)));
    return radius ? blurPixels(source, width, height, radius) : source;
  }
  if (effect.kind === 'sharpen') {
    const radius = Math.max(1, Math.round(Number(params.radius)));
    const blurred = blurPixels(source, width, height, radius), amount = Number(params.amount) / 100;
    const output = new Uint8ClampedArray(source);
    for (let index = 0; index < output.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        output[index + channel] = clamp(source[index + channel] + (source[index + channel] - blurred[index + channel]) * amount);
      }
    }
    return output;
  }
  const output = new Uint8ClampedArray(source);
  for (let index = 0; index < output.length; index += 4) {
    const red = source[index], green = source[index + 1], blue = source[index + 2];
    if (effect.kind === 'brightnessContrast') {
      const brightness = Number(params.brightness) * 2.55, contrast = Number(params.contrast) / 100 + 1;
      output[index] = clamp((red - 127.5) * contrast + 127.5 + brightness);
      output[index + 1] = clamp((green - 127.5) * contrast + 127.5 + brightness);
      output[index + 2] = clamp((blue - 127.5) * contrast + 127.5 + brightness);
    } else if (effect.kind === 'exposure') {
      const factor = 2 ** Number(params.exposure), offset = Number(params.offset) * 255, gamma = Number(params.gamma);
      for (let channel = 0; channel < 3; channel++) output[index + channel] = clamp(255 * (clamp((source[index + channel] * factor + offset) / 255, 0, 1)) ** (1 / gamma));
    } else if (effect.kind === 'hueSaturation') {
      const [hue, saturation, lightness] = rgbToHsl(red, green, blue);
      const adjusted = hslToRgb(
        hue + Number(params.hue),
        clamp(saturation * (1 + Number(params.saturation) / 100), 0, 1),
        clamp(lightness + Number(params.lightness) / 200, 0, 1),
      );
      output[index] = clamp(adjusted[0]); output[index + 1] = clamp(adjusted[1]); output[index + 2] = clamp(adjusted[2]);
    } else if (effect.kind === 'levels') {
      const black = Number(params.inputBlack), white = Number(params.inputWhite), gamma = Number(params.gamma);
      const outputBlack = Number(params.outputBlack), outputWhite = Number(params.outputWhite);
      for (let channel = 0; channel < 3; channel++) {
        const normalized = clamp((source[index + channel] - black) / (white - black), 0, 1);
        output[index + channel] = clamp(outputBlack + normalized ** (1 / gamma) * (outputWhite - outputBlack));
      }
    } else if (effect.kind === 'colorBalance') {
      const light = luminance(red, green, blue) / 255;
      const weights = [1 - light, 1 - Math.abs(2 * light - 1), light];
      const originalLuminosity = luminance(red, green, blue);
      for (let channel = 0; channel < 3; channel++) {
        const name = ['R', 'G', 'B'][channel];
        const change = Number(params[`shadows${name}`]) * weights[0]
          + Number(params[`midtones${name}`]) * weights[1]
          + Number(params[`highlights${name}`]) * weights[2];
        output[index + channel] = clamp(source[index + channel] + change * 2.55);
      }
      if (params.preserveLuminosity === true) {
        const delta = originalLuminosity - luminance(output[index], output[index + 1], output[index + 2]);
        for (let channel = 0; channel < 3; channel++) output[index + channel] = clamp(output[index + channel] + delta);
      }
    } else if (effect.kind === 'grayscale') {
      const gray = luminance(red, green, blue);
      output[index] = output[index + 1] = output[index + 2] = gray;
    } else if (effect.kind === 'invert') {
      output[index] = 255 - red; output[index + 1] = 255 - green; output[index + 2] = 255 - blue;
    } else if (effect.kind === 'sepia') {
      const amount = Number(params.amount) / 100, sepia = [
        .393 * red + .769 * green + .189 * blue,
        .349 * red + .686 * green + .168 * blue,
        .272 * red + .534 * green + .131 * blue,
      ];
      for (let channel = 0; channel < 3; channel++) output[index + channel] = clamp(source[index + channel] * (1 - amount) + sepia[channel] * amount);
    }
  }
  return output;
}

export function applyEffectStack(pixels: Uint8ClampedArray, width: number, height: number, effects: LayerEffect[]): Uint8ClampedArray {
  let expectedBytes: number;
  try { expectedBytes = rgbaByteLength(width, height); }
  catch { throw new Error('Effect input dimensions are invalid or exceed the document pixel limit.'); }
  if (pixels.length !== expectedBytes) {
    throw new Error('Effect input dimensions do not match the pixel buffer.');
  }
  let output = pixels;
  for (const effect of effects) if (effect.enabled) output = applyOneEffect(output, width, height, effect);
  return output === pixels ? new Uint8ClampedArray(pixels) : output;
}

export function blendAdjustmentPixels(
  original: Uint8ClampedArray,
  adjusted: Uint8ClampedArray,
  opacity: number,
  mask?: Uint8ClampedArray,
  blend: AdjustmentBlendMode = 'source-over',
): Uint8ClampedArray {
  assertRgbaBufferLength(original.length);
  if (original.length !== adjusted.length || original.length % 4 !== 0 || (mask && mask.length !== original.length / 4)) {
    throw new Error('Adjustment blend buffers have incompatible dimensions.');
  }
  if (!isAdjustmentBlendMode(blend)) throw new Error(`Unsupported adjustment blend mode: ${String(blend)}.`);
  const output = new Uint8ClampedArray(original);
  const layerOpacity = clamp(opacity, 0, 100) / 100;
  for (let index = 0, pixel = 0; index < output.length; index += 4, pixel++) {
    const weight = layerOpacity * (mask ? mask[pixel] / 255 : 1);
    if (original[index + 3] && weight) for (let channel = 0; channel < 3; channel++) {
      const base = original[index + channel], source = adjusted[index + channel];
      let blended = source;
      if (blend === 'multiply') blended = base * source / 255;
      else if (blend === 'screen') blended = 255 - (255 - base) * (255 - source) / 255;
      else if (blend === 'overlay') blended = base < 128 ? 2 * base * source / 255 : 255 - 2 * (255 - base) * (255 - source) / 255;
      else if (blend === 'darken') blended = Math.min(base, source);
      else if (blend === 'lighten') blended = Math.max(base, source);
      else if (blend === 'color-dodge') blended = source >= 255 ? 255 : Math.min(255, base * 255 / (255 - source));
      else if (blend === 'soft-light') {
        const backdrop = base / 255, foreground = source / 255;
        const curve = backdrop <= .25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
        blended = 255 * (foreground <= .5
          ? backdrop - (1 - 2 * foreground) * backdrop * (1 - backdrop)
          : backdrop + (2 * foreground - 1) * (curve - backdrop));
      }
      output[index + channel] = base + (blended - base) * weight;
    }
  }
  return output;
}

export function applyAdjustmentLayerPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  effects: LayerEffect[],
  opacity: number,
  mask?: Uint8ClampedArray,
  visible = true,
  blend: AdjustmentBlendMode = 'source-over',
): Uint8ClampedArray {
  const expectedBytes = rgbaByteLength(width, height);
  if (pixels.length !== expectedBytes || (mask && mask.length !== expectedBytes / 4)) {
    throw new Error('Adjustment input dimensions do not match the pixel buffers.');
  }
  if (!visible || opacity <= 0 || !effects.some(effect => effect.enabled)) return new Uint8ClampedArray(pixels);
  const adjusted = applyEffectStack(pixels, width, height, effects);
  return blendAdjustmentPixels(pixels, adjusted, opacity, mask, blend);
}

