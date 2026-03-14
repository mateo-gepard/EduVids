// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Frontend Application
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE = '/api';

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  projectId: null,
  selectedFile: null,
  difficulty: 'standard',
  storyboard: null,
};

// ── DOM References ───────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const form = $('#project-form');
const uploadZone = $('#upload-zone');
const fileInput = $('#file-input');
const uploadSelected = $('#upload-selected');
const uploadFilename = $('#upload-filename');
const uploadRemove = $('#upload-remove');
const textInput = $('#text-input');
const durationSlider = $('#duration-slider');
const durationValue = $('#duration-value');
const difficultySelector = $('#difficulty-selector');
const languageSelect = $('#language-select');
const statusBadge = $('#status-badge');
const btnGenerate = $('#btn-generate');
const storyboardSection = $('#storyboard-section');
const storyboardTimeline = $('#storyboard-timeline');
const progressSection = $('#progress-section');
const progressBar = $('#progress-bar');
const progressMessage = $('#progress-message');
const progressPercent = $('#progress-percent');
const progressScenes = $('#progress-scenes');
const playerSection = $('#player-section');
const videoPlayer = $('#video-player');
const downloadBtn = $('#download-btn');

// ── Duration Slider ──────────────────────────────────────────────────────────
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins} min`;
  return `${mins}:${String(secs).padStart(2, '0')} min`;
}

durationSlider.addEventListener('input', () => {
  durationValue.textContent = formatDuration(parseInt(durationSlider.value));
});

// ── Difficulty Selector ──────────────────────────────────────────────────────
difficultySelector.addEventListener('click', (e) => {
  const btn = e.target.closest('.diff-btn');
  if (!btn) return;
  $$('.diff-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.difficulty = btn.dataset.value;
});

// ── File Upload ──────────────────────────────────────────────────────────────
uploadZone.addEventListener('click', (e) => {
  if (e.target.closest('.btn-remove')) return;
  fileInput.click();
});

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    handleFileSelect(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFileSelect(fileInput.files[0]);
  }
});

function handleFileSelect(file) {
  state.selectedFile = file;
  uploadFilename.textContent = file.name;
  uploadSelected.style.display = 'flex';
}

uploadRemove.addEventListener('click', () => {
  state.selectedFile = null;
  fileInput.value = '';
  uploadSelected.style.display = 'none';
});

// ── Form Submit ──────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await createProject();
});

async function createProject() {
  const text = textInput.value.trim();
  const file = state.selectedFile;

  if (!text && !file) {
    shakeElement(btnGenerate);
    return;
  }

  // Disable form
  btnGenerate.disabled = true;
  btnGenerate.classList.add('loading');
  btnGenerate.querySelector('.btn-text').textContent = 'Wird generiert...';
  setStatus('Generiere...', 'rendering');

  try {
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (text) formData.append('text', text);
    formData.append('duration', durationSlider.value);
    formData.append('difficulty', state.difficulty);
    formData.append('language', languageSelect.value);

    const res = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Projekt konnte nicht erstellt werden');
    }

    const data = await res.json();
    state.projectId = data.projectId;

    // Start listening for progress
    startProgressStream(data.projectId);

    // Show progress section
    showSection('progress');
  } catch (err) {
    console.error('Project creation error:', err);
    setStatus('Fehler', 'error');
    alert(`Fehler: ${err.message}`);
    resetGenerateButton();
  }
}

// ── Progress Stream (SSE) ────────────────────────────────────────────────────
function startProgressStream(projectId) {
  const source = new EventSource(`${API_BASE}/projects/${projectId}/progress`);

  source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    updateProgress(event);

    if (event.status === 'done') {
      source.close();
      onProjectDone(projectId);
    } else if (event.status === 'error') {
      source.close();
      onProjectError(event.message);
    }
  };

  source.onerror = () => {
    source.close();
    // Poll project status as fallback
    pollProjectStatus(projectId);
  };
}

function updateProgress(event) {
  const pct = Math.max(0, Math.min(100, event.progress));
  progressBar.style.width = `${pct}%`;
  progressMessage.textContent = event.message;
  progressPercent.textContent = `${pct}%`;

  if (event.currentScene) {
    addSceneProgress(event.currentScene, event.status);
  }
}

function addSceneProgress(sceneName, status) {
  // Check if scene already listed
  const existing = progressScenes.querySelector(`[data-scene="${sceneName}"]`);
  if (existing) {
    if (status === 'done') {
      existing.classList.remove('active');
      existing.classList.add('done');
      existing.querySelector('.scene-status-icon').textContent = '✅';
    }
    return;
  }

  const item = document.createElement('div');
  item.className = 'scene-progress-item active';
  item.dataset.scene = sceneName;
  item.innerHTML = `
    <span class="scene-status-icon">⏳</span>
    <span>${sceneName}</span>
  `;
  progressScenes.appendChild(item);

  // Mark previous items as done
  const items = progressScenes.querySelectorAll('.scene-progress-item.active');
  items.forEach((el, i) => {
    if (i < items.length - 1) {
      el.classList.remove('active');
      el.classList.add('done');
      el.querySelector('.scene-status-icon').textContent = '✅';
    }
  });
}

// ── Fallback polling ─────────────────────────────────────────────────────────
async function pollProjectStatus(projectId) {
  const poll = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}`);
      const project = await res.json();

      if (project.status === 'done') {
        clearInterval(poll);
        onProjectDone(projectId);
      } else if (project.status === 'error') {
        clearInterval(poll);
        onProjectError(project.error);
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 3000);
}

