import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// Use the project's playwright if installed, else a global install.
export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
  }
}

export const root = path.resolve(import.meta.dirname, '..');
export const fixture = (name) => path.join(root, 'tests', 'fixtures', name);
