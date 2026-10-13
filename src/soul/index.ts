import * as crypto from 'crypto';
import * as path from 'path';
import { BodyHarness } from '../body';
import {
  ConsensusModelId,
  ConsensusVote,
  MutationProposal,
  QuorumDecision,
  SandboxExecutionResult,
  SwarmEventType,
  SwarmSoulEvent,
} from '../types';

export interface SwarmSoulOptions {
  logRelativePath?: string;
  quorumThreshold?: number;
  voters?: ConsensusModelId[];
}

export interface VoterReviewer {
  review(
    voterId: ConsensusModelId,
    proposal: MutationProposal,
    sandboxResult: SandboxExecutionResult
  ): Promise<ConsensusVote>;
}

/**
 * The Soul (The Consensus Layer)
 * Implements the hash-chained Swarm-Soul append-only Event Log and multi-model
 * quorum consensus mechanism for reviewing, voting on, and merging mutations.
 */
export class SwarmSoul {
  private readonly body: BodyHarness;
  private readonly logRelativePath: string;
  private readonly quorumThreshold: number;
  private readonly voters: ConsensusModelId[];
  private events: SwarmSoulEvent[] = [];

  constructor(body: BodyHarness, options: SwarmSoulOptions = {}) {
    this.body = body;
    this.logRelativePath =
      options.logRelativePath ?? path.join('.swarm-soul', 'event-log.jsonl');
    this.quorumThreshold = options.quorumThreshold ?? 0.67;
    this.voters = options.voters ?? [
      'gpt-4o',
      'claude-3.5-sonnet',
      'llama-3-70b',
    ];
  }

  /**
   * Loads existing hash-chained events from the persistent JSONL event log if present.
   */
  public async initialize(): Promise<void> {
    if (await this.body.exists(this.logRelativePath)) {
      const content = await this.body.readFile(this.logRelativePath);
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      this.events = lines.map((l) => JSON.parse(l) as SwarmSoulEvent);
    } else {
      this.events = [];
    }
  }

  /**
   * Appends a cryptographically hash-chained event to the Swarm-Soul log.
   */
  public async appendEvent<TPayload>(
    type: SwarmEventType,
    actor: string,
    payload: TPayload
  ): Promise<SwarmSoulEvent<TPayload>> {
    const index = this.events.length;
    const previousHash =
      index > 0 ? this.events[index - 1].hash : '0'.repeat(64);
    const timestamp = new Date().toISOString();
    const id = `evt-${index + 1}-${crypto.randomBytes(4).toString('hex')}`;

    const serializedPayload = JSON.stringify(payload);
    const hash = crypto
      .createHash('sha256')
      .update(`${index}:${id}:${timestamp}:${type}:${actor}:${previousHash}:${serializedPayload}`)
      .digest('hex');

    const event: SwarmSoulEvent<TPayload> = {
      index,
      id,
      timestamp,
      type,
      actor,
      previousHash,
      hash,
      payload,
    };

    this.events.push(event);
    const serializedLine = JSON.stringify(event) + '\n';
    const existing = (await this.body.exists(this.logRelativePath))
      ? await this.body.readFile(this.logRelativePath)
      : '';
    await this.body.writeFile(this.logRelativePath, existing + serializedLine);

    return event;
  }

  /**
   * Verifies the cryptographic integrity of the entire Swarm-Soul event chain.
   */
  public verifyChainIntegrity(): { valid: boolean; brokenAtIndex?: number } {
    for (let i = 0; i < this.events.length; i++) {
      const evt = this.events[i];
      const expectedPrev = i === 0 ? '0'.repeat(64) : this.events[i - 1].hash;
      if (evt.previousHash !== expectedPrev) {
        return { valid: false, brokenAtIndex: i };
      }

      const recomputed = crypto
        .createHash('sha256')
        .update(
          `${evt.index}:${evt.id}:${evt.timestamp}:${evt.type}:${evt.actor}:${
            evt.previousHash
          }:${JSON.stringify(evt.payload)}`
        )
        .digest('hex');

      if (evt.hash !== recomputed) {
        return { valid: false, brokenAtIndex: i };
      }
    }
    return { valid: true };
  }

