const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (n: number) => usd.format(n);
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
