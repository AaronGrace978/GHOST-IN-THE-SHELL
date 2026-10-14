const api = window.ghost;

const apiKeyInput = document.getElementById('apiKey');
const toggleKeyVisBtn = document.getElementById('toggleKeyVis');
const modelInput = document.getElementById('model');
const modelList = document.getElementById('models');
const keyStatus = document.getElementById('keyStatus');
const connBadge = document.getElementById('connBadge');
const activeModelPill = document.getElementById('activeModelPill');
const chainIntegrityPill = document.getElementById('chainIntegrityPill');

const rootLabel = document.getElementById('root');
const telPlatform = document.getElementById('telPlatform');
const telNode = document.getElementById('telNode');
const telMem = document.getElementById('telMem');
const telGenome = document.getElementById('telGenome');
const telemetryUptime = document.getElementById('telemetryUptime');
const bottleneckPill = document.getElementById('bottleneckPill');

const report = document.getElementById('report');
const transcript = document.getElementById('transcript');
const input = document.getElementById('input');
const status = document.getElementById('status');
const busyPulse = document.getElementById('busyPulse');

const tabFilesCount = document.getElementById('tabFilesCount');
const tabSoulCount = document.getElementById('tabSoulCount');

const statGenomeHash = document.getElementById('statGenomeHash');
const statTotalFiles = document.getElementById('statTotalFiles');
const statTotalLines = document.getElementById('statTotalLines');
const statTotalSymbols = document.getElementById('statTotalSymbols');
const statAvgComplexity = document.getElementById('statAvgComplexity');
const bottleneckList = document.getElementById('bottleneckList');
const moduleInventory = document.getElementById('moduleInventory');

const proposalViewerWrap = document.getElementById('proposalViewerWrap');
const proposalTitle = document.getElementById('proposalTitle');
const proposalRationale = document.getElementById('proposalRationale');
const proposalDiff = document.getElementById('proposalDiff');
const sendProposalToChatBtn = document.getElementById('sendProposalToChat');

const soulEventsList = document.getElementById('soulEventsList');

const fileFilterInput = document.getElementById('fileFilter');
const fileTree = document.getElementById('fileTree');
const fileViewerPath = document.getElementById('fileViewerPath');
const fileViewerMeta = document.getElementById('fileViewerMeta');
const fileViewerContent = document.getElementById('fileViewerContent');
const askAboutFileBtn = document.getElementById('askAboutFileBtn');
const copyFileBtn = document.getElementById('copyFileBtn');

let busy = false;
let allWorkspaceFiles = [];
let currentInspectedFile = null;
let lastProposal = null;

api.setChatHandler((event) => {
  if (event.type === 'assistant') {
    addBlock('assistant', 'Ghost', event.content || '');
    void refreshSoulLedger();
    return;
  }
  if (event.type === 'note') {
    addBlock('note', 'Ghost · Thought', event.content || '');
    return;
  }
  if (event.type === 'tool') {
    addTool(event);
  }
});

// Sidebar & Config listeners
document.getElementById('save').addEventListener('click', () => void saveSettings());
document.getElementById('clearKey').addEventListener('click', () => void clearKey());
document.getElementById('refreshModels').addEventListener('click', () => void refreshModels());
document.getElementById('keyLink').addEventListener('click', () => {
  void api.openKeyPage();
});

toggleKeyVisBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

document.getElementById('reflect').addEventListener('click', () => {
  void runReflectAction();
});
document.getElementById('propose').addEventListener('click', () => {
  void runProposeAction();
});
document.getElementById('evolveDry').addEventListener('click', () => {
  void runEvolutionAction();
});
document.getElementById('copyReport').addEventListener('click', () => {
  void copyTextToClipboard(report.textContent || '', document.getElementById('copyReport'));
});

// Mirror tab listeners
document.getElementById('mirrorRefreshBtn').addEventListener('click', () => {
  void runReflectAction();
});
document.getElementById('mirrorProposeBtn').addEventListener('click', () => {
  void runProposeAction(true);
});
sendProposalToChatBtn.addEventListener('click', () => {
  if (!lastProposal) return;
  switchTab('console');
  input.value = `Review this proposed mutation (${lastProposal.id}: ${lastProposal.title}) and let me know if we should apply or refine it:\n\n${lastProposal.diff}`;
  input.focus();
});