// ── Completion Handlers ──────────────────────────────────────────────────────
function onProjectDone(projectId) {
  setStatus('Fertig!', '');
  statusBadge.style.background = 'rgba(91, 245, 160, 0.1)';
  statusBadge.style.color = 'var(--success)';

  // Update progress to 100%
  progressBar.style.width = '100%';
  progressMessage.textContent = '🎉 Video erfolgreich erstellt!';
  progressPercent.textContent = '100%';

  // Show video player
  videoPlayer.src = `${API_BASE}/projects/${projectId}/download`;
  downloadBtn.href = `${API_BASE}/projects/${projectId}/download`;
  showSection('player');

  resetGenerateButton();
}

function onProjectError(message) {
  setStatus('Fehler', 'error');
  progressMessage.textContent = `❌ ${message}`;
  resetGenerateButton();
}

// ── Storyboard Display ───────────────────────────────────────────────────────
function renderStoryboard(storyboard) {
  state.storyboard = storyboard;
  storyboardTimeline.innerHTML = '';

  const sceneIcons = {
    'intro': '🎬', 'outro': '🏁', 'infografik': '📊', 'ken-burns': '🖼️',
    'formel': '📐', 'zitat': '💬', 'step-by-step': '📝', 'quiz': '❓',
    'funfact': '🤓', 'zusammenfassung': '📋',
  };

  storyboard.scenes.forEach((scene, i) => {
    const el = document.createElement('div');
    el.className = 'storyboard-scene';
    el.innerHTML = `
      <span class="scene-order">${String(i + 1).padStart(2, '0')}</span>
      <span class="scene-type-badge ${scene.type}">${sceneIcons[scene.type] || '🎯'} ${scene.type}</span>
      <div class="scene-info">
        <div class="scene-title">${scene.title}</div>
      </div>
      <span class="scene-time">${scene.timeBudget}s</span>
    `;
    storyboardTimeline.appendChild(el);
  });
}

// ── UI Helpers ───────────────────────────────────────────────────────────────
function setStatus(text, className) {
  statusBadge.textContent = text;
  statusBadge.className = 'nav-status' + (className ? ` ${className}` : '');
}

function showSection(name) {
  if (name === 'progress') {
    progressSection.style.display = '';
    progressSection.style.animation = 'fadeUp 600ms cubic-bezier(0.23, 1, 0.32, 1) both';
  }
  if (name === 'storyboard') {
    storyboardSection.style.display = '';
    storyboardSection.style.animation = 'fadeUp 600ms cubic-bezier(0.23, 1, 0.32, 1) both';
  }
  if (name === 'player') {
    playerSection.style.display = '';
    playerSection.style.animation = 'fadeUp 600ms cubic-bezier(0.23, 1, 0.32, 1) both';
  }
}

function resetGenerateButton() {
  btnGenerate.disabled = false;
  btnGenerate.classList.remove('loading');
  btnGenerate.querySelector('.btn-text').textContent = 'Video generieren';
}

function shakeElement(el) {
  el.style.animation = 'none';
  el.offsetHeight; // trigger reflow
  el.style.animation = 'shake 400ms ease-in-out';
}

// Add shake keyframe
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-8px); }
    40%, 80% { transform: translateX(8px); }
  }
`;
document.head.appendChild(style);

// ── Initialize ───────────────────────────────────────────────────────────────
console.log('🎬 EduVid AI initialized');
