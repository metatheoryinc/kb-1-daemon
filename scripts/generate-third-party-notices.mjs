#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const outputPath = join(repoRoot, 'THIRD_PARTY_NOTICES.md');
const entrypoints = [
  { manifestPath: join(repoRoot, 'apps/daemon/package.json') },
  {
    manifestPath: join(repoRoot, 'apps/web/package.json'),
    includeDevDependencies: [
      '@sveltejs/adapter-static',
      '@sveltejs/kit',
      '@sveltejs/vite-plugin-svelte',
      '@tailwindcss/vite',
      'tailwindcss',
      'vite'
    ]
  }
];
const checkOnly = process.argv.includes('--check');

const packages = await collectProductionPackages(entrypoints);
const rendered = await renderNotices(packages);

if (checkOnly) {
  const committed = await readFile(outputPath, 'utf8').catch(() => undefined);
  if (committed !== rendered) {
    console.error('THIRD_PARTY_NOTICES.md is missing or stale. Run `pnpm licenses:generate` and review the result.');
    process.exit(1);
  }
  console.log(`Third-party notice inventory is current (${packages.length} distribution packages).`);
} else {
  await writeFile(outputPath, rendered, 'utf8');
  console.log(`Wrote THIRD_PARTY_NOTICES.md for ${packages.length} distribution packages.`);
}

async function collectProductionPackages(initialManifests) {
  const queue = [];
  const visitedLocations = new Set();
  const external = new Map();

  for (const entrypoint of initialManifests) {
    queue.push({ ...entrypoint, required: true });
  }

  while (queue.length > 0) {
    const next = queue.shift();
    const manifestPath = await realpath(next.manifestPath).catch((error) => {
      if (!next.required && error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!manifestPath || visitedLocations.has(manifestPath)) continue;
    visitedLocations.add(manifestPath);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const packageDir = dirname(manifestPath);
    const relativePackageDir = relative(repoRoot, packageDir);
    const isInsideRepo = relativePackageDir !== '..'
      && !relativePackageDir.startsWith(`..${sep}`)
      && !isAbsolute(relativePackageDir);
    const isWorkspacePackage = isInsideRepo
      && !relativePackageDir.split(sep).includes('node_modules');
    if (!isWorkspacePackage) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!external.has(key)) {
        external.set(key, await packageRecord(manifest, packageDir));
      }
    }

    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      queue.push({
        manifestPath: await resolveDependencyManifest(packageDir, dependency, true),
        required: true
      });
    }
    for (const dependency of next.includeDevDependencies ?? []) {
      if (!(dependency in (manifest.devDependencies ?? {}))) {
        throw new Error(
          `Included web build dependency ${JSON.stringify(dependency)} is not declared in ${manifestPath}.`
        );
      }
      queue.push({
        manifestPath: await resolveDependencyManifest(packageDir, dependency, true),
        required: true
      });
    }
  }

  return [...external.values()].sort((a, b) => (
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  ));
}

