/**
 * Conversion settings typed on a command line (`-O height=720`): which are booleans or numbers.
 *
 * @module
 */

type OptionType = 'boolean' | 'integer' | 'number';

/**
 * The settings whose values are not text, by type. Every other setting is text, also those that
 * look like numbers (`height=720` is the text `"720"`).
 */
export const OPTION_TYPES: Readonly<Record<string, OptionType>> = {
  mute: 'boolean',
  copyVideo: 'boolean',
  normalize: 'boolean',
  fade: 'boolean',
  copyAudio: 'boolean',
  keepMetadata: 'boolean',
  keepLocation: 'boolean',
  lossless: 'boolean',
  flip: 'boolean',
  pdfA: 'boolean',
  sheetsOnePage: 'boolean',
  ocr: 'boolean',
  header: 'boolean',
  tocPage: 'boolean',
  hiddenSlides: 'boolean',
  maxSize: 'integer',
  resizeWidth: 'integer',
  resizeHeight: 'integer',
  maxKb: 'integer',
  sheet: 'integer',
  trimStart: 'number',
  trimEnd: 'number',
  start: 'number',
  subtitleShift: 'number',
};

const TRUE = new Set(['true', 'yes', 'on', '1']);
const FALSE = new Set(['false', 'no', 'off', '0']);

/** One setting's value from text: a boolean, a number or text, by the setting's type. */
export function parseOption(key: string, value: string): string | number | boolean {
  const type = Object.hasOwn(OPTION_TYPES, key) ? OPTION_TYPES[key] : undefined;
  const text = value.trim();
  if (type === 'boolean') {
    if (TRUE.has(text.toLowerCase())) return true;
    if (FALSE.has(text.toLowerCase())) return false;
    throw new TypeError(`${key} takes true or false, not ${JSON.stringify(value)}`);
  }
  if (type === 'integer') {
    if (!/^-?\d+$/.test(text))
      throw new TypeError(`${key} takes a whole number, not ${JSON.stringify(value)}`);
    return Number(text);
  }
  if (type === 'number') {
    const number = Number(text);
    if (text === '' || !Number.isFinite(number))
      throw new TypeError(`${key} takes a number, not ${JSON.stringify(value)}`);
    return number;
  }
  return value;
}
