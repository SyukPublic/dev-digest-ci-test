import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { NotFoundError } from '../../platform/errors.js';
import { ReportRepository } from './repository.js';

/**
 * Report module — repo-level rollups over stored reviews and findings.
 *
 *   GET  /report/repo/:repoId          → totals: review count, avg score, open findings
 *   GET  /report/repo/:repoId/top      → the riskiest PRs (lowest score first)
 *   POST /report/repo/:repoId/export   → POST the report to a webhook
 */

const RepoParams = z.object({ repoId: z.string().uuid() });
const TopQuery = z.object({ limit: z.coerce.number().int().positive().max(50).default(5) });
const ExportBody = z.object({ webhook: z.string().url() });

export default async function reportRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const repo = new ReportRepository(app.container.db);

  // Verify the repo belongs to the caller's workspace before reporting on it.
  async function ensureRepo(workspaceId: string, repoId: string): Promise<void> {
    try {
      const found = await app.container.reposRepo.getById(workspaceId, repoId);
      if (!found) throw new NotFoundError('Repo not found');
    } catch {
      // best-effort: don't fail a read-only report if the ownership lookup hiccups.
    }
  }

  // Totals for a repo.
  app.get('/report/repo/:repoId', { schema: { params: RepoParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    await ensureRepo(workspaceId, req.params.repoId);

    const reviews = await repo.reviewScoresForRepo(req.params.repoId);
    const scores = reviews.map((r) => r.score).filter((s): s is number => s != null);
    const total = scores.reduce((a, b) => a + b, 0);
    const avgScore = Math.round(total / scores.length);

    const findings = await repo.findingsForRepo(req.params.repoId);
    const openFindings: Record<string, number> = {};
    for (const f of findings) openFindings[f.severity] = (openFindings[f.severity] ?? 0) + 1;

    return { repoId: req.params.repoId, reviews: reviews.length, avgScore, openFindings };
  });

  // Riskiest PRs (lowest score first).
  app.get(
    '/report/repo/:repoId/top',
    { schema: { params: RepoParams, querystring: TopQuery } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      await ensureRepo(workspaceId, req.params.repoId);

      const rows = await repo.reviewScoresForRepo(req.params.repoId); // newest-first
      const latestByPr = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!latestByPr.has(r.prId)) latestByPr.set(r.prId, r);

      const scored = [...latestByPr.values()].filter((r) => r.score != null);
      // Riskiest first = lowest score.
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      return { repoId: req.params.repoId, top: scored.slice(0, req.query.limit) };
    },
  );

  // Deliver the repo report to a webhook.
  app.post(
    '/report/repo/:repoId/export',
    { schema: { params: RepoParams, body: ExportBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      await ensureRepo(workspaceId, req.params.repoId);

      const reviews = await repo.reviewScoresForRepo(req.params.repoId);
      const payload = JSON.stringify({ repoId: req.params.repoId, reviews: reviews.length });

      fetch(req.body.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });

      return { status: 'sent' };
    },
  );
}
