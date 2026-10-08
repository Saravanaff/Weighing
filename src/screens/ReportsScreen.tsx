import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { fmtWeight } from '../lib/weights.ts';
import type {
  DailyReport,
  MonthlyReport,
  OverviewReport,
  ReportTotals,
  YearlyReport,
} from '../lib/types.ts';

/** A cell in a report table or CSV: pre-formatted text or a raw number. */
type Cell = string | number;

/**
 * Every report renders from this one shape, so the print view and the CSV
 * export only have to understand a single document format.
 */
interface ReportSection {
  heading: string;
  head: Cell[];
  /** 'l' left, 'r' right — drives the print column alignment. */
  align: Array<'l' | 'r'>;
  body: Cell[][];
  totals?: Cell[];
  note?: string | null;
}

interface ReportDoc {
  code: string;
  title: string;
  subtitle: string;
  period: string;
  summary: Array<{ label: string; value: string }>;
  sections: ReportSection[];
  csvFilename: string;
  csvLines: Cell[][];
}

type ReportTab = 'overview' | 'daily' | 'monthly' | 'yearly';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function fmtStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The YYYY-MM-DD value a <input type="date"> expects. */
const toDayValue = (d: Date): string => fmtStamp(d).slice(0, 10);

function downloadCSV(filename: string, lines: Cell[][]): void {
  // Item and formula names are operator-entered, so a name beginning with =,
  // +, - or @ is executed as a formula when the file is opened in Excel or
  // Sheets. Prefixing with a quote neutralises it.
  const escape = (v: Cell) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const csv = lines
    .map((line) => (Array.isArray(line) ? line.map(escape).join(',') : String(line)))
    .join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function buildOverviewDoc(o: OverviewReport): ReportDoc {
  const months = o.series;
  const years = [...new Set(months.map((e) => e.month.slice(0, 4)))];
  const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const period = `${years[0] || '—'} – ${monthLabel(months[months.length - 1]?.month || '')}`;
  return {
    code: 'OVR',
    title: 'Production Overview Report',
    subtitle: 'Last 12 months production summary',
    period,
    summary: [
      { label: 'Total Bills', value: String(o.totals.bills) },
      { label: 'Total Items Weighed', value: String(o.totals.items) },
      { label: 'Total Weight', value: fmtWeight(o.totals.totalKg) },
    ],
    sections: [
      {
        heading: 'MONTH-WISE PRODUCTION — LAST 12 MONTHS',
        head: ['Month', 'Bills', 'Items', 'Total Weight'],
        align: ['l', 'r', 'r', 'r'],
        body: months.map((e) => [monthLabel(e.month), String(e.bills), String(e.items), fmtWeight(e.totalKg)]),
        totals: ['Grand Total', String(o.totals.bills), String(o.totals.items), fmtWeight(o.totals.totalKg)],
      },
    ],
    csvFilename: 'naveen-poultry-farm-overview.csv',
    csvLines: [
      ['Month', 'Bills', 'Items', 'Total Weight (kg)'],
      ...months.map((e) => [monthLabel(e.month), e.bills, e.items, e.totalKg.toFixed(3)]),
      [],
      ['Grand Total', o.totals.bills, o.totals.items, o.totals.totalKg.toFixed(3)],
    ],
  };
}

function buildMonthlyDoc(m: MonthlyReport, yy: number, mm: number): ReportDoc {
  const label = `${MONTH_NAMES[mm - 1].toUpperCase()} ${yy}`;
  const itemTotals = m.perItem.reduce(
    (s, e) => ({ times: s.times + e.times, kg: s.kg + e.totalKg }),
    { times: 0, kg: 0 },
  );
  const formulaTotals = m.perFormula.reduce(
    (s, e) => ({ bills: s.bills + e.bills, kg: s.kg + e.totalKg }),
    { bills: 0, kg: 0 },
  );
  return {
    code: 'MON',
    title: 'Monthly Production Report',
    subtitle: 'Item and formula breakdown',
    period: label,
    summary: [
      { label: 'Bills', value: String(m.summary.bills) },
      { label: 'Items Weighed', value: String(m.summary.items) },
      { label: 'Total Weight', value: fmtWeight(m.summary.totalKg) },
    ],
    sections: [
      {
        heading: `ITEM BREAKDOWN — ${label}`,
        head: ['Item', 'Times Weighed', 'Total Weight'],
        align: ['l', 'r', 'r'],
        body: m.perItem.map((e) => [e.itemName, String(e.times), fmtWeight(e.totalKg)]),
        totals: ['TOTAL', String(itemTotals.times), fmtWeight(itemTotals.kg)],
        note: m.perItem.length === 0 ? 'No items were weighed during this period.' : null,
      },
      {
        heading: `FORMULA BREAKDOWN — ${label}`,
        head: ['Formula', 'Bills', 'Total Weight'],
        align: ['l', 'r', 'r'],
        body: m.perFormula.map((e) => [e.formulaName, String(e.bills), fmtWeight(e.totalKg)]),
        totals: ['TOTAL', String(formulaTotals.bills), fmtWeight(formulaTotals.kg)],
        note: m.perFormula.length === 0 ? 'No formula-based weighings were recorded during this period.' : null,
      },
    ],
    csvFilename: `naveen-poultry-farm-monthly-${yy}-${String(mm).padStart(2, '0')}.csv`,
    csvLines: [
      ['Item', 'Times Weighed', 'Total Weight (kg)'],
      ...m.perItem.map((e) => [e.itemName, e.times, e.totalKg.toFixed(3)]),
      ['TOTAL', itemTotals.times, itemTotals.kg.toFixed(3)],
      [],
      ['Formula', 'Bills', 'Total Weight (kg)'],
      ...m.perFormula.map((e) => [e.formulaName, e.bills, e.totalKg.toFixed(3)]),
      ['TOTAL', formulaTotals.bills, formulaTotals.kg.toFixed(3)],
    ],
  };
}

/** "27 SEPTEMBER 2026", matching how the month report labels its period. */
function fmtDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const month = MONTH_NAMES[m - 1];
  return month ? `${d} ${month.toUpperCase()} ${y}` : day;
}

