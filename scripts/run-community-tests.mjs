import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const nodeTestImport = /(?:from\s*|import\s*|require\(\s*)['"]node:test['"]/;

/** Discover actual test entrypoints; ordinary helper modules cannot count as passing tests. */
export function collectCommunityTests(root, mode) {
  if (!['app', 'node'].includes(mode)) throw new Error('Select the app or node test group');
  const testRoot = join(resolve(root), 'tests');
  const found = [];
  function visit(directory) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Test directories must be regular source directories');
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Test discovery refuses symbolic links');
      if (item.isDirectory()) { visit(path); continue; }
      if (!item.isFile()) continue;
      const typescriptTest = /\.(?:test|spec)\.[cm]?tsx?$/.test(item.name);
      if (mode === 'app' && typescriptTest) {
        if (nodeTestImport.test(readFileSync(path, 'utf8'))) throw new Error(`A TypeScript test uses the wrong runner: ${relative(root, path)}`);
        found.push(path);
      }
      if (mode === 'node' && item.name.endsWith('.mjs')) {
        const isNodeTest = nodeTestImport.test(readFileSync(path, 'utf8'));
        if (/\.(?:test|e2e)\.mjs$/.test(item.name) && !isNodeTest) throw new Error(`A named Node test has no node:test registration: ${relative(root, path)}`);
        if (isNodeTest) found.push(path);
      }
    }
  }
  visit(testRoot);
  return found.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function runCommunityTests(mode) {
  if (!process.versions.node.startsWith('22.')) throw new Error('Use the qualified isolated Node 22 runtime for the current native dependency build');
  const files = collectCommunityTests(repository, mode);
  if (!files.length) throw new Error('No executable test entrypoints were discovered');
  const runId = process.env.MATCHING_TEST_RUN_ID ?? `run-${Date.now()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(runId)) throw new Error('Invalid test evidence run identifier');
  const artifactRoot = process.env.MATCHING_TEST_EVIDENCE_ROOT;
  let resultFile;
  if (artifactRoot) {
    const destination = resolve(artifactRoot);
    const boundary = relative(resolve(repository), destination);
    if (!isAbsolute(artifactRoot) || (!boundary.startsWith('..') && !isAbsolute(boundary))) throw new Error('Test evidence must be in an explicit directory outside the checkout');
    mkdirSync(destination, { recursive: true });
    const manifestPath = join(destination, `${runId}-${mode}-manifest.json`);
    if (existsSync(manifestPath)) throw new Error('Refusing to replace an existing test evidence manifest');
    const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8',windowsHide:true}).trim(),workingTreeDirty=!!execFileSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8',windowsHide:true}).trim();
    if(!/^[a-f0-9]{40}$/.test(sourceRevision))throw new Error('Candidate revision is unavailable');
    writeFileSync(manifestPath, JSON.stringify({ source_revision:sourceRevision,working_tree_dirty:workingTreeDirty,mode, runtime: process.versions.node, abi: process.versions.modules, created_at: new Date().toISOString(), entrypoints: files.map(path => relative(repository, path).replaceAll('\\', '/')) }, null, 2));
    if (mode === 'app') resultFile = join(destination, `${runId}-vitest.json`);
  }
  const arguments_ = mode === 'app'
    ? [join(repository, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...files, '--maxWorkers=1', ...(resultFile ? ['--reporter=json', `--outputFile=${resultFile}`] : [])]
    : ['--import', 'tsx', '--test', '--test-concurrency=1', ...files];
  console.log(`Running ${files.length} ${mode} test entrypoints with Node ${process.versions.node}; no helper files counted as tests.`);
  const child = spawn(process.execPath, arguments_, { cwd: repository, env: { ...process.env }, stdio: 'inherit', windowsHide: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    console.error('The isolated test command exceeded its 20-minute deadline. This is a failed run, not a skipped test.');
    if (child.pid && process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else child.kill('SIGTERM');
  }, 20 * 60 * 1000);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit(timedOut ? 124 : signal ? 1 : code ?? 1));
    });
  } finally { clearTimeout(deadline); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runCommunityTests(process.argv[2]); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Test discovery failed'); process.exitCode = 1; }
}
