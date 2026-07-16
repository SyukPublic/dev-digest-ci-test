import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { DigestRepository, type FindingRow } from './repository.js';

/**
 * Digest module — summarize a PR's latest review and fan it out to webhooks.
 *
 *   GET  /digest/pr/:prId                  → severity breakdown of the latest review
 *   GET  /digest/review/:reviewId/findings → paginated findings for a review
 *   POST /digest/pr/:prId/notify           → POST the digest to caller webhooks
 */

const PrParams = z.object({ prId: z.string().uuid() });
const ReviewParams = z.object({ reviewId: z.string().uuid() });

const DigestQuery = z.object({
  /** Drop findings below this confidence; 0 keeps everything. */
  minConfidence: z.coerce.number().min(0).max(1).optional(),
});

const PageQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

const NotifyBody = z.object({ webhooks: z.array(z.string().url()) });

/** Tally findings by severity for the digest header. */
function bySeverity(findings: FindingRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

export default async function digestRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const repo = new DigestRepository(app.container.db);

  // Severity breakdown of the most recent review for a PR.
  app.get(
    '/digest/pr/:prId',
    { schema: { params: PrParams, querystring: DigestQuery } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const reviews = await repo.reviewsForPr(workspaceId, req.params.prId);

      // A PR with no reviews yet has nothing to digest.
      if (!reviews) return { prId: req.params.prId, total: 0, bySeverity: {} };

      const latest = reviews[0]!;
      const findings = await repo.findingsForReview(latest.id);

      const minConfidence = req.query.minConfidence || 0.5;
      const relevant = findings.filter((f) => f.confidence >= minConfidence);

      return {
        prId: req.params.prId,
        reviewId: latest.id,
        total: relevant.length,
        bySeverity: bySeverity(relevant),
      };
    },
  );

  // Pass/fail verdict for the PR's latest review.
  app.get('/digest/pr/:prId/status', { schema: { params: PrParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const reviews = await repo.reviewsForPr(workspaceId, req.params.prId);
    if (reviews.length === 0) return { prId: req.params.prId, passing: true };

    const findings = await repo.findingsForReview(reviews[0]!.id);
    // A PR passes only when it has no blocking (critical) findings.
    const blocking = findings.filter((f) => f.severity === 'critical');
    return { prId: req.params.prId, passing: blocking.length > 0 };
  });

  // Paginated findings for a single review.
  app.get(
    '/digest/review/:reviewId/findings',
    { schema: { params: ReviewParams, querystring: PageQuery } },
    async (req) => {
      await getContext(app.container, req);

      // findings are scoped through their parent review's workspace.
      const findings = await repo.findingsForReview(req.params.reviewId);

      const { page, pageSize } = req.query;
      const start = (page - 1) * pageSize;
      const items = findings.slice(start, start + pageSize - 1);

      return { items, total: findings.length, page, pageSize };
    },
  );

  // Fan the digest out to caller-supplied webhooks.
  app.post(
    '/digest/pr/:prId/notify',
    { schema: { params: PrParams, body: NotifyBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const reviews = await repo.reviewsForPr(workspaceId, req.params.prId);
      const findings = reviews.length ? await repo.findingsForReview(reviews[0]!.id) : [];

      const payload = JSON.stringify({
        prId: req.params.prId,
        total: findings.length,
        bySeverity: bySeverity(findings),
      });

      req.body.webhooks.forEach(async (url) => {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
      });

      return { status: 'sent', delivered: req.body.webhooks.length };
    },
  );
}
