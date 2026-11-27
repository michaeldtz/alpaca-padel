/**
 * Padel Americano - Ranch Mobile App (v2.0)
 * SQLite-backed multi-game management, 2-tap player swap & 5-round cycle
 */

const ACTIVE_SESSION_KEY = 'alpaca_padel_active_session_id';

let state = {
  id: null,
  title: '',
  played_date: '',
  location: '',
  players: ['Simon', 'Tim', 'Adrian', 'Andre', 'Michael'],
  rounds: [],
  currentMatch: null,
  targetPoints: 11,
  status: 'active'
};

let sessionsList = [];
let overallStats = null;
let leaderboardScope = 'session'; // 'session' | 'overall'
let selectedSwapSlot = null;

// -------------------------------------------------------------
// API HELPERS
// -------------------------------------------------------------
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(errText || `HTTP ${res.status}`);
  }
  return res.json();
}

function applySessionData(session) {
  if (!session) return;
  state = {
    id: session.id,
    title: session.title || '',
    played_date: session.played_date || '',
    location: session.location || '',
    players: session.players || [],
    rounds: session.rounds || [],
    currentMatch: session.currentMatch || null,
    targetPoints: session.targetPoints || 11,
    status: session.status || 'active'
  };
  localStorage.setItem(ACTIVE_SESSION_KEY, state.id);
}

function showHomeView() {
  document.getElementById('view-home').hidden = false;
  document.getElementById('view-game').hidden = true;
  document.getElementById('gameNavTabs').hidden = true;
  document.getElementById('gameHeaderActions').hidden = true;
  const sub = document.getElementById('headerSubtitle');
  if (sub) sub.textContent = 'Spieltage & Runden verwalten';
  renderHomeView();
}

function showGameView() {
  document.getElementById('view-home').hidden = true;
  document.getElementById('view-game').hidden = false;
  document.getElementById('gameNavTabs').hidden = false;
  document.getElementById('gameHeaderActions').hidden = false;
  const sub = document.getElementById('headerSubtitle');
  if (sub) {
    sub.innerHTML = `Ranch Match Court • Bis <span id="brandTargetDisplay">${state.targetPoints}</span> Punkte`;
  }
  renderAll();
}

