import type { ChannelView } from './editor-model';

export function createChannelPreview(source: Uint8ClampedArray, channel: ChannelView): Uint8ClampedArray {
  if (source.length % 4 !== 0) throw new Error('Channel preview data must contain complete RGBA pixels.');
  const preview = new Uint8ClampedArray(source);
  if (channel === 'rgb') return preview;
  for (let index = 0; index < preview.length; index += 4) {
    if (channel === 'alpha') {
      preview[index] = source[index + 3];
      preview[index + 1] = source[index + 3];
      preview[index + 2] = source[index + 3];
      preview[index + 3] = 255;
      continue;
    }
    const component = channel === 'red' ? 0 : channel === 'green' ? 1 : 2;
    const value = source[index + component];
    preview[index] = value;
    preview[index + 1] = value;
    preview[index + 2] = value;
  }
  return preview;
}