/** weighed_at is 'YYYY-MM-DDTHH:MM:SS'; a day view only needs the clock part. */
const billClock = (weighedAt: string): string => String(weighedAt).slice(11, 16);

function buildDailyDoc(d: DailyReport): ReportDoc {
  const label = fmtDayLabel(d.date);
  const itemTotals = d.perItem.reduce(
    (s, e) => ({ times: s.times + e.times, kg: s.kg + e.totalKg }),
    { times: 0, kg: 0 },
  );
  const formulaTotals = d.perFormula.reduce(
    (s, e) => ({ bills: s.bills + e.bills, kg: s.kg + e.totalKg }),
    { bills: 0, kg: 0 },
  );
  return {
    code: 'DLY',
    title: 'Daily Production Report',
    subtitle: 'Bill-by-bill, item and formula breakdown',
    period: label,
    summary: [
      { label: 'Bills', value: String(d.summary.bills) },
      { label: 'Items Weighed', value: String(d.summary.items) },
      { label: 'Total Weight', value: fmtWeight(d.summary.totalKg) },
    ],
    sections: [
      {
        heading: `BILL DETAIL — ${label}`,
        head: ['Time', 'Bill No', 'Formula', 'Items', 'Total Weight'],
        align: ['l', 'l', 'l', 'r', 'r'],
        body: d.bills.map((b) => [
          b.weighedAt,
          b.batchNo,
          b.formulaName || '—',
          String(b.itemCount),
          fmtWeight(b.totalWeight),
        ]),
        totals: [
          'TOTAL',
          `${d.bills.length} bill${d.bills.length === 1 ? '' : 's'}`,
          '',
          String(d.summary.items),
          fmtWeight(d.summary.totalKg),
        ],
        note: d.bills.length === 0 ? 'No bills were recorded on this day.' : null,
      },
      {
        heading: `ITEM BREAKDOWN — ${label}`,
        head: ['Item', 'Times Weighed', 'Total Weight'],
        align: ['l', 'r', 'r'],
        body: d.perItem.map((e) => [e.itemName, String(e.times), fmtWeight(e.totalKg)]),
        totals: ['TOTAL', String(itemTotals.times), fmtWeight(itemTotals.kg)],
        note: d.perItem.length === 0 ? 'No items were weighed on this day.' : null,
      },
      {
        heading: `FORMULA BREAKDOWN — ${label}`,
        head: ['Formula', 'Bills', 'Total Weight'],
        align: ['l', 'r', 'r'],
        body: d.perFormula.map((e) => [e.formulaName, String(e.bills), fmtWeight(e.totalKg)]),
        totals: ['TOTAL', String(formulaTotals.bills), fmtWeight(formulaTotals.kg)],
        note: d.perFormula.length === 0 ? 'No formula-based weighings were recorded on this day.' : null,
      },
    ],
    csvFilename: `naveen-poultry-farm-daily-${d.date}.csv`,
    csvLines: [
      ['Time', 'Bill No', 'Formula', 'Items', 'Total Weight (kg)'],
      ...d.bills.map((b) => [
        b.weighedAt,
        b.batchNo,
        b.formulaName || '',
        b.itemCount,
        b.totalWeight.toFixed(3),
      ]),
      ['TOTAL', `${d.bills.length} bills`, '', d.summary.items, d.summary.totalKg.toFixed(3)],
      [],
      ['Item', 'Times Weighed', 'Total Weight (kg)'],
      ...d.perItem.map((e) => [e.itemName, e.times, e.totalKg.toFixed(3)]),
      ['TOTAL', itemTotals.times, itemTotals.kg.toFixed(3)],
      [],
      ['Formula', 'Bills', 'Total Weight (kg)'],
      ...d.perFormula.map((e) => [e.formulaName, e.bills, e.totalKg.toFixed(3)]),
      ['TOTAL', formulaTotals.bills, formulaTotals.kg.toFixed(3)],
    ],
  };
}

