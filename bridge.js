/*
 * AIOS mission bridge -- LOCAL, LOOPBACK-ONLY launcher for allowlisted,
 * deterministic AIOS missions.
 *
 * Security posture (deliberate):
 *   - Binds to 127.0.0.1 only. Never 0.0.0.0.
 *   - The caller may send a mission key from the allowlist, and for the
 *     folder-summary mission two absolute PATHS. Nothing else.
 *     No script names, no commands, no shell strings.
 *   - spawn() is called with an argv ARRAY and shell:false. Nothing the
 *     request body contains is ever interpreted as a command.
 *   - Paths are validated here AND re-validated independently inside the
 *     mission runner. Neither trusts the other.
 *   - Missions marked requiresApproval are REFUSED by this bridge (403).
 *     A confirm() dialog in a web page is not an approval gate; those
 *     missions stay on the CLI with a human at the terminal.
 *   - One mission at a time; concurrent requests get 409.
 *   - Success is never inferred from exit code alone. The bridge parses the
 *     mission's OWN verification evidence out of stdout and reports a
 *     verdict of verified / failed / indeterminate.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)); // repo root (this file lives there)
const HOST = '127.0.0.1';             // loopback only
const PORT = 3000;
const TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 4096;

const NODE_ARGS = ['--experimental-strip-types', '--no-warnings'];

/*
 * Allowlist. `args` is a fixed argv array defined HERE, not by the caller.
 * `requiresApproval: true` -> this bridge will not run it.
 *
 * `observed` records what was ACTUALLY observed on this machine on 2026-10-10.
 * It is evidence, not marketing. Entries marked broken are kept so their
 * failure is reproducible from the UI, but the UI must not imply they are
 * healthy.
 */
const ALLOWED_MISSIONS = {
  folder: {
    name: 'Folder Summary Mission',
    script: 'packages/mission-engine/live/run-folder-mission.ts',
    requiresApproval: false,
    observed: 'working',
    observedNote: 'exit 0, 19 PASS / 0 FAIL, mission state complete',
  },
  recovery: {
    name: 'Recovery Mission',
    script: 'packages/mission-engine/live/run-recovery.ts',
    requiresApproval: false,
    observed: 'working',
    observedNote: 'exit 0, 26 PASS / 0 FAIL',
  },
  summary: {
    name: 'Summary Mission',
    script: 'packages/mission-engine/live/run-summary-mission.ts',
    requiresApproval: false,
    observed: 'failing',
    observedNote:
      'exit 1, 3 PASS / 5 FAIL. Mission reports state=failed, 0 steps verified, summary file not written. Pre-existing failure inside the mission script.',
  },
  'two-step': {
    name: 'Two-Step Mission',
    script: 'packages/mission-engine/live/run-two-step.ts',
    requiresApproval: false,
    observed: 'crashing',
    observedNote:
      'exit 1. Crashes at run-two-step.ts:169 TypeError: Cannot read properties of undefined (reading "evidence"). Pre-existing bug in the core mission script, not the bridge.',
  },
  filesystem: {
    name: 'Filesystem Mission',
    script: 'packages/mission-engine/live/run-filesystem.ts',
    requiresApproval: false,
    observed: 'crashing',
    observedNote:
      'exit 1. Crashes at run-filesystem.ts:168 TypeError: Cannot read properties of undefined (reading "outcome"). Pre-existing bug in the core mission script, not the bridge.',
  },
  approval: {
    name: 'Approval Gate Mission',
    script: 'packages/mission-engine/live/run-approval.ts',
    requiresApproval: true,
    observed: 'unverified',
    observedNote: 'Not launched through the bridge. Run it from a terminal with a human present.',
  },
'folder-summary': {
    name: 'Folder Summary (user-supplied paths)',
    script: 'packages/mission-engine/live/run-folder-summary.ts',
    requiresApproval: false,
    takesPaths: true,
    observed: 'new',
    observedNote:
      'Operates on a folder the user names and writes one new file to a folder the user names, ' +
      'under the exact file name requested. Never overwrites, never modifies the source, and ' +
      'refuses to execute at all if the planner would write anywhere other than the requested path.',
  },
};

