// Tokenize literal shell words and command separators without evaluating expansions.
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = '', quote = '', active = false;
  const flush = () => { if (active) words.push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && ['"', '\\', '$', '`', '\n'].includes(command[i + 1])) { word += command[++i]; continue; }
      word += ch; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue; }
    if (ch === '\\') { if (++i >= command.length) throw new Error('Incomplete shell escape'); word += command[i]; active = true; continue; }
    if (';|&\n'.includes(ch)) { flush(); if (words.length) commands.push(words); words = []; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch; active = true;
  }
  if (quote) throw new Error('Unterminated shell quote');
  flush(); if (words.length) commands.push(words);
  return commands;
}