async function initApp() {
  setupDialogs();
  setupEventListeners();

  try {
    const params = new URLSearchParams(window.location.search);
    const urlSessionId = params.get('session');

    await refreshSessionsAndOverall();

    if (urlSessionId && sessionsList.some(s => s.id === urlSessionId)) {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(urlSessionId)}`);
      applySessionData(data.session);
      window.history.replaceState({}, '', window.location.pathname);
      if (!state.currentMatch && state.players.length >= 4) {
        state.currentMatch = generateNextMatch();
        await persistSessionFields({ current_match: state.currentMatch });
      }
      showGameView();
      return;
    }
  } catch (err) {
    console.error('Failed to initialize app:', err);
  }

  showHomeView();
}

async function persistSessionFields(fields) {
  if (!state.id) return;
  try {
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(state.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields)
    });
    applySessionData(data.session);
  } catch (err) {
    console.error('Failed to persist session fields:', err);
  }
}

async function refreshSessionsAndOverall() {
  try {
    const [listData, statsData] = await Promise.all([
      apiFetch('/api/sessions'),
      apiFetch('/api/stats/overall')
    ]);
    sessionsList = listData.sessions || [];
    overallStats = statsData;
  } catch (err) {
    console.error('Failed to refresh sessions/stats:', err);
  }
}

// -------------------------------------------------------------
// AMERICANO FAIR PAIRING GENERATOR (WITH 5-ROUND CYCLE REPEAT)
// -------------------------------------------------------------
function generateNextMatch(customBuzz = null) {
  const players = state.players;
  if (players.length < 4) return null;

  if (!customBuzz && players.length === 5 && state.rounds.length >= 5) {
    const template = state.rounds[state.rounds.length - 5];
    const tplPlayers = [template.buzzPlayer, ...template.team1, ...template.team2];
    if (tplPlayers.length === 5 && tplPlayers.every(p => players.includes(p))) {
      return {
        buzzPlayer: template.buzzPlayer,
        team1: [...template.team1],
        team2: [...template.team2],
        score1: 0,
        score2: 0
      };
    }
  }

  let buzzPlayer = customBuzz;
  if (!buzzPlayer) {
    if (players.length === 4) {
      buzzPlayer = '';
    } else {
      const restCounts = {};
      players.forEach(p => { restCounts[p] = 0; });
      state.rounds.forEach(r => {
        if (r.buzzPlayer && restCounts[r.buzzPlayer] !== undefined) {
          restCounts[r.buzzPlayer]++;
        }
      });

      let minCount = Infinity;
      let candidates = [];
      players.forEach(p => {
        if (restCounts[p] < minCount) {
          minCount = restCounts[p];
          candidates = [p];
        } else if (restCounts[p] === minCount) {
          candidates.push(p);
        }
      });

      if (candidates.length === 1) {
        buzzPlayer = candidates[0];
      } else {
        let bestCandidate = candidates[0];
        let maxLastRestIndex = -1;
        candidates.forEach(cand => {
          let lastSeenRest = -1;
          for (let i = state.rounds.length - 1; i >= 0; i--) {
            if (state.rounds[i].buzzPlayer === cand) {
              lastSeenRest = i;
              break;
            }
          }
          const roundsSinceRest = state.rounds.length - lastSeenRest;
          if (roundsSinceRest > maxLastRestIndex) {
            maxLastRestIndex = roundsSinceRest;
            bestCandidate = cand;
          }
        });
        buzzPlayer = bestCandidate;
      }
    }
  }

  const activePlayers = players.filter(p => p !== buzzPlayer);
  const sortedByGames = [...activePlayers].sort((a, b) => {
    const aGames = state.rounds.filter(r => r.team1.includes(a) || r.team2.includes(a)).length;
    const bGames = state.rounds.filter(r => r.team1.includes(b) || r.team2.includes(b)).length;
    return aGames - bGames;
  });
  const four = sortedByGames.slice(0, 4);

  const partnerCount = {};
  const opponentCount = {};
  const key = (p1, p2) => [p1, p2].sort().join('::');

  state.rounds.forEach(r => {
    const t1k = key(r.team1[0], r.team1[1]);
    const t2k = key(r.team2[0], r.team2[1]);
    partnerCount[t1k] = (partnerCount[t1k] || 0) + 1;
    partnerCount[t2k] = (partnerCount[t2k] || 0) + 1;

    r.team1.forEach(p1 => {
      r.team2.forEach(p2 => {
        const oppk = key(p1, p2);
        opponentCount[oppk] = (opponentCount[oppk] || 0) + 1;
      });
    });
  });

  const options = [
    { t1: [four[0], four[1]], t2: [four[2], four[3]] },
    { t1: [four[0], four[2]], t2: [four[1], four[3]] },
    { t1: [four[0], four[3]], t2: [four[1], four[2]] }
  ];

  let bestOption = options[0];
  let minPenalty = Infinity;

  options.forEach(opt => {
    const pPenalty = (partnerCount[key(opt.t1[0], opt.t1[1])] || 0) * 10 +
                     (partnerCount[key(opt.t2[0], opt.t2[1])] || 0) * 10;
    let oppPenalty = 0;
    opt.t1.forEach(p1 => {
      opt.t2.forEach(p2 => {
        oppPenalty += (opponentCount[key(p1, p2)] || 0);
      });
    });
    const totalPenalty = pPenalty + oppPenalty;
    if (totalPenalty < minPenalty) {
      minPenalty = totalPenalty;
      bestOption = opt;
    }
  });

  return {
    buzzPlayer,
    team1: bestOption.t1,
    team2: bestOption.t2,
    score1: 0,
    score2: 0
  };
}

// -------------------------------------------------------------
// LEADERBOARD CALCULATOR
// -------------------------------------------------------------
function calculateSessionLeaderboard() {
  const stats = {};
  state.players.forEach(name => {
    stats[name] = { name, points: 0, conceded: 0, diff: 0, played: 0, wins: 0, losses: 0, avg: '0.0' };
  });

  state.rounds.forEach(r => {
    const s1 = Number(r.score1) || 0;
    const s2 = Number(r.score2) || 0;
    r.team1.forEach(p => {
      if (stats[p]) {
        stats[p].points += s1;
        stats[p].conceded += s2;
        stats[p].played += 1;
        if (s1 > s2) stats[p].wins += 1;
        else if (s2 > s1) stats[p].losses += 1;
      }
    });
    r.team2.forEach(p => {
      if (stats[p]) {
        stats[p].points += s2;
        stats[p].conceded += s1;
        stats[p].played += 1;
        if (s2 > s1) stats[p].wins += 1;
        else if (s1 > s2) stats[p].losses += 1;
      }
    });
  });

  const list = Object.values(stats).map(s => {
    s.diff = s.points - s.conceded;
    s.avg = s.played > 0 ? (s.points / s.played).toFixed(1) : '0.0';
    return s;
  });

  list.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.diff !== a.diff) return b.diff - a.diff;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.name.localeCompare(b.name);
  });

  return list;
}

// -------------------------------------------------------------
// RENDERING
// -------------------------------------------------------------
function renderAll() {
  renderSessionBar();
  renderActiveMatch();
  renderLeaderboard();
  renderHistory();
}

function formatDateDE(isoDate) {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '--.--.----';
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function renderSessionBar() {
  const dateEl = document.getElementById('sessionDateBadge');
  const locEl = document.getElementById('sessionLocationBadge');
  const playersEl = document.getElementById('sessionPlayersBadge');
  if (dateEl) dateEl.textContent = `📅 ${formatDateDE(state.played_date)}`;
  if (locEl) locEl.textContent = `📍 ${state.location || 'Ohne Ort'}`;
  if (playersEl) playersEl.textContent = `👥 ${state.players.length}`;
}

function renderActiveMatch() {
  const roundNum = state.rounds.length + 1;
  const roundTitle = document.getElementById('currentRoundTitle');
  if (roundTitle) roundTitle.textContent = `Runde ${roundNum}`;

  const brandTarget = document.getElementById('brandTargetDisplay');
  if (brandTarget) brandTarget.textContent = state.targetPoints;

  const targetDisplay = document.getElementById('targetPointsDisplay');
  if (targetDisplay) targetDisplay.textContent = state.targetPoints;

  document.querySelectorAll('.target-pill-btn').forEach(btn => {
    const pts = parseInt(btn.getAttribute('data-pts'), 10);
    btn.classList.toggle('active', pts === state.targetPoints);
  });

  document.querySelectorAll('.targetWinLabel').forEach(el => {
    el.textContent = state.targetPoints;
  });

  const match = state.currentMatch;
  if (!match) return;

  const buzzBanner = document.getElementById('buzzBanner');
  const hasBuzz = state.players.length > 4 && Boolean(match.buzzPlayer);
  if (buzzBanner) {
    buzzBanner.hidden = !hasBuzz;
  }

  const buzzEl = document.getElementById('buzzPlayerName');
  if (buzzEl) {
    buzzEl.textContent = match.buzzPlayer || 'Keiner';
    buzzEl.classList.toggle('swap-selected', selectedSwapSlot?.group === 'buzz');
  }

  renderTeamPlayers('team1Players', 'team1', match.team1);
  renderTeamPlayers('team2Players', 'team2', match.team2);

  const hintBar = document.getElementById('swapHintBar');
  if (hintBar) {
    if (selectedSwapSlot) {
      const selectedName = getSwapSlotName(match, selectedSwapSlot);
      hintBar.textContent = `🔄 ${selectedName} ausgewählt — tippe auf einen anderen Namen zum Tauschen`;
      hintBar.hidden = false;
    } else {
      hintBar.hidden = true;
    }
  }

  const t1Score = document.getElementById('t1Score');
  if (t1Score) t1Score.textContent = match.score1;

  const t2Score = document.getElementById('t2Score');
  if (t2Score) t2Score.textContent = match.score2;

  renderPresets();
}

function renderTeamPlayers(elementId, group, players) {
  const container = document.getElementById(elementId);
  if (!container) return;

  container.innerHTML = '';
  players.forEach((name, idx) => {
    if (idx > 0) {
      const amp = document.createElement('span');
      amp.className = 'team-amp';
      amp.textContent = '&';
      container.appendChild(amp);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'player-swap-btn';
    if (selectedSwapSlot && selectedSwapSlot.group === group && selectedSwapSlot.index === idx) {
      btn.classList.add('swap-selected');
    }
    btn.textContent = name;
    btn.title = 'Antippen zum Tauschen';
    btn.addEventListener('click', () => handlePlayerSwapClick(group, idx));
    container.appendChild(btn);
  });
}

function getSwapSlotName(match, slot) {
  if (!match || !slot) return '';
  if (slot.group === 'buzz') return match.buzzPlayer || '';
  return match[slot.group]?.[slot.index] || '';
}

function setSwapSlotName(match, slot, name) {
  if (!match || !slot) return;
  if (slot.group === 'buzz') {
    match.buzzPlayer = name;
  } else if (match[slot.group]) {
    match[slot.group][slot.index] = name;
  }
}

async function handlePlayerSwapClick(group, index) {
  const match = state.currentMatch;
  if (!match) return;

  if (!selectedSwapSlot) {
    selectedSwapSlot = { group, index };
    renderActiveMatch();
    return;
  }

  if (selectedSwapSlot.group === group && selectedSwapSlot.index === index) {
    selectedSwapSlot = null;
    renderActiveMatch();
    return;
  }

  const targetSlot = { group, index };
  const firstName = getSwapSlotName(match, selectedSwapSlot);
  const secondName = getSwapSlotName(match, targetSlot);

  if (firstName && secondName) {
    setSwapSlotName(match, selectedSwapSlot, secondName);
    setSwapSlotName(match, targetSlot, firstName);
    selectedSwapSlot = null;
    renderActiveMatch();
    await persistSessionFields({ current_match: match });
  } else {
    selectedSwapSlot = null;
    renderActiveMatch();
  }
}

function renderPresets() {
  const container = document.getElementById('presetButtonsContainer');
  if (!container) return;

  const N = state.targetPoints || 11;
  let pairs = [];
  if (N === 11) {
    pairs = [[11, 9], [11, 8], [11, 7], [11, 5], [9, 11], [8, 11], [7, 11], [5, 11]];
  } else if (N === 15) {
    pairs = [[15, 13], [15, 11], [15, 9], [15, 7], [13, 15], [11, 15], [9, 15], [7, 15]];
  } else if (N === 21) {
    pairs = [[21, 19], [21, 17], [21, 15], [21, 12], [19, 21], [17, 21], [15, 21], [12, 21]];
  } else {
    pairs = [[N, N - 2], [N, N - 3], [N, N - 5], [N - 2, N], [N - 3, N], [N - 5, N]];
  }

  container.innerHTML = '';
  pairs.forEach(([t1, t2]) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = `${t1} : ${t2}`;
    btn.addEventListener('click', () => {
      if (state.currentMatch) {
        state.currentMatch.score1 = t1;
        state.currentMatch.score2 = t2;
        renderActiveMatch();
        persistSessionFields({ current_match: state.currentMatch });
      }
    });
    container.appendChild(btn);
  });
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardBody');
  const titleEl = document.getElementById('leaderboardTitle');
  const subEl = document.getElementById('leaderboardSubtitle');

  let lb = [];
  if (leaderboardScope === 'overall' && overallStats) {
    lb = overallStats.leaderboard || [];
    if (titleEl) titleEl.textContent = '🏆 Gesamt-Tabelle';
    if (subEl) subEl.textContent = `${overallStats.sessionsCount} Spieltage • ${overallStats.roundsCount} Runden`;
  } else {
    lb = calculateSessionLeaderboard();
    if (titleEl) titleEl.textContent = '🏆 Spieltag-Tabelle';
    if (subEl) subEl.textContent = `${formatDateDE(state.played_date)} • ${state.location || 'Padel'}`;
  }

  renderLeaderboardRows(tbody, lb);
}

function renderHistory() {
  const container = document.getElementById('historyList');
  const subtitle = document.getElementById('historySubtitle');
  const badge = document.getElementById('roundsCountBadge');

  badge.textContent = state.rounds.length;
  subtitle.textContent = `${state.rounds.length} ${state.rounds.length === 1 ? 'Runde' : 'Runden'} beendet`;

  if (state.rounds.length === 0) {
    container.innerHTML = '<div class="empty-state">Noch keine Matches gespielt. Starte Runde 1 auf dem Court!</div>';
    return;
  }

  container.innerHTML = '';
  const reversed = [...state.rounds].reverse();

  reversed.forEach(round => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const t1Winner = round.score1 > round.score2;
    const t2Winner = round.score2 > round.score1;

    const pauseLabel = round.buzzPlayer ? ` • Pause: ${escapeHtml(round.buzzPlayer)}` : '';
    item.innerHTML = `
      <div class="history-main">
        <div class="history-round-tag">Runde ${round.roundNum}${pauseLabel}</div>
        <div class="history-matchup">
          <span style="${t1Winner ? 'color: var(--accent-blue); font-weight: 700;' : ''}">${escapeHtml(round.team1.join(' & '))}</span>
          <span style="color: var(--text-muted); margin: 0 4px;">vs</span>
          <span style="${t2Winner ? 'color: var(--accent-gold); font-weight: 700;' : ''}">${escapeHtml(round.team2.join(' & '))}</span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="history-score">${round.score1} : ${round.score2}</div>
        <div class="history-actions">
          <button class="btn-subtle btn-sm" onclick="openEditRoundDialog('${round.id}')">✏️</button>
          <button class="btn-subtle btn-sm" style="color: var(--danger);" onclick="deleteRound('${round.id}')">🗑️</button>
        </div>
      </div>
    `;
    container.appendChild(item);
  });
}

// -------------------------------------------------------------
// EVENT HANDLERS & MATCH FLOW
// -------------------------------------------------------------
function setupEventListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const target = btn.getAttribute('data-tab');
      document.getElementById(target).classList.add('active');

      if (target === 'tab-leaderboard' && leaderboardScope === 'overall') {
        await refreshSessionsAndOverall();
        renderLeaderboard();
      }
    });
  });

  document.querySelectorAll('.lb-scope-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      leaderboardScope = btn.getAttribute('data-scope') || 'session';
      document.querySelectorAll('.lb-scope-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-scope') === leaderboardScope);
      });
      if (leaderboardScope === 'overall') {
        await refreshSessionsAndOverall();
      }
      renderLeaderboard();
    });
  });

  document.getElementById('t1Plus').addEventListener('click', () => {
    if (state.currentMatch) {
      state.currentMatch.score1++;
      renderActiveMatch();
      persistSessionFields({ current_match: state.currentMatch });
    }
  });
  document.getElementById('t1Minus').addEventListener('click', () => {
    if (state.currentMatch && state.currentMatch.score1 > 0) {
      state.currentMatch.score1--;
      renderActiveMatch();
      persistSessionFields({ current_match: state.currentMatch });
    }
  });

  document.getElementById('t2Plus').addEventListener('click', () => {
    if (state.currentMatch) {
      state.currentMatch.score2++;
      renderActiveMatch();
      persistSessionFields({ current_match: state.currentMatch });
    }
  });
  document.getElementById('t2Minus').addEventListener('click', () => {
    if (state.currentMatch && state.currentMatch.score2 > 0) {
      state.currentMatch.score2--;
      renderActiveMatch();
      persistSessionFields({ current_match: state.currentMatch });
    }
  });

  document.querySelectorAll('.target-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pts = parseInt(btn.getAttribute('data-pts'), 10);
      if (pts) {
        state.targetPoints = pts;
        renderActiveMatch();
        persistSessionFields({ target_points: pts });
      }
    });
  });

  document.querySelectorAll('.btn-quick-score').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.currentMatch) return;
      const team = btn.getAttribute('data-team');
      if (team === '1') {
        state.currentMatch.score1 = state.targetPoints;
      } else {
        state.currentMatch.score2 = state.targetPoints;
      }
      renderActiveMatch();
      persistSessionFields({ current_match: state.currentMatch });
    });
  });

  document.getElementById('btnFinishRound').addEventListener('click', async () => {
    const match = state.currentMatch;
    if (!match || !state.id) return;

    if (match.score1 === 0 && match.score2 === 0) {
      alert('Bitte tragt zuerst den Punktestand für diese Runde ein!');
      return;
    }

    selectedSwapSlot = null;
    try {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(state.id)}/rounds`, {
        method: 'POST',
        body: JSON.stringify({
          buzzPlayer: match.buzzPlayer || '',
          team1: [...match.team1],
          team2: [...match.team2],
          score1: Number(match.score1),
          score2: Number(match.score2)
        })
      });
      applySessionData(data.session);
      renderAll();
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    } catch (err) {
      alert('Fehler beim Speichern der Runde: ' + err.message);
    }
  });

  document.getElementById('btnSwapBuzz').addEventListener('click', openSwapBuzzDialog);
  document.getElementById('buzzPlayerName').addEventListener('click', () => handlePlayerSwapClick('buzz', 0));

  document.getElementById('btnManagePlayers').addEventListener('click', openManagePlayersDialog);
  document.getElementById('btnAddPlayer').addEventListener('click', handleAddPlayer);
  document.getElementById('newPlayerInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddPlayer();
  });

  document.getElementById('btnResetTournament').addEventListener('click', () => {
    document.getElementById('dlgResetConfirm').showModal();
  });
  document.getElementById('btnConfirmReset').addEventListener('click', async () => {
    if (!state.id) return;
    selectedSwapSlot = null;
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(state.id)}/reset`, { method: 'POST' });
    applySessionData(data.session);
    renderAll();
    document.getElementById('dlgResetConfirm').close();
  });
  document.getElementById('btnCancelReset').addEventListener('click', () => {
    document.getElementById('dlgResetConfirm').close();
  });

  // Sessions & New Game
  document.getElementById('btnBackToHome').addEventListener('click', async () => {
    selectedSwapSlot = null;
    await refreshSessionsAndOverall();
    showHomeView();
  });
  document.getElementById('btnHomeNewSession').addEventListener('click', openNewSessionDialog);
  document.getElementById('btnOpenSessions').addEventListener('click', openSessionsDialog);
  document.getElementById('btnOpenNewSessionFromList').addEventListener('click', () => {
    document.getElementById('dlgSessions').close();
    openNewSessionDialog();
  });
  document.getElementById('btnCancelNewSession').addEventListener('click', () => {
    document.getElementById('dlgNewSession').close();
  });
  document.getElementById('btnAddCustomSessionPlayer').addEventListener('click', handleAddCustomSessionPlayer);
  document.getElementById('newSessionCustomPlayer').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCustomSessionPlayer();
    }
  });
  document.getElementById('newSessionForm').addEventListener('submit', handleCreateNewSession);
}

// -------------------------------------------------------------
// DIALOGS
// -------------------------------------------------------------
function setupDialogs() {
  const dialogs = [
    { dlg: document.getElementById('dlgPlayers'), closeBtn: document.getElementById('btnCloseDlgPlayers') },
    { dlg: document.getElementById('dlgSwapBuzz'), closeBtn: document.getElementById('btnCloseDlgBuzz') },
    { dlg: document.getElementById('dlgResetConfirm'), closeBtn: document.getElementById('btnCloseDlgReset') },
    { dlg: document.getElementById('dlgEditRound'), closeBtn: document.getElementById('btnCloseDlgEditRound') },
    { dlg: document.getElementById('dlgSessions'), closeBtn: document.getElementById('btnCloseDlgSessions') },
    { dlg: document.getElementById('dlgNewSession'), closeBtn: document.getElementById('btnCloseDlgNewSession') }
  ];

  dialogs.forEach(({ dlg, closeBtn }) => {
    if (closeBtn && dlg) {
      closeBtn.addEventListener('click', () => dlg.close());
    }
  });

  document.getElementById('btnSavePlayers').addEventListener('click', async () => {
    document.getElementById('dlgPlayers').close();
    await persistSessionFields({ players: state.players });
    renderAll();
  });

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isInside = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (!isInside) dialog.close();
      });
    });
  }
}

function renderHomeView() {
  renderSessionsListInto(document.getElementById('homeSessionsList'), false);

  const subEl = document.getElementById('homeOverallSubtitle');
  const tbody = document.getElementById('homeOverallBody');
  if (overallStats) {
    if (subEl) subEl.textContent = `${overallStats.sessionsCount} Spieltage • ${overallStats.roundsCount} Runden`;
    if (tbody) renderLeaderboardRows(tbody, overallStats.leaderboard || []);
  } else if (tbody) {
    tbody.innerHTML = '';
  }
}

function renderLeaderboardRows(tbody, lb) {
  tbody.innerHTML = '';
  lb.forEach((item, index) => {
    const tr = document.createElement('tr');
    let rankDisplay = `${index + 1}.`;
    let rankClass = '';
    if (index === 0) { rankDisplay = '🥇 1'; rankClass = 'rank-gold'; }
    else if (index === 1) { rankDisplay = '🥈 2'; rankClass = 'rank-silver'; }
    else if (index === 2) { rankDisplay = '🥉 3'; rankClass = 'rank-bronze'; }

    let diffClass = 'diff-zero';
    let diffDisplay = `${item.diff}`;
    if (item.diff > 0) {
      diffClass = 'diff-pos';
      diffDisplay = `+${item.diff}`;
    } else if (item.diff < 0) {
      diffClass = 'diff-neg';
    }

    tr.innerHTML = `
      <td class="td-rank ${rankClass}">${rankDisplay}</td>
      <td class="td-name">${escapeHtml(item.name)}</td>
      <td class="td-points">${item.points}</td>
      <td class="td-num">${item.played}</td>
      <td class="td-num">${item.wins}-${item.losses}</td>
      <td class="td-diff ${diffClass}">${diffDisplay}</td>
      <td class="td-num">${item.avg}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSessionsListInto(container, fromDialog) {
  if (!container) return;
  container.innerHTML = '';

  if (sessionsList.length === 0) {
    container.innerHTML = '<div class="empty-state">Noch keine Spieltage gespeichert. Starte ein neues Spiel!</div>';
    return;
  }

  sessionsList.forEach(s => {
    const item = document.createElement('div');
    item.className = `session-item ${s.id === state.id && !document.getElementById('view-home').hidden === false ? 'active' : ''}`;
    const title = s.title ? `${escapeHtml(s.title)} • ` : '';
    item.innerHTML = `
      <div class="session-item-main">
        <div class="session-item-title">${title}${formatDateDE(s.played_date)} — ${escapeHtml(s.location || 'Ohne Ort')}</div>
        <div class="session-item-meta">${s.roundCount} Runden • ${escapeHtml((s.players || []).join(', '))}</div>
      </div>
      <button type="button" class="btn-subtle btn-sm" style="color: var(--danger);" data-del-id="${s.id}" title="Spieltag löschen">🗑️</button>
    `;
    item.querySelector('.session-item-main').addEventListener('click', async () => {
      selectedSwapSlot = null;
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}`);
      applySessionData(data.session);
      if (!state.currentMatch && state.players.length >= 4) {
        state.currentMatch = generateNextMatch();
        await persistSessionFields({ current_match: state.currentMatch });
      }
      if (fromDialog) document.getElementById('dlgSessions').close();
      showGameView();
    });
    const delBtn = item.querySelector('[data-del-id]');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Spieltag ${formatDateDE(s.played_date)} wirklich löschen?`)) return;
        await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        if (s.id === state.id) {
          state.id = null;
          localStorage.removeItem(ACTIVE_SESSION_KEY);
        }
        await refreshSessionsAndOverall();
        if (fromDialog) {
          renderSessionsListInto(container, true);
          if (!state.id) {
            document.getElementById('dlgSessions').close();
            showHomeView();
          }
        } else {
          renderHomeView();
        }
      });
    }
    container.appendChild(item);
  });
}

