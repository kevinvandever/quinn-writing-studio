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
 *   npm run quality-check -w @quinn/backend -- --runs 3      # each case 3 times (1-5), for pass rates
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

/**
 * Rough cost, from real runs: writing the cached prompt costs about $0.50
 * (skipped when a request in the last hour already wrote it); after that,
 * each turn about $0.02 and each grading about $0.012.
 */
const CACHE_WRITE_USD = 0.5;
const estimateCost = (cases: QualityCase[], runs: number): number =>
  CACHE_WRITE_USD + runs * cases.reduce((sum, c) => sum + 0.02 * c.turns.length + (c.rubric.length > 0 ? 0.012 : 0), 0);

const money = (n: number): string => `$${n.toFixed(2)}`;
const seconds = (ms: number): string => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
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

/** One run of one case. */
type RunResult = CaseResult & { attempt: number };

interface Report {
  startedAt: string;
  projectId: string;
  apiUrl: string;
  runsPerCase: number;
  totalCostUsd: number;
  ms: number;
  results: RunResult[];
}

/** A case's runs, summed up. */
interface CaseSummary {
  id: string;
  title: string;
  runs: RunResult[];
  /** Runs that produced a verdict (not skipped or broken). */
  judged: number;
  passed: number;
  grade: number | null;
}

function summarize(results: RunResult[]): CaseSummary[] {
  const byId = new Map<string, RunResult[]>();
  for (const r of results) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  return [...byId.values()].map((runs) => {
    const judged = runs.filter((r) => r.status === 'pass' || r.status === 'fail');
    const grades = runs.map((r) => r.judge?.score).filter((g): g is number => typeof g === 'number');
    return {
      id: runs[0]!.id,
      title: runs[0]!.title,
      runs,
      judged: judged.length,
      passed: judged.filter((r) => r.status === 'pass').length,
      grade: grades.length > 0 ? grades.reduce((a, b) => a + b, 0) / grades.length : null,
    };
  });
}

/** ✓ when every run passed, ✗ when none did, ~ in between, – when skipped. */
function mark(s: CaseSummary): string {
  if (s.judged === 0) return s.runs.some((r) => r.status === 'error') ? '!' : '–';
  if (s.passed === s.judged) return '✓';
  return s.passed === 0 ? '✗' : '~';
}

const passText = (s: CaseSummary): string => (s.judged === 0 ? '' : `${s.passed}/${s.judged}`);
const gradeText = (g: number | null): string => (g === null ? '' : Number.isInteger(g) ? `${g}/5` : `${g.toFixed(1)}/5`);

function previousReport(reportsDir: string, before: string): Report | null {
  if (!existsSync(reportsDir)) return null;
  const last = readdirSync(reportsDir)
    .filter((f) => f.endsWith('.json') && f < before)
    .sort()
    .at(-1);
  if (!last) return null;
  try {
    const report = JSON.parse(readFileSync(join(reportsDir, last), 'utf-8')) as Report;
    report.results = report.results.map((r) => ({ ...r, attempt: r.attempt ?? 1 }));
    return report;
  } catch {
    return null;
  }
}

function comparison(report: Report, previous: Report | null): string[] {
  if (!previous) return [];
  const before = new Map(summarize(previous.results).map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const s of summarize(report.results)) {
    const old = before.get(s.id);
    if (!old) {
      lines.push(`- New case: ${s.title} (passed ${passText(s) || 'no runs'})`);
      continue;
    }
    const rate = (x: CaseSummary): number | null => (x.judged === 0 ? null : x.passed / x.judged);
    const changes: string[] = [];
    if (rate(old) !== rate(s)) changes.push(`passed ${passText(old) || 'none'} → ${passText(s) || 'none'}`);
    if (old.grade !== null && s.grade !== null && Math.abs(old.grade - s.grade) >= 0.5) {
      changes.push(`grade ${gradeText(old.grade)} → ${gradeText(s.grade)}`);
    }
    if (changes.length > 0) lines.push(`- ${s.title}: ${changes.join(', ')}`);
  }
  return lines.length > 0 ? lines : ['- No changes in pass rates, and no grade moved by half a point or more.'];
}

