#!/usr/bin/env tsx
/**
 * Quinn Quality Check: local runner
 *
 * Runs the test conversations in evals/quinn-cases.json against the live
 * backend, one at a time, and writes a report to evals/reports/ (kept out of
 * git: it quotes the writer's work). Each case is a fresh conversation in the
 * project; nothing is stored in the app except API usage ("quality check" in
 * Settings → Usage).
 *
 * Usage (from the repo root):
 *   npm run quality-check -w @quinn/backend                  # every case
 *   npm run quality-check -w @quinn/backend -- --case archive-trash --case coach-stuck
 *   npm run quality-check -w @quinn/backend -- --list        # list the cases
 *   npm run quality-check -w @quinn/backend -- --check       # validate the case file only
 *   add --yes to skip the cost prompt
 *
 * Uses the Scrivener watcher's settings in packages/backend/.env:
 * QUINN_API_URL, QUINN_EMAIL, QUINN_PASSWORD, and SCRIV_PROJECT_ID (or pass
 * --project <id>).
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import {
  qualityCaseFileSchema,
  type CaseResult,
  type QualityCase,
} from '../services/quality-check.schema.js';

// ─── Arguments and settings ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const values = (name: string): string[] => {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) out.push(...args[i + 1]!.split(','));
  });
  return out;
};

const API_URL = (process.env.QUINN_API_URL || '').replace(/\/$/, '');
const EMAIL = process.env.QUINN_EMAIL;
const PASSWORD = process.env.QUINN_PASSWORD;
const PROJECT_ID = values('project')[0] || process.env.SCRIV_PROJECT_ID;

/** The evals folder: the nearest one at or above the current directory. */
function findEvalsDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'evals', 'quinn-cases.json'))) return join(dir, 'evals');
    dir = dirname(dir);
  }
  throw new Error('Could not find evals/quinn-cases.json above the current directory.');
}

/** Rough cost: the first request writes the cached prompt (~$0.40 on Sonnet); later ones mostly read it. */
const estimateCost = (cases: QualityCase[]): number =>
  0.45 + cases.reduce((sum, c) => sum + 0.04 * c.turns.length + (c.rubric.length > 0 ? 0.02 : 0), 0);

const money = (n: number): string => `$${n.toFixed(2)}`;
const seconds = (ms: number): string => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
const STATUS_MARK: Record<CaseResult['status'], string> = { pass: '✓', fail: '✗', skip: '–', error: '!' };
const STATUS_WORD: Record<CaseResult['status'], string> = { pass: 'pass', fail: 'FAIL', skip: 'skip', error: 'ERROR' };

// ─── API ─────────────────────────────────────────────────────────────────────

let token: string | null = null;