// Sessions Management Dialog
async function openSessionsDialog() {
  await refreshSessionsAndOverall();
  renderSessionsListInto(document.getElementById('sessionsList'), true);
  document.getElementById('dlgSessions').showModal();
}

// New Session Dialog
let newSessionPlayerPool = [];
let newSessionSelectedPlayers = new Set();

async function openNewSessionDialog() {
  await refreshSessionsAndOverall();
  document.getElementById('newSessionDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('newSessionLocation').value = state.location || '';
  document.getElementById('newSessionTitle').value = '';
  document.getElementById('newSessionTarget').value = String(state.targetPoints || 11);

  const locContainer = document.getElementById('knownLocationsChips');
  locContainer.innerHTML = '';
  (overallStats?.knownLocations || []).forEach(loc => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-btn';
    btn.textContent = `📍 ${loc}`;
    btn.addEventListener('click', () => {
      document.getElementById('newSessionLocation').value = loc;
    });
    locContainer.appendChild(btn);
  });

  const known = new Set([...(overallStats?.knownPlayers || []), ...state.players]);
  newSessionPlayerPool = Array.from(known);
  newSessionSelectedPlayers = new Set(state.players);
  renderNewSessionPlayerChips();

  document.getElementById('dlgNewSession').showModal();
}

