// Returns a magnitude-suffixed count, e.g. "532M", "3.3M", "45.0K", "304K", "999", "0".
function kStr(n: number): string {
  const v = n || 0;
  if (v === 0) return '0';
  const fmt = (scaled: number, suffix: string) =>
    (scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))) + suffix;
  if (v >= 1e9) return fmt(v / 1e9, 'B');
  if (v >= 1e6) return fmt(v / 1e6, 'M');
  if (v >= 1e3) return fmt(v / 1e3, 'K');
  return String(Math.round(v));
}

function formatTokens(n: number): string {
  return kStr(n) + ' tokens';
}

export { kStr, formatTokens };