  /**
   * Conducts a multi-instance Swarm review of a MutationProposal and its Purgatory Sandbox results.
   */
  public async deliberate(
    proposal: MutationProposal,
    sandboxResult: SandboxExecutionResult,
    customReviewer?: VoterReviewer
  ): Promise<QuorumDecision> {
    const votes: ConsensusVote[] = [];

    for (const voterId of this.voters) {
      const vote = customReviewer
        ? await customReviewer.review(voterId, proposal, sandboxResult)
        : this.evaluateWithDefaultMind(voterId, proposal, sandboxResult);

      votes.push(vote);
      await this.appendEvent('VOTE_CAST', voterId, vote);
    }

    const totalVotes = votes.length;
    const approvals = votes.filter((v) => v.approve).length;
    const rejections = totalVotes - approvals;

    const totalConfidence = votes.reduce((sum, v) => sum + v.confidence, 0);
    const approvedConfidence = votes
      .filter((v) => v.approve)
      .reduce((sum, v) => sum + v.confidence, 0);

    const weightedApprovalRatio =
      totalConfidence > 0
        ? Math.round((approvedConfidence / totalConfidence) * 1000) / 1000
        : 0;

    const approved =
      sandboxResult.appliedCleanly &&
      sandboxResult.compiledCleanly &&
      sandboxResult.testsPassed &&
      weightedApprovalRatio >= this.quorumThreshold;

    const decision: QuorumDecision = {
      proposalId: proposal.id,
      approved,
      totalVotes,
      approvals,
      rejections,
      weightedApprovalRatio,
      quorumThreshold: this.quorumThreshold,
      votes,
      decidedAt: new Date().toISOString(),
    };

    await this.appendEvent('QUORUM_REACHED', 'swarm-soul-arbiter', decision);
    return decision;
  }

  /**
   * Merges an approved MutationProposal into the Prime Body if and only if quorum is met.
   */
  public async mergeIfApproved(
    proposal: MutationProposal,
    decision: QuorumDecision
  ): Promise<{ merged: boolean; message: string }> {
    if (!decision.approved) {
      await this.appendEvent('MUTATION_REJECTED', 'swarm-soul-arbiter', {
        proposalId: proposal.id,
        weightedApprovalRatio: decision.weightedApprovalRatio,
        quorumThreshold: decision.quorumThreshold,
      });
      return {
        merged: false,
        message: `Mutation ${proposal.id} rejected by Swarm-Soul (approval ratio ${decision.weightedApprovalRatio} < ${decision.quorumThreshold}).`,
      };
    }

    const tmpPatch = `.swarm-soul/${proposal.id}.patch`;
    await this.body.writeFile(tmpPatch, proposal.diff);
    const applyRes = await this.body.execCommand('git', [
      'apply',
      '--whitespace=nowarn',
      this.body.resolveSafePath(tmpPatch),
    ]);
    await this.body.deleteFile(tmpPatch).catch(() => {});

    if (applyRes.exitCode !== 0) {
      return {
        merged: false,
        message: `Failed to apply approved diff to Prime Body: ${applyRes.stderr}`,
      };
    }

    await this.appendEvent('MUTATION_MERGED', 'swarm-soul-arbiter', {
      proposalId: proposal.id,
      targetFiles: proposal.targetFiles,
      weightedApprovalRatio: decision.weightedApprovalRatio,
    });

    return {
      merged: true,
      message: `Mutation ${proposal.id} merged into Prime Body with quorum ${decision.weightedApprovalRatio}.`,
    };
  }

  /**
   * Returns a shallow copy of all recorded Swarm-Soul events.
   */
  public getEvents(): SwarmSoulEvent[] {
    return [...this.events];
  }

  private evaluateWithDefaultMind(
    voterId: ConsensusModelId,
    proposal: MutationProposal,
    sandboxResult: SandboxExecutionResult
  ): ConsensusVote {
    const diffHasChanges = proposal.diff.trim().length > 0;
    const sandboxHealthy =
      sandboxResult.appliedCleanly &&
      sandboxResult.compiledCleanly &&
      sandboxResult.testsPassed;

    const approve = diffHasChanges && sandboxHealthy && sandboxResult.fitnessScore >= 0.8;
    const score = approve ? sandboxResult.fitnessScore : 0.2;

    return {
      voterId,
      proposalId: proposal.id,
      approve,
      confidence: 0.9,
      score,
      reasoning: approve
        ? `[${voterId}] Patch "${proposal.title}" applied cleanly in ${sandboxResult.executionMode} and passed TypeScript verification (fitness=${sandboxResult.fitnessScore}).`
        : `[${voterId}] Patch "${proposal.title}" failed sandbox verification or fitness threshold.`,
      timestamp: new Date().toISOString(),
    };
  }
}