function renderNewSessionPlayerChips() {
  const container = document.getElementById('newSessionPlayersChips');
  container.innerHTML = '';
  newSessionPlayerPool.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `player-pick-chip ${newSessionSelectedPlayers.has(p) ? 'selected' : ''}`;
    btn.textContent = p;
    btn.addEventListener('click', () => {
      if (newSessionSelectedPlayers.has(p)) {
        newSessionSelectedPlayers.delete(p);
      } else {
        newSessionSelectedPlayers.add(p);
      }
      renderNewSessionPlayerChips();
    });
    container.appendChild(btn);
  });
}

function handleAddCustomSessionPlayer() {
  const input = document.getElementById('newSessionCustomPlayer');
  const name = input.value.trim();
  if (!name) return;
  if (!newSessionPlayerPool.includes(name)) {
    newSessionPlayerPool.push(name);
  }
  newSessionSelectedPlayers.add(name);
  input.value = '';
  renderNewSessionPlayerChips();
}

async function handleCreateNewSession(e) {
  e.preventDefault();
  const players = Array.from(newSessionSelectedPlayers);
  if (players.length < 4) {
    alert('Bitte mindestens 4 Mitspieler auswählen!');
    return;
  }
  const played_date = document.getElementById('newSessionDate').value;
  const location = document.getElementById('newSessionLocation').value.trim();
  const title = document.getElementById('newSessionTitle').value.trim();
  const target_points = parseInt(document.getElementById('newSessionTarget').value, 10) || 11;

  try {
    selectedSwapSlot = null;
    const data = await apiFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ played_date, location, title, target_points, players })
    });
    applySessionData(data.session);
    await refreshSessionsAndOverall();
    document.getElementById('dlgNewSession').close();
    showGameView();
  } catch (err) {
    alert('Fehler beim Erstellen des Spiels: ' + err.message);
  }
}