// Soul tab listener
document.getElementById('soulRefreshBtn').addEventListener('click', () => {
  void refreshSoulLedger();
});

// Files tab listeners
document.getElementById('filesRefreshBtn').addEventListener('click', () => {
  void loadWorkspaceFiles();
});
fileFilterInput.addEventListener('input', () => {
  renderFileTree();
});
askAboutFileBtn.addEventListener('click', () => {
  if (!currentInspectedFile) return;
  switchTab('console');
  input.value = `Inspect "${currentInspectedFile.relativePath}" and explain its role, exports, and any potential improvements.`;
  input.focus();
});
copyFileBtn.addEventListener('click', () => {
  if (!currentInspectedFile) return;
  void copyTextToClipboard(currentInspectedFile.content, copyFileBtn);
});

// Tab switching
for (const tabBtn of document.querySelectorAll('.tab')) {
  tabBtn.addEventListener('click', () => {
    const target = tabBtn.getAttribute('data-tab');
    if (target) {
      switchTab(target);
    }
  });
}

// Quick prompt chips
function bindQuickPromptChips() {
  for (const chip of document.querySelectorAll('.qp-chip')) {
    chip.addEventListener('click', () => {
      const promptText = chip.getAttribute('data-prompt');
      if (promptText && !busy) {
        input.value = promptText;
        void sendChat();
      }
    });
  }
}
bindQuickPromptChips();

// Chat composer listeners
document.getElementById('clear').addEventListener('click', () => void clearChat());
document.getElementById('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendChat();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendChat();
  }
});

void boot();

async function boot() {
  const [settings, harness] = await Promise.all([
    api.getSettings(),
    api.status(),
  ]);
  updateSettingsUI(settings);
  updateTelemetryUI(harness);

  // Run initial background introspection for Mirror, Soul, and Files
  void Promise.all([
    loadInitialMirror(),
    refreshSoulLedger(),
    loadWorkspaceFiles(),
  ]);

  // Poll lightweight telemetry every 5 seconds
  setInterval(async () => {
    try {
      const latest = await api.status();
      updateTelemetryUI(latest);
    } catch {
      // Ignore transient telemetry errors
    }
  }, 5000);
}

function switchTab(tabName) {
  for (const btn of document.querySelectorAll('.tab')) {
    const active = btn.getAttribute('data-tab') === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.tab-view')) {
    panel.classList.toggle('active', panel.id === `view-${tabName}`);
  }
}

function updateSettingsUI(settings) {
  modelInput.value = settings.model || '';
  activeModelPill.textContent = `Model: ${settings.model || 'default'}`;
  keyStatus.textContent = describeKey(settings);
  if (settings.hasApiKey) {
    connBadge.textContent = settings.keyStoredOnDisk ? 'ENCRYPTED' : 'SESSION';
    connBadge.className = 'badge badge-ok';
  } else {
    connBadge.textContent = 'NO KEY';
    connBadge.className = 'badge badge-warn';
  }
}

function updateTelemetryUI(harness) {
  telPlatform.textContent = `${harness.platform}/${harness.arch} (${harness.cpus}c)`;
  telNode.textContent = harness.nodeVersion;
  telMem.textContent = `${harness.memoryUsageMb} MB`;
  telemetryUptime.textContent = `${Math.floor(harness.uptimeSeconds)}s`;
  rootLabel.textContent = harness.rootDir;
}

async function loadInitialMirror() {
  try {
    const result = await api.reflect();
    if (result.ok && result.reflection) {
      renderMirrorData(result.reflection);
      report.textContent = result.report;
    }
  } catch {
    // Ignore initial mirror error
  }
}

async function saveSettings() {
  const result = await api.saveSettings({
    apiKey: apiKeyInput.value,
    model: modelInput.value,
  });
  if (!result.ok) {
    keyStatus.textContent = result.error;
    return;
  }
  apiKeyInput.value = '';
  const settings = await api.getSettings();
  updateSettingsUI(settings);
  if (result.persisted === false && settings.hasApiKey) {
    keyStatus.textContent += ' This machine cannot encrypt it, so it lasts only until you close the app.';
  }
}

