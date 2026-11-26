/**
 * Padel Americano - Ranch Mobile App
 * Optimized for continuous 5-player Americano tournaments up to 15 points
 */

// Initial configuration
const DEFAULT_PLAYERS = ['Simon', 'Tim', 'Adrian', 'Andre', 'Michael'];
const STORAGE_KEY = 'alpaca_padel_v1';
const TARGET_POINTS = 11;

// Tournament State
let state = {
  players: [...DEFAULT_PLAYERS],
  rounds: [], // { id, roundNum, buzzPlayer, team1: [p1, p2], team2: [p3, p4], score1: 0, score2: 0, timestamp }
  currentMatch: null, // { buzzPlayer, team1: [p1, p2], team2: [p3, p4], score1: 0, score2: 0 }
  targetPoints: TARGET_POINTS,
  migrated11: true
};

// Active 2-tap player swap selection: { group: 'team1' | 'team2' | 'buzz', index: number } | null
let selectedSwapSlot = null;

// Initialize App
function initApp() {
  loadState();
  if (!state.currentMatch) {
    state.currentMatch = generateNextMatch();
    saveState();
  }
  setupDialogs();
  setupEventListeners();
  renderAll();
}

// Storage helpers
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.players) && parsed.players.length >= 4) {
        state = parsed;
        // Migration to 11 points requested by Michael (keeps all games/players intact)
        if (!state.migrated11) {
          state.targetPoints = 11;
          state.migrated11 = true;
          saveState();
        }
      }
    }
  } catch (e) {
    console.error('Failed to parse state from localStorage', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state to localStorage', e);
  }
}