function buildYearlyDoc(y: YearlyReport, yr: number): ReportDoc {
  return {
    code: 'YRL',
    title: 'Yearly Production Report',
    subtitle: 'Month-by-month production summary',
    period: `Calendar year ${yr}`,
    summary: [
      { label: 'Bills', value: String(y.totals.bills) },
      { label: 'Items Weighed', value: String(y.totals.items) },
      { label: 'Total Weight', value: fmtWeight(y.totals.totalKg) },
    ],
    sections: [
      {
        heading: `MONTH-BY-MONTH — ${yr}`,
        head: ['Month', 'Bills', 'Items', 'Total Weight'],
        align: ['l', 'r', 'r', 'r'],
        body: y.months.map((e) => [MONTH_NAMES[Number(e.month.slice(5, 7)) - 1], String(e.bills), String(e.items), fmtWeight(e.totalKg)]),
        totals: [`Year Total ${yr}`, String(y.totals.bills), String(y.totals.items), fmtWeight(y.totals.totalKg)],
      },
    ],
    csvFilename: `naveen-poultry-farm-yearly-${yr}.csv`,
    csvLines: [
      ['Month', 'Bills', 'Items', 'Total Weight (kg)'],
      ...y.months.map((e) => [MONTH_NAMES[Number(e.month.slice(5, 7)) - 1], e.bills, e.items, e.totalKg.toFixed(3)]),
      [],
      [`Year Total ${yr}`, y.totals.bills, y.totals.items, y.totals.totalKg.toFixed(3)],
    ],
  };
}

interface PrintReportProps {
  doc: ReportDoc;
  onClose: () => void;
}

