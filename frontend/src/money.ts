/** Formats integer paise as rupees using integer maths only, e.g. 123456 -> "₹1,234.56". */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
  const rest = abs % 100;
  return `${sign}₹${rupees}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}