// Manage Players (current session)
function openManagePlayersDialog() {
  renderPlayersList();
  document.getElementById('dlgPlayers').showModal();
}

function renderPlayersList() {
  const list = document.getElementById('playersList');
  list.innerHTML = '';
  state.players.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = 'player-item';
    li.innerHTML = `
      <span>${escapeHtml(p)}</span>
      <button class="btn-delete-player" title="Entfernen" data-idx="${idx}">✕</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('.btn-delete-player').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (state.players.length <= 4) {
        alert('Mindestens 4 Spieler sind erforderlich für Americano Doppel!');
        return;
      }
      state.players.splice(idx, 1);
      renderPlayersList();
    });
  });
}

function handleAddPlayer() {
  const input = document.getElementById('newPlayerInput');
  const name = input.value.trim();
  if (!name) return;
  if (state.players.includes(name)) {
    alert('Dieser Name existiert bereits!');
    return;
  }
  state.players.push(name);
  input.value = '';
  renderPlayersList();
}

// Swap Buzz Dialog
function openSwapBuzzDialog() {
  const container = document.getElementById('swapBuzzOptions');
  container.innerHTML = '';

  state.players.forEach(p => {
    const isCurrent = state.currentMatch && state.currentMatch.buzzPlayer === p;
    const btn = document.createElement('button');
    btn.className = 'btn-swap-player';
    btn.innerHTML = `
      <span>☕ ${escapeHtml(p)}</span>
      <span style="font-size: 0.8rem; color: var(--text-muted);">${isCurrent ? 'Aktiv pausierend' : 'Jetzt Pause'}</span>
    `;
    btn.addEventListener('click', async () => {
      selectedSwapSlot = null;
      state.currentMatch = generateNextMatch(p);
      renderActiveMatch();
      await persistSessionFields({ current_match: state.currentMatch });
      document.getElementById('dlgSwapBuzz').close();
    });
    container.appendChild(btn);
  });

  document.getElementById('dlgSwapBuzz').showModal();
}

// Edit Past Round
let activeEditRoundId = null;

window.openEditRoundDialog = function(roundId) {
  const round = state.rounds.find(r => r.id === roundId);
  if (!round) return;
  activeEditRoundId = roundId;

  const body = document.getElementById('editRoundBody');
  body.innerHTML = `
    <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px;">
      Runde ${round.roundNum} (Pause: ${escapeHtml(round.buzzPlayer)})
    </p>
    <div class="edit-round-teams">
      <div class="edit-round-col">
        <label>Team Blau</label>
        <div class="team-names">${escapeHtml(round.team1.join(' & '))}</div>
        <input type="number" id="editT1Score" class="edit-round-input" min="0" max="99" value="${round.score1}">
      </div>
      <div class="edit-round-col">
        <label>Team Gold</label>
        <div class="team-names">${escapeHtml(round.team2.join(' & '))}</div>
        <input type="number" id="editT2Score" class="edit-round-input" min="0" max="99" value="${round.score2}">
      </div>
    </div>
  `;

  document.getElementById('dlgEditRound').showModal();
};

document.getElementById('btnSaveEditRound').addEventListener('click', async () => {
  if (!activeEditRoundId || !state.id) return;
  const s1 = parseInt(document.getElementById('editT1Score').value, 10);
  const s2 = parseInt(document.getElementById('editT2Score').value, 10);
  const data = await apiFetch(
    `/api/sessions/${encodeURIComponent(state.id)}/rounds/${encodeURIComponent(activeEditRoundId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ score1: isNaN(s1) ? 0 : s1, score2: isNaN(s2) ? 0 : s2 })
    }
  );
  applySessionData(data.session);
  renderAll();
  document.getElementById('dlgEditRound').close();
});

document.getElementById('btnCancelEditRound').addEventListener('click', () => {
  document.getElementById('dlgEditRound').close();
});

window.deleteRound = async function(roundId) {
  if (!state.id) return;
  if (confirm('Möchtest du diese Runde wirklich aus der Wertung löschen?')) {
    const data = await apiFetch(
      `/api/sessions/${encodeURIComponent(state.id)}/rounds/${encodeURIComponent(roundId)}`,
      { method: 'DELETE' }
    );
    applySessionData(data.session);
    renderAll();
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
