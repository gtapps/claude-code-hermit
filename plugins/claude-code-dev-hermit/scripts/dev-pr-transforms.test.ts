import {
  classifyForge,
  rewriteSsh,
  deriveTitle,
  stripAndDedup,
} from './dev-pr-transforms';

let passed = 0;
let failed = 0;

function assert(name: string, cond: any, detail?: string) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

console.log('\nclassify-forge:');

let c = classifyForge('gh pr create', 'git@github.com:org/repo.git');
assert('github + gh → ok', c.forge === 'github' && c.tool === 'gh' && c.verdict === 'ok');

c = classifyForge('glab mr create', 'https://github.com/org/repo.git');
assert('github + glab → fail', c.forge === 'github' && c.tool === 'glab' && c.verdict === 'fail');

c = classifyForge('glab mr create', 'git@gitlab.com:org/repo.git');
assert('gitlab + glab → ok', c.forge === 'gitlab' && c.tool === 'glab' && c.verdict === 'ok');

c = classifyForge('gh pr create', 'git@gitlab.com:org/repo.git');
assert('gitlab + gh → fail', c.forge === 'gitlab' && c.verdict === 'fail');

c = classifyForge('my-pr-wrapper --open', 'git@bitbucket.org:org/repo.git');
assert('bitbucket + custom tool → warn', c.forge === 'bitbucket' && c.tool === 'my-pr-wrapper' && c.verdict === 'warn');

c = classifyForge('open-pr.sh', 'https://example.com/org/repo.git');
assert('custom forge → warn', c.forge === 'custom' && c.verdict === 'warn');

c = classifyForge('gh pr create', '');
assert('no remote → custom + warn', c.forge === 'custom' && c.verdict === 'warn');

c = classifyForge('/usr/local/bin/gh pr create', 'git@github.com:org/repo.git');
assert('tool basename strips path', c.tool === 'gh' && c.verdict === 'ok');

c = classifyForge('gh pr create', 'git@github.work:org/repo.git');
assert('github.-alias host classifies as github', c.forge === 'github' && c.verdict === 'ok');

console.log('\nrewrite-ssh:');

let r = rewriteSsh('github', 'git@github.com:owner/repo.git');
assert('github scp → https', 'url' in r && r.url === 'https://github.com/owner/repo.git');

r = rewriteSsh('github', 'git@github.work:owner/repo.git');
assert('github alias host → canonical github.com', 'url' in r && r.url === 'https://github.com/owner/repo.git');

r = rewriteSsh('github', 'git@github.com:owner/repo');
assert('github scp without .git suffix', 'url' in r && r.url === 'https://github.com/owner/repo.git');

r = rewriteSsh('gitlab', 'git@gitlab.com:group/sub/repo.git');
assert('gitlab preserves subgroup path', 'url' in r && r.url === 'https://gitlab.com/group/sub/repo.git');

r = rewriteSsh('bitbucket', 'git@bitbucket.org:owner/repo.git');
assert('bitbucket → error (no rewrite)', 'error' in r);

r = rewriteSsh('custom', 'git@example.com:owner/repo.git');
assert('custom forge → error (no rewrite)', 'error' in r);

r = rewriteSsh('github', 'https://github.com/owner/repo.git');
assert('non-ssh remote → error (unparseable)', 'error' in r);

console.log('\nbuild-title (deriveTitle):');

let t = deriveTitle(['add the thing'], 'feat/x', { id: 'PROJ-123', title: 'ticket title' });
assert('priority 1: binding id + raw first subject', t.title === 'PROJ-123: add the thing');

t = deriveTitle(['feat(auth): add the thing'], 'feat/x', { id: 'PROJ-9', title: 'ticket' });
assert('priority 1: binding case does NOT strip prefix', t.title === 'PROJ-9: feat(auth): add the thing');

t = deriveTitle(['fix(auth): resolve login redirect'], 'feat/x', null);
assert('priority 2: bare first subject with prefix stripped', t.title === 'resolve login redirect');

t = deriveTitle(['plain subject no prefix'], 'feat/x', null);
assert('priority 2: unprefixed subject passes through', t.title === 'plain subject no prefix');

t = deriveTitle(['some commit'], 'feat/x', { id: 'PROJ-1' });
assert('priority 2: binding without title falls through to commit', t.title === 'some commit');

t = deriveTitle([], 'feature/proj-123/fix-login', null);
assert('priority 3: no commits → branch slug', t.title === 'feature-proj-123-fix-login');

console.log('\nbuild-summary (stripAndDedup):');

let s = stripAndDedup(['feat: add a', 'fix(ui): tweak b', 'chore: bump c']);
assert('strips varied conventional prefixes', JSON.stringify(s) === JSON.stringify(['add a', 'tweak b', 'bump c']));

s = stripAndDedup(['feat: add auth', 'fix: add auth', 'refactor: add auth']);
assert('dedup by post-strip string', JSON.stringify(s) === JSON.stringify(['add auth']));

s = stripAndDedup(['fix: b', 'feat: a', 'chore: b', 'docs: a']);
assert('dedup preserves first-occurrence order', JSON.stringify(s) === JSON.stringify(['b', 'a']));

s = stripAndDedup(['feat(scope)!: breaking change', 'perf: speed up']);
assert('strips scoped + breaking-bang prefixes', JSON.stringify(s) === JSON.stringify(['breaking change', 'speed up']));

s = stripAndDedup(['just a plain message']);
assert('leaves non-conventional message intact', JSON.stringify(s) === JSON.stringify(['just a plain message']));

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
