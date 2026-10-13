import * as crypto from 'crypto';

export type MutationEventKind = 'Propose' | 'Vote' | 'Merge';

export interface ProposeEventPayload {
  proposalId: string;
  author: string;
  title: string;
  diff: string;
  targetFiles: string[];
  parentGenomeHash: string;
}

export interface VoteEventPayload {
  proposalId: string;
  voterId: string;
  approve: boolean;
  weight?: number;
  rationale: string;
}

export interface MergeEventPayload {
  proposalId: string;
  mergedBy: string;
  resultingGenomeHash: string;
}

export type MutationEventPayload =
  | { kind: 'Propose'; data: ProposeEventPayload }
  | { kind: 'Vote'; data: VoteEventPayload }
  | { kind: 'Merge'; data: MergeEventPayload };

export interface MutationEvent {
  index: number;
  id: string;
  timestamp: string;
  kind: MutationEventKind;
  payload: MutationEventPayload;
  previousHash: string;
  hash: string;
}

export interface ProposalEvolutionState {
  proposalId: string;
  author: string;
  title: string;
  diff: string;
  targetFiles: string[];
  parentGenomeHash: string;
  status: 'proposed' | 'approved' | 'rejected' | 'merged';
  votes: Record<
    string,
    {
      voterId: string;
      approve: boolean;
      weight: number;
      rationale: string;
      timestamp: string;
    }
  >;
  approvalWeight: number;
  totalWeight: number;
  mergedAt?: string;
  resultingGenomeHash?: string;
}

export interface EvolutionState {
  generation: number;
  currentGenomeHash: string;
  proposals: Record<string, ProposalEvolutionState>;
  mergedProposalIds: string[];
  lastEventHash: string;
  eventCount: number;
}

/**
 * Deterministically serializes any JSON-compatible value by recursively sorting object keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();

  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  );
  return `{${entries.join(',')}}`;
}

/**
 * Computes a SHA-256 hex digest over the canonical JSON representation of a value.
 */
