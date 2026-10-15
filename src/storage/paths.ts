import { isAbsolute, join, normalize, relative, resolve } from 'path';

export type AccountingRuntimeMode = 'repository-coupled' | 'external-runtime-root';
export type RuntimePathCategory =
  | 'database'
  | 'documents'
  | 'imports'
  | 'exports'
  | 'backups'
  | 'logs'
  | 'cache'
  | 'temp'
  | 'state';

export interface AccountingPaths {
  mode: AccountingRuntimeMode;
  repositoryRoot: string;
  runtimeRoot: string;
  dataRoot: string;
  databaseRoot: string;
  databaseFile: string;
  documentRoot: string;
  importRoot: string;
  exportRoot: string;
  backupRoot: string;
  logRoot: string;
  cacheRoot: string;
  tempRoot: string;
  stateRoot: string;
}

interface ResolveAccountingPathsOptions {
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

export function resolveAccountingPaths(
  options: ResolveAccountingPathsOptions = {},
): AccountingPaths {
  const environment = options.environment ?? process.env;
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const configuredRuntimeRoot = environment.MATCHING_RUNTIME_ROOT?.trim();
  const configuredMode = environment.MATCHING_RUNTIME_MODE?.trim();
  const mode = configuredMode ?? (configuredRuntimeRoot ? 'external-runtime-root' : 'repository-coupled');

  if (mode !== 'repository-coupled' && mode !== 'external-runtime-root') {
    throw new Error(`unsupported runtime mode: ${mode}`);
  }

  if (mode === 'external-runtime-root') {
    if (!configuredRuntimeRoot) {
      throw new Error('MATCHING_RUNTIME_ROOT is required for external-runtime-root mode');
    }
    if (!isAbsolute(configuredRuntimeRoot)) {
      throw new Error('MATCHING_RUNTIME_ROOT must be an absolute path');
    }
    const runtimeRoot = normalize(configuredRuntimeRoot);
    if (isInside(repositoryRoot, runtimeRoot)) {
      throw new Error('external runtime root must remain outside the repository');
    }
    return {
      mode,
      repositoryRoot,
      runtimeRoot,
      dataRoot: join(runtimeRoot, 'state'),
      databaseRoot: join(runtimeRoot, 'database'),
      databaseFile: join(runtimeRoot, 'database', 'matching.db'),
      documentRoot: join(runtimeRoot, 'documents'),
      importRoot: join(runtimeRoot, 'imports'),
      exportRoot: join(runtimeRoot, 'exports'),
      backupRoot: join(runtimeRoot, 'backups'),
      logRoot: join(runtimeRoot, 'logs'),
      cacheRoot: join(runtimeRoot, 'cache'),
      tempRoot: join(runtimeRoot, 'temp'),
      stateRoot: join(runtimeRoot, 'state'),
    };
  }

  const legacyDataRoot = environment.MATCHING_DATA_DIR
    ? resolve(repositoryRoot, environment.MATCHING_DATA_DIR)
    : join(repositoryRoot, 'data');
  return {
    mode,
    repositoryRoot,
    runtimeRoot: legacyDataRoot,
    dataRoot: legacyDataRoot,
    databaseRoot: legacyDataRoot,
    databaseFile: join(legacyDataRoot, 'matching.db'),
    documentRoot: join(repositoryRoot, 'Belege'),
    importRoot: join(legacyDataRoot, 'imports'),
    exportRoot: join(legacyDataRoot, 'exports'),
    backupRoot: join(legacyDataRoot, 'backups'),
    logRoot: join(legacyDataRoot, 'logs'),
    cacheRoot: join(legacyDataRoot, 'cache'),
    tempRoot: join(legacyDataRoot, 'temp'),
    stateRoot: legacyDataRoot,
  };
}

export function resolveRuntimePath(
  paths: AccountingPaths,
  category: RuntimePathCategory,
  ...segments: string[]
): string {
  if (segments.some((segment) => isAbsolute(segment) || segment.split(/[\\/]/).includes('..'))) {
    throw new Error('runtime path traversal is not allowed');
  }
  const rootByCategory: Record<RuntimePathCategory, string> = {
    database: paths.databaseRoot,
    documents: paths.documentRoot,
    imports: paths.importRoot,
    exports: paths.exportRoot,
    backups: paths.backupRoot,
    logs: paths.logRoot,
    cache: paths.cacheRoot,
    temp: paths.tempRoot,
    state: paths.stateRoot,
  };
  const target = resolve(rootByCategory[category], ...segments);
  if (!isInside(rootByCategory[category], target)) {
    throw new Error('runtime path traversal is not allowed');
  }
  return target;
}