/*
 * folder-summary is the one entry that takes caller-supplied OPERANDS rather than no operands.
 * It gets its own argv slot here, built from two validated strings. `buildArgv` is the ONLY place
 * a request value reaches spawn(), and it passes them as discrete argv entries after the script
 * path, so nothing can be smuggled in as an extra flag.
 */

/** Two absolute Windows paths, nothing else, validated here and again in the runner. */
function validatePathPair(source, output) {
  const bad = (m) => ({ ok: false, reason: m });

  if (typeof source !== 'string' || typeof output !== 'string') {
    return bad('"source" and "output" must both be strings');
  }
  if (source.length === 0 || output.length === 0) return bad('"source" and "output" must not be empty');
  if (source.length > 400 || output.length > 400) return bad('paths are too long');
  // Control characters cannot appear in a legitimate Windows path and would corrupt argv display.
  if (/[\x00-\x1f]/.test(source) || /[\x00-\x1f]/.test(output)) return bad('paths must not contain control characters');

  // Absolute, drive-lettered only. A UNC path or a relative path is refused rather than guessed at.
  const ABS = /^[A-Za-z]:[\\/]/;
  if (!ABS.test(source)) return bad(`"source" must be an absolute drive-lettered path, e.g. C:\\Users\\...`);
  if (!ABS.test(output)) return bad(`"output" must be an absolute drive-lettered path, e.g. C:\\Users\\...`);

  // No traversal. Checked on the RAW text so `..` cannot hide behind normalisation, and again
  // after resolution by the runner's own containment checks.
  for (const [label, p] of [['source', source], ['output', output]]) {
    if (p.split(/[\\/]/).some((seg) => seg === '..')) {
      return bad(`"${label}" must not contain ".." path traversal`);
    }
  }

  const srcAbs = path.resolve(source);
  const outAbs = path.resolve(output);
  const outDir = path.dirname(outAbs);

  // The output name is a bare file name. No separators (guaranteed by the traversal check above),
  // restricted characters so it cannot introduce a word into the objective the planner parses.
  const outName = path.basename(outAbs);
  if (!/^[A-Za-z0-9_-]+\.txt$/.test(outName)) {
    return bad(`the output file name "${outName}" must be letters, digits, "_" or "-", ending in .txt`);
  }

  if (!fs.existsSync(srcAbs)) return bad(`the source folder "${srcAbs}" does not exist`);
  if (!fs.statSync(srcAbs).isDirectory()) return bad(`"${srcAbs}" is a file, not a folder`);
  if (!fs.existsSync(outDir)) return bad(`the output folder "${outDir}" does not exist`);
  if (!fs.statSync(outDir).isDirectory()) return bad(`the output folder "${outDir}" is not a directory`);
  if (fs.existsSync(outAbs)) return bad(`"${outAbs}" already exists; this creates new files only and will not overwrite`);

  return { ok: true, source: srcAbs, output: outAbs, outputRoot: outDir, outputName: outName };
}

function buildArgv(entry, operands) {
  if (entry.takesPaths) {
    return [...NODE_ARGS, path.resolve(REPO_ROOT, entry.script), '--source', operands.source, '--output', operands.output];
  }
  return [...NODE_ARGS, path.resolve(REPO_ROOT, entry.script)];
}

/** Concatenated display string for the UI. Never parsed, never executed. */
function displayCommand(key, operands) {
  const m = ALLOWED_MISSIONS[key];
  if (!m) return null;
  if (m.takesPaths && operands) {
    return ['node', ...NODE_ARGS, m.script, '--source', operands.source, '--output', operands.output].join(' ');
  }
  return ['node', ...NODE_ARGS, m.script].join(' ');
}