async function login(): Promise<string> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Login failed (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

async function runCase(testCase: QualityCase): Promise<CaseResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    token ??= await login();
    const response = await fetch(`${API_URL}/api/projects/${PROJECT_ID}/quality-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ case: testCase }),
    });
    if (response.status === 401 && attempt === 0) {
      token = null;
      continue;
    }
    const body = (await response.text()).trim();
    if (!response.ok) throw new Error(`The backend refused the case (${response.status}): ${body.slice(0, 300)}`);
    const parsed = JSON.parse(body) as { result?: CaseResult; error?: string };
    if (parsed.error || !parsed.result) throw new Error(parsed.error || 'The backend sent no result.');
    return parsed.result;
  }
  throw new Error('Login expired twice in a row.');
}

// ─── Report ──────────────────────────────────────────────────────────────────

interface Report {
  startedAt: string;
  projectId: string;
  apiUrl: string;
  totalCostUsd: number;
  ms: number;
  results: CaseResult[];
}

function previousReport(reportsDir: string, before: string): Report | null {
  if (!existsSync(reportsDir)) return null;
  const files = readdirSync(reportsDir)
    .filter((f) => f.endsWith('.json') && f < before)
    .sort();
  const last = files.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(readFileSync(join(reportsDir, last), 'utf-8')) as Report;
  } catch {
    return null;
  }
}

function comparison(report: Report, previous: Report | null): string[] {
  if (!previous) return [];
  const before = new Map(previous.results.map((r) => [r.id, r]));
  const lines: string[] = [];
  for (const r of report.results) {
    const old = before.get(r.id);
    if (!old) {
      lines.push(`- New case: ${r.title} (${STATUS_WORD[r.status]})`);
      continue;
    }
    if (old.status !== r.status) lines.push(`- ${r.title}: ${STATUS_WORD[old.status]} → ${STATUS_WORD[r.status]}`);
    else if (old.judge?.score && r.judge?.score && old.judge.score !== r.judge.score) {
      lines.push(`- ${r.title}: grade ${old.judge.score}/5 → ${r.judge.score}/5`);
    }
  }
  return lines.length > 0 ? lines : ['- No changes in results or grades.'];
}

/** The first thing that went wrong in a case, for the summary table. */
function note(r: CaseResult): string {
  if (r.reason) return r.reason;
  const failedCheck = r.results.find((c) => !c.pass && !c.soft);
  if (failedCheck) return `${failedCheck.name}: ${failedCheck.detail}`;
  const failedCriterion = r.judge?.criteria.find((c) => !c.pass);
  if (failedCriterion) return `Not met: ${failedCriterion.criterion} ${failedCriterion.reason}`;
  const warnings = r.results.filter((c) => !c.pass && c.soft);
  return warnings.length > 0 ? `Warning: ${warnings.map((w) => `${w.name} (${w.detail})`).join('; ')}` : '';
}

const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function renderMarkdown(report: Report, previous: Report | null, projectLabel: string): string {
  const started = new Date(report.startedAt);
  const count = (s: CaseResult['status']): number => report.results.filter((r) => r.status === s).length;
  const lines: string[] = [
    `# Quinn quality check, ${started.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
    '',
    `Project: ${projectLabel} · ${report.results.length} cases · ${money(report.totalCostUsd)} · ${seconds(report.ms)}`,
    '',
    `**${count('pass')} passed, ${count('fail')} failed${count('skip') ? `, ${count('skip')} skipped` : ''}${count('error') ? `, ${count('error')} could not run` : ''}.**`,
    '',
    'A case passes when every check and every grader criterion passes. Warnings (length, unneeded lookups) don\'t fail a case. Grades are the grader\'s 1-5 score for the coaching overall.',
  ];
  const changes = comparison(report, previous);
  if (previous) {
    lines.push('', `Compared with the run of ${new Date(previous.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}:`, ...changes);
  }
  lines.push('', '| | Case | Grade | Notes |', '|---|---|---|---|');
  for (const r of report.results) {
    lines.push(`| ${STATUS_MARK[r.status]} | ${cell(r.title)} | ${r.judge?.score ? `${r.judge.score}/5` : ''} | ${cell(note(r))} |`);
  }
  for (const r of report.results) {
    lines.push('', '---', '', `## ${STATUS_MARK[r.status]} ${r.title} (\`${r.id}\`)`, '', `What it checks: ${r.checks}`);
    if (r.reason) lines.push('', `**${r.reason}**`);
    const filled = Object.entries(r.resolved);
    if (filled.length > 0) {
      lines.push('', `Filled in from your files: ${filled.map(([k, v]) => `${k} = "${v}"`).join('; ')}`);
    }
    for (const t of r.transcript) {
      lines.push('', t.role === 'writer' ? `**Test message:** ${t.text}` : `**Quinn:**\n\n${t.text}`);
    }
    if (r.transcript.length > 0) {
      const lookups = r.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.input)}${c.isError ? ' (error)' : ''}`);
      lines.push('', `Lookups: ${lookups.length > 0 ? lookups.join('; ') : 'none'}`);
    }
    if (r.results.length > 0) {
      lines.push('', 'Checks:');
      for (const c of r.results) lines.push(`- ${c.pass ? '✓' : c.soft ? '⚠' : '✗'} ${c.name} (${c.detail})`);
    }
    if (r.judge) {
      lines.push('', `Grader${r.judge.score ? `, ${r.judge.score}/5` : ''}: ${r.judge.summary}`);
      for (const c of r.judge.criteria) lines.push(`- ${c.pass ? '✓' : '✗'} ${c.criterion} ${c.reason}`);
    }
    const model = r.model ? ` · ${r.model === 'opus' ? 'Opus' : 'Sonnet'}${r.effort ? `, ${r.effort} effort` : ''}` : '';
    lines.push('', `Cost ${money(r.usage.costUsd)}${model} · ${seconds(r.ms)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const evalsDir = findEvalsDir();
  const file = qualityCaseFileSchema.safeParse(JSON.parse(readFileSync(join(evalsDir, 'quinn-cases.json'), 'utf-8')));
  if (!file.success) {
    console.error('evals/quinn-cases.json has problems:');
    for (const issue of file.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    process.exit(1);
  }
  const all = file.data.cases;
  if (flag('list')) {
    for (const c of all) console.log(`${c.id.padEnd(28)} ${c.title}`);
    return;
  }
  if (flag('check')) {
    console.log(`evals/quinn-cases.json is valid: ${all.length} cases.`);
    return;
  }
  const wanted = values('case');
  const unknown = wanted.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`No case with id ${unknown.join(', ')}. Use --list to see them.`);
  const cases = wanted.length > 0 ? all.filter((c) => wanted.includes(c.id)) : all;

  if (!API_URL || !EMAIL || !PASSWORD || !PROJECT_ID) {
    throw new Error('Set QUINN_API_URL, QUINN_EMAIL, QUINN_PASSWORD, and SCRIV_PROJECT_ID in packages/backend/.env (or pass --project).');
  }
  console.log(`${cases.length} case${cases.length === 1 ? '' : 's'} against ${API_URL}, project ${PROJECT_ID}. Estimated cost: about ${money(estimateCost(cases))}.`);
  if (!flag('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Run them? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') return;
  }

  const startedAt = new Date();
  const results: CaseResult[] = [];
  for (const [i, testCase] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${testCase.title}… `);
    let result: CaseResult;
    try {
      result = await runCase(testCase);
    } catch (err) {
      result = {
        id: testCase.id,
        title: testCase.title,
        checks: testCase.checks,
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
        resolved: {},
        transcript: [],
        toolCalls: [],
        results: [],
        judge: null,
        model: null,
        effort: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        ms: 0,
      };
    }
    results.push(result);
    const grade = result.judge?.score ? ` · ${result.judge.score}/5` : '';
    const why = result.status === 'pass' ? '' : ` · ${note(result)}`;
    console.log(`${STATUS_WORD[result.status]}${grade} · ${money(result.usage.costUsd)} · ${seconds(result.ms)}${why.slice(0, 160)}`);
  }

  const report: Report = {
    startedAt: startedAt.toISOString(),
    projectId: PROJECT_ID,
    apiUrl: API_URL,
    totalCostUsd: results.reduce((s, r) => s + r.usage.costUsd, 0),
    ms: Date.now() - startedAt.getTime(),
    results,
  };
  const reportsDir = join(evalsDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}`;
  const previous = previousReport(reportsDir, `${stamp}.json`);
  writeFileSync(join(reportsDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  const projectLabel = results.find((r) => r.projectName)?.projectName ?? PROJECT_ID;
  writeFileSync(join(reportsDir, `${stamp}.md`), renderMarkdown(report, previous, projectLabel));

  const count = (s: CaseResult['status']): number => results.filter((r) => r.status === s).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped, ${count('error')} could not run. Cost ${money(report.totalCostUsd)}, ${seconds(report.ms)}.`);
  for (const line of comparison(report, previous)) console.log(line);
  console.log(`Report: ${resolve(reportsDir, `${stamp}.md`)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
