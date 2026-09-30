import { Router, pageParams } from './http.js';
import { RunService } from '../core/service.js';
import { validatePid, validatePlant, validateRunInput } from '../core/validation.js';
import { validation } from '../core/errors.js';

export function registerRoutes(router: Router, svc: RunService): void {
  router.add('GET', '/health', () => ({ ok: true }));

  // --- versioned plants ---
  router.add('POST', '/plants/:name', (ctx) => {
    const config = validatePlant(ctx.body);
    return svc.createPlant(ctx.params.name!, config);
  });
  router.add('GET', '/plants', () => ({ items: svc.repo.listPlants() }));
  router.add('GET', '/plants/:name', (ctx) => {
    const v = ctx.query.get('version');
    return svc.repo.getPlant(ctx.params.name!, v ? Number(v) : undefined);
  });

  // --- versioned controllers ---
  router.add('POST', '/controllers/:name', (ctx) => {
    const config = validatePid(ctx.body);
    const note = typeof ctx.body?.note === 'string' ? ctx.body.note : '';
    return svc.createController(ctx.params.name!, config, note);
  });
  router.add('GET', '/controllers', () => ({ items: svc.repo.listControllers() }));
  router.add('GET', '/controllers/:name', (ctx) => {
    const v = ctx.query.get('version');
    return svc.repo.getController(ctx.params.name!, v ? Number(v) : undefined);
  });

  // --- runs ---
  router.add('POST', '/runs', (ctx) => {
    const input = validateRunInput(ctx.body);
    const { run, created } = svc.createRun(input);
    return { created, run: presentRun(run.id, run.state, run.status, run.failureReason) };
  });

  router.add('GET', '/runs', (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    const page = svc.repo.listRuns(limit, offset);
    return {
      ...page,
      items: page.items.map((r) =>
        presentRun(r.id, r.state, r.status, r.failureReason),
      ),
    };
  });

  router.add('GET', '/runs/:id', (ctx) => {
    const r = svc.repo.getRun(ctx.params.id!);
    return { run: presentRun(r.id, r.state, r.status, r.failureReason), config: r.config };
  });

  router.add('POST', '/runs/:id/advance', (ctx) => {
    const n = Number(ctx.body?.n ?? 1);
    const r = svc.advance(ctx.params.id!, n);
    return { run: presentRun(r.id, r.state, r.status, r.failureReason) };
  });

  router.add('POST', '/runs/:id/pause', (ctx) => {
    const r = svc.pause(ctx.params.id!);
    return { run: presentRun(r.id, r.state, r.status, r.failureReason) };
  });

  router.add('POST', '/runs/:id/resume', (ctx) => {
    const r = svc.resume(ctx.params.id!);
    return { run: presentRun(r.id, r.state, r.status, r.failureReason) };
  });

  router.add('GET', '/runs/:id/report', (ctx) => svc.report(ctx.params.id!));

  router.add('GET', '/runs/:id/samples', (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return svc.repo.getSamples(ctx.params.id!, limit, offset);
  });

  router.add('GET', '/runs/:id/ops', (ctx) => {
    const { limit, offset } = pageParams(ctx.query);
    return svc.repo.listOps(ctx.params.id!, limit, offset);
  });

  // --- multi-PID comparison on one scenario ---
  router.add('POST', '/compare', (ctx) => {
    const b = ctx.body ?? {};
    const key = typeof b.scenarioKey === 'string' && b.scenarioKey.trim()
      ? b.scenarioKey.trim()
      : validation('scenarioKey required');
    const validated = validateRunInput({
      plant: b.plant,
      pid: { kp: 0, ki: 0, kd: 0, tf: 0, antiWindup: 'freeze', kaw: 1 },
      setpoint: b.setpoint ?? 0,
      y0: b.y0 ?? 0,
      maxSamples: b.maxSamples ?? 500,
      settlingFraction: b.settlingFraction ?? 0.05,
      events: b.events ?? [],
      idempotencyKey: `compare-scenario-${key}`,
    });
    const scenario = {
      plant: validated.plant,
      setpoint: validated.setpoint,
      y0: validated.y0,
      maxSamples: validated.maxSamples,
      settlingFraction: validated.settlingFraction,
      events: validated.events,
    };
    if (!Array.isArray(b.candidates) || b.candidates.length === 0) {
      validation('candidates must be a non-empty array');
    }
    const candidates = b.candidates.map((c: any, i: number) => {
      if (!c?.name) validation(`candidates[${i}].name required`);
      return { name: String(c.name), pid: validatePid(c.pid) };
    });
    return { results: svc.compare(scenario, key, candidates) };
  });
}

function presentRun(id: string, state: any, status: string, failureReason: string | null) {
  return {
    id,
    status,
    failureReason,
    k: state.k,
    sp: state.sp,
    y: state.y,
    load: state.load,
    uCommand: state.uCommand,
    uApplied: state.uApplied,
    pid: {
      pTerm: state.pid.pTerm,
      iTerm: state.pid.iTerm,
      dTerm: state.pid.dTerm,
      integral: state.pid.integral,
      vUnsat: state.pid.vUnsat,
    },
  };
}
