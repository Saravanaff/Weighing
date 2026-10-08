import { createRequester } from '../shared/http.ts';
import type {
  Bill,
  BillDetail,
  Formula,
  Item,
  MonthlyReport,
  DailyReport,
  OverviewReport,
  WeighingLine,
  YearlyReport,
} from './lib/types.ts';
import { serverBase } from './lib/serverAddress.ts';

// The base is read on every call: in the Android build the server address is
// configurable at runtime, so it must not be frozen at import time.
const request = createRequester(() => `${serverBase()}/api`);

export interface NewItemPayload {
  name: string;
  name_hi?: string;
  name_bn?: string;
  name_ta?: string;
}

/** The server resolves item_name from itemId, so the name is not sent. */
export interface FormulaPayload {
  name: string;
  lines: Array<Pick<WeighingLine, 'itemId' | 'requiredWeight'>>;
}

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
  createItem: (payload: NewItemPayload) =>
    request<Item>('/items', { method: 'POST', body: JSON.stringify(payload) }),
  /** Attaches or replaces an item photo from a resized data: URL. */
  uploadItemImage: (id: number, dataUrl: string) =>
    request<Item>(`/items/${id}/image`, { method: 'POST', body: JSON.stringify({ dataUrl }) }),
  /** Clears the item photo and deletes the file behind it. */
  removeItemImage: (id: number) =>
    request<Item>(`/items/${id}/image`, { method: 'DELETE' }),
  deleteItem: (id: number) => request<{ ok: boolean }>(`/items/${id}`, { method: 'DELETE' }),
  saveWeighing: (payload: WeighingPayload) =>
    // A longer window than the default: this is the request that saves real
    // production data, and a 15 second abort on a slow link just turns a
    // successful save into an error screen the operator has to retry.
    request<Bill>('/weighings', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 60000,
    }),
  getWeighings: () => request<Bill[]>('/weighings'),
  getWeighing: (id: number) => request<BillDetail>(`/weighings/${id}`),
  getFormulas: () => request<Formula[]>('/formulas'),
  createFormula: (payload: FormulaPayload) =>
    request<Formula>('/formulas', { method: 'POST', body: JSON.stringify(payload) }),
  updateFormula: (id: number, payload: FormulaPayload) =>
    request<Formula>(`/formulas/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteFormula: (id: number) => request<{ ok: boolean }>(`/formulas/${id}`, { method: 'DELETE' }),
  getOverview: () => request<OverviewReport>('/reports/overview'),
  getMonthlyReport: (year: number, month: number) =>
    request<MonthlyReport>(`/reports/monthly?year=${year}&month=${month}`),
  getYearlyReport: (year: number) => request<YearlyReport>(`/reports/yearly?year=${year}`),
  getDailyReport: (date: string) =>
    request<DailyReport>(`/reports/daily?date=${encodeURIComponent(date)}`),
  getScalePorts: () => request<import('../shared/scale.ts').ScalePortsResponse>('/scale/ports'),
  getScaleStatus: () => request<import('../shared/scale.ts').ScaleStatusResponse>('/scale/status'),
  connectScale: (payload: { port?: string; baudRate?: number }) =>
    request<import('../shared/scale.ts').ScaleStatusResponse>('/scale/connect', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disconnectScale: () =>
    request<import('../shared/scale.ts').ScaleStatusResponse>('/scale/disconnect', {
      method: 'POST',
    }),
  setPlcOutput: (state: 'on' | 'off') =>
    request<{ ok: boolean; state: 'on' | 'off' }>('/plc/output', {
      method: 'POST',
      body: JSON.stringify({ state }),
    }),
  getPlcConfig: () => request<{ ip: string }>('/plc/config'),
  setPlcConfig: (ip: string) =>
    request<{ ip: string }>('/plc/config', {
      method: 'PUT',
      body: JSON.stringify({ ip }),
    }),
};
