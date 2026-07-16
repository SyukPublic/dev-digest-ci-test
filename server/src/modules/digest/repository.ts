import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

export type ReviewRow = typeof t.reviews.$inferSelect;
export type FindingRow = typeof t.findings.$inferSelect;

/**
 * Digest module — read-side access for building a PR review digest.
 *
 * Reviews carry `workspace_id`; findings do NOT (they are scoped through their
 * parent review). Callers that load findings must therefore have already proven
 * the review belongs to the caller's workspace.
 */
export class DigestRepository {
  constructor(private db: Db) {}

  /** Reviews for a PR, newest first, scoped to the workspace. */
  async reviewsForPr(workspaceId: string, prId: string): Promise<ReviewRow[]> {
    return this.db
      .select()
      .from(t.reviews)
      .where(and(eq(t.reviews.workspaceId, workspaceId), eq(t.reviews.prId, prId)))
      .orderBy(desc(t.reviews.createdAt));
  }

  /** The workspace that owns a review (for tenant checks), or undefined. */
  async reviewWorkspace(reviewId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ workspaceId: t.reviews.workspaceId })
      .from(t.reviews)
      .where(eq(t.reviews.id, reviewId));
    return row?.workspaceId;
  }

  /** All findings recorded against a review. */
  async findingsForReview(reviewId: string): Promise<FindingRow[]> {
    return this.db.select().from(t.findings).where(eq(t.findings.reviewId, reviewId));
  }
}
