import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface BalanceSheetOptions {
  start_date?: string;
  end_date?: string;
  accounting_method?: "Cash" | "Accrual";
  summarize_column_by?: "Total" | "Month" | "Week" | "Days";
}

export async function getQuickbooksBalanceSheet(options: BalanceSheetOptions): Promise<ToolResponse<any>> {
  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();
    // Balance Sheet is a point-in-time report — end_date is the "as of" date.
    // QBO quirk (verified against the live API 2026-06-12): the BalanceSheet
    // report SILENTLY IGNORES end_date unless start_date is also present, and
    // falls back to "this calendar year-to-date" (i.e. as of today). So we
    // always send start_date alongside end_date, defaulting start_date to
    // end_date when the caller omits it — for the Total view this is a pure
    // as-of report and the start_date value does not change any balances.
    const params: Record<string, any> = {};
    if (options.end_date) {
      params.end_date = options.end_date;
      params.start_date = options.start_date || options.end_date;
    } else if (options.start_date) {
      params.start_date = options.start_date;
    }
    if (options.accounting_method) params.accounting_method = options.accounting_method;
    if (options.summarize_column_by) params.summarize_column_by = options.summarize_column_by;

    return new Promise((resolve) => {
      (quickbooks as any).reportBalanceSheet(params, (err: any, report: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result: report, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
