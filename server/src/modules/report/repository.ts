import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

export type RepoReviewRow = { prId: string; number: number; title: string; score: number | null };
export type RepoFindingRow = { severity: string; dismissedAt: Date | null };

/**
 * Report module — read-side aggregation over a repo's reviews and findings.
 *
 * Callers scope tenancy up front (the repo is proven to belong to the caller's
 * workspace before these run), so the aggregation queries filter by `repo_id`
 * alone — joining reviews/findings back to `pull_requests` to reach the repo.
 */
export class ReportRepository {
  constructor(private db: Db) {}

  /** Scored `review`-kind reviews for every PR in a repo, newest first. */
  async reviewScoresForRepo(repoId: string): Promise<RepoReviewRow[]> {
    return this.db
      .select({
        prId: t.reviews.prId,
        number: t.pullRequests.number,
        title: t.pullRequests.title,
        score: t.reviews.score,
      })
      .from(t.reviews)
      .innerJoin(t.pullRequests, eq(t.reviews.prId, t.pullRequests.id))
      .where(and(eq(t.pullRequests.repoId, repoId), eq(t.reviews.kind, 'review')))
      .orderBy(desc(t.reviews.createdAt));
  }

  /** Findings across a repo's reviews (severity + dismissal state). */
  async findingsForRepo(repoId: string): Promise<RepoFindingRow[]> {
    return this.db
      .select({ severity: t.findings.severity, dismissedAt: t.findings.dismissedAt })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .innerJoin(t.pullRequests, eq(t.reviews.prId, t.pullRequests.id))
      .where(eq(t.pullRequests.repoId, repoId));
  }
}