/** Read the mission's own verification evidence out of its stdout. */
function readEvidence(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);

  const pass = lines.filter((l) => /^\s*PASS\b/.test(l));
  const fail = lines.filter((l) => /^\s*FAIL\b/.test(l));

  // Final "=== ... ===" banner line, e.g. "=== PASS ===" / "=== 2 FAILURE(S) ==="
  const banners = lines
    .map((l) => l.match(/^\s*=+\s*(.+?)\s*=+\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
  const banner = banners.length ? banners[banners.length - 1] : null;

  const complete = (stdout.match(/^\s*complete\s+true\s*$/m) || [])[0]
    ? 'true'
    : 'false';

  const missionState = (stdout.match(/^\s*mission state\s+(\S+)/m) || [])[1] || null;

  let verdict;
  if (fail.length > 0 || (banner && /FAIL/i.test(banner))) verdict = 'failed';
  else if (pass.length > 0 && banner && /^PASS$/i.test(banner)) verdict = 'verified';
  else verdict = 'indeterminate';

  return {
    verdict,
    passCount: pass.length,
    failCount: fail.length,
    banner,
    missionComplete: complete === 'true',
    missionState,
    samplePass: pass.slice(0, 12).map((l) => l.trim()),
    sampleFail: fail.slice(0, 12).map((l) => l.trim()),
  };
}

let inFlight = false;

function launchMission(key, operands) {
  const entry = ALLOWED_MISSIONS[key];
  const scriptAbs = path.resolve(REPO_ROOT, entry.script);

  if (!scriptAbs.startsWith(path.resolve(REPO_ROOT) + path.sep)) {
    return Promise.reject(new Error('script escapes repository root'));
  }
  if (!fs.existsSync(scriptAbs)) {
    return Promise.reject(new Error('mission script not found on disk: ' + entry.script));
  }

  return new Promise((resolve, reject) => {
    // argv array, shell:false -> no caller text can become a command
    const child = spawn(process.execPath, buildArgv(entry, operands), {
        cwd: REPO_ROOT,
        shell: false,
        windowsHide: true,
        env: { ...process.env, AIOS_LOCAL_MODEL_PORT: '8795' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`mission exceeded ${TIMEOUT_MS}ms and was terminated`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { if (stdout.length < 400000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 40000) stderr += d; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code === null ? -1 : code,
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
}

/*
 * A page loaded from file:// sends Origin: null. A page served from the local
 * bridge itself would send http://127.0.0.1:3000. Anything else -- i.e. a page
 * on the open web -- is refused. This is what stops a hostile web page from
 * driving this endpoint through the user's browser. Loopback binding alone does
 * NOT provide this protection.
 */
const ALLOWED_ORIGINS = new Set(['null', `http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

/* DNS-rebinding guard: the Host header must point back at our own loopback. */
function hostAllowed(req) {
  const h = String(req.headers['host'] || '').toLowerCase();
  return h === `${HOST}:${PORT}` || h === `localhost:${PORT}`;
}

function originAllowed(req) {
  const o = req.headers['origin'];
  if (o === undefined) return true;          // no Origin header (e.g. curl/Invoke-RestMethod)
  return ALLOWED_ORIGINS.has(String(o).toLowerCase());
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) return send(res, 421, { error: 'bad Host header' });
  if (!originAllowed(req)) return send(res, 403, { error: 'origin refused' });

  // Mission catalogue -- GET only, no side effects.
  if (req.method === 'GET' && req.url === '/missions') {
    const list = Object.entries(ALLOWED_MISSIONS).map(([key, m]) => ({
      key,
      name: m.name,
      script: m.script,
      command: displayCommand(key),
      launchable: !m.requiresApproval,
      observed: m.observed,
      observedNote: m.observedNote,
      takesPaths: !!m.takesPaths,
      outputNameRule: m.takesPaths
        ? 'any bare name of letters, digits, "_" or "-", ending in .txt'
        : null,
      blockedReason: m.requiresApproval
        ? 'approval-gated: must be run from a terminal by a human; the bridge will not launch it'
        : null,
    }));
    return send(res, 200, { missions: list, modelPlanning: 'disabled' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, pid: process.pid, inFlight });
  }

  if (req.method !== 'POST' || req.url !== '/run-mission') {
    return send(res, 404, { error: 'not found' });
  }

  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.includes('application/json')) {
    return send(res, 415, { error: 'Content-Type must be application/json' });
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'invalid JSON body: ' + e.message });
  }

  /*
   * Strict shape, two forms:
   *   {"mission":"<key>"}                              -- no operands
   *   {"mission":"folder-summary","source":..,"output":..}  -- exactly two paths
   * Any other key set is refused. Extra fields are refused rather than ignored, so a typo in a
   * field name is an error and not a silently-dropped instruction.
   */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return send(res, 400, { error: 'body must be a JSON object' });
  }

  const keys = Object.keys(parsed).sort();
  const entry = typeof parsed.mission === 'string' ? ALLOWED_MISSIONS[parsed.mission] : undefined;

  let operands = null;
  if (entry && entry.takesPaths) {
    const expected = ['mission', 'output', 'source'];
    if (keys.join(',') !== expected.join(',')) {
      return send(res, 400, {
        error: `folder-summary requires exactly {"mission","source","output"}. Received: {${keys.join(',')}}`,
      });
    }
    const v = validatePathPair(parsed.source, parsed.output);
    if (!v.ok) return send(res, 400, { error: v.reason });
    operands = v;
  } else if (keys.length !== 1 || typeof parsed.mission !== 'string') {
    return send(res, 400, {
      error: 'body must be exactly {"mission":"<key>"}. Arguments, paths and script names are not accepted.',
    });
  }

  const key = parsed.mission;

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_MISSIONS, key)) {
    return send(res, 400, { error: 'mission key is not on the allowlist', mission: key });
  }

  if (entry.requiresApproval) {
    return send(res, 403, {
      error: 'approval required',
      mission: key,
      detail:
        'This mission is approval-gated. The bridge does not hold the authority to approve it. ' +
        'Run it from a terminal: ' + displayCommand(key),
      exitCode: null,
      verdict: 'refused',
    });
  }

  if (inFlight) {
    return send(res, 409, { error: 'a mission is already running', mission: key });
  }

  inFlight = true;
  try {
    const r = await launchMission(key, operands);
    const evidence = readEvidence(r.stdout);

    // status is success ONLY when the process exited 0 AND the mission's own
    // evidence says verified. Exit 0 with no positive evidence -> indeterminate.
    let status;
    if (r.exitCode !== 0) status = 'failure';
    else if (evidence.verdict === 'verified') status = 'success';
    else if (evidence.verdict === 'failed') status = 'failure';
    else status = 'indeterminate';

    return send(res, 200, {
      mission: key,
      name: entry.name,
      command: displayCommand(key, operands),
      requestedSource: operands ? operands.source : undefined,
      requestedOutput: operands ? operands.output : undefined,
      status,
      exitCode: r.exitCode,
      signal: r.signal,
      evidence,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  } catch (e) {
    return send(res, 500, {
      mission: key,
      error: String(e && e.message ? e.message : e),
      status: 'failure',
      exitCode: null,
    });
  } finally {
    inFlight = false;
  }
});

/* Exported so the verdict logic can be unit-tested without starting a server. */
export { readEvidence, ALLOWED_MISSIONS, validatePathPair };

/* Only listen when run directly, not when imported by a test. */
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
server.listen(PORT, HOST, () => {
  const missing = Object.entries(ALLOWED_MISSIONS)
    .filter(([, m]) => !fs.existsSync(path.resolve(REPO_ROOT, m.script)))
    .map(([k, m]) => `${k} -> ${m.script}`);
  console.log(`AIOS bridge listening on http://${HOST}:${PORT}  (pid ${process.pid})`);
  console.log(`repository root: ${REPO_ROOT}`);
  console.log('launchable: ' + Object.keys(ALLOWED_MISSIONS).filter((k) => !ALLOWED_MISSIONS[k].requiresApproval).join(', '));
  console.log('approval-gated (never launched here): ' + Object.keys(ALLOWED_MISSIONS).filter((k) => ALLOWED_MISSIONS[k].requiresApproval).join(', '));
  if (missing.length) console.log('WARNING missing scripts: ' + missing.join('; '));
});

server.on('error', (e) => {
  console.error('bridge failed to start: ' + e.message);
  process.exit(2);
});
}