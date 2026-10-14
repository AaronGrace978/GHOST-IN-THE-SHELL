import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  defaultModel,
  OllamaCloudAgent,
  type AgentEvent,
} from '../src/agent/ollamaCloud';
import { GhostInTheShell } from '../src/index';

interface SavedSettings {
  model: string;
  apiKeyProtected?: string;
}

const rootDir = path.resolve(__dirname, '..', '..');
const KEY_PAGE = 'https://ollama.com/settings/keys';

const ghost = new GhostInTheShell(rootDir, { allowedHosts: ['ollama.com'] });
let memoryKey = '';
let settings: SavedSettings = { model: defaultModel() };
let chain: Promise<unknown> = Promise.resolve();
let mainWindow: BrowserWindow | null = null;

const agent = new OllamaCloudAgent(ghost, {
  getApiKey: () => memoryKey || decryptKey(settings.apiKeyProtected),
  getModel: () => settings.model || defaultModel(),
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    settings = loadSettings();
    memoryKey = decryptKey(settings.apiKeyProtected);
    try {
      await ghost.soul.initialize();
    } catch (err) {
      console.error('[GHOST] Soul log could not be loaded:', err);
    }
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 660,
    title: 'Ghost in the Shell — Recursive AI Harness',
    backgroundColor: '#07090d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (mainWindow && url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[GHOST] Failed to load window:', code, description);
  });

  void mainWindow.loadFile(path.join(rootDir, 'app', 'renderer', 'index.html'));
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'ghost-settings.json');
}

function loadSettings(): SavedSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as SavedSettings;
    return {
      model: typeof parsed.model === 'string' ? parsed.model : defaultModel(),
      apiKeyProtected:
        typeof parsed.apiKeyProtected === 'string'
          ? parsed.apiKeyProtected
          : undefined,
    };
  } catch {
    return { model: defaultModel() };
  }
}

function saveSettingsFile(): void {
  const filePath = settingsFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: SavedSettings = {
    model: settings.model,
    apiKeyProtected: settings.apiKeyProtected,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function decryptKey(protectedKey: string | undefined): string {
  if (!protectedKey || !safeStorage.isEncryptionAvailable()) {
    return '';
  }
  try {
    return safeStorage.decryptString(Buffer.from(protectedKey, 'base64'));
  } catch {
    return '';
  }
}

function validModel(model: string): boolean {
  return /^[a-zA-Z0-9_.:/-]{1,80}$/.test(model);
}

ipcMain.handle('settings:get', () => ({
  hasApiKey: Boolean(memoryKey),
  model: settings.model || defaultModel(),
  keyStoredOnDisk: Boolean(settings.apiKeyProtected),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
}));

ipcMain.handle('settings:set', (_event, input: unknown) => {
  const body = (input ?? {}) as { apiKey?: unknown; model?: unknown };
  if (typeof body.model === 'string' && body.model.trim()) {
    const model = body.model.trim();
    if (!validModel(model)) {
      return { ok: false, error: 'Model name looks invalid.' };
    }
    settings.model = model;
  } else if (body.model !== undefined) {
    settings.model = defaultModel();
  }

  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const apiKey = body.apiKey.trim();
    if (apiKey.length > 300 || /[\r\n]/.test(apiKey)) {
      return { ok: false, error: 'API key looks invalid.' };
    }
    memoryKey = apiKey;
    if (safeStorage.isEncryptionAvailable()) {
      settings.apiKeyProtected = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      settings.apiKeyProtected = undefined;
    }
  }

  saveSettingsFile();
  return {
    ok: true,
    hasApiKey: Boolean(memoryKey),
    model: settings.model,
    persisted: Boolean(settings.apiKeyProtected),
  };
});

ipcMain.handle('settings:clear-key', () => {
  memoryKey = '';
  settings.apiKeyProtected = undefined;
  saveSettingsFile();
  return { ok: true };
});

ipcMain.handle('harness:status', () => ({
  rootDir: ghost.body.rootDir,
  ...ghost.body.getSystemTelemetry(),
}));

ipcMain.handle('models:list', () =>
  enqueue(async () => {
    const models = await agent.listModels();
    return { ok: true, models };
  }).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : 'Could not list models.',
  }))
);

ipcMain.handle('harness:reflect', () =>
  enqueue(async () => {
    const reflection = await ghost.mirror.reflect();
    await ghost.soul.appendEvent('GENOME_REFLECTED', 'electron', {
      genomeHash: reflection.genomeHash,
      totalFiles: reflection.totalFiles,
      totalLines: reflection.totalLines,
      bottleneckCount: reflection.bottlenecks.length,
    });
    return {
      ok: true,
      report: ghost.mirror.formatReflectionReport(reflection),
      reflection,
    };
  }).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : 'Mirror failed.',
  }))
);