async function clearKey() {
  await api.clearKey();
  apiKeyInput.value = '';
  const settings = await api.getSettings();
  updateSettingsUI(settings);
}

async function refreshModels() {
  setBusy(true, 'Querying Ollama Cloud models…');
  try {
    const result = await api.listModels();
    if (!result.ok) {
      keyStatus.textContent = result.error;
      return;
    }
    modelList.replaceChildren();
    for (const name of result.models) {
      const option = document.createElement('option');
      option.value = name;
      modelList.append(option);
    }
    if (!modelInput.value && result.models.length > 0) {
      modelInput.value = result.models[0];
    }
    keyStatus.textContent = `Loaded ${result.models.length} cloud models.`;
  } finally {
    setBusy(false, '');
  }
}

async function runReflectAction() {
  setBusy(true, 'Running Phase 1 Mirror AST Reflection…');
  report.textContent = 'Reflecting over TypeScript AST…';
  try {
    const result = await api.reflect();
    if (!result.ok) {
      report.textContent = result.error;
      return;
    }
    report.textContent = result.report;
    if (result.reflection) {
      renderMirrorData(result.reflection);
    }
    void refreshSoulLedger();
  } finally {
    setBusy(false, '');
  }
}

async function runProposeAction(openMirrorTab = false) {
  setBusy(true, 'Asking WillEngine for a mutation proposal…');
  report.textContent = 'Synthesizing unified git diff…';
  try {
    const result = await api.propose();
    if (!result.ok) {
      report.textContent = result.error;
      return;
    }
    report.textContent = result.report;
    if (result.proposal) {
      lastProposal = result.proposal;
      renderProposal(result.proposal);
      if (openMirrorTab) {
        switchTab('mirror');
      }
    }
    void refreshSoulLedger();
  } finally {
    setBusy(false, '');
  }
}

async function runEvolutionAction() {
  setBusy(true, 'Executing Purgatory Sandbox & Swarm-Soul Quorum…');
  report.textContent = 'Staging Shadow Body and running typecheck benchmark…';
  try {
    const result = await api.evolve({ applyMerge: false });
    if (!result.ok) {
      report.textContent = result.error;
      return;
    }
    report.textContent = result.report;
    if (result.cycle?.reflection) {
      renderMirrorData(result.cycle.reflection);
    }
    if (result.cycle?.proposal) {
      lastProposal = result.cycle.proposal;
      renderProposal(result.cycle.proposal);
    }
    void refreshSoulLedger();
  } finally {
    setBusy(false, '');
  }
}

