import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  FileEntry,
  NetworkRequestOptions,
  NetworkResponse,
} from '../types';

const execFileAsync = promisify(execFile);

export interface HarnessConfig {
  rootDir?: string;
  ignoredDirs?: string[];
  allowedHosts?: string[];
  defaultNetworkTimeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * The Body (The Harness)
 * Runtime environment providing the AI with primitives to interact with the
 * filesystem, network, OS process execution, and its own source genome.
 */
export class BodyHarness {
  public readonly rootDir: string;
  private readonly ignoredDirs: Set<string>;
  private readonly allowedHosts: Set<string> | null;
  private readonly defaultTimeoutMs: number;

  constructor(config: HarnessConfig = {}) {
    this.rootDir = path.resolve(config.rootDir ?? process.cwd());
    this.ignoredDirs = new Set(
      config.ignoredDirs ?? [
        'node_modules',
        '.git',
        'dist',
        '.ghost-sandbox',
        '.swarm-soul',
      ]
    );
    this.allowedHosts = config.allowedHosts
      ? new Set(config.allowedHosts)
      : null;
    this.defaultTimeoutMs = config.defaultNetworkTimeoutMs ?? 15_000;
  }

  /**
   * Resolves a target path and ensures it stays within the harness root directory.
   */
  public resolveSafePath(targetPath: string): string {
    const resolved = path.resolve(this.rootDir, targetPath);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Security boundary violation: Path "${targetPath}" escapes root "${this.rootDir}"`
      );
    }
    return resolved;
  }

  /**
   * FileSystem Primitive: Read a UTF-8 file relative to the workspace root.
   */
  public async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolveSafePath(relativePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  /**
   * FileSystem Primitive: Write UTF-8 content to a file, creating parent directories as needed.
   */
  public async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolveSafePath(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  /**
   * FileSystem Primitive: Check if a path exists inside the workspace.
   */
  public async exists(relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafePath(relativePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * FileSystem Primitive: Delete a file inside the workspace.
   */
  public async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolveSafePath(relativePath);
    await fs.unlink(fullPath);
  }

  /**
   * FileSystem Primitive: Recursively list files in a directory with optional extension filter.
   */
  public async listFiles(
    subDir = '.',
    extensions?: string[]
  ): Promise<string[]> {
    const startDir = this.resolveSafePath(subDir);
    const results: string[] = [];

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (this.ignoredDirs.has(entry.name)) {
            continue;
          }
          await walk(path.join(currentDir, entry.name));
        } else if (entry.isFile()) {
          const fullPath = path.join(currentDir, entry.name);
          const relPath = path.relative(this.rootDir, fullPath);
          if (
            !extensions ||
            extensions.some((ext) => relPath.endsWith(ext))
          ) {
            results.push(relPath);
          }
        }
      }
    };

    if (fsSync.existsSync(startDir)) {
      await walk(startDir);
    }

    return results.sort();
  }

  /**
   * Reads a file along with metadata and SHA-256 integrity digest.
   */
  public async inspectFile(relativePath: string): Promise<FileEntry> {
    const fullPath = this.resolveSafePath(relativePath);
    const [stat, content] = await Promise.all([
      fs.stat(fullPath),
      fs.readFile(fullPath, 'utf-8'),
    ]);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    return {
      path: fullPath,
      relativePath: path.relative(this.rootDir, fullPath),
      size: stat.size,
      lastModified: stat.mtimeMs,
      content,
      sha256,
    };
  }

  /**
   * Reads all source files that constitute the agent's mutable genome.
   */
  public async readSourceGenome(
    extensions: string[] = ['.ts', '.json']
  ): Promise<FileEntry[]> {
    const files = await this.listFiles('.', extensions);
    const entries = await Promise.all(
      files.map((relPath) => this.inspectFile(relPath))
    );
    return entries;
  }

  /**
   * Network Primitive: Perform an HTTP/HTTPS request with timeout and host policy enforcement.
   */
  public async request<T = unknown>(
    url: string,
    options: NetworkRequestOptions = {}
  ): Promise<NetworkResponse<T>> {
    const parsedUrl = new URL(url);
    if (this.allowedHosts && !this.allowedHosts.has(parsedUrl.hostname)) {
      throw new Error(
        `Network access denied: Host "${parsedUrl.hostname}" is not in allowedHosts`
      );
    }

    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'user-agent': 'GhostInTheShell-Harness/0.1.0',
      ...(options.headers ?? {}),
    };

    let bodyPayload: string | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        bodyPayload = options.body;
      } else {
        bodyPayload = JSON.stringify(options.body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    const start = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyPayload,
        signal: controller.signal,
      });

      const rawBody = await response.text();
      const durationMs = Date.now() - start;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let parsedData: T | undefined;
      try {
        parsedData = JSON.parse(rawBody) as T;
      } catch {
        // Non-JSON payload; rawBody remains available
      }

      return {
        status: response.status,
        ok: response.ok,
        headers: responseHeaders,
        rawBody,
        data: parsedData,
        durationMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Network Primitive convenience: HTTP GET
   */
  public async httpGet<T = unknown>(
    url: string,
    headers?: Record<string, string>
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, { method: 'GET', headers });
  }

  /**
   * Network Primitive convenience: HTTP POST
   */
  public async httpPost<T = unknown>(
    url: string,
    body: string | Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, { method: 'POST', body, headers });
  }

  /**
   * OS Primitive: Execute a binary command safely within the workspace.
   */
  public async execCommand(
    command: string,
    args: string[] = [],
    options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
  ): Promise<CommandResult> {
    const cwd = options.cwd
      ? this.resolveSafePath(options.cwd)
      : this.rootDir;
    const timeout = options.timeoutMs ?? 60_000;
    const start = Date.now();

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        timeout,
        env: { ...process.env, ...(options.env ?? {}) },
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const execErr = err as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message?: string;
      };
      return {
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? execErr.message ?? 'Command execution failed',
        exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Returns current OS / process telemetry for the agent's runtime awareness.
   */
  public getSystemTelemetry(): {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    cpus: number;
    memoryUsageMb: number;
    uptimeSeconds: number;
  } {
    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpus: os.cpus().length,
      memoryUsageMb: Math.round(
        (process.memoryUsage().heapUsed / 1024 / 1024) * 100
      ) / 100,
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
    };
  }
}