ipcMain.handle('harness:propose', () =>
  enqueue(async () => {
    const proposal = await ghost.will.proposeNextMutation();
    if (!proposal) {
      return {
        ok: true,
        report: 'The Will had nothing to propose.',
        proposal: null,
      };
    }
    await ghost.soul.appendEvent('MUTATION_PROPOSED', 'electron', {
      proposalId: proposal.id,
      title: proposal.title,
      targetFiles: proposal.targetFiles,
    });
    return {
      ok: true,
      report: `${proposal.title}\n\n${proposal.rationale}\n\n${proposal.diff}`,
      proposal,
    };
  }).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : 'Will failed.',
  }))
);

ipcMain.handle('harness:evolve', (_event, options: unknown) =>
  enqueue(async () => {
    const opts = (options ?? {}) as { applyMerge?: boolean };
    const cycle = await ghost.runEvolutionCycle({
      applyMerge: Boolean(opts.applyMerge),
    });
    const summaryLines: string[] = [
      '=== EVOLUTION CYCLE REPORT ===',
      `Genome Hash : ${cycle.reflection.genomeHash.slice(0, 16)}...`,
      `Files / LOC : ${cycle.reflection.totalFiles} files, ${cycle.reflection.totalLines} lines`,
      `Bottlenecks : ${cycle.reflection.bottlenecks.length}`,
    ];
    if (!cycle.proposal) {
      summaryLines.push('', 'No mutation proposal generated (genome is clean or already annotated).');
    } else {
      summaryLines.push(
        '',
        `Proposal    : [${cycle.proposal.id}] ${cycle.proposal.title}`,
        `Targets     : ${cycle.proposal.targetFiles.join(', ')}`
      );
      if (cycle.sandboxResult) {
        summaryLines.push(
          `Sandbox     : ${cycle.sandboxResult.executionMode} | compiled=${cycle.sandboxResult.compiledCleanly} | fitness=${cycle.sandboxResult.fitnessScore}`
        );
      }
      if (cycle.decision) {
        summaryLines.push(
          `Quorum      : ${cycle.decision.approved ? 'APPROVED' : 'REJECTED'} (${cycle.decision.approvals}/${cycle.decision.totalVotes} votes, ratio=${cycle.decision.weightedApprovalRatio})`,
          `Merged      : ${cycle.merged ? 'YES (applied to Prime Body)' : 'NO (dry-run / unmerged)'}`
        );
      }
      summaryLines.push('', '--- Diff ---', cycle.proposal.diff);
    }
    return {
      ok: true,
      report: summaryLines.join('\n'),
      cycle,
    };
  }).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : 'Evolution cycle failed.',
  }))
);

ipcMain.handle('soul:events', async () => {
  try {
    await ghost.soul.initialize();
    const events = ghost.soul.getEvents();
    const integrity = ghost.soul.verifyChainIntegrity();
    return {
      ok: true,
      events: events.slice(-60).reverse(),
      totalEvents: events.length,
      integrity,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not read Soul events.',
    };
  }
});

ipcMain.handle('files:list', async () => {
  try {
    const files = await ghost.body.listFiles('.', [
      '.ts',
      '.js',
      '.json',
      '.md',
      '.html',
      '.css',
      '.bat',
    ]);
    return { ok: true, files };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not list files.',
    };
  }
});

ipcMain.handle('files:read', async (_event, relPath: unknown) => {
  try {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      return { ok: false, error: 'Invalid file path.' };
    }
    const entry = await ghost.body.inspectFile(relPath.trim());
    return {
      ok: true,
      file: {
        relativePath: entry.relativePath,
        size: entry.size,
        lastModified: entry.lastModified,
        sha256: entry.sha256,
        content: entry.content.slice(0, 60_000),
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not read file.',
    };
  }
});

ipcMain.handle('chat:clear', () => {
  agent.clear();
  return { ok: true };
});

ipcMain.handle('chat:send', (event, text: unknown) =>
  enqueue(async () => {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, error: 'Type a message first.' };
    }
    if (text.length > 8_000) {
      return { ok: false, error: 'Message is too long.' };
    }
    const emit = (payload: AgentEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:event', payload);
      }
    };
    await agent.chat(text.trim(), emit);
    return { ok: true };
  }).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : 'Chat failed.',
  }))
);

ipcMain.handle('app:open-key-page', async () => {
  await shell.openExternal(KEY_PAGE);
  return { ok: true };
});