export function hashCanonical(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Soul (Event-Sourced Consensus Layer)
 * Maintains an append-only hash-chained log of MutationEvents (Propose, Vote, Merge)
 * and derives the current evolutionary state via `foldInto`.
 */
export class Soul {
  private readonly log: MutationEvent[] = [];
  private readonly quorumRatio: number;
  private readonly minVotes: number;
  private readonly genesisGenomeHash: string;

  constructor(options: {
    quorumRatio?: number;
    minVotes?: number;
    genesisGenomeHash?: string;
    initialEvents?: MutationEvent[];
  } = {}) {
    this.quorumRatio = options.quorumRatio ?? 0.67;
    this.minVotes = options.minVotes ?? 2;
    this.genesisGenomeHash = options.genesisGenomeHash ?? '0'.repeat(64);

    if (options.initialEvents) {
      for (const evt of options.initialEvents) {
        this.log.push(evt);
      }
      if (!this.verifyIntegrity()) {
        throw new Error('Initial MutationEvent log failed canonicalJson hash integrity verification.');
      }
    }
  }

  /**
   * Appends a new Propose event to the append-only log.
   */
  public propose(data: ProposeEventPayload): MutationEvent {
    return this.append({ kind: 'Propose', data });
  }

  /**
   * Appends a new Vote event to the append-only log.
   */
  public vote(data: VoteEventPayload): MutationEvent {
    return this.append({ kind: 'Vote', data });
  }

  /**
   * Appends a new Merge event to the append-only log after verifying quorum approval.
   */
  public merge(data: MergeEventPayload): MutationEvent {
    const state = this.foldInto();
    const proposal = state.proposals[data.proposalId];
    if (!proposal) {
      throw new Error(`Cannot merge unknown proposal "${data.proposalId}".`);
    }
    if (proposal.status !== 'approved') {
      throw new Error(
        `Cannot merge proposal "${data.proposalId}" with status "${proposal.status}" (quorum not reached).`
      );
    }
    return this.append({ kind: 'Merge', data });
  }

  /**
   * Appends a raw MutationEventPayload and links its canonicalJson SHA-256 hash to the chain.
   */
  public append(payload: MutationEventPayload): MutationEvent {
    const index = this.log.length;
    const previousHash =
      index === 0 ? '0'.repeat(64) : this.log[index - 1].hash;
    const timestamp = new Date().toISOString();
    const id = `mevt-${index + 1}-${crypto.randomBytes(4).toString('hex')}`;

    const hashEnvelope = {
      index,
      id,
      timestamp,
      kind: payload.kind,
      payload,
      previousHash,
    };

    const hash = hashCanonical(hashEnvelope);
    const event: MutationEvent = {
      ...hashEnvelope,
      hash,
    };

    this.log.push(event);
    return event;
  }

  /**
   * Verifies that every event in the log matches its `canonicalJson` SHA-256 hash and previousHash link.
   */
  public verifyIntegrity(): boolean {
    for (let i = 0; i < this.log.length; i++) {
      const evt = this.log[i];
      const expectedPrev = i === 0 ? '0'.repeat(64) : this.log[i - 1].hash;
      if (evt.previousHash !== expectedPrev) {
        return false;
      }

      const expectedHash = hashCanonical({
        index: evt.index,
        id: evt.id,
        timestamp: evt.timestamp,
        kind: evt.kind,
        payload: evt.payload,
        previousHash: evt.previousHash,
      });

      if (evt.hash !== expectedHash) {
        return false;
      }
    }
    return true;
  }

  /**
   * Folds the append-only MutationEvent log into the current EvolutionState (or into a caller-supplied initial state).
   */
  public foldInto(initialState?: EvolutionState): EvolutionState {
    const state: EvolutionState = initialState
      ? {
          ...initialState,
          proposals: { ...initialState.proposals },
          mergedProposalIds: [...initialState.mergedProposalIds],
        }
      : {
          generation: 0,
          currentGenomeHash: this.genesisGenomeHash,
          proposals: {},
          mergedProposalIds: [],
          lastEventHash: '0'.repeat(64),
          eventCount: 0,
        };

    for (const event of this.log) {
      switch (event.payload.kind) {
        case 'Propose': {
          const {
            proposalId,
            author,
            title,
            diff,
            targetFiles,
            parentGenomeHash,
          } = event.payload.data;
          state.proposals[proposalId] = {
            proposalId,
            author,
            title,
            diff,
            targetFiles: [...targetFiles],
            parentGenomeHash,
            status: 'proposed',
            votes: {},
            approvalWeight: 0,
            totalWeight: 0,
          };
          break;
        }

        case 'Vote': {
          const { proposalId, voterId, approve, weight = 1, rationale } =
            event.payload.data;
          const proposal = state.proposals[proposalId];
          if (proposal && proposal.status !== 'merged') {
            proposal.votes[voterId] = {
              voterId,
              approve,
              weight,
              rationale,
              timestamp: event.timestamp,
            };

            const voteList = Object.values(proposal.votes);
            const totalWeight = voteList.reduce((acc, v) => acc + v.weight, 0);
            const approvalWeight = voteList
              .filter((v) => v.approve)
              .reduce((acc, v) => acc + v.weight, 0);

            proposal.totalWeight = totalWeight;
            proposal.approvalWeight = approvalWeight;

            if (voteList.length >= this.minVotes && totalWeight > 0) {
              const ratio = approvalWeight / totalWeight;
              if (ratio >= this.quorumRatio) {
                proposal.status = 'approved';
              } else if (
                (totalWeight - approvalWeight) / totalWeight >
                1 - this.quorumRatio
              ) {
                proposal.status = 'rejected';
              }
            }
          }
          break;
        }

        case 'Merge': {
          const { proposalId, resultingGenomeHash } = event.payload.data;
          const proposal = state.proposals[proposalId];
          if (proposal) {
            proposal.status = 'merged';
            proposal.mergedAt = event.timestamp;
            proposal.resultingGenomeHash = resultingGenomeHash;
            state.generation += 1;
            state.currentGenomeHash = resultingGenomeHash;
            if (!state.mergedProposalIds.includes(proposalId)) {
              state.mergedProposalIds.push(proposalId);
            }
          }
          break;
        }
      }

      state.lastEventHash = event.hash;
      state.eventCount += 1;
    }

    return state;
  }

  /**
   * Returns a read-only snapshot of all MutationEvents in the log.
   */
  public getEvents(): ReadonlyArray<MutationEvent> {
    return [...this.log];
  }
}