function renderMirrorData(reflection) {
  const shortHash = reflection.genomeHash ? reflection.genomeHash.slice(0, 12) : '—';
  telGenome.textContent = shortHash;
  statGenomeHash.textContent = reflection.genomeHash ? `${reflection.genomeHash.slice(0, 16)}…` : '—';
  statGenomeHash.title = reflection.genomeHash || '';
  statTotalFiles.textContent = String(reflection.totalFiles);
  statTotalLines.textContent = String(reflection.totalLines);
  statTotalSymbols.textContent = String(reflection.totalSymbols);
  statAvgComplexity.textContent = String(reflection.averageComplexity);
  tabFilesCount.textContent = String(reflection.totalFiles);

  const count = reflection.bottlenecks?.length || 0;
  bottleneckPill.textContent = `${count} bottleneck${count === 1 ? '' : 's'}`;
  bottleneckPill.className = `badge ${count > 0 ? 'badge-warn' : 'badge-ok'}`;

  bottleneckList.replaceChildren();
  if (!reflection.bottlenecks || reflection.bottlenecks.length === 0) {
    const clean = document.createElement('p');
    clean.className = 'hint';
    clean.textContent = 'No complexity or diagnostic bottlenecks detected.';
    bottleneckList.append(clean);
  } else {
    for (const b of reflection.bottlenecks) {
      const card = document.createElement('div');
      card.className = 'item-card';

      const top = document.createElement('div');
      top.className = 'item-card-top';

      const loc = document.createElement('span');
      loc.className = 'item-card-title';
      loc.textContent = `${b.file}${b.line ? `:${b.line}` : ''}`;

      const badge = document.createElement('span');
      badge.className = `badge ${
        b.severity === 'high' ? 'badge-danger' : b.severity === 'medium' ? 'badge-warn' : 'badge-neutral'
      }`;
      badge.textContent = `${b.severity} · ${b.category}`;

      top.append(loc, badge);

      const desc = document.createElement('div');
      desc.className = 'item-card-desc';
      desc.textContent = b.description;

      const sub = document.createElement('div');
      sub.className = 'item-card-sub';
      sub.textContent = `Suggested: ${b.suggestedAction}`;

      card.append(top, desc, sub);
      bottleneckList.append(card);
    }
  }

  moduleInventory.replaceChildren();
  for (const file of reflection.files || []) {
    const card = document.createElement('div');
    card.className = 'item-card';

    const top = document.createElement('div');
    top.className = 'item-card-top';

    const title = document.createElement('span');
    title.className = 'item-card-title';
    title.textContent = file.relativePath;

    const badge = document.createElement('span');
    badge.className = `badge ${file.maxSymbolComplexity > 10 ? 'badge-warn' : 'badge-neutral'}`;
    badge.textContent = `${file.lineCount} LOC · maxCx ${file.maxSymbolComplexity}`;

    top.append(title, badge);

    const desc = document.createElement('div');
    desc.className = 'item-card-sub';
    const exportedNames = (file.exports || []).slice(0, 6).join(', ');
    desc.textContent = `${file.symbols.length} AST symbols | Exports: ${exportedNames || 'none'}`;

    card.append(top, desc);
    moduleInventory.append(card);
  }
}

function renderProposal(proposal) {
  proposalViewerWrap.classList.remove('hidden');
  proposalTitle.textContent = `[${proposal.id}] ${proposal.title}`;
  proposalRationale.textContent = proposal.rationale;
  proposalDiff.replaceChildren();

  const lines = (proposal.diff || '').split(/\r?\n/);
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      div.classList.add('meta');
    } else if (line.startsWith('@@')) {
      div.classList.add('hunk');
    } else if (line.startsWith('+')) {
      div.classList.add('add');
    } else if (line.startsWith('-')) {
      div.classList.add('del');
    }
    div.textContent = line;
    proposalDiff.append(div);
  }
}

async function refreshSoulLedger() {
  try {
    const res = await api.soulEvents();
    if (!res.ok) {
      return;
    }
    tabSoulCount.textContent = String(res.totalEvents || 0);
    if (res.integrity?.valid) {
      chainIntegrityPill.textContent = `Soul Chain: Verified (${res.totalEvents})`;
      chainIntegrityPill.className = 'integrity-pill ok';
    } else {
      chainIntegrityPill.textContent = `Soul Chain: Broken @ #${res.integrity?.brokenAtIndex}`;
      chainIntegrityPill.className = 'integrity-pill bad';
    }

    soulEventsList.replaceChildren();
    if (!res.events || res.events.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'hint';
      emptyMsg.textContent = 'No events recorded in .swarm-soul/event-log.jsonl yet.';
      soulEventsList.append(emptyMsg);
      return;
    }

    for (const evt of res.events) {
      const card = document.createElement('div');
      card.className = 'soul-event';

      const top = document.createElement('div');
      top.className = 'soul-event-top';

      const left = document.createElement('div');
      left.className = 'soul-event-left';

      const idx = document.createElement('span');
      idx.className = 'soul-index';
      idx.textContent = `#${evt.index}`;

      const badge = document.createElement('span');
      badge.className = `badge ${soulBadgeStyle(evt.type)}`;
      badge.textContent = evt.type;

      const actor = document.createElement('span');
      actor.className = 'soul-actor';
      actor.textContent = `@${evt.actor}`;

      left.append(idx, badge, actor);

      const right = document.createElement('span');
      right.className = 'soul-hash';
      const timeStr = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : '';
      right.textContent = `${timeStr} · sha256:${(evt.hash || '').slice(0, 12)}…`;
      right.title = `Hash: ${evt.hash}\nPrev: ${evt.previousHash}`;

      top.append(left, right);

      const payloadPre = document.createElement('pre');
      payloadPre.className = 'soul-payload';
      payloadPre.textContent = JSON.stringify(evt.payload, null, 2);

      card.append(top, payloadPre);
      soulEventsList.append(card);
    }
  } catch {
    // Ignore ledger refresh failure
  }
}

