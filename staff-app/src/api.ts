import { createRequester } from '../../shared/http.ts';
import type { ScalePortsResponse, ScaleStatusResponse } from '../../shared/scale.ts';
import type { Bill, Formula, Item, WeighingLine } from './lib/types.ts';
import { API_BASE } from './lib/config.ts';

export { API_BASE };

const request = createRequester(API_BASE);

export interface WeighingPayload {
  weighedAt: string;
  formulaName: string | null;
  lines: WeighingLine[];
  /**
   * Identifies this one physical weighing for as long as it is being retried.
   * The server treats a repeated reference as the same bill and returns the
   * original, so a RETRY SAVE after a response that was lost in transit cannot
   * write a second identical bill and double count the batch.
   */
  ref: string;
}

export const api = {
  getItems: () => request<Item[]>('/items'),
  getFormulas: () => request<Formula[]>('/formulas'),
  saveWeighing: (payload: WeighingPayload) =>
    // A longer window than the default: this is the request that saves real
    // production data, and a 15 second abort on a slow link just turns a
    // successful save into an error screen the operator has to retry.
    request<Bill>('/weighings', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 60000,
    }),
  getScalePorts: () => request<ScalePortsResponse>('/scale/ports'),
  getScaleStatus: () => request<ScaleStatusResponse>('/scale/status'),
  connectScale: (payload: { port?: string; baudRate?: number }) =>
    request<ScaleStatusResponse>('/scale/connect', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disconnectScale: () => request<ScaleStatusResponse>('/scale/disconnect', { method: 'POST' }),
  setPlcOutput: (state: 'on' | 'off') =>
    request<{ ok: boolean; state: 'on' | 'off' }>('/plc/output', {
      method: 'POST',
      body: JSON.stringify({ state }),
    }),
};

export type { WeighingLine };
