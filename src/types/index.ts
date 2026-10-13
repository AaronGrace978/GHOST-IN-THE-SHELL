export interface FileEntry {
  path: string;
  relativePath: string;
  size: number;
  lastModified: number;
  content: string;
  sha256: string;
}

export interface SymbolDescriptor {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method';
  exported: boolean;
  line: number;
  endLine: number;
  parameters?: string[];
  returnType?: string;
  complexity: number;
}

export interface FileAnalysis {
  relativePath: string;
  lineCount: number;
  byteSize: number;
  sha256: string;
  imports: string[];
  exports: string[];
  symbols: SymbolDescriptor[];
  todos: Array<{ line: number; text: string }>;
  totalComplexity: number;
  maxSymbolComplexity: number;
  diagnostics: string[];
}

export interface CodebaseReflection {
  timestamp: string;
  rootDir: string;
  genomeHash: string;
  totalFiles: number;
  totalLines: number;
  totalSymbols: number;
  averageComplexity: number;
  files: FileAnalysis[];
  dependencyGraph: Record<string, string[]>;
  bottlenecks: BottleneckReport[];
}

export interface BottleneckReport {
  id: string;
  severity: 'low' | 'medium' | 'high';
  category: 'complexity' | 'todo' | 'missing-export' | 'diagnostic' | 'coverage-gap';
  file: string;
  line?: number;
  symbol?: string;
  description: string;
  suggestedAction: string;
}

export interface NetworkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
}

export interface NetworkResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  rawBody: string;
  data?: T;
  durationMs: number;
}

export interface MutationProposal {
  id: string;
  parentGenomeHash: string;
  createdAt: string;
  title: string;
  rationale: string;
  targetFiles: string[];
  bottleneckId?: string;
  diff: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkMetric {
  name: string;
  passed: boolean;
  score: number;
  durationMs: number;
  output?: string;
}

export interface SandboxExecutionResult {
  proposalId: string;
  containerId?: string;
  executionMode: 'docker' | 'isolated-worktree';
  appliedCleanly: boolean;
  compiledCleanly: boolean;
  testsPassed: boolean;
  fitnessScore: number;
  durationMs: number;
  metrics: BenchmarkMetric[];
  stdout: string;
  stderr: string;
}

export type ConsensusModelId = 'gpt-4o' | 'claude-3.5-sonnet' | 'llama-3-70b' | string;

export interface ConsensusVote {
  voterId: ConsensusModelId;
  proposalId: string;
  approve: boolean;
  confidence: number;
  score: number;
  reasoning: string;
  timestamp: string;
}

export type SwarmEventType =
  | 'GENOME_REFLECTED'
  | 'MUTATION_PROPOSED'
  | 'SANDBOX_EVALUATED'
  | 'VOTE_CAST'
  | 'QUORUM_REACHED'
  | 'MUTATION_MERGED'
  | 'MUTATION_REJECTED';

export interface SwarmSoulEvent<TPayload = unknown> {
  index: number;
  id: string;
  timestamp: string;
  type: SwarmEventType;
  actor: string;
  previousHash: string;
  hash: string;
  payload: TPayload;
}

export interface QuorumDecision {
  proposalId: string;
  approved: boolean;
  totalVotes: number;
  approvals: number;
  rejections: number;
  weightedApprovalRatio: number;
  quorumThreshold: number;
  votes: ConsensusVote[];
  decidedAt: string;
}