// -------------------------------------------------------------
// AMERICANO FAIR PAIRING GENERATOR
// -------------------------------------------------------------
function generateNextMatch(customBuzz = null) {
  const players = state.players;
  if (players.length < 4) return null;

  // 1. Determine who rests (Buzz)
  let buzzPlayer = customBuzz;
  if (!buzzPlayer) {
    const restCounts = {};
    players.forEach(p => restCounts[p] = 0);
    state.rounds.forEach(r => {
      if (r.buzzPlayer && restCounts[r.buzzPlayer] !== undefined) {
        restCounts[r.buzzPlayer]++;
      }
    });

    // Find player with minimum rest count; tie-break by longest time since last rest
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
      // Pick candidate who rested longest ago
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

  // 2. Active 4 players
  const activePlayers = players.filter(p => p !== buzzPlayer);

  // If more than 4 players, pick the 4 with fewest games played
  const sortedByGames = [...activePlayers].sort((a, b) => {
    const aGames = state.rounds.filter(r => r.team1.includes(a) || r.team2.includes(a)).length;
    const bGames = state.rounds.filter(r => r.team1.includes(b) || r.team2.includes(b)).length;
    return aGames - bGames;
  });
  const four = sortedByGames.slice(0, 4);

  // 3. Count historical partnerings and opposing matchups
  const partnerCount = {};
  const opponentCount = {};
  function key(p1, p2) {
    return [p1, p2].sort().join('::');
  }

  state.rounds.forEach(r => {
    // Partners
    const t1k = key(r.team1[0], r.team1[1]);
    const t2k = key(r.team2[0], r.team2[1]);
    partnerCount[t1k] = (partnerCount[t1k] || 0) + 1;
    partnerCount[t2k] = (partnerCount[t2k] || 0) + 1;

    // Opponents
    r.team1.forEach(p1 => {
      r.team2.forEach(p2 => {
        const oppk = key(p1, p2);
        opponentCount[oppk] = (opponentCount[oppk] || 0) + 1;
      });
    });
  });

  // 3 possible pairings of the 4 players:
  // Option 1: (0,1) vs (2,3)
  // Option 2: (0,2) vs (1,3)
  // Option 3: (0,3) vs (1,2)
  const options = [
    { t1: [four[0], four[1]], t2: [four[2], four[3]] },
    { t1: [four[0], four[2]], t2: [four[1], four[3]] },
    { t1: [four[0], four[3]], t2: [four[1], four[2]] }
  ];

  let bestOption = options[0];
  let minPenalty = Infinity;

  options.forEach(opt => {
    // Penalty heavily weights repeat partnerships, then repeat opponents
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
function calculateLeaderboard() {
  const stats = {};
  state.players.forEach(name => {
    stats[name] = {
      name,
      points: 0,
      conceded: 0,
      diff: 0,
      played: 0,
      wins: 0,
      losses: 0,
      avg: '0.0'
    };
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

  // Sort: Points DESC, Diff DESC, Wins DESC, Name ASC
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
  renderActiveMatch();
  renderLeaderboard();
  renderHistory();
}

function renderActiveMatch() {
  const roundNum = state.rounds.length + 1;
  const roundTitle = document.getElementById('currentRoundTitle');
  if (roundTitle) roundTitle.textContent = `Runde ${roundNum}`;
  
  const brandTarget = document.getElementById('brandTargetDisplay');
  if (brandTarget) brandTarget.textContent = state.targetPoints;

  const targetDisplay = document.getElementById('targetPointsDisplay');
  if (targetDisplay) targetDisplay.textContent = state.targetPoints;

  // Update target pill buttons active state
  document.querySelectorAll('.target-pill-btn').forEach(btn => {
    const pts = parseInt(btn.getAttribute('data-pts'), 10);
    btn.classList.toggle('active', pts === state.targetPoints);
  });

  // Update target win button labels
  document.querySelectorAll('.targetWinLabel').forEach(el => {
    el.textContent = state.targetPoints;
  });

  const match = state.currentMatch;
  if (!match) return;

  // Buzz / Pause
  const buzzEl = document.getElementById('buzzPlayerName');
  if (buzzEl) {
    buzzEl.textContent = match.buzzPlayer || 'Keiner';
    buzzEl.classList.toggle('swap-selected', selectedSwapSlot?.group === 'buzz');
  }

  // Team players (clickable to swap)
  renderTeamPlayers('team1Players', 'team1', match.team1);
  renderTeamPlayers('team2Players', 'team2', match.team2);

  // Swap hint banner
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

  // Scores
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

function handlePlayerSwapClick(group, index) {
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
    saveState();
  }

  selectedSwapSlot = null;
  renderActiveMatch();
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
        saveState();
      }
    });
    container.appendChild(btn);
  });
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardBody');
  const lb = calculateLeaderboard();

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
  // Show most recent rounds first
  const reversed = [...state.rounds].reverse();

  reversed.forEach(round => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const t1Winner = round.score1 > round.score2;
    const t2Winner = round.score2 > round.score1;

    item.innerHTML = `
      <div class="history-main">
        <div class="history-round-tag">Runde ${round.roundNum} • Pause: ${escapeHtml(round.buzzPlayer)}</div>
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
  // Navigation Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const target = btn.getAttribute('data-tab');
      document.getElementById(target).classList.add('active');
    });
  });

  // Score adjustments Team 1
  document.getElementById('t1Plus').addEventListener('click', () => {
    if (state.currentMatch) {
      state.currentMatch.score1++;
      renderActiveMatch();
      saveState();
    }
  });
  document.getElementById('t1Minus').addEventListener('click', () => {
    if (state.currentMatch && state.currentMatch.score1 > 0) {
      state.currentMatch.score1--;
      renderActiveMatch();
      saveState();
    }
  });

  // Score adjustments Team 2
  document.getElementById('t2Plus').addEventListener('click', () => {
    if (state.currentMatch) {
      state.currentMatch.score2++;
      renderActiveMatch();
      saveState();
    }
  });
  document.getElementById('t2Minus').addEventListener('click', () => {
    if (state.currentMatch && state.currentMatch.score2 > 0) {
      state.currentMatch.score2--;
      renderActiveMatch();
      saveState();
    }
  });

  // Target points switcher (11 / 15 / 21)
  document.querySelectorAll('.target-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pts = parseInt(btn.getAttribute('data-pts'), 10);
      if (pts) {
        state.targetPoints = pts;
        saveState();
        renderActiveMatch();
      }
    });
  });

  // Quick win buttons
  document.querySelectorAll('.btn-quick-score').forEach(btn => {
    btn.addEventListener('click', () => {
      const team = btn.getAttribute('data-team');
      if (team === '1') {
        state.currentMatch.score1 = state.targetPoints;
      } else {
        state.currentMatch.score2 = state.targetPoints;
      }
      renderActiveMatch();
      saveState();
    });
  });

  // Finish Round
  document.getElementById('btnFinishRound').addEventListener('click', () => {
    const match = state.currentMatch;
    if (!match) return;

    if (match.score1 === 0 && match.score2 === 0) {
      alert('Bitte tragt zuerst den Punktestand für diese Runde ein!');
      return;
    }

    const roundData = {
      id: 'round_' + Date.now(),
      roundNum: state.rounds.length + 1,
      buzzPlayer: match.buzzPlayer,
      team1: [...match.team1],
      team2: [...match.team2],
      score1: Number(match.score1),
      score2: Number(match.score2),
      timestamp: new Date().toISOString()
    };

    state.rounds.push(roundData);
    // Generate next round automatically
    selectedSwapSlot = null;
    state.currentMatch = generateNextMatch();
    saveState();
    renderAll();

    // Haptic feedback if supported
    if (navigator.vibrate) {
      navigator.vibrate([40, 60, 40]);
    }
  });

  // Swap Buzz Dialog trigger & Buzz player name tap-to-swap
  document.getElementById('btnSwapBuzz').addEventListener('click', openSwapBuzzDialog);
  document.getElementById('buzzPlayerName').addEventListener('click', () => handlePlayerSwapClick('buzz', 0));

  // Manage Players Dialog
  document.getElementById('btnManagePlayers').addEventListener('click', openManagePlayersDialog);
  document.getElementById('btnAddPlayer').addEventListener('click', handleAddPlayer);
  document.getElementById('newPlayerInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddPlayer();
  });

  // Reset Tournament Dialog
  document.getElementById('btnResetTournament').addEventListener('click', () => {
    document.getElementById('dlgResetConfirm').showModal();
  });
  document.getElementById('btnConfirmReset').addEventListener('click', () => {
    state.rounds = [];
    selectedSwapSlot = null;
    state.currentMatch = generateNextMatch();
    saveState();
    renderAll();
    document.getElementById('dlgResetConfirm').close();
  });
  document.getElementById('btnCancelReset').addEventListener('click', () => {
    document.getElementById('dlgResetConfirm').close();
  });
}

// -------------------------------------------------------------
// DIALOG MANAGEMENT & MODERN WEB GUIDANCE COMPLIANCE
// -------------------------------------------------------------
function setupDialogs() {
  const dialogs = [
    { dlg: document.getElementById('dlgPlayers'), closeBtn: document.getElementById('btnCloseDlgPlayers') },
    { dlg: document.getElementById('dlgSwapBuzz'), closeBtn: document.getElementById('btnCloseDlgBuzz') },
    { dlg: document.getElementById('dlgResetConfirm'), closeBtn: document.getElementById('btnCloseDlgReset') },
    { dlg: document.getElementById('dlgEditRound'), closeBtn: document.getElementById('btnCloseDlgEditRound') }
  ];

  // Close buttons
  dialogs.forEach(({ dlg, closeBtn }) => {
    if (closeBtn && dlg) {
      closeBtn.addEventListener('click', () => dlg.close());
    }
  });

  document.getElementById('btnSavePlayers').addEventListener('click', () => {
    document.getElementById('dlgPlayers').close();
    saveState();
    renderAll();
  });

  // Light-dismiss fallback for browsers without closedby support (Safari etc.)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (!isDialogContent) {
          dialog.close();
        }
      });
    });
  }
}

// Manage Players
function openManagePlayersDialog() {
  const list = document.getElementById('playersList');
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
    btn.addEventListener('click', (e) => {
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
    btn.addEventListener('click', () => {
      selectedSwapSlot = null;
      state.currentMatch = generateNextMatch(p);
      saveState();
      renderActiveMatch();
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

document.getElementById('btnSaveEditRound').addEventListener('click', () => {
  if (!activeEditRoundId) return;
  const round = state.rounds.find(r => r.id === activeEditRoundId);
  if (round) {
    const s1 = parseInt(document.getElementById('editT1Score').value, 10);
    const s2 = parseInt(document.getElementById('editT2Score').value, 10);
    round.score1 = isNaN(s1) ? 0 : s1;
    round.score2 = isNaN(s2) ? 0 : s2;
    saveState();
    renderAll();
  }
  document.getElementById('dlgEditRound').close();
});

document.getElementById('btnCancelEditRound').addEventListener('click', () => {
  document.getElementById('dlgEditRound').close();
});

// Delete Round
window.deleteRound = function(roundId) {
  if (confirm('Möchtest du diese Runde wirklich aus der Wertung löschen?')) {
    state.rounds = state.rounds.filter(r => r.id !== roundId);
    // Renumber rounds
    state.rounds.forEach((r, idx) => r.roundNum = idx + 1);
    saveState();
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

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
