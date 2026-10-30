'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

// 规则配置：分类名对应输出文件名，url 为上游来源。
// rules.add / rules.remove 用于手动增删规则；remove 最后生效。
const RULE_SETS = {
  'direct-fix': {
    url: [
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Direct+.list',
    ],
    rules: { add: [], remove: [] },
  },
  reject: {
    url: [
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/Reject/Advertising.list',
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/Reject/Tracking.list',
    ],
    rules: { add: [], remove: [] },
  },
  us: {
    url: [
      // 'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/PayPal.list',
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/GenAI/OpenAI.list',
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/GenAI/Anthropic.list',
    ],
    rules: { add: [], remove: [] },
  },
  proxy: {
    url: [
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/Streaming/!CN.list',
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Proxy.list',
    ],
    rules: { add: [], remove: [] },
  },
  direct: {
    url: [
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Direct.list',
      'https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Extra/Apple/Apple.list',
      'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/ByteDance/ByteDance.list',
      'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Speedtest/Speedtest.list',
      'https://raw.githubusercontent.com/Lc1fer/rule/main/lan.txt',
    ],
    rules: { add: [], remove: [] },
  },
};

const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 4,
  attempts: 3,
  timeoutMs: 60_000,
  retryMs: 2_000,
});
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);
const MAX_TIMER_MS = 2 ** 31 - 1;

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..');

function normalizeList(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label}: use an array`);
  return [...new Set(Array.from(values, value => {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || !value.trim() || value.trimStart().startsWith('#')) {
      throw new Error(`${label}: items must be nonempty, single-line strings; use JavaScript comments`);
    }
    return value.trim();
  }))];
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid rule configuration: use an object');
  }
  const categories = Object.entries(config);
  if (!categories.length) throw new Error('No rule categories found');
  const names = new Set();
  return categories.map(([name, item]) => {
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.endsWith('.') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      throw new Error(`Invalid output name: ${name}`);
    }
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate output name: ${name}`);
    names.add(key);
    assertKnownOptions(item, ['url', 'rules'], name);
    const { url = [], rules = {} } = item;
    assertKnownOptions(rules, ['add', 'remove'], `${name}.rules`);
    const { add = [], remove = [] } = rules;
    const urls = normalizeList(url, `${name}.url`);
    for (const value of urls) {
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error(`${name}: Invalid URL: ${value}`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name}: URL must use HTTP or HTTPS`);
      if (parsed.username || parsed.password) throw new Error(`${name}: URL credentials are not supported`);
    }
    // Copy every array so repeated runs never mutate the editable configuration.
    return [name, {
      url: urls,
      rules: {
        add: normalizeList(add, `${name}.rules.add`),
        remove: normalizeList(remove, `${name}.rules.remove`),
      },
    }];
  });
}

function addRules(target, text) {
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) target.add(line);
  }
  return target;
}

function assertKnownOptions(options, supportedKeys, label = 'options') {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`Invalid ${label}: use an object`);
  }
  for (const key of Object.keys(options)) {
    if (!supportedKeys.includes(key)) throw new Error(`Unknown option in ${label}: ${key}`);
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

function parseDownloadedRules(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (cause) { throw new DownloadError('Response is not valid UTF-8', { cause }); }
  const rules = addRules(new Set(), text);
  // Error pages may arrive with HTTP 200 and even a text/plain Content-Type.
  // Check the content without maintaining a whitelist of Surge rule types.
  for (const rule of rules) {
    if (/^[<{\[]/.test(rule)) {
      throw new DownloadError('Expected plain-text rules, received HTML, XML or JSON content');
    }
  }
  return rules;
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
    // No Range header was sent: a partial response cannot replace a complete rule set.
    if (!response.ok || response.status === 206) {
      // A stalled cancellation must not block this worker or the next retry.
      try { response.body?.cancel().catch(() => {}); } catch {}
      controller.abort();
      throw new DownloadError(`HTTP ${response.status} ${response.statusText}`, {
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500,
      });
    }
    return parseDownloadedRules(await response.arrayBuffer());
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
  // Preserve the old category if only some sources have gone empty. Entirely empty
  // categories are still skipped by generateRule; explicit removals can clear a set.
  if (config.rules.add.length || sources.some(source => source.rules.size)) {
    const emptySourceIndex = sources.findIndex(source => source.rules.size === 0);
    if (emptySourceIndex !== -1) {
      throw new Error(`Empty rule source: ${config.url[emptySourceIndex]}`);
    }
  }
  let rules = new Set();
  // Reuse the largest exclusively owned set to minimize copying; shared sources stay intact.
  for (const source of sources) {
    if (source.remainingUsers === 1 && source.rules.size > rules.size) rules = source.rules;
  }
  for (const source of sources) {
    if (source.rules !== rules) for (const rule of source.rules) rules.add(rule);
  }
  // Configuration values are already single-line, trimmed rules from normalizeConfig.
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
  const bytes = await fs.readFile(output);
  let text;
  // Repair invalid UTF-8 instead of treating decoding replacement characters as rules.
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return false; }
  const oldRules = addRules(new Set(), text);
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

async function main(runOptions = {}) {
  assertKnownOptions(runOptions, ['config', 'outputDir', 'options']);
  const {
    config = RULE_SETS,
    outputDir = DEFAULT_OUTPUT_DIR,
    options = {},
  } = runOptions;
  const settings = resolveOptions(options);
  const categories = normalizeConfig(config);
  await fs.mkdir(outputDir, { recursive: true });
  const realOutputDir = await fs.realpath(outputDir);

  const downloads = createDownloadCache(categories);
  await downloadSources(downloads, settings);

  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const [name, item] of categories) {
    try { summary[await generateRule(name, item, downloads, realOutputDir)]++; }
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

module.exports = { RULE_SETS, normalizeConfig, addRules, download, main };
