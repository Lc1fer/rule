'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 4,
  attempts: 3,
  timeoutMs: 60_000,
  retryMs: 2_000,
});
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);
const MAX_TIMER_MS = 2 ** 31 - 1;

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..');

// Only category -> url / rules -> add / remove is supported.
// Values must be unquoted, single-line strings; comments occupy their own lines.
function parseConfig(text) {
  const result = Object.create(null);
  const names = new Set();
  let current = null;
  let section = null;
  let ruleAction = null;
  let sections = new Set();
  let ruleActions = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fail = message => { throw new Error(`Line ${index + 1}: ${message}`); };
    if (/^\s*\t/.test(raw)) fail('Use spaces for indentation');
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0 && line.endsWith(':')) {
      const name = line.slice(0, -1).trim();
      if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.endsWith('.') ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        fail(`Invalid output name: ${name}`);
      }
      const key = name.toLowerCase();
      if (names.has(key)) fail(`Duplicate output name: ${name}`);
      names.add(key);
      current = result[name] = { url: [], rules: { add: [], remove: [] } };
      sections = new Set();
      ruleActions = new Set();
      section = null;
      ruleAction = null;
      continue;
    }
    const match = indent === 2 && line.match(/^(url|rules):\s*(\[\s*\])?$/);
    if (current && match) {
      if (sections.has(match[1])) fail(`Duplicate section: ${match[1]}`);
      sections.add(match[1]);
      section = match[2] ? null : match[1];
      ruleAction = null;
      continue;
    }
    const actionMatch = indent === 4 && line.match(/^(add|remove):\s*(\[\s*\])?$/);
    if (current && section === 'rules' && actionMatch) {
      if (ruleActions.has(actionMatch[1])) fail(`Duplicate rule action: ${actionMatch[1]}`);
      ruleActions.add(actionMatch[1]);
      ruleAction = actionMatch[2] ? null : actionMatch[1];
      continue;
    }
    if (current && ((section === 'url' && indent === 4) ||
        (section === 'rules' && ruleAction && indent === 6)) && line.startsWith('- ')) {
      const value = line.slice(2).trim();
      if (!value || value.startsWith('#')) fail('List items need a value; put comments on separate lines');
      if (/^["'|>\[\]{}&*!%@`]/.test(value) || /\s#|:\s/.test(value) || /^(?:null|true|false|~)$/i.test(value)) {
        fail('Unsupported YAML value; use an unquoted single-line value and separate comment lines');
      }
      if (section === 'url') {
        let parsed;
        try { parsed = new URL(value); } catch { fail(`Invalid URL: ${value}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) fail('URL must use HTTP or HTTPS');
        if (parsed.username || parsed.password) fail('URL credentials are not supported');
      }
      if (section === 'url') current.url.push(value);
      else current.rules[ruleAction].push(value);
      continue;
    }
    fail(`Unsupported syntax: ${line}`);
  }
  if (!names.size) throw new Error('No rule categories found');
  return result;
}

function addRules(target, text) {
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) target.add(line);
  }
  return target;
}

function assertKnownOptions(options, supportedKeys) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid options: use an object');
  }
  for (const key of Object.keys(options)) {
    if (!supportedKeys.includes(key)) throw new Error(`Unknown option: ${key}`);
  }
}

function resolveOptions(options = {}) {
  assertKnownOptions(options, Object.keys(DEFAULT_OPTIONS));
  const settings = { ...DEFAULT_OPTIONS, ...options };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 ||
        ((key === 'timeoutMs' || key === 'retryMs') && settings[key] > MAX_TIMER_MS)) {
      throw new Error(`Invalid option: ${key}`);
    }
  }
  return settings;
}

class DownloadError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'DownloadError';
    this.retryable = retryable;
  }
}

// Keep the timeout active until the body has been fully read, not just the headers.
async function fetchRules(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'GitHub-Actions-Rule-Merger' },
    });
    if (!response.ok) {
      // A stalled cancellation must not block this worker or the next retry.
      try { response.body?.cancel().catch(() => {}); } catch {}
      controller.abort();
      throw new DownloadError(`HTTP ${response.status} ${response.statusText}`, {
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500,
      });
    }
    const bytes = await response.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (cause) { throw new DownloadError('Response is not valid UTF-8', { cause }); }
    return addRules(new Set(), text);
  } catch (cause) {
    // HTTP errors abort their response body too; keep their original status/retry policy.
    if (controller.signal.aborted && !(cause instanceof DownloadError)) {
      throw new DownloadError(`Request timed out after ${timeoutMs} ms`, { retryable: true, cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, options = {}) {
  const settings = resolveOptions(options);
  for (let attempt = 1; attempt <= settings.attempts; attempt++) {
    try { return await fetchRules(url, settings.timeoutMs); }
    catch (error) {
      if (attempt === settings.attempts || (error instanceof DownloadError && !error.retryable)) throw error;
      console.warn(`Retry ${attempt}/${settings.attempts - 1}: ${url} (${error.message})`);
      // Node.js otherwise turns overflowing delays into a 1 ms timer.
      await sleep(Math.min(settings.retryMs * 2 ** (attempt - 1), MAX_TIMER_MS));
    }
  }
}

async function mapLimit(items, limit, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await action(items[index]);
    }
  }));
}

const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

async function atomicWrite(output, content) {
  // A fixed-length basename also supports output names near the filesystem limit.
  const temporary = path.join(path.dirname(output), `.merge-rules-${randomUUID()}.tmp`);
  // Only clean up a temporary file after this call has created it exclusively.
  let handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = null;
    await fs.rename(temporary, output);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try { await fs.rm(temporary, { force: true }); }
    catch (cleanupError) {
      console.warn(`Could not remove temporary file ${temporary}: ${cleanupError.message}`);
    }
    throw error;
  }
}

function collectRules(config, downloads) {
  const sources = config.url.map(url => {
    const result = downloads.get(url);
    if (result.error) {
      throw new Error(`${url}: ${result.error.message}`, { cause: result.error });
    }
    return result;
  });
  let rules = new Set();
  // Reuse the largest exclusively owned set to minimize copying; shared sources stay intact.
  for (const source of sources) {
    if (source.remainingUsers === 1 && source.rules.size > rules.size) rules = source.rules;
  }
  for (const source of sources) {
    if (source.rules !== rules) for (const rule of source.rules) rules.add(rule);
  }
  // Configuration values are already single-line, trimmed rules from parseConfig.
  for (const rule of config.rules.add) rules.add(rule);
  return rules;
}

async function outputMatchesRules(output, rules) {
  let info;
  try { info = await fs.lstat(output); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // A link can point to another output that changes later in this run. Replace the link itself.
  if (info.isSymbolicLink()) return false;
  if (!info.isFile()) throw new Error(`Output must be a regular file or symbolic link: ${output}`);
  const oldRules = addRules(new Set(), await fs.readFile(output, 'utf8'));
  return oldRules.size === rules.size && oldRules.isSupersetOf(rules);
}

async function generateRule(name, config, downloads, outputDir) {
  if (!config.url.length && !config.rules.add.length) return 'skipped';
  const output = path.join(outputDir, `${name}.txt`);
  const rules = collectRules(config, downloads);
  if (!rules.size) {
    console.warn(`SKIP: ${name} generated no rules; original file preserved`);
    return 'skipped';
  }
  // Apply removals last so they override both downloaded and added rules.
  for (const rule of config.rules.remove) rules.delete(rule);
  if (await outputMatchesRules(output, rules)) {
    console.log(`UNCHANGED: ${output}`);
    return 'unchanged';
  }
  // Allocate and sort only when the output actually needs to change.
  const sorted = [...rules].sort();
  await atomicWrite(output, `# 更新时间：${timeFormatter.format(new Date())}\n\n${sorted.join('\n')}\n`);
  console.log(`UPDATED: ${output} (${rules.size} unique rules)`);
  return 'updated';
}

// Windows paths are case-insensitive; Linux paths must match exactly.
function fileKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function resolveFilePaths(outputDir, configFile) {
  const [realOutputDir, realConfigFile, realConfigDir] = await Promise.all([
    fs.realpath(outputDir), fs.realpath(configFile), fs.realpath(path.dirname(path.resolve(configFile))),
  ]);
  // Protect both a configuration symlink and its target, including directory aliases.
  const protectedPaths = new Set([
    path.resolve(configFile), realConfigFile, path.join(realConfigDir, path.basename(configFile)),
  ].map(fileKey));
  return { realOutputDir, protectedPaths };
}

function assertSafeOutputs(config, outputDir, protectedPaths) {
  for (const name of Object.keys(config)) {
    if (protectedPaths.has(fileKey(path.join(outputDir, `${name}.txt`)))) {
      throw new Error(`Output would overwrite configuration: ${name}.txt`);
    }
  }
}

// Count category users so shared sources download once and are released after last use.
function createDownloadCache(categories) {
  const downloads = new Map();
  for (const [, config] of categories) {
    for (const url of config.url) {
      const cached = downloads.get(url);
      if (cached) cached.remainingUsers++;
      else downloads.set(url, { remainingUsers: 1 });
    }
  }
  return downloads;
}

async function downloadSources(downloads, settings) {
  await mapLimit([...downloads.keys()], settings.concurrency, async url => {
    const cached = downloads.get(url);
    console.log(`Downloading: ${url}`);
    try { cached.rules = await download(url, settings); }
    catch (error) { cached.error = error; }
  });
}

function releaseDownloads(config, downloads) {
  for (const url of config.url) {
    const cached = downloads.get(url);
    if (--cached.remainingUsers === 0) downloads.delete(url);
  }
}

async function readConfig(configFile) {
  const bytes = await fs.readFile(configFile);
  try {
    return parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${configFile}: ${cause.message}`, { cause });
  }
}

async function main(runOptions = {}) {
  assertKnownOptions(runOptions, ['configFile', 'outputDir', 'options']);
  const {
    configFile = path.join(DEFAULT_OUTPUT_DIR, 'merge.yaml'),
    outputDir = DEFAULT_OUTPUT_DIR,
    options = {},
  } = runOptions;
  const settings = resolveOptions(options);
  const config = await readConfig(configFile);
  await fs.mkdir(outputDir, { recursive: true });
  const resolvedPaths = await resolveFilePaths(outputDir, configFile);
  assertSafeOutputs(config, resolvedPaths.realOutputDir, resolvedPaths.protectedPaths);

  // Deduplicate source URLs before building the shared download cache.
  const categories = Object.entries(config).map(([name, item]) => [
    name, { ...item, url: [...new Set(item.url)] },
  ]);
  const downloads = createDownloadCache(categories);
  await downloadSources(downloads, settings);

  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const [name, item] of categories) {
    try { summary[await generateRule(name, item, downloads, resolvedPaths.realOutputDir)]++; }
    catch (error) {
      summary.failed++;
      console.error(`FAILED: ${name}: ${error.message}; original file preserved`);
    } finally {
      releaseDownloads(item, downloads);
    }
  }
  console.log('Summary:', summary);
  return summary;
}

if (require.main === module) {
  main().then(summary => {
    if (summary.failed) process.exitCode = 1;
  }).catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseConfig, addRules, download, main };
