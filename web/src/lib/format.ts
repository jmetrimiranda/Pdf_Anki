const num2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function formatNumber(n: number, digits: 0 | 2 = 2): string {
  return (digits === 0 ? num0 : num2).format(n);
}