function PrintReport({ doc, onClose }: PrintReportProps) {
  const [generatedOn] = useState(() => new Date());
  const handlePrint = () => {
    try {
      window.print();
    } catch (err) {
      console.error('print failed', err);
    }
  };
  return createPortal(
    <div className="print-overlay" role="dialog" aria-modal="true" aria-label={doc.title}>
      <div className="print-toolbar">
        <div className="print-toolbar-info">
          <span className="print-toolbar-title">{doc.title}</span>
          <span className="print-toolbar-sub">{doc.subtitle} — {doc.period}</span>
        </div>
        <div className="print-toolbar-actions">
          <button className="btn btn-primary" type="button" onClick={handlePrint}>Print / Save PDF</button>
          <button className="btn btn-secondary" type="button" onClick={() => downloadCSV(doc.csvFilename, doc.csvLines)}>Download CSV</button>
          <button className="btn btn-secondary" type="button" onClick={onClose}>Done</button>
        </div>
      </div>

      <div className="print-report">
        <header className="print-header">
          <div className="print-company">
            <div className="print-company-mark">NF</div>
            <div>
              <div className="print-company-name">Naveen Poultry Farm</div>
              <div className="print-company-sub">Industrial Weighing &amp; Packing Solutions</div>
            </div>
          </div>
          <div className="print-docno">DOC-{doc.code}</div>
        </header>

        <div className="print-titleblock">
          <div>
            <h1 className="print-report-title">{doc.title}</h1>
            <div className="print-report-sub">{doc.subtitle}</div>
          </div>
          <div className="print-generated">
            Generated: {fmtStamp(generatedOn)}
            <div>Period: {doc.period}</div>
          </div>
        </div>

        <div className="print-summary">
          {doc.summary.map((s) => (
            <div className="print-summary-box" key={s.label}>
              <div className="print-summary-label">{s.label}</div>
              <div className="print-summary-value">{s.value}</div>
            </div>
          ))}
        </div>

        {doc.sections.map((sec) => (
          <section className="print-section" key={sec.heading}>
            <div className="print-section-title">{sec.heading}</div>
            <table className="print-table">
              <thead>
                <tr>{sec.head.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {sec.body.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={sec.align?.[j] === 'r' ? 'num' : undefined}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {sec.totals ? (
                <tfoot>
                  <tr>
                    {sec.totals.map((cell, j) => (
                      <td key={j} className={sec.align?.[j] === 'r' ? 'num' : undefined}>{cell}</td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
            {sec.note ? <div className="print-section-note">{sec.note}</div> : null}
          </section>
        ))}

        <footer className="print-footer">
          <div className="print-signatures">
            <div className="print-signature">
              <div className="print-signature-line" />
              <span>Prepared by</span>
            </div>
            <div className="print-signature">
              <div className="print-signature-line" />
              <span>Checked by</span>
            </div>
            <div className="print-signature">
              <div className="print-signature-line" />
              <span>Authorized by</span>
            </div>
          </div>
          <div className="print-footer-note">Naveen Poultry Farm — Plant Weighbridge Records · All weights in kilograms, rounded down to whole kilograms</div>
          <div className="print-footer-note">© Copyright Reem Engineering Enterprises</div>
        </footer>
      </div>
    </div>,
    document.body
  );
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'overview', label: 'OVERVIEW' },
  { key: 'daily', label: 'DAILY' },
  { key: 'monthly', label: 'MONTHLY' },
  { key: 'yearly', label: 'YEARLY' },
];

const emptySummary = (): ReportTotals => ({ bills: 0, items: 0, totalKg: 0 });

interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
}

function StatCard({ label, value, unit }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

export function ReportsScreen() {
  const now = new Date();
  const [tab, setTab] = useState<ReportTab>('overview');

  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');

  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState('');

  const [yearly, setYearly] = useState<YearlyReport | null>(null);
  const [yearlyLoading, setYearlyLoading] = useState(false);
  const [yearlyError, setYearlyError] = useState('');

  const [daily, setDaily] = useState<DailyReport | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState('');

  const [selYear, setSelYear] = useState(now.getFullYear());
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selDay, setSelDay] = useState(() => toDayValue(now));
  const [printDoc, setPrintDoc] = useState<ReportDoc | null>(null);
  // Flipping through the year and month selects fires overlapping requests.
  // Without a sequence guard a slower earlier response could land last and
  // show last year's numbers under this year's heading.
  const overviewSeq = useRef(0);
  const monthlySeq = useRef(0);
  const yearlySeq = useRef(0);
  const dailySeq = useRef(0);

  const loadOverview = async () => {
    const seq = ++overviewSeq.current;
    setOverviewLoading(true);
    setOverviewError('');
    try {
      const data = await api.getOverview();
      if (seq !== overviewSeq.current) return;
      if (!data || !Array.isArray(data.series)) throw new Error('Unexpected report data');
      setOverview(data);
    } catch (err) {
      if (seq !== overviewSeq.current) return;
      setOverviewError(errText(err));
    } finally {
      if (seq === overviewSeq.current) setOverviewLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
    return () => {
      overviewSeq.current += 1;
      monthlySeq.current += 1;
      yearlySeq.current += 1;
      dailySeq.current += 1;
    };
  }, []);

  const loadDaily = async (date: string) => {
    const seq = ++dailySeq.current;
    setDailyLoading(true);
    setDailyError('');
    try {
      const data = await api.getDailyReport(date);
      if (seq !== dailySeq.current) return;
      if (!data || !Array.isArray(data.bills)) throw new Error('Unexpected report data');
      setDaily(data);
    } catch (err) {
      if (seq !== dailySeq.current) return;
      setDailyError(errText(err));
    } finally {
      if (seq === dailySeq.current) setDailyLoading(false);
    }
  };

  const loadMonthly = async (year: number, month: number) => {
    const seq = ++monthlySeq.current;
    setMonthlyLoading(true);
    setMonthlyError('');
    try {
      const data = await api.getMonthlyReport(year, month);
      if (seq !== monthlySeq.current) return;
      setMonthly(data);
    } catch (err) {
      if (seq !== monthlySeq.current) return;
      setMonthlyError(errText(err));
    } finally {
      if (seq === monthlySeq.current) setMonthlyLoading(false);
    }
  };

  const loadYearly = async (year: number) => {
    const seq = ++yearlySeq.current;
    setYearlyLoading(true);
    setYearlyError('');
    try {
      const data = await api.getYearlyReport(year);
      if (seq !== yearlySeq.current) return;
      setYearly(data);
    } catch (err) {
      if (seq !== yearlySeq.current) return;
      setYearlyError(errText(err));
    } finally {
      if (seq === yearlySeq.current) setYearlyLoading(false);
    }
  };

  /**
   * Opens the monthly tab already pointed at this month. React batches the
   * three updates into one render, so the tab's effect loads the new year and
   * month once instead of firing a request for the old selection first.
   */
  const openMonth = (year: number, month: number) => {
    setSelYear(year);
    setSelMonth(month);
    setTab('monthly');
  };

  useEffect(() => {
    if (tab === 'monthly') loadMonthly(selYear, selMonth);
  }, [tab, selYear, selMonth]);

  useEffect(() => {
    if (tab === 'yearly') loadYearly(selYear);
  }, [tab, selYear]);

  useEffect(() => {
    if (tab === 'daily') loadDaily(selDay);
  }, [tab, selDay]);

  const years = useMemo(() => {
    const set = new Set([now.getFullYear()]);
    if (overview) {
      for (const entry of overview.series) set.add(Number(entry.month.slice(0, 4)));
    }
    return [...set].sort((a, b) => b - a);
  }, [overview, now]);

  const overTotals = overview?.totals || emptySummary();
  const monthlySummary = monthly?.summary || emptySummary();
  const yearTotals = yearly?.totals || emptySummary();

  return (
    <section className="stage">
      <div className="screen-title">REPORTS</div>
      <div className="screen-sub">Production totals and per-item breakdowns.</div>

      {overviewError && (
        <div className="error-banner">
          Could not load reports: {overviewError}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadOverview}>
            RETRY
          </button>
        </div>
      )}

      <div className="report-tabs">
        {TABS.map((t: { key: ReportTab; label: string }) => (
          <button
            key={t.key}
            type="button"
            className={`report-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="report-body">
          {overview && (
            <div className="report-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setPrintDoc(buildOverviewDoc(overview))}>
                Download PDF
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const doc = buildOverviewDoc(overview);
                  downloadCSV(doc.csvFilename, doc.csvLines);
                }}
              >
                Download CSV
              </button>
            </div>
          )}
          <div className="stat-cards">
            <StatCard label="Total Bills" value={overTotals.bills} />
            <StatCard label="Total Items Weighed" value={overTotals.items} />
            <StatCard label="Total Weight" value={overTotals.totalKg} unit="kg" />
          </div>
          <div className="panel">
            <div className="panel-title">LAST 12 MONTHS</div>
            {overviewLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : overviewError && !overview ? (
              <div className="panel-placeholder error-text">
                {overviewError}{' '}
                <button type="button" className="btn btn-secondary btn-sm" onClick={loadOverview}>
                  RETRY
                </button>
              </div>
            ) : !overview ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Items</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.series.map((entry) => (
                    <tr key={entry.month}>
                      <td>
                        {/* Selecting a month here carries straight over to the
                            monthly tab, so the operator never has to pick the
                            same month twice. */}
                        <button
                          type="button"
                          className="month-link"
                          onClick={() => openMonth(Number(entry.month.slice(0, 4)), Number(entry.month.slice(5, 7)))}
                        >
                          {MONTH_NAMES[Number(entry.month.slice(5, 7)) - 1]}{' '}
                          {entry.month.slice(0, 4)}
                        </button>
                      </td>
                      <td className="num text-right">{entry.bills}</td>
                      <td className="num text-right">{entry.items}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'daily' && (
        <div className="report-body">
          {daily && (
            <div className="report-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setPrintDoc(buildDailyDoc(daily))}>
                Download PDF
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const doc = buildDailyDoc(daily);
                  downloadCSV(doc.csvFilename, doc.csvLines);
                }}
              >
                Download CSV
              </button>
            </div>
          )}
          <div className="report-filters">
            <label className="filter-field">
              <span className="filter-label">Date</span>
              <input
                type="date"
                className="select-input"
                value={selDay}
                max={toDayValue(now)}
                onChange={(e) => e.target.value && setSelDay(e.target.value)}
              />
            </label>
          </div>

          <div className="stat-cards">
            <StatCard label="Bills" value={daily?.summary.bills ?? 0} />
            <StatCard label="Items" value={daily?.summary.items ?? 0} />
            <StatCard label="Total Weight" value={daily?.summary.totalKg ?? 0} unit="kg" />
          </div>

          <div className="panel">
            <div className="panel-title">BILL DETAIL — {fmtDayLabel(selDay)}</div>
            {dailyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : dailyError ? (
              <div className="panel-placeholder error-text">
                {dailyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadDaily(selDay)}
                >
                  RETRY
                </button>
              </div>
            ) : !daily ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : daily.bills.length === 0 ? (
              <div className="panel-placeholder">No weighings recorded for this day.</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Bill No</th>
                    <th>Formula</th>
                    <th className="text-right">Items</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.bills.map((bill) => (
                    <tr key={bill.id}>
                      <td className="num">{billClock(bill.weighedAt)}</td>
                      <td className="num">{bill.batchNo}</td>
                      <td className="item-name">{bill.formulaName || '—'}</td>
                      <td className="num text-right">{bill.itemCount}</td>
                      <td className="num text-right">{fmtWeight(bill.totalWeight)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="row-total">
                    <td>TOTAL</td>
                    <td>{daily.bills.length} bill{daily.bills.length === 1 ? '' : 's'}</td>
                    <td />
                    <td className="num text-right">{daily.summary.items}</td>
                    <td className="num text-right">{fmtWeight(daily.summary.totalKg)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">ITEM BREAKDOWN — {fmtDayLabel(selDay)}</div>
            {dailyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : dailyError ? (
              <div className="panel-placeholder error-text">
                {dailyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadDaily(selDay)}
                >
                  RETRY
                </button>
              </div>
            ) : !daily ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : daily.perItem.length === 0 ? (
              <div className="panel-placeholder">No items were weighed on this day.</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Times Weighed</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.perItem.map((entry) => (
                    <tr key={entry.itemName}>
                      <td className="item-name">{entry.itemName}</td>
                      <td className="num text-right">{entry.times}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">FORMULA BREAKDOWN — {fmtDayLabel(selDay)}</div>
            {dailyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : dailyError ? (
              <div className="panel-placeholder error-text">
                {dailyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadDaily(selDay)}
                >
                  RETRY
                </button>
              </div>
            ) : !daily ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : daily.perFormula.length === 0 ? (
              <div className="panel-placeholder">No formula-based weighings on this day.</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Formula</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.perFormula.map((entry) => (
                    <tr key={entry.formulaName}>
                      <td className="item-name">{entry.formulaName}</td>
                      <td className="num text-right">{entry.bills}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'monthly' && (
        <div className="report-body">
          {monthly && (
            <div className="report-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setPrintDoc(buildMonthlyDoc(monthly, selYear, selMonth))}>
                Download PDF
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const doc = buildMonthlyDoc(monthly, selYear, selMonth);
                  downloadCSV(doc.csvFilename, doc.csvLines);
                }}
              >
                Download CSV
              </button>
            </div>
          )}
          <div className="report-filters">
            <label className="filter-field">
              <span className="filter-label">Year</span>
              <select className="select-input" value={selYear} onChange={(e) => setSelYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span className="filter-label">Month</span>
              <select className="select-input" value={selMonth} onChange={(e) => setSelMonth(Number(e.target.value))}>
                {MONTH_NAMES.map((m, index) => (
                  <option key={m} value={index + 1}>{m}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="stat-cards">
            <StatCard label="Bills" value={monthlySummary.bills} />
            <StatCard label="Items" value={monthlySummary.items} />
            <StatCard label="Total Weight" value={monthlySummary.totalKg} unit="kg" />
          </div>

          <div className="panel">
            <div className="panel-title">
              ITEM BREAKDOWN — {MONTH_NAMES[selMonth - 1].toUpperCase()} {selYear}
            </div>
            {monthlyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : monthlyError ? (
              <div className="panel-placeholder error-text">
                {monthlyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadMonthly(selYear, selMonth)}
                >
                  RETRY
                </button>
              </div>
            ) : !monthly ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : monthly.perItem.length === 0 ? (
              <div className="panel-placeholder">No weighings recorded for this month.</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Times Weighed</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {monthly.perItem.map((entry) => (
                    <tr key={entry.itemName}>
                      <td className="item-name">{entry.itemName}</td>
                      <td className="num text-right">{entry.times}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">
              FORMULA BREAKDOWN — {MONTH_NAMES[selMonth - 1].toUpperCase()} {selYear}
            </div>
            {monthlyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : monthlyError ? (
              <div className="panel-placeholder error-text">
                {monthlyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadMonthly(selYear, selMonth)}
                >
                  RETRY
                </button>
              </div>
            ) : !monthly ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : monthly.perFormula.length === 0 ? (
              <div className="panel-placeholder">No formula-based weighings this month.</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Formula</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {monthly.perFormula.map((entry) => (
                    <tr key={entry.formulaName}>
                      <td className="item-name">{entry.formulaName}</td>
                      <td className="num text-right">{entry.bills}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'yearly' && (
        <div className="report-body">
          {yearly && (
            <div className="report-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setPrintDoc(buildYearlyDoc(yearly, selYear))}>
                Download PDF
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  const doc = buildYearlyDoc(yearly, selYear);
                  downloadCSV(doc.csvFilename, doc.csvLines);
                }}
              >
                Download CSV
              </button>
            </div>
          )}
          <div className="report-filters">
            <label className="filter-field">
              <span className="filter-label">Year</span>
              <select className="select-input" value={selYear} onChange={(e) => setSelYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="stat-cards">
            <StatCard label="Bills" value={yearTotals.bills} />
            <StatCard label="Items" value={yearTotals.items} />
            <StatCard label="Total Weight" value={yearTotals.totalKg} unit="kg" />
          </div>

          <div className="panel">
            <div className="panel-title">MONTH-BY-MONTH — {selYear}</div>
            {yearlyLoading ? (
              <div className="panel-placeholder">Loading…</div>
            ) : yearlyError ? (
              <div className="panel-placeholder error-text">
                {yearlyError}{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => loadYearly(selYear)}
                >
                  RETRY
                </button>
              </div>
            ) : !yearly ? (
              <div className="panel-placeholder">Loading report…</div>
            ) : (
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Items</th>
                    <th className="text-right">Total Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {yearly.months.map((entry) => (
                    <tr key={entry.month} className={entry.bills === 0 ? 'row-zero' : ''}>
                      <td>{MONTH_NAMES[Number(entry.month.slice(5, 7)) - 1]}</td>
                      <td className="num text-right">{entry.bills}</td>
                      <td className="num text-right">{entry.items}</td>
                      <td className="num text-right">{fmtWeight(entry.totalKg)}</td>
                    </tr>
                  ))}
                  <tr className="row-total">
                    <td>Year Total</td>
                    <td className="num text-right">{yearTotals.bills}</td>
                    <td className="num text-right">{yearTotals.items}</td>
                    <td className="num text-right">{fmtWeight(yearTotals.totalKg)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {printDoc ? <PrintReport doc={printDoc} onClose={() => setPrintDoc(null)} /> : null}
    </section>
  );
}