const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Formats an amount in Azerbaijani manat. */
export const money = (n: number) => `${amount.format(n)} AZN`;
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
