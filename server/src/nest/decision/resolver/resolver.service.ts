import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type {
  DecisionExplanation,
  DecisionSession,
  DecisionTravelEstimate,
  RecommendationResult,
  RecommendationRun,
} from '@trek/shared';
import { DatabaseService } from '../../database/database.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { TravelMatrixService } from '../travel/travel-matrix.service';
import { DecisionService } from '../decision.service';
import { NotFoundError, ValidationError } from '../../common/domain-errors';
import { evaluateConstraints } from './constraint-engine';
import { computeFairness } from './fairness-engine';
import { scoreCandidate, RESOLVER_V1_STRATEGY } from './ranking-engine';
import { explainCandidate } from './explanation-engine';
import type { ParticipantContext } from './resolver.types';

/** Resolvable session states — the host can resolve and re-resolve after edits. */
const RESOLVABLE: ReadonlySet<string> = new Set(['collecting', 'ready', 'resolved', 'selected']);

/**
 * The deterministic, versioned resolver (spec §14): constraints → travel
 * matrix → fairness → ranking → Top 3 → structured explanation. Persists a
 * recommendation_run + per-candidate score rows so every answer is
 * reproducible evidence; strategy_version pins the algorithm that produced it.
 */
@Injectable()
export class DecisionResolverService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
    private readonly decisions: DecisionService,
    private readonly matrix: TravelMatrixService,
  ) {}

  /**
   * POST /resolve: run the pipeline, persist the run, flip the session to
   * 'resolved', and notify the trip room with a content-free ready event —
   * clients refetch recommendations.
   */
  async resolve(sessionId: number): Promise<RecommendationResult> {
    const session = this.decisions.getSession(sessionId);
    if (!session) throw new NotFoundError('Decision not found');
    if (!RESOLVABLE.has(session.status)) {
      throw new ValidationError(`Decision is ${session.status} — cannot resolve`);
    }
    const participants = this.loadParticipantContexts(sessionId);
    const candidates = this.decisions.listCandidates(sessionId);
    if (candidates.length === 0) throw new ValidationError('No candidates to rank');
    if (participants.length === 0) throw new ValidationError('No participants joined');

    // Resolve happens inside 'resolving' so a watcher sees the transition.
    this.setStatus(session, 'resolving');
    const estimates = await this.matrix.computeSessionMatrix(sessionId, session.travel_mode, true);

    const inputHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          v: RESOLVER_V1_STRATEGY,
          participants: participants.map((p) => ({
            id: p.participant.id,
            o: [p.participant.origin_lat, p.participant.origin_lng],
            m: p.participant.max_travel_minutes,
            b: [p.participant.budget_min, p.participant.budget_max],
            prefs: p.preferences,
            dbs: p.dealBreakers,
          })),
          candidates: candidates.map((c) => [c.id, c.snapshot]),
          estimates: estimates.map((e) => [e.participant_id, e.candidate_id, e.travel_mode, e.duration_seconds, e.status]),
        }),
      )
      .digest('hex');

    const runId = this.db.transaction((conn) => {
      const res = conn
        .prepare(
          "INSERT INTO recommendation_runs (decision_session_id, strategy_version, status, input_hash) VALUES (?, ?, 'running', ?)",
        )
        .run(sessionId, RESOLVER_V1_STRATEGY, inputHash);
      return Number(res.lastInsertRowid);
    });

    const byCandidate = new Map<number, Map<number, DecisionTravelEstimate | null>>();
    for (const c of candidates) byCandidate.set(c.id, new Map());
    for (const e of estimates) byCandidate.get(e.candidate_id)?.set(e.participant_id, e);

    const evaluated: {
      candidate: (typeof candidates)[number];
      est: Map<number, DecisionTravelEstimate | null>;
      constraint: ReturnType<typeof evaluateConstraints>;
      fairness: ReturnType<typeof computeFairness>;
      scores: ReturnType<typeof scoreCandidate>;
      explanation?: DecisionExplanation;
      rank?: number;
    }[] = candidates.map((candidate) => {
      const est = byCandidate.get(candidate.id)!;
      const constraint = evaluateConstraints({ candidate, session, participants, estimateByParticipant: est });
      const fairness = computeFairness({ participants, estimateByParticipant: est });
      const scores = scoreCandidate({ candidate, participants, fairnessScore: fairness.score });
      return { candidate, est, constraint, fairness, scores };
    });

    // Rank: eligible first by total score, then ineligible (kept for the
    // "why not" story). Ranks are 1-based across the whole candidate set.
    const ranked = [...evaluated].sort((a, b) => {
      if (a.constraint.eligible !== b.constraint.eligible) return a.constraint.eligible ? -1 : 1;
      return b.scores.totalScore - a.scores.totalScore;
    });
    ranked.forEach((e, i) => {
      const rank = i + 1;
      const explanation = explainCandidate({
        candidate: e.candidate,
        participants,
        estimateByParticipant: e.est,
        metrics: e.fairness.metrics,
        unknowns: e.constraint.unknowns,
        scores: e.scores,
      });
      e.explanation = explanation;
      e.rank = rank;
    });

    this.db.transaction((conn) => {
      const ins = conn.prepare(
        `INSERT INTO recommendation_scores
           (recommendation_run_id, candidate_id, eligible, constraint_result_json,
            place_fit, group_fit, travel_fairness, context_fit, trust_score, total_score, rank, explanation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of ranked) {
        ins.run(
          runId,
          e.candidate.id,
          e.constraint.eligible ? 1 : 0,
          JSON.stringify({ eligible: e.constraint.eligible, violations: e.constraint.violations, unknowns: e.constraint.unknowns }),
          e.scores.placeFit,
          e.scores.groupFit,
          e.scores.travelFairness,
          e.scores.contextFit,
          e.scores.trustScore,
          e.scores.totalScore,
          e.rank,
          JSON.stringify(e.explanation),
        );
      }
      conn
        .prepare("UPDATE recommendation_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(runId);
      conn
        .prepare("UPDATE decision_sessions SET status = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(sessionId);
    });

    this.setStatus({ ...session, status: 'resolved' }, 'resolved');
    this.realtime.broadcast(String(session.trip_id), 'decision:recommendation-ready', {
      decisionSessionId: sessionId,
      runId,
    });
    return this.latestResult(sessionId)!;
  }

  /** The latest completed run with its ranked items (Top 3 first). */
  latestResult(sessionId: number): RecommendationResult | undefined {
    const run = this.db.get<RecommendationRun>(
      "SELECT * FROM recommendation_runs WHERE decision_session_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      sessionId,
    );
    if (!run) return undefined;
    const items = this.db
      .all<Record<string, unknown>>(
        `SELECT rs.*, dc.snapshot_json AS _snap, dc.place_id AS _place, dc.source AS _source,
                dc.added_by_type AS _abt, dc.added_by_id AS _abi, dc.created_at AS _ccreated,
                dc.decision_session_id AS _dsid
           FROM recommendation_scores rs
           JOIN decision_candidates dc ON dc.id = rs.candidate_id
          WHERE rs.recommendation_run_id = ? ORDER BY rs.rank`,
        run.id,
      )
      .map((r) => ({
        id: r.id,
        recommendation_run_id: r.recommendation_run_id,
        candidate_id: r.candidate_id,
        eligible: Boolean(r.eligible),
        constraint_result: typeof r.constraint_result_json === 'string' ? JSON.parse(r.constraint_result_json) : null,
        place_fit: r.place_fit,
        group_fit: r.group_fit,
        travel_fairness: r.travel_fairness,
        context_fit: r.context_fit,
        trust_score: r.trust_score,
        total_score: r.total_score,
        rank: r.rank,
        explanation: typeof r.explanation_json === 'string' ? JSON.parse(r.explanation_json) : null,
        candidate: {
          id: r.candidate_id,
          decision_session_id: r._dsid,
          place_id: r._place,
          source: r._source,
          added_by_type: r._abt,
          added_by_id: r._abi,
          snapshot: typeof r._snap === 'string' ? JSON.parse(r._snap) : null,
          created_at: r._ccreated,
        },
      })) as RecommendationResult['items'];
    return { run, items };
  }

  /** The session's participants with their preferences + deal-breakers loaded. */
  private loadParticipantContexts(sessionId: number): ParticipantContext[] {
    const participants = this.db.all<Record<string, unknown>>(
      'SELECT * FROM decision_participants WHERE decision_session_id = ? ORDER BY created_at',
      sessionId,
    ) as unknown as ParticipantContext['participant'][];
    const prefStmt = this.db.prepare(
      'SELECT * FROM decision_preferences WHERE participant_id = ? ORDER BY id',
    );
    const dbStmt = this.db.prepare(
      'SELECT * FROM decision_constraints WHERE participant_id = ? ORDER BY id',
    );
    return participants.map((participant) => ({
      participant,
      preferences: (prefStmt.all(participant.id) as Record<string, unknown>[]).map(
        (r) => ({ ...r, is_hard: Boolean(r.is_hard) }) as ParticipantContext['preferences'][number],
      ),
      dealBreakers: (dbStmt.all(participant.id) as Record<string, unknown>[]).map(
        (r) =>
          ({
            ...r,
            value: typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json,
            is_hard: Boolean(r.is_hard),
          }) as ParticipantContext['dealBreakers'][number],
      ),
    }));
  }

  /** Transition helper: persist + broadcast the new status. */
  private setStatus(session: DecisionSession, status: DecisionSession['status']): void {
    this.db.run('UPDATE decision_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', status, session.id);
    this.realtime.broadcast(String(session.trip_id), 'decision:status-updated', {
      decisionSessionId: session.id,
      status,
    });
  }
}