function soulBadgeStyle(type) {
  if (type === 'MUTATION_MERGED' || type === 'QUORUM_REACHED') return 'badge-ok';
  if (type === 'MUTATION_REJECTED') return 'badge-danger';
  if (type === 'MUTATION_PROPOSED' || type === 'SANDBOX_EVALUATED') return 'badge-warn';
  return 'badge-neutral';
}

async function loadWorkspaceFiles() {
  const res = await api.listFiles();
  if (!res.ok) {
    return;
  }
  allWorkspaceFiles = res.files || [];
  renderFileTree();
  if (!currentInspectedFile && allWorkspaceFiles.length > 0) {
    const defaultTarget =
      allWorkspaceFiles.includes('src/index.ts') ? 'src/index.ts' : allWorkspaceFiles[0];
    void inspectWorkspaceFile(defaultTarget);
  }
}

function renderFileTree() {
  const query = (fileFilterInput.value || '').trim().toLowerCase();
  fileTree.replaceChildren();
  const filtered = allWorkspaceFiles.filter((f) => f.toLowerCase().includes(query));
  for (const relPath of filtered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `file-item${
      currentInspectedFile && currentInspectedFile.relativePath === relPath ? ' active' : ''
    }`;
    btn.textContent = relPath;
    btn.addEventListener('click', () => {
      void inspectWorkspaceFile(relPath);
    });
    fileTree.append(btn);
  }
}

async function inspectWorkspaceFile(relPath) {
  const res = await api.readFile(relPath);
  if (!res.ok || !res.file) {
    fileViewerPath.textContent = relPath;
    fileViewerMeta.textContent = res.error || 'Error reading file';
    fileViewerContent.textContent = '';
    return;
  }
  currentInspectedFile = res.file;
  fileViewerPath.textContent = res.file.relativePath;
  fileViewerMeta.textContent = `${res.file.size} bytes · sha256:${res.file.sha256.slice(0, 12)}…`;
  fileViewerContent.textContent = res.file.content;
  askAboutFileBtn.disabled = false;
  copyFileBtn.disabled = false;
  renderFileTree();
}

async function sendChat() {
  const text = input.value.trim();
  if (!text || busy) {
    return;
  }
  input.value = '';
  dismissEmpty();
  addBlock('user', 'Operator', text);
  setBusy(true, 'Ghost is reasoning with Ollama Cloud…');
  try {
    const result = await api.sendChat(text);
    if (!result.ok) {
      addBlock('error', 'System Alert', result.error);
    }
    void refreshSoulLedger();
  } finally {
    setBusy(false, '');
    input.focus();
  }
}

async function clearChat() {
  await api.clearChat();
  transcript.replaceChildren();
  const emptyWrap = document.createElement('div');
  emptyWrap.id = 'empty';
  emptyWrap.className = 'empty-state';
  emptyWrap.innerHTML = `
    <div class="empty-hero">
      <div class="hero-emblem"><span class="core-pulse"></span></div>
      <h3>SESSION MEMORY CLEARED</h3>
      <p class="empty">Conversation history has been reset on this machine. Select a quick directive or transmit a new message below.</p>
    </div>
    <div class="quick-prompts">
      <span class="qp-label">Quick Directives:</span>
      <div class="qp-grid">
        <button class="qp-chip" data-prompt="Run reflect on the codebase and summarize the architecture and top complexity bottlenecks." type="button">🪞 Reflect &amp; summarize bottlenecks</button>
        <button class="qp-chip" data-prompt="Propose a mutation using propose_mutation and explain what it changes and why." type="button">⚡ Propose a self-mutation diff</button>
        <button class="qp-chip" data-prompt="Run tsc -p tsconfig.electron.json --noEmit using exec_command and verify the build is clean." type="button">🛡️ Verify TypeScript build health</button>
        <button class="qp-chip" data-prompt="Search the codebase for SwarmSoul and explain how the hash-chained consensus layer works." type="button">🔗 Explain Swarm-Soul consensus</button>
      </div>
    </div>
  `;
  transcript.append(emptyWrap);
  bindQuickPromptChips();
}

