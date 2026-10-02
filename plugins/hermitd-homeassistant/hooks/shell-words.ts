// Tokenize literal shell words and command separators without evaluating expansions.
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = '', quote = '', active = false, plain = true, redirect = false;
  const flush = () => {
    if (active) {
      if (!redirect) words.push(word);
      redirect = false;
    }
    word = ''; active = false; plain = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && ['"', '\\', '$', '`', '\n'].includes(command[i + 1])) { word += command[++i]; continue; }
      word += ch; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; plain = false; continue; }
    if (ch === '\\') {
      if (++i >= command.length) throw new Error('Incomplete shell escape');
      if (command[i] === '\n') continue; // line continuation: both characters vanish
      word += command[i]; active = true; plain = false; continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && command[i + 1] === '>')) {
      // An adjacent, unquoted IO number belongs to the redirection, not argv.
      if (!redirect && plain && /^\d+$/.test(word)) { word = ''; active = false; }
      else flush();
      if (redirect) throw new Error('Missing redirection target');
      if (ch === '&') i++;
      const operator = command[i];
      if (operator === '<' && command[i + 1] === '<') throw new Error('Unsupported here-document');
      if (operator === '>' && command[i + 1] === '>') i++;
      else if (command[i + 1] === '&' || (operator === '>' && command[i + 1] === '|') || (operator === '<' && command[i + 1] === '>')) i++;
      redirect = true;
      continue;
    }
    // Split on `(` `)` and backtick too, so a nested command is not swallowed into an outer word.
    if (';|&\n()`'.includes(ch)) {
      flush();
      if (redirect) throw new Error('Missing redirection target');
      if (words.length) commands.push(words);
      words = []; continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch; active = true;
  }
  if (quote) throw new Error('Unterminated shell quote');
  flush();
  if (redirect) throw new Error('Missing redirection target');
  if (words.length) commands.push(words);
  return commands;
}
