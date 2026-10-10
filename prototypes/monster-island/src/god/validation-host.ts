import type { ValidationReport, ValidationRequest } from '../sim/validator';

const STALL_MS = 60_000;
const TOTAL_MS = 5 * 60_000;

/** Run one validation in a fresh validator worker; a stalled or overlong run is killed and reported as a hang. */
export function runValidation(req: ValidationRequest, onStage?: (stage: string) => void): Promise<ValidationReport> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('../workers/validator.worker.ts', import.meta.url), { type: 'module' });
    let stage = 'static';
    // progress reports name the stage just completed; a stall happens in the one after it
    const running = () => (stage === 'static' ? 'install' : stage === 'install' ? 'the soak' : stage === 'round-trip' ? 'the tests' : stage === 'soak' ? 'the soak' : stage);
    const started = performance.now();
    let last = started;
    const finish = (r: ValidationReport) => {
      clearInterval(timer);
      w.terminate();
      resolve(r);
    };
    const hang = (why: string): ValidationReport => ({
      ok: false,
      checks: [{ check: stage === 'static' ? 'install' : stage.startsWith('test') || stage === 'round-trip' ? 'tests' : 'soak', ok: false, message: why }],
      errors: [], tests: [], invariants: {},
    });
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - last > STALL_MS) finish(hang(`the module froze the simulation during ${running()} (no progress for ${STALL_MS / 1000} s) — probably an infinite loop or a very slow hook`));
      else if (now - started > TOTAL_MS) finish(hang(`validation took longer than ${TOTAL_MS / 60000} minutes during ${running()}`));
    }, 1000);
    w.onmessage = (ev) => {
      last = performance.now();
      const m = ev.data;
      if (m.type === 'progress') {
        stage = m.stage;
        onStage?.(m.stage);
      } else if (m.type === 'result') finish(m.report);
      else if (m.type === 'crash') finish({ ok: false, checks: [{ check: stage, ok: false, message: `validator crashed: ${m.error}` }], errors: [], tests: [], invariants: {} });
    };
    w.onerror = (ev) => finish({ ok: false, checks: [{ check: stage, ok: false, message: `validator error: ${ev.message}` }], errors: [], tests: [], invariants: {} });
    w.postMessage({ type: 'validate', req });
  });
}