function describeKey(settings) {
  if (!settings.hasApiKey) {
    return 'No API key configured yet.';
  }
  if (settings.keyStoredOnDisk) {
    return 'API key encrypted via OS safeStorage.';
  }
  return 'API key active for this session only.';
}

function dismissEmpty() {
  const node = document.getElementById('empty');
  if (node) {
    node.remove();
  }
}

function addBlock(kind, label, text) {
  dismissEmpty();
  const article = document.createElement('article');
  article.className = `msg ${kind}`;

  const header = document.createElement('div');
  header.className = 'msg-header';

  const heading = document.createElement('span');
  heading.className = 'msg-label';
  heading.textContent = label;

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date().toLocaleTimeString();

  header.append(heading, time);

  const body = document.createElement('div');
  body.className = 'msg-body';
  renderFormattedContent(body, text);

  article.append(header, body);
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
}

function renderFormattedContent(container, rawText) {
  // Split fenced code blocks ```lang ... ``` safely using DOM nodes
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(rawText)) !== null) {
    if (match.index > lastIndex) {
      appendParagraphs(container, rawText.slice(lastIndex, match.index));
    }
    const pre = document.createElement('pre');
    pre.className = 'code-block';
    pre.textContent = match[2].replace(/\n$/, '');
    container.append(pre);
    lastIndex = fenceRegex.lastIndex;
  }

  if (lastIndex < rawText.length) {
    appendParagraphs(container, rawText.slice(lastIndex));
  }
}

function appendParagraphs(container, textChunk) {
  const paragraphs = textChunk.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const p = document.createElement('p');
    // Render inline `code` spans safely
    const parts = trimmed.split(/(`[^`]+`)/g);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        const code = document.createElement('code');
        code.className = 'inline-code';
        code.textContent = part.slice(1, -1);
        p.append(code);
      } else {
        // Preserve single line breaks inside a paragraph
        const lines = part.split('\n');
        lines.forEach((line, idx) => {
          if (idx > 0) p.append(document.createElement('br'));
          p.append(document.createTextNode(line));
        });
      }
    }
    container.append(p);
  }
}

function addTool(event) {
  dismissEmpty();
  const details = document.createElement('details');
  details.className = `tool-card ${event.ok ? 'ok' : 'fail'}`;
  if (!event.ok) {
    details.open = true;
  }

  const summary = document.createElement('summary');
  summary.className = 'tool-summary';

  const left = document.createElement('div');
  left.className = 'tool-summary-left';

  const dot = document.createElement('span');
  dot.className = 'tool-status-dot';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tool-name';
  nameSpan.textContent = event.name || 'tool';

  const detailSpan = document.createElement('span');
  detailSpan.className = 'tool-detail';
  detailSpan.textContent = event.detail || '';

  left.append(dot, nameSpan, detailSpan);

  const badge = document.createElement('span');
  badge.className = `badge ${event.ok ? 'badge-ok' : 'badge-danger'}`;
  badge.textContent = event.ok ? 'OK' : 'ERR';

  summary.append(left, badge);

  const body = document.createElement('pre');
  body.className = 'tool-output';
  body.textContent = event.output || '(no output)';

  details.append(summary, body);
  transcript.append(details);
  transcript.scrollTop = transcript.scrollHeight;
}

async function copyTextToClipboard(text, btnElement) {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btnElement.textContent;
    btnElement.textContent = 'Copied!';
    setTimeout(() => {
      btnElement.textContent = prev;
    }, 1400);
  } catch {
    // Ignore clipboard error
  }
}

function setBusy(next, label) {
  busy = next;
  status.textContent = label;
  busyPulse.classList.toggle('hidden', !next);
  input.disabled = next;
  for (const id of [
    'send',
    'clear',
    'reflect',
    'propose',
    'evolveDry',
    'refreshModels',
    'save',
    'clearKey',
    'mirrorRefreshBtn',
    'mirrorProposeBtn',
  ]) {
    const el = document.getElementById(id);
    if (el) el.disabled = next;
  }
}
