export {
  parseYaohuaFrame,
  YAOHUA_FRAME_LENGTH,
  YAOHUA_START_CHAR,
} from './yaohua.ts';
export type { ScaleServiceOptions } from './scaleService.ts';
export {
  ScaleService,
  DEFAULT_PORT_PATH,
  DEFAULT_BAUD_RATE,
  SUPPORTED_BAUD_RATES,
} from './scaleService.ts';
export {
  createScaleStreamHandler,
  createScaleStatusHandler,
} from './sse.ts';

import { createScaleStreamHandler, createScaleStatusHandler } from './sse.ts';
import type { ScaleService } from './scaleService.ts';

export function createScaleHttpHandlers(service: ScaleService) {
  return {
    stream: createScaleStreamHandler(service),
    status: createScaleStatusHandler(service),
  };
}
