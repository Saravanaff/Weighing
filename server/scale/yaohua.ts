export const YAOHUA_FRAME_LENGTH = 8;
export const YAOHUA_START_CHAR = '=';

/**
 * Parse a single YH-T7E (YAOHUA) scale frame.
 *
 * A frame is 8 characters:
 *   '=' followed by 7 characters. The last of the 7 is the sign character
 *   ('-' indicates a negative reading, anything else is positive). The
 *   remaining 6 characters are the digits (including the decimal point) in
 *   reversed order, so we reverse them before parsing.
 *
 *   =052.100  ->  payload "052.100"  ->  digits "052.1"  ->  "1.250"  ->  1.25
 *   =003.00-  ->  payload "003.00-"  ->  digits "003.0"  ->  "0.300"  ->  -0.3
 *
 * @returns the weight in kilograms, or null when this is not a usable frame.
 *   Null is the normal result for noise: a floating or mis-wired RX line
 *   produces plenty of bytes and almost none of them decode.
 */
export function parseYaohuaFrame(frame: string | undefined | null): number | null {
  if (!frame || frame.length < YAOHUA_FRAME_LENGTH) return null;
  if (frame[0] !== YAOHUA_START_CHAR) return null;
  const payload = frame.slice(1, YAOHUA_FRAME_LENGTH);
  const signChar = payload[payload.length - 1];
  const digitPart = payload.slice(0, payload.length - 1);
  const normalOrder = digitPart.split('').reverse().join('');
  const value = Number(normalOrder);
  if (!Number.isFinite(value)) return null;
  return signChar === '-' ? -value : value;
}