async function resolveDependencyManifest(packageDir, dependency, required) {
  let current = packageDir;
  const tried = [];
  while (true) {
    const candidates = [join(current, 'node_modules', dependency, 'package.json')];
    if (basename(current) === 'node_modules') {
      candidates.push(join(current, dependency, 'package.json'));
    }
    for (const candidate of candidates) {
      tried.push(candidate);
      const resolved = await realpath(candidate).catch((error) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (resolved) return resolved;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!required) return undefined;
  throw new Error(
    `Installed production dependency ${JSON.stringify(dependency)} could not be resolved from ${packageDir}. `
      + `Run pnpm install --frozen-lockfile before generating notices. Tried: ${tried.join(', ')}`
  );
}

async function packageRecord(manifest, packageDir) {
  const files = await readdir(packageDir, { withFileTypes: true });
  const noticeFiles = files
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([-._].*)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const notices = [];
  for (const filename of noticeFiles) {
    const content = normalizeText(await readFile(join(packageDir, filename), 'utf8'));
    notices.push({ filename, content, digest: digest(content) });
  }

  return {
    name: manifest.name,
    version: manifest.version,
    license: declaredLicense(manifest),
    source: repositoryUrl(manifest),
    notices,
    installedFrom: relative(repoRoot, packageDir)
  };
}

async function renderNotices(packagesToRender) {
  const lines = [
    '# Third-Party Notices',
    '',
    'KB-1 Local includes or distributes code from the dependencies listed below.',
    'This conservative inventory covers the installed daemon runtime plus the web',
    'runtime and build-tool graphs used to produce the bundled application. It must be',
    'regenerated and reviewed for every release.',
    'Platform-specific optional native build bindings are excluded because they are not',
    'copied into the shipped runtime; their platform-neutral parent packages remain listed.',
    '',
    `Inventory count: **${packagesToRender.length} packages**.`,
    '',
    '| Package | Declared license | Source | Included notice files |',
    '| --- | --- | --- | --- |'
  ];

  for (const pkg of packagesToRender) {
    const packageName = `${escapeTable(pkg.name)} ${escapeTable(pkg.version)}`;
    const source = pkg.source ? `[source](${pkg.source})` : 'Not declared';
    const notices = pkg.notices.length > 0
      ? pkg.notices.map((notice) => `${notice.filename} (${notice.digest.slice(0, 12)})`).join('<br>')
      : 'None included';
    lines.push(`| ${packageName} | ${escapeTable(pkg.license)} | ${source} | ${notices} |`);
  }

  lines.push('', '## Included license and notice texts', '');
  const textGroups = groupNoticeTexts(packagesToRender);
  for (const group of textGroups) {
    lines.push(
      `### ${group.digest}`,
      '',
      `Packages: ${group.packages.join(', ')}`,
      '',
      `Files: ${group.files.join(', ')}`,
      '',
      '```text',
      escapeCodeFence(group.content),
      '```',
      ''
    );
  }

  const missing = packagesToRender.filter((pkg) => pkg.notices.length === 0);
  if (missing.length > 0) {
    lines.push(
      '## Packages without an included top-level notice file',
      '',
      'These packages declared a license in their package metadata but did not ship a',
      'top-level LICENSE, LICENCE, COPYING, or NOTICE file in the installed package.',
      'Their presence is explicit here so release review does not silently omit them.',
      '',
      ...missing.map((pkg) => `- ${pkg.name} ${pkg.version}: ${pkg.license}`),
      ''
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function groupNoticeTexts(packagesToGroup) {
  const groups = new Map();
  for (const pkg of packagesToGroup) {
    for (const notice of pkg.notices) {
      let group = groups.get(notice.digest);
      if (!group) {
        group = { digest: notice.digest, content: notice.content, packages: [], files: [] };
        groups.set(notice.digest, group);
      }
      group.packages.push(`${pkg.name}@${pkg.version}`);
      group.files.push(`${pkg.name}@${pkg.version}/${notice.filename}`);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      packages: [...new Set(group.packages)].sort(),
      files: [...new Set(group.files)].sort()
    }))
    .sort((a, b) => a.packages[0].localeCompare(b.packages[0]) || a.digest.localeCompare(b.digest));
}

function declaredLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const licenses = manifest.licenses
      .map((license) => typeof license === 'string' ? license : license?.type)
      .filter(Boolean);
    if (licenses.length > 0) return licenses.join(' OR ');
  }
  return 'Not declared';
}

function repositoryUrl(manifest) {
  const repository = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url;
  if (!repository || typeof repository !== 'string') return manifest.homepage || undefined;
  const normalized = repository
    .replace(/^git\+/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)
    ? `https://github.com/${normalized}`
    : normalized;
}

function normalizeText(content) {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|');
}

function escapeCodeFence(value) {
  return value.replace(/```/g, '`\u200b``');
}
