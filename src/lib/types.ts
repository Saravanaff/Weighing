/** Language codes the app speaks and records names in. */
export type LangCode = 'en' | 'hi' | 'bn' | 'ta';

/** The four names an item carries, one per language. */
export interface LocalizedNames {
  en?: string;
  hi?: string;
  bn?: string;
  ta?: string;
}

/** An item as returned by GET /api/items. */
export interface Item {
  id: number;
  slug: string;
  code: string;
  name: string;
  names: LocalizedNames;
  /**
   * Path of the item photo on the server, e.g. '/item-images/maize-a1b2.jpg'.
   * Only the path is stored in the database; the picture itself is a file. Null
   * when the item has no photo.
   */
  imagePath?: string | null;
  createdAt: string;
}

/** One ingredient line inside a formula or a weighing. */
export interface WeighingLine {
  itemId?: number | null;
  itemName: string;
  requiredWeight: number;
  /**
   * The weight actually measured, on bills only. Formulas have no measured
   * value, and bills saved before this existed keep it null.
   */
  actualWeight?: number | null;
}

/** A saved formula as returned by GET /api/formulas. */
export interface Formula {
  id: number;
  name: string;
  itemCount: number;
  totalWeight: number;
  createdAt: string;
  lines: Array<WeighingLine & { id?: number; position?: number }>;
}

/** A completed weighing ("bill") with its lines. */
export interface Bill {
  id: number;
  batchNo: string;
  weighedAt: string;
  formulaName: string | null;
  itemCount: number;
  totalWeight: number;
  lines?: WeighingLine[];
}

/** A single bill fetched by id: the list endpoint omits lines, this one has them. */
export interface BillDetail extends Bill {
  lines: Array<WeighingLine & { id?: number }>;
}

/** Totals shared by the overview and monthly reports. */
export interface ReportTotals {
  bills: number;
  items: number;
  totalKg: number;
}

export interface MonthlyBucket {
  month: string;
  bills: number;
  items: number;
  totalKg: number;
}

export interface OverviewReport {
  totals: ReportTotals;
  series: MonthlyBucket[];
}

export interface PerItemTotal {
  itemName: string;
  times: number;
  totalKg: number;
}

export interface PerFormulaTotal {
  formulaName: string;
  bills: number;
  totalKg: number;
}

export interface MonthlyReport {
  year: number;
  month: number;
  key: string;
  summary: ReportTotals;
  perItem: PerItemTotal[];
  perFormula: PerFormulaTotal[];
}

/** One day of production: the same breakdowns as the month view, plus the
 *  individual bills in the order they were weighed. */
export interface DailyReport {
  date: string;
  summary: ReportTotals;
  perItem: PerItemTotal[];
  perFormula: PerFormulaTotal[];
  bills: Bill[];
}

export interface YearlyReport {
  year: number;
  months: MonthlyBucket[];
  totals: ReportTotals;
}

/** Lifecycle of a single line in the active cart. */
export type CartItemStatus = 'pending' | 'active' | 'completed';

/** One line in the weighing cart: an item plus the weight it needs. */
export interface CartItem {
  /** Client-side identity; the server does not store it. */
  uid: string;
  id: number | null;
  slug: string;
  name: string;
  names: LocalizedNames;
  /** Copied from the item when the line was queued, null when it has no photo. */
  imagePath?: string | null;
  required: number;
  status: CartItemStatus;
  /** Filled in once the operator accepts this line. */
  actual?: number | null;
  /** Set when the line came from a loaded formula. */
  formulaName?: string | null;
  formulaId?: number | null;
}

/** The saved weighing posted when a cart is completed. */
export interface CompletionSummary {
  batchNo: string;
  weighedAt: string;
  totalWeight: number;
  lines: Array<{ name: string; required: number; actual: number | null }>;
}

/**
 * The minimum an object needs to be displayed and spoken. Both a master Item
 * and a CartItem line satisfy this, which is what lets the shared TTS helpers
 * serve both.
 */
export interface NameBearing {
  name: string;
  names: LocalizedNames;
  slug?: string;
}
