const api = window.ghost;

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const modelList = document.getElementById('models');
const keyStatus = document.getElementById('keyStatus');
const rootLabel = document.getElementById('root');
const report = document.getElementById('report');
const transcript = document.getElementById('transcript');
const empty = document.getElementById('empty');
const input = document.getElementById('input');
const status = document.getElementById('status');

let busy = false;

api.setChatHandler((event) => {
  if (event.type === 'assistant') {
    addBlock('assistant', 'Ghost', event.content || '');
    return;
  }
  if (event.type === 'note') {
    addBlock('note', 'Ghost', event.content || '');
    return;
  }
  if (event.type === 'tool') {
    addTool(event);
  }
});

document.getElementById('save').addEventListener('click', saveSettings);
document.getElementById('clearKey').addEventListener('click', clearKey);
document.getElementById('refreshModels').addEventListener('click', refreshModels);
document.getElementById('keyLink').addEventListener('click', () => {
  void api.openKeyPage();
});
document.getElementById('reflect').addEventListener('click', () => {
  void runReport('Reflecting…', () => api.reflect());
});
document.getElementById('propose').addEventListener('click', () => {
  void runReport('Asking the Will…', () => api.propose());
});
document.getElementById('clear').addEventListener('click', clearChat);
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
  modelInput.value = settings.model;
  keyStatus.textContent = describeKey(settings);
  rootLabel.textContent = `${harness.platform} · Node ${harness.nodeVersion} · ${harness.rootDir}`;
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
  modelInput.value = result.model;
  const settings = await api.getSettings();
  keyStatus.textContent = describeKey(settings);
  if (result.persisted === false && settings.hasApiKey) {
    keyStatus.textContent += ' This machine cannot encrypt it, so it lasts only until you close the app.';
  }
}

async function clearKey() {
  await api.clearKey();
  apiKeyInput.value = '';
  const settings = await api.getSettings();
  keyStatus.textContent = describeKey(settings);
}

async function refreshModels() {
  setBusy(true, 'Loading models…');
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
    keyStatus.textContent = `${result.models.length} cloud models.`;
  } finally {
    setBusy(false, '');
  }
}

async function runReport(label, action) {
  setBusy(true, label);
  report.textContent = label;
  try {
    const result = await action();
    report.textContent = result.ok ? result.report : result.error;
  } finally {
    setBusy(false, '');
  }
}

async function sendChat() {
  const text = input.value.trim();
  if (!text || busy) {
    return;
  }
  input.value = '';
  dismissEmpty();
  addBlock('user', 'You', text);
  setBusy(true, 'Talking to Ollama Cloud…');
  try {
    const result = await api.sendChat(text);
    if (!result.ok) {
      addBlock('error', 'Error', result.error);
    }
  } finally {
    setBusy(false, '');
    input.focus();
  }
}

async function clearChat() {
  await api.clearChat();
  transcript.replaceChildren();
  const note = document.createElement('p');
  note.id = 'empty';
  note.className = 'empty';
  note.textContent = 'Conversation cleared on this machine.';
  transcript.append(note);
}

function describeKey(settings) {
  if (!settings.hasApiKey) {
    return 'No key saved yet.';
  }
  if (settings.keyStoredOnDisk) {
    return 'A key is encrypted on this machine.';
  }
  return 'A key is loaded for this session only.';
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
  const heading = document.createElement('div');
  heading.className = 'msg-label';
  heading.textContent = label;
  const body = document.createElement('pre');
  body.textContent = text;
  article.append(heading, body);
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
}

function addTool(event) {
  dismissEmpty();
  const article = document.createElement('article');
  article.className = `tool ${event.ok ? 'ok' : 'fail'}`;
  const heading = document.createElement('div');
  heading.className = 'tool-label';
  heading.textContent = `${event.name} · ${event.detail || ''}`.trim();
  const body = document.createElement('pre');
  body.textContent = event.output || '';
  article.append(heading, body);
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(next, label) {
  busy = next;
  status.textContent = label;
  input.disabled = next;
  for (const id of ['send', 'clear', 'reflect', 'propose', 'refreshModels', 'save', 'clearKey']) {
    document.getElementById(id).disabled = next;
  }
}
