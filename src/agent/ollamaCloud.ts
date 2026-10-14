import * as fs from 'fs';
import * as path from 'path';
import { GhostInTheShell } from '../index';

const CLOUD_ORIGIN = 'https://ollama.com';
const DEFAULT_MODEL = 'gemma4:31b';
const MAX_TOOL_ROUNDS = 6;
const MAX_CALLS_PER_ROUND = 4;

const ALLOWED_COMMANDS = new Set(['git', 'npm', 'npx', 'node', 'tsc', 'ts-node']);
const BLOCKED_GIT = new Set([
  'push',
  'config',
  'reset',
  'clean',
  'rebase',
  'filter-branch',
  'update-ref',
  'credential',
]);
const BLOCKED_NODE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const SECRET_BASENAMES = new Set([
  '.env',
  '.env.local',
  'credentials.json',
  'id_rsa',
]);

export interface OllamaSessionConfig {
  getApiKey: () => string;
  getModel: () => string;
}

export type AgentEvent =
  | { type: 'note'; content: string }
  | {
      type: 'tool';
      name: string;
      detail: string;
      ok: boolean;
      output: string;
    }
  | { type: 'assistant'; content: string };

interface ToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

interface ChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  error?: string;
}

interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'reflect',
      description:
        'Run the Mirror over this project. Returns file counts, symbol counts, and complexity bottlenecks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List project files under a relative folder.',
      parameters: {
        type: 'object',
        properties: {
          subDir: {
            type: 'string',
            description: 'Folder relative to the project root. Defaults to the root.',
          },
          extension: {
            type: 'string',
            description: 'Optional extension filter such as .ts',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search text files for a short snippet. Returns matching lines.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          subDir: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the project.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or replace a UTF-8 file inside the project. This writes immediately.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec_command',
      description:
        'Run git, npm, npx, node, tsc, or ts-node in the project root. args is an array of strings. git push, git reset, npm publish, and node -e are blocked.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_mutation',
      description:
        'Ask the Will engine for a unified diff against the worst bottleneck. Does not modify the project.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/**
 * Ollama Cloud chat loop. Network calls go through the harness, which only
 * allows ollama.com. Tools read and write through the same harness.
 */
export class OllamaCloudAgent {
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(
    private readonly ghost: GhostInTheShell,
    private readonly config: OllamaSessionConfig
  ) {}

  public clear(): void {
    this.history = [];
  }

  public async listModels(): Promise<string[]> {
    const response = await this.ghost.body.request<TagsResponse>(
      `${CLOUD_ORIGIN}/api/tags`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this.requireKey()}` },
        timeoutMs: 20_000,
      }
    );
    this.assertOk(response.status, response.rawBody);
    const names = (response.data?.models ?? [])
      .map((model) => model.name || model.model || '')
      .filter((name) => name.length > 0);
    return Array.from(new Set(names)).sort();
  }

  public async chat(
    userText: string,
    emit: (event: AgentEvent) => void
  ): Promise<string> {
    const messages: OllamaMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...this.history.slice(-12),
      { role: 'user', content: userText },
    ];

    let finalText = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const message = await this.complete(messages);
      const calls = (message.tool_calls ?? []).slice(0, MAX_CALLS_PER_ROUND);
      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: calls.length > 0 ? calls : undefined,
      });

      if (calls.length === 0) {
        finalText = (message.content ?? '').trim();
        break;
      }

      const aside = (message.content ?? '').trim();
      if (aside) {
        emit({ type: 'note', content: aside });
      }

      for (const call of calls) {
        const name = call.function?.name || 'unknown';
        const args = parseArgs(call.function?.arguments);
        const detail = summarizeCall(name, args);
        let output = '';
        let ok = true;
        try {
          output = await this.execute(name, args);
        } catch (err) {
          ok = false;
          output = err instanceof Error ? err.message : 'Tool failed';
        }
        emit({
          type: 'tool',
          name,
          detail,
          ok,
          output: clampText(output, 2_500),
        });
        await this.record(name, ok, detail);
        messages.push({
          role: 'tool',
          tool_name: name,
          content: clampText(output, 12_000),
        });
      }
    }

    if (!finalText) {
      finalText =
        'I stopped after several tool calls without a final answer. Ask me to continue.';
    }

    this.history.push({ role: 'user', content: userText });
    this.history.push({ role: 'assistant', content: finalText });
    if (this.history.length > 16) {
      this.history.splice(0, this.history.length - 16);
    }
    emit({ type: 'assistant', content: finalText });
    return finalText;
  }

  private systemPrompt(): string {
    return [
      `You are Ghost, a coding agent for the local project at ${this.ghost.body.rootDir}.`,
      'File access goes through the Ghost harness and must stay inside this project.',
      'Use reflect, list_files, search, and read_file before claiming what the code does.',
      'write_file changes the project immediately. propose_mutation only returns a diff and does not apply it.',
      'exec_command can run git, npm, npx, node, tsc, or ts-node. git push, git reset, npm publish, and node -e are blocked.',
      'Do not invent file contents. After a write, say which path changed. Keep answers short.',
    ].join(' ');
  }

  private requireKey(): string {
    const key = this.config.getApiKey().trim();
    if (!key) {
      throw new Error('Add an Ollama Cloud API key and save it first.');
    }
    return key;
  }

  private async complete(messages: OllamaMessage[]): Promise<{
    content: string;
    tool_calls?: ToolCall[];
  }> {
    const model = this.config.getModel().trim() || DEFAULT_MODEL;
    const payload = {
      model,
      messages,
      tools: TOOLS,
      stream: false,
      think: false,
      options: { temperature: 0.2 },
    };
    try {
      return await this.postChat(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!/think/i.test(message)) {
        throw err;
      }
      const { think: _ignored, ...withoutThink } = payload;
      return this.postChat(withoutThink);
    }
  }

  private async postChat(payload: Record<string, unknown>): Promise<{
    content: string;
    tool_calls?: ToolCall[];
  }> {
    const key = this.requireKey();
    const response = await this.ghost.body.request<ChatResponse>(
      `${CLOUD_ORIGIN}/api/chat`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: payload,
        timeoutMs: 120_000,
      }
    );
    this.assertOk(response.status, response.rawBody, key);
    if (!response.data?.message) {
      throw new Error('Ollama Cloud returned a response without a message.');
    }
    return {
      content: response.data.message.content ?? '',
      tool_calls: response.data.message.tool_calls,
    };
  }

  private assertOk(status: number, rawBody: string, apiKey = ''): void {
    if (status === 401 || status === 403) {
      throw new Error('Ollama Cloud rejected the API key.');
    }
    if (status < 200 || status >= 300) {
      const cleaned = apiKey ? rawBody.replaceAll(apiKey, '[key]') : rawBody;
      throw new Error(
        `Ollama Cloud returned ${status}: ${clampText(cleaned, 300)}`
      );
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case 'reflect':
        return this.reflect();
      case 'list_files':
        return this.listFiles(args);
      case 'search':
        return this.search(args);
      case 'read_file':
        return this.readFile(args);
      case 'write_file':
        return this.writeFile(args);
      case 'exec_command':
        return this.execCommand(args);
      case 'propose_mutation':
        return this.propose();
      default:
        throw new Error(`Unknown tool "${name}".`);
    }
  }

  private async reflect(): Promise<string> {
    const reflection = await this.ghost.mirror.reflect();
    await this.ghost.soul.appendEvent('GENOME_REFLECTED', 'ollama-cloud', {
      genomeHash: reflection.genomeHash,
      totalFiles: reflection.totalFiles,
      totalLines: reflection.totalLines,
      bottleneckCount: reflection.bottlenecks.length,
    });
    return this.ghost.mirror.formatReflectionReport(reflection);
  }

  private async listFiles(args: Record<string, unknown>): Promise<string> {
    const subDir =
      typeof args.subDir === 'string' && args.subDir.trim()
        ? assertRelative(args.subDir)
        : '.';
    const extension =
      typeof args.extension === 'string' && args.extension.trim()
        ? normalizeExtension(args.extension)
        : undefined;
    const files = await this.ghost.body.listFiles(
      subDir,
      extension ? [extension] : undefined
    );
    const shown = files.slice(0, 200);
    const suffix =
      files.length > shown.length ? `\n… ${files.length - shown.length} more` : '';
    return shown.join('\n') + suffix || 'No files.';
  }

  private async search(args: Record<string, unknown>): Promise<string> {
    const query = requiredString(args.query, 'query').slice(0, 200);
    if (query.trim().length < 2) {
      throw new Error('query must be at least 2 characters.');
    }
    const subDir =
      typeof args.subDir === 'string' && args.subDir.trim()
        ? assertRelative(args.subDir)
        : '.';
    const files = await this.ghost.body.listFiles(subDir, [
      '.ts',
      '.js',
      '.json',
      '.md',
      '.html',
      '.css',
    ]);
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= 30) {
        break;
      }
      if (isSecretPath(file)) {
        continue;
      }
      const text = await this.ghost.body.readFile(file);
      if (text.includes('\0') || text.length > 200_000) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 30; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    return hits.join('\n') || 'No matches.';
  }

  private async readFile(args: Record<string, unknown>): Promise<string> {
    const relativePath = assertReadable(requiredString(args.path, 'path'));
    const text = await this.ghost.body.readFile(relativePath);
    if (text.includes('\0')) {
      throw new Error('That file is not UTF-8 text.');
    }
    return clampText(text, 20_000);
  }

  private async writeFile(args: Record<string, unknown>): Promise<string> {
    const relativePath = assertWritable(requiredString(args.path, 'path'));
    const content = requiredString(args.content, 'content');
    if (content.includes('\0')) {
      throw new Error('Refusing to write binary content.');
    }
    if (content.length > 150_000) {
      throw new Error('Refusing to write more than 150000 characters.');
    }
    await this.ghost.body.writeFile(relativePath, content);
    return `Wrote ${relativePath} (${content.length} characters).`;
  }

  private async execCommand(args: Record<string, unknown>): Promise<string> {
    const requested = requiredString(args.command, 'command');
    const commandArgs = stringArray(args.args);
    const resolved = resolveCommand(
      requested,
      commandArgs,
      this.ghost.body.rootDir
    );
    const bin = path.join(this.ghost.body.rootDir, 'node_modules', '.bin');
    const inherited = process.env.Path ?? process.env.PATH ?? '';
    const result = await this.ghost.body.execCommand(resolved.command, resolved.args, {
      timeoutMs: 20_000,
      env: scrubSecrets({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? inherited}`,
        Path: `${bin}${path.delimiter}${inherited}`,
      }),
    });
    return [
      `exit ${result.exitCode} after ${result.durationMs}ms`,
      result.stdout.trim() ? `stdout:\n${clampText(result.stdout.trim(), 8_000)}` : '',
      result.stderr.trim() ? `stderr:\n${clampText(result.stderr.trim(), 4_000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async propose(): Promise<string> {
    const proposal = await this.ghost.will.proposeNextMutation();
    if (!proposal) {
      return 'The Will had nothing to propose.';
    }
    await this.ghost.soul.appendEvent('MUTATION_PROPOSED', 'ollama-cloud', {
      proposalId: proposal.id,
      title: proposal.title,
      targetFiles: proposal.targetFiles,
    });
    return clampText(
      `${proposal.title}\n\n${proposal.rationale}\n\n${proposal.diff}`,
      12_000
    );
  }

  private async record(tool: string, ok: boolean, detail: string): Promise<void> {
    try {
      await this.ghost.soul.appendEvent('AGENT_ACTION', 'ollama-cloud', {
        tool,
        ok,
        detail: detail.slice(0, 180),
      });
    } catch {
      // Chat continues when the event log cannot be written.
    }
  }
}

export function defaultModel(): string {
  return DEFAULT_MODEL;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    if (value.length > 20 || value.some((item) => item.length > 500)) {
      throw new Error('args has too many items or an item that is too long.');
    }
    return value;
  }
  throw new Error('args must be an array of strings.');
}

function assertRelative(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(normalized)) {
    throw new Error('Use a path relative to the project.');
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('That path leaves the project.');
  }
  return normalized || '.';
}

function isSecretPath(relativePath: string): boolean {
  const base = relativePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return (
    SECRET_BASENAMES.has(base) ||
    base.startsWith('.env') ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  );
}

function assertReadable(input: string): string {
  const relative = assertRelative(input);
  if (isSecretPath(relative)) {
    throw new Error('Refusing to read a secrets file.');
  }
  return relative;
}

function assertWritable(input: string): string {
  const relative = assertReadable(input);
  const parts = relative.split('/');
  if (parts.some((part) => part === '.git' || part === 'node_modules')) {
    throw new Error('Refusing to write inside .git or node_modules.');
  }
  return relative;
}

function normalizeExtension(input: string): string {
  const extension = input.startsWith('.') ? input : `.${input}`;
  if (!/^\.[a-z0-9]{1,8}$/i.test(extension)) {
    throw new Error('extension must look like .ts');
  }
  return extension;
}

function resolveCommand(
  command: string,
  args: string[],
  rootDir: string
): { command: string; args: string[] } {
  if (/[\\/]/.test(command) || command.includes('..')) {
    throw new Error('Command must be a bare executable name.');
  }
  const base = path
    .basename(command)
    .toLowerCase()
    .replace(/\.cmd$/, '')
    .replace(/\.exe$/, '');
  if (!ALLOWED_COMMANDS.has(base)) {
    throw new Error(
      `Command "${base}" is not available. Use git, npm, npx, node, tsc, or ts-node.`
    );
  }
  if (base === 'git' && args.length > 0 && BLOCKED_GIT.has(args[0])) {
    throw new Error(`git ${args[0]} is blocked.`);
  }
  if (base === 'npm' && args[0] === 'publish') {
    throw new Error('npm publish is blocked.');
  }
  if (base === 'node' && args.some((arg) => BLOCKED_NODE_FLAGS.has(arg))) {
    throw new Error('Inline node eval is disabled. Run a file in this project instead.');
  }
  if (process.platform === 'win32' && ['npm', 'npx', 'tsc', 'ts-node'].includes(base)) {
    return {
      command: 'node',
      args: [resolveWindowsScript(base, rootDir), ...args],
    };
  }
  return { command: base, args };
}

function resolveWindowsScript(base: string, rootDir: string): string {
  if (base === 'tsc') {
    const local = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(local)) {
      return local;
    }
  }
  if (base === 'ts-node') {
    const local = path.join(rootDir, 'node_modules', 'ts-node', 'dist', 'bin.js');
    if (fs.existsSync(local)) {
      return local;
    }
  }
  if (base === 'npm' || base === 'npx') {
    const file = base === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    const found = findOnPath(['node_modules', 'npm', 'bin', file]);
    if (found) {
      return found;
    }
  }
  throw new Error(`Could not find a Node entry point for ${base}.`);
}

function findOnPath(parts: string[]): string | null {
  const pathEnv = process.env.Path ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, ...parts);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
      cleaned[key] = '';
    }
  }
  return cleaned;
}

function summarizeCall(name: string, args: Record<string, unknown>): string {
  if (name === 'read_file' || name === 'write_file') {
    return typeof args.path === 'string' ? args.path : name;
  }
  if (name === 'exec_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    const rest = Array.isArray(args.args) ? args.args.join(' ') : '';
    return `${command} ${rest}`.trim();
  }
  if (name === 'search') {
    return typeof args.query === 'string' ? args.query : name;
  }
  if (name === 'list_files') {
    return typeof args.subDir === 'string' ? args.subDir : '.';
  }
  return name;
}

function clampText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n… truncated ${value.length - max} characters`;
}
