'use strict';

function kStr(n) {
  const k = (n || 0) / 1000;
  if (k === 0) return '0';
  return k < 100 ? k.toFixed(1) : String(Math.round(k));
}

function formatTokens(n) {
  return kStr(n) + 'K tokens';
}

module.exports = { kStr, formatTokens };
