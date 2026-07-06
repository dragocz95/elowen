// Security-scan plugin: a static pattern scanner for risky code. Zero dependencies — pure regex
// heuristics. It classifies findings as
// "danger" (likely exploitable / RCE) or "warn" (worth a look), so the model can review its own or
// fetched code before trusting it. Advisory only: it reads, it never runs anything.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync } from 'node:fs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Each rule: id, severity, human message, and a matcher. Kept deliberately conservative to limit
 *  false positives — this is a nudge for review, not a gate. */
const RULES = [
  { id: 'py-eval', sev: 'danger', re: /\beval\s*\(/, msg: 'eval() executes arbitrary code' },
  { id: 'py-exec', sev: 'danger', re: /\bexec\s*\(/, msg: 'exec() executes arbitrary code' },
  { id: 'pickle', sev: 'danger', re: /\bpickle\.(load|loads)\s*\(/, msg: 'pickle.load on untrusted data is RCE' },
  { id: 'yaml-load', sev: 'danger', re: /\byaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)/, msg: 'yaml.load without SafeLoader is unsafe — use yaml.safe_load' },
  { id: 'torch-load', sev: 'danger', re: /\btorch\.load\s*\((?![^)]*weights_only\s*=\s*True)/, msg: 'torch.load without weights_only=True can execute code' },
  { id: 'shell-true', sev: 'danger', re: /subprocess\.\w+\([^)]*shell\s*=\s*True/, msg: 'subprocess(shell=True) risks shell injection' },
  { id: 'os-system', sev: 'danger', re: /\bos\.system\s*\(/, msg: 'os.system passes a raw string to the shell' },
  { id: 'js-eval', sev: 'danger', re: /\beval\s*\(|new\s+Function\s*\(/, msg: 'eval / new Function executes arbitrary code' },
  { id: 'child-exec', sev: 'danger', re: /child_process\.(exec|execSync)\s*\(/, msg: 'child_process.exec runs through a shell — prefer execFile' },
  { id: 'curl-sh', sev: 'danger', re: /curl\s+[^\n|]*\|\s*(sudo\s+)?(ba)?sh/, msg: 'piping curl straight into a shell runs remote code unverified' },
  { id: 'rm-rf', sev: 'warn', re: /\brm\s+-rf?\s+([/~]|\$)/, msg: 'rm -rf on an absolute/expanded path is destructive' },
  { id: 'secret', sev: 'warn', re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i, msg: 'looks like a hardcoded secret' },
  { id: 'aws-key', sev: 'danger', re: /AKIA[0-9A-Z]{16}/, msg: 'hardcoded AWS access key id' },
  { id: 'private-key', sev: 'danger', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, msg: 'embedded private key' },
  { id: 'md5-hash', sev: 'warn', re: /\b(hashlib\.md5|createHash\(["']md5)/, msg: 'MD5 is broken for security use' },
];

/** Scan source text; returns findings with 1-based line numbers. */
export function scan(source) {
  const lines = source.split('\n');
  const findings = [];
  lines.forEach((line, i) => {
    if (/^\s*(#|\/\/|\*)/.test(line)) return; // skip obvious comment lines to cut noise
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push({ line: i + 1, id: rule.id, sev: rule.sev, msg: rule.msg, text: line.trim().slice(0, 120) });
    }
  });
  return findings;
}

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'scan_code', label: 'Scan code for risks',
    description: 'Statically scan code for dangerous patterns (eval, pickle.load, shell=True, hardcoded '
      + 'secrets, unsafe deserialization…). Provide code directly or a repo file path. Advisory only.',
    parameters: Type.Object({
      code: Type.Optional(Type.String({ description: 'Source code to scan' })),
      path: Type.Optional(Type.String({ description: 'A repo file within your accessible repositories' })),
    }),
    execute: async (_id, p) => {
      try {
        let source = p.code;
        if (!source && p.path) source = readFileSync(ctx.assertPathAllowed(p.path), 'utf-8');
        if (!source) return ok('Error: provide code or a repo file path.');
        const findings = scan(source);
        if (findings.length === 0) return ok('✅ No risky patterns found.');
        const danger = findings.filter((f) => f.sev === 'danger');
        const head = `Found ${findings.length} finding(s) — ${danger.length} danger, ${findings.length - danger.length} warning:`;
        const body = findings.map((f) => `${f.sev === 'danger' ? '🔴' : '🟡'} line ${f.line} [${f.id}] ${f.msg}\n    ${f.text}`).join('\n');
        return ok(`${head}\n${body}`);
      } catch (e) { return fail(e); }
    },
  }));
  ctx.logger.info('security-scan registered (scan_code)');
}