/** The first thing that went wrong in a run, for the summary table. */
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
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function renderRun(r: RunResult, lines: string[]): void {
  if (r.reason) lines.push('', `**${r.reason}**`);
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

function renderMarkdown(report: Report, previous: Report | null, projectLabel: string): string {
  const summaries = summarize(report.results);
  const judged = summaries.filter((s) => s.judged > 0);
  const allPassing = judged.filter((s) => s.passed === s.judged).length;
  const runsJudged = judged.reduce((n, s) => n + s.judged, 0);
  const runsPassed = judged.reduce((n, s) => n + s.passed, 0);
  const skipped = summaries.filter((s) => s.judged === 0);
  const perCase = report.runsPerCase > 1 ? `, ${report.runsPerCase} runs each` : '';
  const lines: string[] = [
    `# Quinn quality check, ${when(report.startedAt)}`,
    '',
    `Project: ${projectLabel} · ${summaries.length} case${summaries.length === 1 ? '' : 's'}${perCase} · ${money(report.totalCostUsd)} · ${seconds(report.ms)}`,
    '',
    report.runsPerCase > 1
      ? `**${allPassing} of ${judged.length} cases passed every run. ${runsPassed} of ${runsJudged} runs passed.${skipped.length ? ` ${skipped.length} skipped.` : ''}**`
      : `**${runsPassed} passed, ${runsJudged - runsPassed} failed${skipped.length ? `, ${skipped.length} skipped` : ''}.**`,
    '',
    "A run passes when every check and every grader criterion passes. Warnings (length, unneeded lookups) don't fail a run. The grade is the grader's 1-5 score for the coaching overall. Quinn and the grader both vary from run to run, so one failure can be noise; a case that fails most runs points at something real.",
  ];
  if (previous) lines.push('', `Compared with the run of ${when(previous.startedAt)}:`, ...comparison(report, previous));
  lines.push('', '| | Case | Passed | Grade | Notes |', '|---|---|---|---|---|');
  for (const s of summaries) {
    const firstProblem = s.runs.find((r) => r.status !== 'pass') ?? s.runs[0]!;
    lines.push(`| ${mark(s)} | ${cell(s.title)} | ${passText(s)} | ${gradeText(s.grade)} | ${cell(note(firstProblem))} |`);
  }
  for (const s of summaries) {
    const first = s.runs[0]!;
    lines.push('', '---', '', `## ${mark(s)} ${s.title} (\`${s.id}\`)`, '', `What it checks: ${first.checks}`);
    const filled = Object.entries(first.resolved);
    if (filled.length > 0) lines.push('', `Filled in from your files: ${filled.map(([k, v]) => `${k} = "${v}"`).join('; ')}`);
    for (const r of s.runs) {
      if (s.runs.length > 1) lines.push('', `### Run ${r.attempt}: ${STATUS_WORD[r.status]}`);
      renderRun(r, lines);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const brokenRun = (testCase: QualityCase, attempt: number, err: unknown): RunResult => ({
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
  attempt,
});

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
  // A copy: cases that skip are dropped from it between rounds.
  const cases = all.filter((c) => wanted.length === 0 || wanted.includes(c.id));
  const runsArg = values('runs')[0];
  const runs = runsArg === undefined ? 1 : Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs takes a whole number from 1 to 5.');

  if (!API_URL || !EMAIL || !PASSWORD || !PROJECT_ID) {
    throw new Error('Set QUINN_API_URL, QUINN_EMAIL, QUINN_PASSWORD, and SCRIV_PROJECT_ID in packages/backend/.env (or pass --project).');
  }
  const runText = runs > 1 ? `, ${runs} runs each` : '';
  console.log(
    `${cases.length} case${cases.length === 1 ? '' : 's'}${runText}, against ${API_URL}, project ${PROJECT_ID}. ` +
      `Estimated cost: about ${money(estimateCost(cases, runs))} (${money(CACHE_WRITE_USD)} less if a run in the last hour already cached Quinn's prompt).`
  );
  if (!flag('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Run them? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') return;
  }

  const startedAt = new Date();
  const results: RunResult[] = [];
  let total = cases.length * runs;
  let n = 0;
  // Each round runs every case once, so repeated runs of a case are spread out.
  for (let attempt = 1; attempt <= runs; attempt++) {
    for (const testCase of cases) {
      process.stdout.write(`[${++n}/${total}] ${testCase.title}${runs > 1 ? ` (run ${attempt})` : ''}… `);
      let result: RunResult;
      try {
        result = { ...(await runCase(testCase)), attempt };
      } catch (err) {
        result = brokenRun(testCase, attempt, err);
      }
      results.push(result);
      const grade = result.judge?.score ? ` · ${result.judge.score}/5` : '';
      const why = result.status === 'pass' ? '' : ` · ${note(result)}`;
      console.log(`${STATUS_WORD[result.status]}${grade} · ${money(result.usage.costUsd)} · ${seconds(result.ms)}${why.slice(0, 160)}`);
      // A skipped case would skip every time, so its later runs are dropped.
      if (result.status === 'skip') total -= runs - attempt;
    }
    // Drop cases that skipped from later rounds.
    for (let i = cases.length - 1; i >= 0; i--) {
      if (results.some((r) => r.id === cases[i]!.id && r.status === 'skip')) cases.splice(i, 1);
    }
  }
  results.sort((a, b) => all.findIndex((c) => c.id === a.id) - all.findIndex((c) => c.id === b.id) || a.attempt - b.attempt);

  const report: Report = {
    startedAt: startedAt.toISOString(),
    projectId: PROJECT_ID,
    apiUrl: API_URL,
    runsPerCase: runs,
    totalCostUsd: results.reduce((s, r) => s + r.usage.costUsd, 0),
    ms: Date.now() - startedAt.getTime(),
    results,
  };
  const reportsDir = join(evalsDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const pad = (v: number): string => String(v).padStart(2, '0');
  // Down to the second, so two runs in the same minute don't overwrite each other.
  const stamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  const previous = previousReport(reportsDir, `${stamp}.json`);
  writeFileSync(join(reportsDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  const projectLabel = results.find((r) => r.projectName)?.projectName ?? PROJECT_ID;
  writeFileSync(join(reportsDir, `${stamp}.md`), renderMarkdown(report, previous, projectLabel));

  const summaries = summarize(results).filter((s) => s.judged > 0);
  const runsPassed = summaries.reduce((v, s) => v + s.passed, 0);
  const runsJudged = summaries.reduce((v, s) => v + s.judged, 0);
  const allPassing = summaries.filter((s) => s.passed === s.judged).length;
  console.log(
    `\n${runsPassed} of ${runsJudged} runs passed${runs > 1 ? `; ${allPassing} of ${summaries.length} cases passed every run` : ''}. Cost ${money(report.totalCostUsd)}, ${seconds(report.ms)}.`
  );
  for (const line of comparison(report, previous)) console.log(line);
  console.log(`Report: ${resolve(reportsDir, `${stamp}.md`)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
