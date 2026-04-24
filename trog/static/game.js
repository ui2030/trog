/* ── STATE ──────────────────────────────── */
let ws = null;
let myId = null;
let isOwner = false;
let isSpectator = false;            // 🆕 관전자 모드 여부
let selectedClass = '전사';
let selectedRace = null;   // 🆕 null 이면 서버가 랜덤 배정, 값 있으면 그 종족으로 고정
let selectedWeapon = null; // 🆕 null 이면 클래스 기본 무기 사용
let selectedAnimal = '늑대'; // 🆕 수인 전용 — 동물 종류 (기본 늑대)
let selectedRatio = 50;    // 🆕 수인 전용 — 인간/동물 비율 (10~90, 기본 반반)
// 수인 비율 경계값. 0=인간, 100=짐승 이라 정체성상 수인이 아니므로 서버에서 거부됨.
const BEASTFOLK_RATIO_MIN = 10;
const BEASTFOLK_RATIO_MAX = 90;
let currentRoomCode = '';  // 현재 방 코드 — 게임 화면 헤더 뱃지에 표시
let myRace = null;
let reconnectTimer = null;
let currentTurnPlayerId = null;  // 현재 턴 플레이어의 id

const SESSION_KEY = 'trog-session';

/* ── SESSION PERSISTENCE ───────────────── */
function saveSession(room_id, player_id) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ room_id, player_id, ts: Date.now() }));
  } catch (_) {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // 2시간 넘으면 폐기
    if (Date.now() - (s.ts || 0) > 2 * 60 * 60 * 1000) return null;
    return s;
  } catch (_) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/* ── CLASS SELECTION ────────────────────── */
document.querySelectorAll('.class-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.class-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedClass = card.dataset.class;
    renderWeaponOptions();
  });
});
document.querySelector('[data-class="전사"]').classList.add('selected');

/* ── WEAPON SELECTION ───────────────────── */
const WEAPON_OPTIONS = {
  '전사': [
    { name: '녹슨 장검',      emoji: '🗡️', effect: '균형잡힌 한손검 — 출혈 확률 소폭' },
    { name: '거대한 양손도끼', emoji: '🪓', effect: '양손 무기 — 공격력 +3, 속도 -1' },
    { name: '뾰족한 창',      emoji: '🔱', effect: '긴 리치 — 선제공격 보너스' },
  ],
  '마법사': [
    { name: '견습생의 지팡이', emoji: '🪄', effect: '균형잡힌 지팡이 — MP 소비 -10%' },
    { name: '서리 오브',       emoji: '🔮', effect: '냉기 주문 강화 — 슬로우 부여' },
    { name: '화염 완드',       emoji: '🔥', effect: '화염 주문 강화 — 광역 피해 +15%' },
  ],
  '도적': [
    { name: '쌍단검',       emoji: '🗡️', effect: '2회 공격 — 치명타 확률 +10%' },
    { name: '짧은 석궁',    emoji: '🏹', effect: '원거리 공격 — 은신 중 피해 +25%' },
    { name: '독 바른 단도', emoji: '🧪', effect: '독 부여 — 매 턴 HP -3 (3턴)' },
  ],
  '성직자': [
    { name: '축복받은 철퇴', emoji: '🔨', effect: '언데드에 추가 피해 +20%' },
    { name: '성스러운 원드', emoji: '🪄', effect: '신성 주문 MP 소비 -20%' },
    { name: '은빛 망치',     emoji: '🔆', effect: '치유 주문 +10% — 팀 버프' },
  ],
};

// weapon-grid 에 클릭 delegation 한 번만 바인딩.
// 카드가 innerHTML 로 재생성돼도 delegation 은 유효하므로 stale closure / 리스너 유실 이슈가 원천 차단된다.
(function bindWeaponGrid() {
  const grid = document.getElementById('weapon-grid');
  if (!grid || grid.dataset.bound) return;
  grid.dataset.bound = '1';
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.weapon-card');
    if (!card || !grid.contains(card)) return;
    grid.querySelectorAll('.weapon-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedWeapon = card.dataset.weapon;
  });
})();

function renderWeaponOptions() {
  const grid = document.getElementById('weapon-grid');
  if (!grid) return;
  const opts = WEAPON_OPTIONS[selectedClass] || [];
  grid.innerHTML = '';
  opts.forEach((w, i) => {
    const card = document.createElement('div');
    card.className = 'weapon-card' + (i === 0 ? ' selected' : '');
    card.dataset.weapon = w.name;
    card.innerHTML = `
      <div class="weapon-emoji">${w.emoji}</div>
      <div class="weapon-name">${escapeHtmlStr(w.name)}</div>
      <div class="weapon-desc">${escapeHtmlStr(w.effect)}</div>
    `;
    grid.appendChild(card);
  });
  selectedWeapon = opts.length ? opts[0].name : null;
}

// escapeHtml은 나중에 정의되므로 엔트리 화면 렌더용 경량 헬퍼
function escapeHtmlStr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

renderWeaponOptions();

/* ── RACE SELECTION (토글 + 카드) ───────── */
const raceToggle = document.getElementById('race-manual-toggle');
const raceGrid   = document.getElementById('race-grid');
const raceHint   = document.getElementById('race-random-hint');
if (raceToggle && raceGrid) {
  raceToggle.addEventListener('change', () => {
    if (raceToggle.checked) {
      raceGrid.style.display = 'grid';
      raceHint.style.display = 'none';
      // 처음 열면 안내
      if (!selectedRace) {
        // 아무 것도 선택 안 했을 때 힌트
      }
    } else {
      raceGrid.style.display = 'none';
      raceHint.style.display = 'block';
      // 토글 해제하면 선택도 초기화 (서버에 null 보냄 = 랜덤)
      selectedRace = null;
      document.querySelectorAll('.race-card').forEach(c => c.classList.remove('selected'));
      // 🆕 수인 서브 UI 도 같이 접기 — 안 접으면 사용자가 "수인 골랐다" 착각 → 실제론 race 미전송 → 랜덤 배정 버그
      const bfCfg = document.getElementById('beastfolk-config');
      if (bfCfg) bfCfg.style.display = 'none';
    }
  });
}
document.querySelectorAll('.race-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.race-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedRace = card.dataset.race;
    // 🆕 수인일 때만 sub-UI 노출. 다른 종족이면 숨김.
    const bfCfg = document.getElementById('beastfolk-config');
    if (bfCfg) bfCfg.style.display = (selectedRace === '수인') ? '' : 'none';
  });
});

/* ── 수인(Beastfolk) sub-UI ───────────────── */
// 서버 프롬프트와 맞춘 5단 버킷 라벨. 서버 _beastfolk_portrait 의 버킷 경계(25/45/55/70)에 동기.
function _beastfolkBucketLabel(r) {
  if (r <= 25) return '인간형 — 귀·꼬리만 살짝 드러난 섬세한 수인';
  if (r <= 45) return '약(弱)혼혈 — 얼굴선과 털이 살짝 보이는 인간 쪽';
  if (r <= 55) return '반수인 — 인간과 짐승이 반반 드러난 혼혈';
  if (r <= 70) return '강(强)혼혈 — 주둥이·털이 두드러지는 짐승 쪽';
  return '수형 — 동물성이 강하게 나타난 영웅 (여전히 휴머노이드)';
}

// 버킷 라벨은 `_beastfolkBucketLabel` 로 일원화. 호환용 레거시 구간(하위 3단) 동시 제공.
function _legacyBucketLabel(r) {
  if (r <= 33) return '인간형';
  if (r <= 66) return '반수인';
  return '수형 — 짐승의 모습이 짙게 드러난다';
}
(function initBeastfolkUI() {
  // 동물 그리드 — 기본 늑대 선택 상태 반영
  const animalGrid = document.getElementById('beastfolk-animal-grid');
  if (animalGrid) {
    const applyAnimalSelection = () => {
      animalGrid.querySelectorAll('.beastfolk-animal').forEach(el => {
        el.classList.toggle('selected', el.dataset.animal === selectedAnimal);
      });
    };
    applyAnimalSelection();
    animalGrid.addEventListener('click', (e) => {
      const el = e.target.closest('.beastfolk-animal');
      if (!el || !animalGrid.contains(el)) return;
      selectedAnimal = el.dataset.animal;
      applyAnimalSelection();
    });
  }
  // 비율 슬라이더
  const slider = document.getElementById('beastfolk-ratio-slider');
  const valueEl = document.getElementById('beastfolk-ratio-value');
  const bucketEl = document.getElementById('beastfolk-ratio-bucket');
  if (slider) {
    // 서버 검증과 맞춰 10~90 범위로 제한. 0/100 은 '수인' 정체성 경계에서 모순.
    slider.min = String(BEASTFOLK_RATIO_MIN);
    slider.max = String(BEASTFOLK_RATIO_MAX);
    if (parseInt(slider.value, 10) < BEASTFOLK_RATIO_MIN) slider.value = String(BEASTFOLK_RATIO_MIN);
    if (parseInt(slider.value, 10) > BEASTFOLK_RATIO_MAX) slider.value = String(BEASTFOLK_RATIO_MAX);
    const syncRatio = () => {
      const raw = parseInt(slider.value, 10);
      selectedRatio = Math.max(BEASTFOLK_RATIO_MIN, Math.min(BEASTFOLK_RATIO_MAX, isNaN(raw) ? 50 : raw));
      if (valueEl) valueEl.textContent = `${selectedRatio}%`;
      if (bucketEl) bucketEl.textContent = _beastfolkBucketLabel(selectedRatio);
    };
    slider.addEventListener('input', syncRatio);
    syncRatio();
  }
})();

function buildJoinPayload(baseType, extra) {
  // 서버에 보낼 공통 페이로드 — race 는 체크박스 + 선택 있을 때만 포함
  const p = { type: baseType, ...extra };
  if (raceToggle && raceToggle.checked && selectedRace) {
    p.race = selectedRace;
    // 🆕 수인 선택 시 동물·비율 함께 전송
    if (selectedRace === '수인') {
      p.race_animal = selectedAnimal;
      p.race_ratio = selectedRatio;
    }
  }
  if (selectedWeapon) {
    p.weapon_choice = selectedWeapon;
  }
  return p;
}


/* ── ENTRY BUTTONS ──────────────────────── */
document.getElementById('create-room-btn').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  if (!name) return alert('이름을 입력하세요!');
  if (raceToggle && raceToggle.checked && !selectedRace) {
    return alert('종족을 직접 선택하거나, 체크박스를 해제해서 랜덤으로 돌리세요.');
  }
  const payload = buildJoinPayload('create_room', {
    player_name: name,
    character_class: selectedClass,
  });
  // 🐛 진단 로그 — race 미스매치 추적용 (콘솔 F12 에서 확인 가능)
  console.log('[CREATE_ROOM] sending payload:', payload,
              '| toggle.checked=', raceToggle && raceToggle.checked,
              '| selectedRace=', selectedRace,
              '| selectedAnimal=', selectedAnimal,
              '| selectedRatio=', selectedRatio);
  connect(payload);
});

// 🆕 join_room 재전송 용 pending state (takeover 모달에서 새 캐릭 선택 시 필요)
let _pendingJoin = null;

document.getElementById('join-room-btn').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!name) return alert('이름을 입력하세요!');
  if (!code) return alert('방 코드를 입력하세요!');
  if (raceToggle && raceToggle.checked && !selectedRace) {
    return alert('종족을 직접 선택하거나, 체크박스를 해제해서 랜덤으로 돌리세요.');
  }
  _pendingJoin = buildJoinPayload('join_room', {
    room_id: code,
    player_name: name,
    character_class: selectedClass,
  });
  connect(_pendingJoin);
});

document.getElementById('room-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('join-room-btn').click();
});

/* ── SPECTATOR ENTRY ────────────────────── */
function doSpectate() {
  const code = (document.getElementById('spectate-code').value || '').trim().toUpperCase();
  if (!code) return alert('관전할 방 코드를 입력하세요.');
  // 관전자 이름은 user name 칸이 있으면 그대로, 없으면 익명.
  const nm = (document.getElementById('player-name').value || '').trim().slice(0, 16);
  isSpectator = true;
  connect({ type: 'join_as_spectator', room_id: code, spectator_name: nm });
}
const spectateBtn = document.getElementById('spectate-btn');
if (spectateBtn) spectateBtn.addEventListener('click', doSpectate);
const spectateCodeInp = document.getElementById('spectate-code');
if (spectateCodeInp) {
  spectateCodeInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSpectate();
  });
}

/* ── READY TOGGLE ───────────────────────── */
const readyBtn = document.getElementById('ready-btn');
if (readyBtn) {
  readyBtn.addEventListener('click', () => {
    if (!ws) return;
    ws.send(JSON.stringify({ type: 'toggle_ready' }));
  });
}

/* ── WAITING ROOM CHAT ──────────────────── */
function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text || !ws) return;
  ws.send(JSON.stringify({ type: 'chat_message', text }));
  inp.value = '';
}
const chatSendBtn = document.getElementById('chat-send-btn');
if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);
const chatInput = document.getElementById('chat-input');
if (chatInput) {
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
}

function appendChatEntry(entry) {
  // 대기실 채팅, 게임 채팅 양쪽에 모두 추가
  const logs = document.querySelectorAll('.chat-log');
  if (!logs.length) return;
  const isMine = entry.player_id === myId;
  const isSpec = !!entry.is_spectator;
  const emoji = isSpec ? '👁' : (entry.race_emoji || entry.emoji || '🧑');
  const specBadge = isSpec ? '<span class="chat-spec-badge">(관전자)</span>' : '';
  logs.forEach(log => {
    const row = document.createElement('div');
    row.className = 'chat-entry'
      + (isMine ? ' mine' : '')
      + (isSpec ? ' spectator' : '');
    row.innerHTML = `
      <span class="chat-name">${emoji} ${escapeHtml(entry.name)}${specBadge}</span>
      <span class="chat-text">${escapeHtml(entry.text)}</span>
    `;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  });
}

/* ── GAME CHAT INPUT (char-panel 쪽, 대기실 채팅과 동일한 WS 메시지 공유) ──
   🐛 Fix: 이전 버전은 DOMContentLoaded 핸들러에서 바인딩했으나,
   game.js 가 <body> 끝에 로드돼 이미 DOMContentLoaded 가 발화한 뒤라 바인딩이 무시됐음.
   → 엘리먼트가 즉시 존재하므로 모듈 로드 시점에 직접 바인딩. */
function sendGameChat() {
  const inp = document.getElementById('game-chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text || !ws) return;
  if (isSpectator) {
    pushErrorToast('관전자는 채팅을 보낼 수 없습니다.');
    return;
  }
  ws.send(JSON.stringify({ type: 'chat_message', text }));
  inp.value = '';
}
(function bindGameChatImmediate() {
  const btn = document.getElementById('game-chat-send-btn');
  const inp = document.getElementById('game-chat-input');
  if (btn) btn.addEventListener('click', sendGameChat);
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') sendGameChat(); });
})();

document.getElementById('send-btn').addEventListener('click', sendAction);
document.getElementById('action-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendAction();
});

document.querySelectorAll('.q-btn').forEach(btn => {
  btn.addEventListener('click', () => sendRaw(btn.dataset.action));
});

/* ── DICE ROLL ──────────────────────────── */
const DIE_MAX = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100 };
// 🔒 서버가 직접 난수를 굴린다. 클라는 "굴려달라" 요청만 보내고 결과는 dice_rolled 브로드캐스트로 받는다.
// (이전엔 Math.random() 을 클라가 계산 → DevTools 로 항상 20 찍기 가능 했음.)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.dice-btn');
  if (!btn || !btn.dataset.die) return;
  const die = btn.dataset.die;
  if (!DIE_MAX[die] || !ws) return;
  ws.send(JSON.stringify({ type: 'dice_roll', die }));
  btn.classList.remove('rolling');
  void btn.offsetWidth;
  btn.classList.add('rolling');
});

// 주사위 확장 토글
document.getElementById('dice-expand-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();  // 확장 버튼 자체가 dice-btn 클릭으로 오인되지 않게 (data-die 없으니 무시되지만 안전)
  const extras = document.getElementById('dice-extras');
  const btn = e.currentTarget;
  if (!extras) return;
  const isOpen = !extras.hasAttribute('hidden');
  if (isOpen) {
    extras.setAttribute('hidden', '');
    btn.textContent = '▾';
  } else {
    extras.removeAttribute('hidden');
    btn.textContent = '▴';
  }
});

function sendAction() {
  if (isSpectator) return;
  const inp = document.getElementById('action-input');
  const val = inp.value.trim();
  if (!val) return;
  sendRaw(val);
  inp.value = '';
}

function sendRaw(action) {
  if (!ws || isSpectator) return;
  ws.send(JSON.stringify({ type: 'player_action', action }));
  showDmTyping(true);
}

/* ── WEBSOCKET ──────────────────────────── */
function connect(firstMsg) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify(firstMsg));
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    sysMsg('서버 연결이 끊어졌습니다. 3초 뒤 재연결 시도...');
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const s = loadSession();
  if (!s) return;  // 저장된 세션 없으면 그냥 끝
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'rejoin_room',
      room_id: s.room_id,
      player_id: s.player_id,
    }));
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = () => scheduleReconnect();
  }, 3000);
}

/* ── MESSAGE HANDLER ────────────────────── */
function handle(d) {
  // 서버가 players 동봉하는 모든 브로드캐스트에 monsters 필드를 자동 포함해서 보냄.
  // 타입별 case 마다 호출하지 않아도 되도록 switch 앞에서 일괄 렌더.
  if (Array.isArray(d.monsters)) renderMonsters(d.monsters);
  switch (d.type) {
    case 'room_created':
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      showWaiting(d.room_id, d.players);
      updateOwnerToolsVisibility();
      if (Array.isArray(d.dormant)) refreshDormantList(d.dormant);
      // 🐛 진단 — 내가 요청한 종족과 서버가 배정한 종족이 일치하는지 토스트로 확인
      if (raceToggle && raceToggle.checked && selectedRace) {
        const me = (d.players || []).find(p => p.player_id === d.player_id);
        const assigned = me && me.race;
        console.log('[CREATE_ROOM] server assigned race:', assigned, '| I requested:', selectedRace);
        if (assigned && assigned !== selectedRace) {
          const layer = ensureToastLayer();
          pushToast(layer,
            `⚠ 종족 미스매치 — 요청: ${selectedRace} / 배정: ${assigned}. 서버 재시작/강제 새로고침 필요할 수 있음.`,
            'toast-error');
        }
      }
      break;

    case 'joined_room':
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      if (d.started) {
        showGame(d.players);
        updateTimeBadge(d.current_time);
        // 🆕 지금까지의 서사 로그 전부 재생 (신규 입장자도 이전 대화 볼 수 있음)
        replayNarrativeLog(d.narrative_log, d.players);
        if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
      } else {
        showWaiting(d.room_id, d.players);
      }
      // 파티 채팅 로그 복원
      if (Array.isArray(d.chat_log)) {
        document.querySelectorAll('.chat-log').forEach(l => l.innerHTML = '');
        d.chat_log.forEach(appendChatEntry);
      }
      updateOwnerToolsVisibility();
      if (Array.isArray(d.dormant)) refreshDormantList(d.dormant);
      if (d.took_over && d.taken_over_name) {
        sysMsg(`🎭 ${d.taken_over_name}의 자리를 이어받았습니다 — 인벤토리 / 레벨 / 장비가 그대로 복원됩니다`);
      }
      break;

    case 'rejoin_ok':
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      if (d.started) {
        showGame(d.players);
        updateTimeBadge(d.current_time);
        // 🆕 narrative_log 있으면 그걸로 전체 재생 (없으면 last_dm 폴백)
        if (Array.isArray(d.narrative_log) && d.narrative_log.length) {
          replayNarrativeLog(d.narrative_log, d.players);
        } else if (d.last_dm) {
          dmMsg(d.last_dm, false);
        }
        if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
        sysMsg('재연결되었습니다.');
      } else {
        showWaiting(d.room_id, d.players);
        sysMsg('대기실로 복귀했습니다.');
      }
      updateOwnerToolsVisibility();
      // 채팅 로그 복원 (대기실/게임 모두)
      if (Array.isArray(d.chat_log)) {
        document.querySelectorAll('.chat-log').forEach(l => l.innerHTML = '');
        d.chat_log.forEach(appendChatEntry);
      }
      if (Array.isArray(d.dormant)) refreshDormantList(d.dormant);
      break;

    case 'chat_broadcast':
      if (d.entry) appendChatEntry(d.entry);
      break;

    case 'dice_rolled':
      renderDiceRoll(d);
      break;

    case 'joined_as_spectator':
      isSpectator = true;
      myId = d.spectator_id;
      enterSpectatorMode(d);
      break;

    case 'spectator_joined':
      sysMsg(`👁 ${d.spectator_name}이(가) 관전을 시작했습니다. (총 ${d.spectator_count}명)`);
      break;

    case 'spectator_left':
      sysMsg(`👁 관전자 한 명이 나갔습니다. (총 ${d.spectator_count}명)`);
      break;

    case 'turn_auto_skipped':
      sysMsg(`⏭ ${d.skipped_player_name}의 턴이 스킵됨 (${d.reason || '알 수 없음'})`);
      if (d.turn_player_id !== undefined) {
        updateTurnIndicator(d.turn_player_id, _lastSeenPlayers || []);
      }
      break;

    case 'dormant_choice':
      // 🆕 방에 takeover 가능한 휴면 캐릭터가 있음 — 사용자 선택 유도
      openTakeoverModal(d);
      break;

    case 'dm_interlude':
      // 🆕 퇴장/복귀 DM 내러티브 (일반 DM 메시지와 동일 스타일로 렌더)
      if (d.text) dmMsg(d.text, true);
      if (d.kind === 'departure' && d.player_name) {
        sysMsg(`👋 ${d.player_name}이(가) 파티를 떠났습니다 (2분 후 이어받기 가능)`);
      } else if (d.kind === 'return' && d.player_name) {
        sysMsg(`✨ ${d.player_name}이(가) 돌아왔습니다`);
      } else if (d.kind === 'takeover' && d.player_name) {
        sysMsg(`🎭 새 영웅이 ${d.player_name}의 자리를 이어받았습니다`);
      }
      break;

    case 'ready_updated':
      refreshWaitingList(d.players);
      updateReadyBtnState(d.players);
      break;

    case 'rejoin_failed':
      clearSession();
      sysMsg(`재연결 실패: ${d.reason || '알 수 없음'}`);
      // 엔트리 화면 강제
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById('entry-screen').classList.add('active');
      document.getElementById('game-screen').style.display = '';
      break;

    case 'player_joined':
      addWaitingCard(d.player);
      break;

    case 'player_rejoined':
      sysMsg(`${d.player_name}이(가) 돌아왔습니다.`);
      break;

    case 'game_started':
      showGame(d.players);
      updateTimeBadge(d.current_time);
      showDmTyping(false);
      setTimeout(() => dmMsg(d.dm_text, true), 1800);
      if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
      break;

    case 'action_taken':
      playerMsg(d.player_name, d.action, d.player_emoji, d.portrait_url);
      break;

    case 'dm_response':
      showDmTyping(false);
      updateTimeBadge(d.current_time);
      // DM 주사위는 본문 내 [🎲DM d20:X] 태그를 formatDmInline 이 뱃지로 변환하여 우측 정렬로 노출한다.
      // (예전엔 여기서 renderDmDiceRoll 로 별도 칩 행을 찍었으나 본문과 중복되어 가독성이 떨어져 제거)
      // 직전 플레이어의 액션 버블에 맥락 이미지 부착 (DM 응답 참조)
      attachActionImageToLastBubble(d.acting_player_id, d.players, d.text);
      dmMsg(d.text, true);
      refreshPlayers(d.players);
      refreshCharPanel(d.players);
      if (d.events) showEventToasts(d.events);
      if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
      // 라운드 완료 시 상단 장면 배너 업데이트 (파티 종족을 씬에 섞어서 일관성)
      if (d.round_complete) {
        updateSceneBanner(d.text, d.current_time, d.players);
      }
      break;

    case 'portrait_updated':
      refreshPlayers(d.players);
      refreshCharPanel(d.players);
      refreshWaitingList(d.players);
      break;

    case 'player_left':
      sysMsg(`${d.player_name}이(가) 파티를 떠났습니다.`);
      refreshPlayers(d.players);
      refreshWaitingList(d.players);
      updateReadyBtnState(d.players);
      if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
      if (Array.isArray(d.dormant)) refreshDormantList(d.dormant);
      break;

    case 'dormant_unlocked':
      sysMsg(`⚡ ${d.target_name}의 휴면 잠금이 ${d.by}에 의해 해제됨 — 이제 누구나 이어받기 가능`);
      if (Array.isArray(d.dormant)) refreshDormantList(d.dormant);
      break;

    case 'dormant_unlock_pending': {
      // 🔒 force_unlock 2단계 — 서버가 확인 요청. 사용자에게 한 번 더 묻고 confirm:true 로 재전송.
      const name = d.target_name || '해당 캐릭터';
      const secs = d.elapsed_sec ?? '?';
      const ok = confirm(
        `${name} 이(가) 파티를 떠난 지 ${secs}초.\n\n` +
        `지금 타이머를 해제하면 **누구나** 이 캐릭터를 이어받을 수 있게 됩니다.\n` +
        `본인이 돌아올 수 없음이 확실합니까?`
      );
      if (ok && d.target_id && ws) {
        ws.send(JSON.stringify({ type: 'force_unlock_dormant', target_id: d.target_id, confirm: true }));
      }
      break;
    }

    case 'owner_vacant':
      sysMsg('⚠ 방장이 없습니다. 다음 입장자 또는 재접속자가 자동으로 방장이 됩니다.');
      isOwner = false;
      updateOwnerToolsVisibility && updateOwnerToolsVisibility();
      break;

    case 'owner_changed':
      if (d.new_owner_id === myId) {
        isOwner = true;
        sysMsg(`당신이 새 방장이 되었습니다.`);
      } else {
        sysMsg(`${d.new_owner_name}이(가) 새 방장이 되었습니다.`);
      }
      updateOwnerToolsVisibility();
      break;

    case 'owner_granted':
      isOwner = true;
      updateOwnerToolsVisibility();
      break;

    case 'stat_point_spent':
      // 🆕 레벨업 포인트 분배 결과 — 전원 패널 갱신 + 본인만 간단한 피드백 토스트.
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_id === myId) {
        const labelMap = { max_hp: '체력', max_mp: '마력', attack: '공격', defense: '방어' };
        const label = labelMap[d.stat] || d.stat;
        const layer = ensureToastLayer();
        pushToast(layer, `✨ ${label} +${d.delta} (남은 포인트 ${d.remaining_points})`, 'toast-xp');
      }
      break;

    case 'item_used':
      // 🆕 서버가 UI-트리거 아이템 사용을 확정 — 인벤토리/상태 즉시 반영
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_name && d.item) {
        const layer = ensureToastLayer();
        pushToast(layer, `🧪 ${d.player_name} 이(가) '${d.item}' 사용 (남은 ${d.remaining})`, 'toast-item-mine');
      }
      break;

    case 'kicked':
      alert(`방장(${d.by || '알 수 없음'})에 의해 강퇴되었습니다.`);
      clearSession();
      try { if (ws) ws.close(); } catch (_) {}
      location.href = location.pathname;
      break;

    case 'left_room':
      // 서버가 퇴장 확정 — 클라이언트는 finalizeLeave에서 이미 대응 중
      break;

    case 'error':
      showDmTyping(false);
      sysMsg(`⚠ ${d.message}`);
      // 대기실 등 narr-log 없는 화면에서도 보이게 토스트로도 띄우기
      pushErrorToast(d.message);
      break;

    case 'game_starting':
      // 전원 준비됨 → DM 호출 중. 대기실 준비 힌트에 표시
      const hint = document.getElementById('ready-hint');
      if (hint) hint.textContent = '🎲 DM이 서사를 준비 중입니다...';
      showDmTyping(true);
      break;
  }
}

/* ── RACE REVEAL ────────────────────────── */
// 🆕 종족 라벨 헬퍼 — 수인이면 "수인 (늑대·반수인·55%)" 형식, 아니면 "엘프" 처럼 단순.
//    파티 카드 / 캐릭터 패널 / 대기실 박스 / takeover 카드 어디서든 재사용.
function raceLabel(p) {
  if (!p) return '';
  if (p.race !== '수인' || p.race_animal == null) return p.race || '';
  const r = (typeof p.race_ratio === 'number') ? p.race_ratio : 50;
  const bucket = r <= 33 ? '인간형' : (r <= 66 ? '반수인' : '수형');
  return `수인 (${p.race_animal}·${bucket}·${r}%)`;
}

function revealMyRace(players) {
  const me = players.find(p => p.player_id === myId);
  if (!me) return;
  myRace = me.race;
  const box = document.getElementById('my-race-box');
  box.style.display = 'block';
  document.getElementById('my-race-emoji').textContent = me.race_emoji || '🧑';
  // 🆕 수인이면 "수인 (늑대 · 반수인 · 55%)" 처럼 세부 정보 함께 표시
  let raceName = me.race;
  let raceDesc = me.race_desc || '';
  if (me.race === '수인' && me.race_animal != null) {
    const r = (typeof me.race_ratio === 'number') ? me.race_ratio : 50;
    const bucket = r <= 33 ? '인간형' : (r <= 66 ? '반수인' : '수형');
    raceName = `수인 (${me.race_animal} · ${bucket} · ${r}%)`;
    raceDesc = `${raceDesc} — ${me.race_animal}의 피가 ${bucket} 수준으로 드러난다`;
  }
  document.getElementById('my-race-name').textContent = raceName;
  document.getElementById('my-race-desc').textContent = raceDesc;
  document.getElementById('draw-title').textContent = `${raceName} ${me.character_class} 그리기`;
  document.getElementById('draw-hint').textContent = `${raceDesc} — 자유롭게 그려보세요`;
}

/* ── WAITING SCREEN ─────────────────────── */
function showWaiting(roomId, players) {
  // 대기실은 게임 아님 — 엣지 탭/HUD 숨김
  document.body.classList.remove('in-game');
  hide('entry-screen');
  hide('game-screen');
  show('waiting-screen');
  document.getElementById('game-screen').style.display = '';

  document.getElementById('display-room-code').textContent = roomId;
  refreshWaitingList(players);
  updateReadyBtnState(players);
  // 방 코드 기억 — 나중에 game 진입 시 헤더 뱃지에 주입
  currentRoomCode = roomId;
}

function updateReadyBtnState(players) {
  const btn = document.getElementById('ready-btn');
  const lbl = document.getElementById('ready-btn-label');
  const chk = document.getElementById('ready-btn-check');
  const hint = document.getElementById('ready-hint');
  if (!btn) return;
  const me = players.find(p => p.player_id === myId);
  if (!me) return;
  if (me.is_ready) {
    btn.classList.add('ready-on');
    lbl.textContent = '⏳ 준비 완료 (다시 눌러 해제)';
    chk.style.display = 'inline';
  } else {
    btn.classList.remove('ready-on');
    lbl.textContent = '⚔️ 모험 시작!';
    chk.style.display = 'none';
  }
  const readyCount = players.filter(p => p.is_ready).length;
  const total = players.length;
  if (hint) hint.textContent = `${readyCount} / ${total} 준비됨 — 모두 누르면 자동 시작`;
}

function refreshWaitingList(players) {
  _lastSeenPlayers = players;
  const list = document.getElementById('waiting-list');
  list.innerHTML = '';
  players.forEach(addWaitingCard);
}

function addWaitingCard(p) {
  const list = document.getElementById('waiting-list');
  const existing = list.querySelector(`[data-pid="${p.player_id}"]`);
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'waiting-card' + (p.is_ready ? ' ready' : '');
  el.dataset.pid = p.player_id;
  const meTag = p.player_id === myId ? ' <span class="me-tag">나</span>' : '';
  const customBadge = p.has_custom_portrait ? ' 🎨' : '';
  const readyCheck = p.is_ready ? '<span class="waiting-ready">✓</span>' : '';
  // 방장이고 본인이 아니면 강퇴 버튼 노출
  const kickBtn = (isOwner && p.player_id !== myId)
    ? `<button class="waiting-kick" data-kick="${p.player_id}" title="강퇴">✕</button>`
    : '';
  el.innerHTML = `
    <img src="${p.portrait_url}" alt="${escapeHtml(p.name)}" class="waiting-portrait portrait-enlarge"
         data-full="${p.portrait_url}" data-caption="${escapeHtml(p.name)} — ${escapeHtml(p.race + ' ' + p.character_class)}"
         onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span style="font-size:1.5rem;display:none">${p.emoji}</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700">${escapeHtml(p.name)}${meTag}${customBadge}</div>
      <div style="color:var(--muted);font-size:.78rem">${p.race_emoji || ''} ${raceLabel(p)} · ${p.character_class}</div>
    </div>
    ${readyCheck}
    ${kickBtn}
  `;
  list.appendChild(el);

  // 강퇴 버튼 이벤트
  const kb = el.querySelector('.waiting-kick');
  if (kb) {
    kb.addEventListener('click', (e) => {
      e.stopPropagation();
      const tid = kb.dataset.kick;
      if (!tid || !ws) return;
      if (confirm(`${p.name}을(를) 강퇴합니까?`)) {
        ws.send(JSON.stringify({ type: 'kick_player', target_id: tid }));
      }
    });
  }
}

/* ── GAME SCREEN ────────────────────────── */
/* ── 신규/재입장자를 위한 서사 로그 재생 ──
   서버가 내려준 narrative_log 배열을 타입별로 렌더. */
function replayNarrativeLog(log, players) {
  if (!Array.isArray(log) || !log.length) return;
  const narrLog = document.getElementById('narr-log');
  if (narrLog) narrLog.innerHTML = '';
  // 라이브 애니메이션 없이, 순차적으로 조용히 채움
  log.forEach((ev, idx) => {
    try {
      if (ev.type === 'dm') {
        // 애니메이션 false 로 즉시 렌더, 마지막 하나만 typewriter 느낌
        const isLast = idx === log.length - 1;
        dmMsg(ev.text || '', false);
      } else if (ev.type === 'action') {
        playerMsg(ev.player_name || '?', ev.action || '',
                  ev.player_emoji || '', ev.portrait_url || '');
      } else if (ev.type === 'dice') {
        renderDiceRoll({
          player_id: ev.player_id,
          name: ev.name,
          emoji: ev.emoji,
          die: ev.die,
          result: ev.result,
          max: ev.max,
        });
      } else if (ev.type === 'sys') {
        sysMsg(ev.text || '');
      }
    } catch (e) {
      // 한 이벤트 실패해도 나머지 진행
      console.warn('replay event skipped', ev, e);
    }
  });
  // 진입 안내
  sysMsg(`📜 지금까지의 모험 ${log.length}개 항목 복원됨`);
  if (narrLog) narrLog.scrollTop = narrLog.scrollHeight;
}

function showGame(players) {
  // 모바일 엣지 탭/HUD 는 body.in-game 상태일 때만 나타남 (엔트리/대기실에선 안 보임)
  document.body.classList.add('in-game');
  // 방 코드 뱃지 갱신 — 게임 중에도 확인 가능, 클릭하면 복사
  const rcBadge = document.getElementById('room-code-badge');
  if (rcBadge && currentRoomCode) {
    rcBadge.textContent = `🔑 ${currentRoomCode}`;
    rcBadge.style.display = 'inline-block';
    if (!rcBadge.dataset.bound) {
      rcBadge.dataset.bound = '1';
      rcBadge.addEventListener('click', () => {
        navigator.clipboard?.writeText(currentRoomCode).then(
          () => { rcBadge.textContent = '✓ 복사됨'; setTimeout(() => rcBadge.textContent = `🔑 ${currentRoomCode}`, 1200); },
          () => { sysMsg('복사 실패 — 수동으로 기억해주세요: ' + currentRoomCode); }
        );
      });
    }
  }
  hide('waiting-screen');
  hide('entry-screen');
  const gs = document.getElementById('game-screen');
  gs.style.display = 'grid';
  gs.classList.add('active');

  document.getElementById('narr-log').innerHTML = '';
  refreshPlayers(players);
  refreshCharPanel(players);

  const seq = [
    ['party-panel',     200],
    ['narrative-panel', 500],
    ['char-panel',      800],
    ['action-bar',     1100],
  ];
  seq.forEach(([id, delay]) => {
    setTimeout(() => document.getElementById(id).classList.add('show'), delay);
  });

  renderCustomActions();
  initMobileDrawers();
}

/* ── MOBILE SIDE DRAWERS (파티 / 내 캐릭터) ──
   모바일에선 이 두 패널이 기본 숨김. 헤더 버튼 또는 엣지 탭 또는 미니 HUD 로 여닫음. */
let _drawersBound = false;
function initMobileDrawers() {
  if (_drawersBound) return;
  _drawersBound = true;
  // 헤더 토글 버튼 (구 방식, 기본은 CSS 로 숨김) — 혹시 남아있으면 여전히 작동
  document.getElementById('toggle-party-btn')?.addEventListener('click', () => toggleDrawer('party-panel'));
  document.getElementById('toggle-char-btn')?.addEventListener('click', () => toggleDrawer('char-panel'));
  // 엣지 탭
  document.getElementById('edge-tab-party')?.addEventListener('click', () => toggleDrawer('party-panel'));
  document.getElementById('edge-tab-char')?.addEventListener('click', () => toggleDrawer('char-panel'));
  // 좌상단 미니 HUD 클릭 → 내 캐릭터 상세
  document.getElementById('mobile-mini-hud')?.addEventListener('click', () => toggleDrawer('char-panel'));
}

/* ── 좌상단 미니 HUD 갱신 (HP/MP 아크 + 초상화 + 레벨) ── */
function updateMiniHud(me) {
  if (!me) return;
  const img = document.getElementById('mini-hud-portrait');
  const lvlEl = document.getElementById('mini-hud-lvl');
  if (img && me.portrait_url && img.src !== me.portrait_url) img.src = me.portrait_url;
  if (lvlEl) lvlEl.textContent = `Lv.${me.level || 1}`;

  const hp    = typeof me.hp === 'number' ? me.hp : 0;
  const maxHp = typeof me.max_hp === 'number' ? me.max_hp : 1;
  const mp    = typeof me.mp === 'number' ? me.mp : 0;
  const maxMp = typeof me.max_mp === 'number' ? me.max_mp : 1;

  // 반원 길이 = PI * r (r=26) ≈ 81.68. stroke-dasharray 는 CSS에서 82로 설정.
  const ARC = 82;
  const hpRatio = Math.max(0, Math.min(1, hp / maxHp));
  const mpRatio = Math.max(0, Math.min(1, maxMp > 0 ? mp / maxMp : 0));

  const hpFill = document.querySelector('.hud-hp-fill');
  const mpFill = document.querySelector('.hud-mp-fill');
  if (hpFill) {
    // 비율만큼만 보이도록 dashoffset 조정 (채워진 부분 = ARC*ratio, 나머지는 가려짐)
    hpFill.style.strokeDashoffset = `${ARC * (1 - hpRatio)}`;
    // HP 낮으면 색 변경
    const pct = hpRatio * 100;
    const col = pct > 60 ? 'var(--hp-hi)' : pct > 30 ? 'var(--hp-mid)' : 'var(--hp-lo)';
    hpFill.style.stroke = col;
  }
  if (mpFill) {
    mpFill.style.strokeDashoffset = `${ARC * (1 - mpRatio)}`;
  }
}

// 진짜 모바일 뷰일 때만 드로어 작동 — CSS breakpoint(720px)와 일치해야 함
function isMobileViewport() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function toggleDrawer(id) {
  if (!isMobileViewport()) return;   // 데스크탑/태블릿에선 무시 (CSS 도 비활성)
  const panel = document.getElementById(id);
  if (!panel) return;
  const other = id === 'party-panel' ? 'char-panel' : 'party-panel';
  const otherEl = document.getElementById(other);
  if (otherEl) otherEl.classList.remove('drawer-open');
  panel.classList.toggle('drawer-open');
  updateDrawerBackdrop();
}

function closeAllDrawers() {
  document.getElementById('party-panel')?.classList.remove('drawer-open');
  document.getElementById('char-panel')?.classList.remove('drawer-open');
  updateDrawerBackdrop();
}

function updateDrawerBackdrop() {
  let bd = document.getElementById('mobile-drawer-backdrop');
  const anyOpen = document.querySelector('.party-panel.drawer-open, .char-panel.drawer-open');
  // 데스크탑이 되면 백드롭/드로어 상태 깨끗이 정리
  if (!isMobileViewport()) {
    document.querySelectorAll('.drawer-open').forEach(el => el.classList.remove('drawer-open'));
    if (bd) bd.classList.remove('visible');
    return;
  }
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'mobile-drawer-backdrop';
    bd.className = 'mobile-drawer-backdrop';
    bd.addEventListener('click', closeAllDrawers);
    document.body.appendChild(bd);
  }
  bd.classList.toggle('visible', !!anyOpen);
}

// 창 크기 바뀔 때 (예: 태블릿 회전) 자동 정리
window.addEventListener('resize', () => {
  if (!isMobileViewport()) {
    document.querySelectorAll('.drawer-open').forEach(el => el.classList.remove('drawer-open'));
    document.getElementById('mobile-drawer-backdrop')?.classList.remove('visible');
  }
});

// ESC 로도 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllDrawers();
});

/* ── PLAYER / CHAR PANELS ───────────────── */

/* ── 몬스터 카드 렌더링 ──
   DM 이 `[적 등장 / 적 HP / 적 상태 / 적 퇴장]` 태그로 갱신. 비어있으면 섹션 숨김.
   서버가 broadcast 에 monsters 필드를 자동 주입하므로 players 핸들러 옆에서 함께 호출. */
function renderMonsters(monsters) {
  const section = document.getElementById('monster-section');
  const list = document.getElementById('monster-list');
  if (!section || !list) return;
  const arr = Array.isArray(monsters) ? monsters : [];
  if (!arr.length) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  section.style.display = '';
  list.innerHTML = '';
  arr.forEach(m => {
    const hp = Number(m.hp) || 0;
    const max = Math.max(1, Number(m.max_hp) || 1);
    const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
    const hpCls = pct >= 60 ? 'hp-hi' : (pct >= 25 ? 'hp-mid' : 'hp-lo');
    const card = document.createElement('div');
    card.className = 'monster-card' + (hp <= 0 ? ' defeated' : '');
    card.innerHTML = `
      <div class="monster-row">
        <span class="monster-name">👹 ${escapeHtml(m.name || '?')}</span>
        <span class="monster-hp-text">${hp} / ${max}</span>
      </div>
      <div class="monster-hp-bar"><div class="monster-hp-fill ${hpCls}" style="width:${pct}%"></div></div>
      ${m.status_note ? `<div class="monster-status">${escapeHtml(m.status_note)}</div>` : ''}
    `;
    list.appendChild(card);
  });
}

/* ── 휴면 캐릭터 목록 렌더링 ──
   파티 떠난 사람들. 방장에겐 "즉시 해제" 버튼. 타이머 남아있으면 카운트다운 표시. */
function refreshDormantList(dormantArr) {
  const section = document.getElementById('dormant-section');
  const list = document.getElementById('dormant-list');
  if (!section || !list) return;
  const arr = Array.isArray(dormantArr) ? dormantArr : [];
  if (!arr.length) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  section.style.display = 'block';
  list.innerHTML = '';
  arr.forEach(d => {
    const card = document.createElement('div');
    card.className = 'dormant-card' + (d.takeover_ready ? ' ready' : ' locked');
    card.dataset.pid = d.player_id;
    const statusHtml = d.takeover_ready
      ? '<span class="dormant-status ready">✓ 이어받기 가능</span>'
      : `<span class="dormant-status locked">🔒 ${d.unlock_in_sec}초 남음</span>`;
    const unlockBtn = (isOwner && !d.takeover_ready)
      ? `<button class="dormant-unlock-btn" data-unlock="${d.player_id}" title="지금 바로 이어받기 잠금 해제">⚡ 즉시 해제</button>`
      : '';
    card.innerHTML = `
      <img class="dormant-portrait" src="${d.portrait_url}" alt="${escapeHtml(d.name)}"
           onerror="this.style.display='none'">
      <div class="dormant-info">
        <div class="dormant-name">${escapeHtml(d.name)} <span class="dormant-lvl">Lv.${d.level}</span></div>
        <div class="dormant-class">${escapeHtml(raceLabel(d))} · ${escapeHtml(d.character_class)}</div>
        ${statusHtml}
      </div>
      ${unlockBtn}
    `;
    const btn = card.querySelector('.dormant-unlock-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pid = btn.dataset.unlock;
        if (!pid || !ws) return;
        // 🔒 2단계 확인. 1차로 서버에 확인 요청 → dormant_unlock_pending 이벤트 수신 →
        // 유저에게 한 번 더 confirm → 2차 요청(confirm=true).
        // 방장이 잠깐 끊긴 플레이어 캐릭터를 임의로 다른 사람에게 넘기는 실수를 방지.
        ws.send(JSON.stringify({ type: 'force_unlock_dormant', target_id: pid, confirm: false }));
      });
    }
    list.appendChild(card);
  });
}

let _partyCollapsed = (() => {
  try { return localStorage.getItem('trog-party-collapsed') === '1'; } catch (_) { return false; }
})();

function setPartyCollapsed(v) {
  _partyCollapsed = !!v;
  try { localStorage.setItem('trog-party-collapsed', v ? '1' : '0'); } catch (_) {}
  const panel = document.getElementById('party-panel');
  if (panel) panel.classList.toggle('collapsed-cards', _partyCollapsed);
  const btn = document.getElementById('party-collapse-btn');
  if (btn) btn.textContent = _partyCollapsed ? '▣' : '◧';
  if (_lastSeenPlayers) refreshPlayers(_lastSeenPlayers);
}

function renderStatusChips(statuses) {
  if (!Array.isArray(statuses) || !statuses.length) return '';
  const chips = statuses.map(st => {
    const cls = st.kind === '버프' ? 'buff' : 'debuff';
    const emoji = st.kind === '버프' ? '✨' : '☠';
    const tip = st.effect ? `${st.name} (${st.turns_remaining}턴)\n${st.effect}` : `${st.name} (${st.turns_remaining}턴)`;
    return `<span class="status-chip ${cls}" title="${escapeHtml(tip)}">
              ${emoji} ${escapeHtml(st.name)}
              <span class="status-turns">${st.turns_remaining}턴</span>
            </span>`;
  }).join('');
  return `<div class="status-row">${chips}</div>`;
}

function refreshPlayers(players) {
  _lastSeenPlayers = players;
  const list = document.getElementById('party-list');
  list.innerHTML = '';
  const panel = document.getElementById('party-panel');
  if (panel) panel.classList.toggle('collapsed-cards', _partyCollapsed);
  players.forEach((p, i) => {
    const hpPct = Math.round((p.hp / p.max_hp) * 100);
    const hpCol = hpPct > 60 ? 'var(--hp-hi)' : hpPct > 30 ? 'var(--hp-mid)' : 'var(--hp-lo)';
    const mp    = typeof p.mp === 'number' ? p.mp : 0;
    const maxMp = typeof p.max_mp === 'number' ? p.max_mp : 0;
    const mpPct = maxMp > 0 ? Math.round((mp / maxMp) * 100) : 0;
    const kickBtn = (isOwner && !isSpectator && p.player_id !== myId)
      ? `<button class="pc-kick" data-kick-pid="${p.player_id}" title="강퇴 / 턴 자동 스킵">✕</button>`
      : '';
    const statusChips = renderStatusChips(p.status_effects);

    const card = document.createElement('div');
    card.className = 'player-card' + (p.player_id === myId ? ' mine' : '');
    card.dataset.pid = p.player_id;
    card.style.animationDelay = `${i * 80}ms`;

    if (_partyCollapsed) {
      // 접힌 카드: 좌측 HP 게이지 | 초상화+이름 | 우측 MP 게이지
      card.classList.add('compact');
      card.innerHTML = `
        <div class="pc-compact-row">
          <div class="pc-gauge-v hp" title="HP ${p.hp}/${p.max_hp}">
            <div class="pc-gauge-fill hp-fill" style="height:${hpPct}%;background:${hpCol}"></div>
            <span class="pc-gauge-lbl">HP</span>
          </div>
          <div class="pc-compact-mid">
            <img src="${p.portrait_url}" alt="${p.name}" class="pc-compact-portrait portrait-enlarge"
                 data-full="${p.portrait_url}" data-caption="${escapeHtml(p.name)}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
            <span class="pc-emoji-fallback" style="display:none">${p.emoji}</span>
            <div class="pc-compact-name">${escapeHtml(p.name)} <span class="pc-lvl">Lv.${p.level}</span></div>
          </div>
          <div class="pc-gauge-v mp" title="MP ${mp}/${maxMp}">
            <div class="pc-gauge-fill mp-fill" style="height:${mpPct}%"></div>
            <span class="pc-gauge-lbl">MP</span>
          </div>
          ${kickBtn}
        </div>
        ${statusChips}
      `;
    } else {
      card.innerHTML = `
        <div class="pc-head">
          <div class="pc-sprite-wrap">
            <div class="pc-sprite walk-idle">
              <img src="${p.portrait_url}" alt="${p.name}" class="pc-portrait portrait-enlarge" data-full="${p.portrait_url}" data-caption="${escapeHtml(p.name)} — ${escapeHtml(p.race + ' ' + p.character_class + ' · Lv.' + p.level)}"
                   onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
              <span class="pc-emoji-fallback" style="display:none">${p.emoji}</span>
            </div>
          </div>
          <div class="pc-info">
            <div class="pc-name">
              ${p.name}
              <span class="pc-lvl">Lv.${p.level}</span>
              ${p.player_id === myId ? '<span style="color:var(--gold);font-size:.7rem">(나)</span>' : ''}
            </div>
            <div class="pc-class">${p.race_emoji || ''} ${raceLabel(p)} · ${p.character_class}</div>
          </div>
          ${kickBtn}
        </div>
        <div class="hp-label">HP ${p.hp} / ${p.max_hp}</div>
        <div class="hp-track"><div class="hp-fill" style="width:${hpPct}%;background:${hpCol}"></div></div>
        <div class="mp-label">MP ${mp} / ${maxMp}</div>
        <div class="mp-track"><div class="mp-fill" style="width:${mpPct}%"></div></div>
        ${statusChips}
      `;
    }
    list.appendChild(card);
  });

  list.querySelectorAll('.pc-kick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tid = btn.dataset.kickPid;
      if (!tid || !ws) return;
      const target = (players || []).find(x => x.player_id === tid);
      const nm = target ? target.name : '이 플레이어';
      if (confirm(`${nm}을(를) 강퇴합니까? (게임 중이면 턴이 자동 스킵됩니다)`)) {
        ws.send(JSON.stringify({ type: 'kick_player', target_id: tid }));
      }
    });
  });
}

(function bindPartyCollapse() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'party-collapse-btn') {
      setPartyCollapsed(!_partyCollapsed);
    }
  });
})();

function refreshCharPanel(players) {
  const me = players.find(p => p.player_id === myId);
  if (!me) return;
  updateMiniHud(me);  // 모바일 좌상단 HUD 도 같이 갱신
  const hpPct = Math.round((me.hp / me.max_hp) * 100);
  const hpCol = hpPct > 60 ? 'var(--hp-hi)' : hpPct > 30 ? 'var(--hp-mid)' : 'var(--hp-lo)';

  // 🆕 MP 진행도
  const mp    = typeof me.mp === 'number' ? me.mp : 0;
  const maxMp = typeof me.max_mp === 'number' ? me.max_mp : 0;
  const mpPct = maxMp > 0 ? Math.round((mp / maxMp) * 100) : 0;

  // XP 진행도: 다음 레벨까지 비율
  const xpNeeded = (me.xp_to_next || 0) + (me.xp - xpBaseForLevel(me.level));
  const xpProgress = xpNeeded > 0
    ? Math.round(((me.xp - xpBaseForLevel(me.level)) / xpNeeded) * 100)
    : 0;

  // 🆕 장착 장비 3슬롯 — 효과 툴팁: 알려진 효과 or "효과: 아직 잘 모르겠다"
  const eq = me.equipped || {};
  const slot = (icon, label, item) => {
    // item 은 문자열 또는 {name, effect} 딕트 허용
    const data = (item && typeof item === 'object') ? item : { name: item || '', effect: null };
    const name = data.name || '';
    if (!name) {
      return `<div class="eq-slot eq-empty" title="비어 있음">
                <span class="eq-icon">${icon}</span>
                <span class="eq-label">${label}</span>
                <span class="eq-item">—</span>
              </div>`;
    }
    const effect = data.effect;
    const tip = effect
      ? `${name}\n효과: ${effect}`
      : `${name}\n효과: 아직 잘 모르겠다`;
    const cls = effect ? 'has-effect' : 'effect-unknown';
    const effLine = effect
      ? `<span class="eq-effect">${escapeHtml(effect)}</span>`
      : `<span class="eq-effect eq-unk">효과: 아직 잘 모르겠다</span>`;
    return `<div class="eq-slot ${cls}" title="${escapeHtml(tip)}">
              <div class="eq-row">
                <span class="eq-icon">${icon}</span>
                <span class="eq-label">${label}</span>
                <span class="eq-item">${escapeHtml(name)}</span>
              </div>
              ${effLine}
            </div>`;
  };
  const equipHtml = `
    <div class="equipment">
      <div class="eq-title">🛡 장착 중</div>
      ${slot('⚔️', '무기',   eq.weapon)}
      ${slot('🛡',  '방어구', eq.armor)}
      ${slot('💎', '장신구', eq.accessory)}
    </div>
  `;

  const inv = Array.isArray(me.inventory) ? me.inventory : [];
  // 인벤토리 요소는 이제 {name, effect} 딕트. (구 포맷 '문자열'도 방어적으로 처리)
  const renderItem = (it) => {
    const obj = (typeof it === 'string') ? { name: it, effect: null, quantity: 1 } : (it || {});
    const name = obj.name || '';
    const effect = obj.effect;
    const qty = (typeof obj.quantity === 'number' && obj.quantity > 0) ? obj.quantity : 1;
    const qtyHtml = qty > 1 ? `<span class="inv-item-qty">×${qty}</span>` : '';
    const title = effect
      ? `${name}${qty > 1 ? ' ×' + qty : ''}\n효과: ${effect}`
      : `${name}${qty > 1 ? ' ×' + qty : ''}\n(효과 미확인)`;
    const useBtn = `<button class="inv-use-btn" data-use-item="${escapeHtml(name)}" title="이 아이템을 1개 사용">사용</button>`;
    return `
      <div class="inv-item ${effect ? 'has-effect' : 'effect-unknown'}" title="${escapeHtml(title)}">
        <div class="inv-item-head">
          <div class="inv-item-name">${escapeHtml(name)}${qtyHtml}</div>
          ${useBtn}
        </div>
        <div class="inv-item-effect">${effect ? escapeHtml(effect) : '<span class="unk">? 아직 알 수 없음</span>'}</div>
      </div>
    `;
  };
  const invHtml = inv.length
    ? `<div class="inventory">
         <div class="inv-title">🎒 소지품 (${inv.length})</div>
         <div class="inv-list">${inv.map(renderItem).join('')}</div>
       </div>`
    : `<div class="inventory inv-empty">🎒 소지품 없음</div>`;

  const myStatusChips = renderStatusChips(me.status_effects);

  document.getElementById('char-body').innerHTML = `
    <div class="char-avatar">
      <div class="char-sprite-wrap">
        <div class="char-sprite walk-idle">
          <img src="${me.portrait_url}" alt="${me.name}" class="char-portrait portrait-enlarge" data-full="${me.portrait_url}" data-caption="${escapeHtml(me.name)} — ${escapeHtml(me.race + ' ' + me.character_class + ' · Lv.' + me.level)}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
          <span class="char-emoji-fallback" style="display:none">${me.emoji}</span>
        </div>
      </div>
    </div>
    <div class="char-name">${me.name}</div>
    <div class="char-sub">${me.race_emoji || ''} ${raceLabel(me)} · ${me.character_class} · <span class="lvl-chip">Lv.${me.level}</span></div>

    <div class="stat-row"><span class="stat-lbl">HP</span><span class="stat-val" style="color:${hpCol}">${me.hp} / ${me.max_hp}</span></div>
    <div class="hp-track" style="margin-top:.2rem">
      <div class="hp-fill" style="width:${hpPct}%;background:${hpCol}"></div>
    </div>

    <div class="stat-row" style="margin-top:.35rem"><span class="stat-lbl">MP</span><span class="stat-val mp-val">${mp} / ${maxMp}</span></div>
    <div class="mp-track" style="margin-top:.2rem">
      <div class="mp-fill" style="width:${mpPct}%"></div>
    </div>

    ${(function _statDetailBlock() {
      // 🆕 세부 스탯 + 레벨업 포인트 분배 UI.
      // stat_points > 0 이면 + 버튼 활성, 그 외엔 dim. 포인트당 증가: HP/MP +5, ATK/DEF +1.
      const pts = Number(me.stat_points) || 0;
      const plusBtn = (stat, inc, hint) => {
        const dis = pts > 0 ? '' : ' disabled';
        return `<button class="stat-plus${dis}" type="button" data-stat="${stat}" title="${hint} (+${inc}) — 1 포인트 소비"${pts > 0 ? '' : ' tabindex="-1"'}>＋</button>`;
      };
      const banner = pts > 0
        ? `<div class="stat-points-banner">✨ 레벨업 보상 <b>${pts}</b> 포인트 — 원하는 스탯에 분배하세요</div>`
        : '';
      return `
        <div class="stat-detail">
          <div class="stat-detail-title">⚙ 세부 스탯</div>
          ${banner}
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">체력 <span class="stat-sub">max HP</span></span>
            <span class="stat-val">${me.max_hp}</span>
            ${plusBtn('max_hp', 5, '최대 HP 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">마력 <span class="stat-sub">max MP</span></span>
            <span class="stat-val">${me.max_mp}</span>
            ${plusBtn('max_mp', 5, '최대 MP 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">공격 <span class="stat-sub">ATK</span></span>
            <span class="stat-val">${me.attack}</span>
            ${plusBtn('attack', 1, '공격력 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">방어 <span class="stat-sub">DEF</span></span>
            <span class="stat-val">${me.defense}</span>
            ${plusBtn('defense', 1, '방어력 증가')}
          </div>
          <div class="stat-row"><span class="stat-lbl">XP</span><span class="stat-val">${me.xp} <span class="xp-next">(다음까지 ${me.xp_to_next || 0})</span></span></div>
          <div class="xp-track"><div class="xp-fill" style="width:${xpProgress}%"></div></div>
        </div>
      `;
    })()}

    ${myStatusChips}
    ${equipHtml}
    ${invHtml}
  `;

  // 🆕 스탯 포인트 분배 버튼 — stat_points > 0 일 때만 활성.
  //    즉시 서버 전송 (confirm 없음) — 분배 실수해도 게임 밸런스 영향 미미하고 반복 클릭 빠름.
  document.querySelectorAll('#char-body .stat-plus:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSpectator) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const stat = btn.dataset.stat;
      if (!stat) return;
      // 더블 클릭 방지 — 즉시 disable 처리 (서버 응답 오면 refreshCharPanel 로 재렌더)
      btn.classList.add('disabled');
      try {
        ws.send(JSON.stringify({ type: 'spend_stat_point', stat }));
      } catch (err) {
        console.error('[spend_stat_point] send failed:', err);
        btn.classList.remove('disabled');
      }
    });
  });

  // 사용 버튼 위임 바인딩 — char-body 재렌더마다 새로 붙음.
  // 2-클릭 confirm 패턴: 첫 클릭은 "확인?" 상태 전환, 2초 내 재클릭해야 실제 전송.
  // (브라우저 native confirm() 이 차단되거나 모바일에서 동작이 불안정한 케이스 회피)
  document.querySelectorAll('#char-body .inv-use-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSpectator) return;
      const item = btn.dataset.useItem;
      if (!item) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const layer = ensureToastLayer();
        pushToast(layer, '⚠ 서버 연결 끊김 — 잠시 후 다시 시도', 'toast-error');
        return;
      }
      // 첫 클릭: "한 번 더 눌러 확인" 상태로 전환
      if (btn.dataset.confirming !== '1') {
        btn.dataset.confirming = '1';
        const originalText = btn.textContent;
        btn.textContent = '확인?';
        btn.classList.add('confirming');
        const timeoutId = setTimeout(() => {
          btn.dataset.confirming = '';
          btn.textContent = originalText;
          btn.classList.remove('confirming');
        }, 2000);
        btn.dataset.timeoutId = String(timeoutId);
        return;
      }
      // 2번째 클릭: 실제 전송
      clearTimeout(Number(btn.dataset.timeoutId || 0));
      btn.dataset.confirming = '';
      btn.classList.remove('confirming');
      try {
        ws.send(JSON.stringify({ type: 'use_item', item_name: item }));
      } catch (err) {
        console.error('[use_item] send failed:', err);
        const layer = ensureToastLayer();
        pushToast(layer, `⚠ 전송 실패: ${err.message || err}`, 'toast-error');
      }
    });
  });
}

// Lv N에 도달했을 때의 누적 XP 하한. xp_to_next와 함께 현재 레벨 내 진행도 계산에 사용.
function xpBaseForLevel(level) {
  if (level <= 1) return 0;
  let total = 0, inc = 100;
  for (let i = 0; i < level - 1; i++) { total += inc; inc += 50; }
  return total;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ── NARRATIVE LOG ──────────────────────── */

// DM 주사위 태그 → 우측 정렬 뱃지로 변환. die 별 최대값을 매핑하고 d20 에서 1/20 은 치명타 색상.
const DMD_MAX = { d4:4, d6:6, d8:8, d10:10, d12:12, d20:20, d100:100 };
function _dmDiceBadge(die, resultStr) {
  const d = die.toLowerCase();
  const result = parseInt(resultStr, 10);
  const max = DMD_MAX[d] || result;
  let cls = '';
  if (d === 'd20' && result === 20) cls = ' crit-high';
  else if (d === 'd20' && result === 1) cls = ' crit-low';
  return `<span class="dm-dice-inline${cls}" title="DM 주사위 ${d}"><span class="dmd-icon">🎲</span><span class="dmd-die">DM ${d}</span><span class="dmd-result">${result}</span><span class="dmd-max">/${max}</span></span>`;
}

// DM 텍스트 → 안전한 HTML. markdown(**,*)와 화이트리스트 태그(<b>,<i>,<em>,<strong>,<u>)만 활성화.
function formatDmInline(s) {
  let h = escapeHtml(s);
  // 마크다운: **굵게** → <strong>
  h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // 마크다운: *기울임* 또는 _기울임_
  h = h.replace(/(^|\s)\*([^*\n\s][^*\n]*?)\*(?=$|\s|[.,!?:;])/g, '$1<em>$2</em>');
  h = h.replace(/(^|\s)_([^_\n\s][^_\n]*?)_(?=$|\s|[.,!?:;])/g, '$1<em>$2</em>');
  // 화이트리스트 태그만 복원
  h = h.replace(/&lt;(\/?(?:b|i|em|strong|u|br))\s*&gt;/gi, '<$1>');
  // 인라인 대사 하이라이트: "..." 또는 「...」
  h = h.replace(/"([^"\n]{1,200})"/g, '<span class="quote">"$1"</span>');
  h = h.replace(/「([^」\n]{1,200})」/g, '<span class="quote">「$1」</span>');
  // DM 주사위 [🎲DM d20: 16] → 우측 정렬 뱃지.
  // ⚠ 반드시 **마지막**에 변환! 앞에서 변환하면 뱃지 HTML 의 class="..." / title="..." 따옴표가
  //   위 quote 정규식(/"..."/g)에 매칭되어 속성이 <span class="quote"> 로 감싸져 HTML 이 깨짐.
  h = h.replace(/\[🎲\s*DM\s*(d\d+)\s*[:：]\s*(\d+)\]/gi, (_m, die, res) => _dmDiceBadge(die, res));
  return h;
}

// DM 응답 전체 포맷팅 (시간대 태그 제거, 단락 분리, 대사 블록 감지)
function formatDmBlocks(text) {
  // 첫 줄의 시간대 태그 [🌅 새벽] 제거 (이미 상단 배지로 노출됨)
  text = text.replace(/^\s*\[[🌅☀️🌞🌆🌙🌌][^\]]*\]\s*\n?/, '');
  // HP/XP/아이템 태그도 본문에서 제거 (옆에 토스트로 뜸)
  text = text
    .replace(/\[[^\]]+?HP[^\]]*?\]/g, '')
    .replace(/\[[^\]]+?XP\s*\+\s*\d+\]/g, '')
    .replace(/\[[^\]]+?획득:[^\]]*?\]/g, '')
    .replace(/\[🎲d\d+:\s*\d+\]/g, '');

  // 빈 줄 기준 단락 분리, 단일 \n도 단락 취급
  const paragraphs = text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs.map(p => {
    // 문단 전체가 대사면 speech block
    const m = p.match(/^[「"'](.+)["'」]$/s);
    const isSpeech = !!m;
    return { text: p, isSpeech };
  });
}

function dmMsg(text, animate = true) {
  const log = document.getElementById('narr-log');
  const wrap = document.createElement('div');
  wrap.className = 'msg-dm';
  log.appendChild(wrap);

  const blocks = formatDmBlocks(text);
  blocks.forEach((b, i) => {
    const p = document.createElement('div');
    p.className = b.isSpeech ? 'dm-para dm-speech' : 'dm-para';
    p.innerHTML = formatDmInline(b.text);
    if (animate) {
      p.style.animationDelay = `${Math.min(i * 0.18, 2.4)}s`;
      p.classList.add('fade-in');
    }
    wrap.appendChild(p);
  });
  log.scrollTop = log.scrollHeight;
  triggerWalkAction();
}

function playerMsg(name, action, emoji, portraitUrl) {
  const log = document.getElementById('narr-log');
  const el = document.createElement('div');
  el.className = 'msg-player';
  const portraitHtml = portraitUrl
    ? `<img class="msg-portrait portrait-enlarge" src="${portraitUrl}" alt="${escapeHtml(name)}"
            data-full="${portraitUrl}" data-caption="${escapeHtml(name)}"
            onerror="this.style.display='none'">`
    : '';
  el.innerHTML = `
    ${portraitHtml}
    <div class="msg-body">
      <div class="msg-header">${emoji || ''} <span class="msg-name">${escapeHtml(name)}</span></div>
      <div class="msg-action">${escapeHtml(action)}</div>
    </div>
  `;
  log.appendChild(el);
  // 이 버블을 기억해둬서 DM 응답 오면 맥락 이미지 부착
  _lastActionBubble = el;
  _lastActionText = action;
  log.scrollTop = log.scrollHeight;
  triggerWalkAction();
}

function sysMsg(text) {
  const log = document.getElementById('narr-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'msg-sys';
  el.textContent = `— ${text} —`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function showDmTyping(on) {
  const t = document.getElementById('dm-typing');
  if (t) t.style.display = on ? 'block' : 'none';
}

function updateTimeBadge(t) {
  const badge = document.getElementById('time-badge');
  if (!badge) return;
  if (!t || !t.icon) { badge.style.display = 'none'; return; }
  badge.textContent = `${t.icon} ${t.label}`;
  badge.style.display = 'inline-block';
}

/* ── TURN INDICATOR ─────────────────────── */
function updateTurnIndicator(turnPlayerId, players) {
  currentTurnPlayerId = turnPlayerId;
  // 파티 패널 카드에 current-turn 클래스
  document.querySelectorAll('.player-card').forEach(c => c.classList.remove('current-turn'));
  if (turnPlayerId) {
    const cards = document.querySelectorAll('.player-card');
    // data-pid 를 refreshPlayers에서 안 붙여뒀으니 name 매칭은 위험.
    // index 기반: players 배열의 순서 = 카드 순서
    if (players && Array.isArray(players)) {
      const idx = players.findIndex(p => p.player_id === turnPlayerId);
      if (idx >= 0 && cards[idx]) cards[idx].classList.add('current-turn');
    }
  }
  // action-bar lock
  const myTurn = !turnPlayerId || turnPlayerId === myId;
  const bar = document.getElementById('action-bar');
  const inp = document.getElementById('action-input');
  const sendBtn = document.getElementById('send-btn');
  if (bar) bar.classList.toggle('locked', !myTurn);
  if (inp) {
    inp.disabled = !myTurn;
    const name = (players || []).find(p => p.player_id === turnPlayerId);
    inp.placeholder = myTurn
      ? '행동을 입력하세요... (예: 검을 뽑아 전방의 고블린을 공격한다)'
      : `${name ? name.name : '누군가'}의 차례 — 잠시 기다리세요`;
  }
  if (sendBtn) sendBtn.disabled = !myTurn;
  // 퀵액션 버튼도 같이 잠금
  document.querySelectorAll('.q-btn').forEach(b => b.disabled = !myTurn);
  // 턴 알림 뱃지
  const turnBadge = ensureTurnBadge();
  if (turnPlayerId) {
    const name = (players || []).find(p => p.player_id === turnPlayerId);
    turnBadge.textContent = myTurn ? '▶ 당신 차례' : `⏳ ${name ? name.name : '대기중'}`;
    turnBadge.className = 'turn-badge ' + (myTurn ? 'mine' : '');
    turnBadge.style.display = 'inline-block';
  } else {
    turnBadge.style.display = 'none';
  }
}

function ensureTurnBadge() {
  let b = document.getElementById('turn-badge');
  if (!b) {
    const header = document.querySelector('#narrative-panel .panel-header');
    if (header) {
      b = document.createElement('span');
      b.id = 'turn-badge';
      header.appendChild(b);
    }
  }
  return b;
}

/* ── EVENT TOASTS (XP / 레벨업 / 아이템) ──── */
function showEventToasts(events) {
  const layer = ensureToastLayer();
  (events.xp_events || []).forEach(ev => {
    const mine = isMyName(ev.name);
    pushToast(layer, `✨ ${ev.name} +${ev.amount} XP`, mine ? 'toast-xp-mine' : 'toast-xp');
    if (ev.new_level) {
      // 🆕 레벨업 스탯 증가분 표기 (누적: 여러 레벨 한번에 올라도 합쳐 보여줌)
      const g = ev.gains || {};
      const parts = [];
      if (g.max_hp)  parts.push(`HP +${g.max_hp}`);
      if (g.max_mp)  parts.push(`MP +${g.max_mp}`);
      if (g.attack)  parts.push(`공격 +${g.attack}`);
      const gainStr = parts.length ? ` (${parts.join(', ')})` : '';
      pushToast(layer, `🌟 레벨업! ${ev.name} → Lv.${ev.new_level}${gainStr}`, 'toast-levelup');
      if (mine) flashLevelUp();
    }
  });
  (events.items || []).forEach(ev => {
    const mine = isMyName(ev.name);
    pushToast(layer, `🎁 ${ev.name} 획득: ${ev.item}`, mine ? 'toast-item-mine' : 'toast-item');
  });
  // 🆕 상태 효과 적용 토스트
  (events.statuses_applied || []).forEach(st => {
    const emoji = st.kind === '버프' ? '✨' : '☠';
    const cls = st.kind === '버프' ? 'toast-buff' : 'toast-debuff';
    const desc = st.effect ? ` — ${st.effect}` : '';
    pushToast(layer, `${emoji} ${st.player_name} ${st.kind}: ${st.name} (${st.turns}턴)${desc}`, cls);
  });
  (events.statuses_expired || []).forEach(st => {
    pushToast(layer, `⌛ ${st.player_name} ${st.kind} '${st.name}' 해제`, 'toast-xp');
  });
}

function pushErrorToast(message) {
  const layer = ensureToastLayer();
  pushToast(layer, `⚠ ${message}`, 'toast-error');
}

/* ── DM DICE RENDER (AI 가 굴린 주사위) ── */
function renderDmDiceRoll(dd) {
  const log = document.getElementById('narr-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'msg-dice dm-roll';
  const critical = (dd.die === 'd20' && dd.result === 20) ? ' crit-high' :
                   (dd.die === 'd20' && dd.result === 1)  ? ' crit-low' : '';
  el.innerHTML = `
    <span class="dice-roll-icon">🎲</span>
    <span class="dice-roll-who dm-who">🎩 던전 마스터</span>
    <span class="dice-roll-die">${escapeHtml(dd.die)}</span>
    <span class="dice-roll-result${critical}">${dd.result}</span>
    <span class="dice-roll-max">/ ${dd.max}</span>
  `;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

/* ── TAKEOVER MODAL (휴면 캐릭터 이어받기) ── */
function openTakeoverModal(d) {
  const modal = document.getElementById('takeover-modal');
  const list  = document.getElementById('takeover-list');
  if (!modal || !list) return;
  list.innerHTML = '';

  const dormants = Array.isArray(d.dormants) ? d.dormants : [];
  const roomId   = d.room_id;

  // 경과 시간 한국어 포맷 (초 → "약 3분")
  const secToKo = (s) => {
    s = Number(s) || 0;
    if (s < 60)     return `${s}초 전 이탈`;
    if (s < 3600)   return `약 ${Math.floor(s/60)}분 전 이탈`;
    return `약 ${Math.floor(s/3600)}시간 ${Math.floor((s%3600)/60)}분 전 이탈`;
  };

  dormants.forEach(p => {
    const card = document.createElement('div');
    card.className = 'takeover-card';
    const inv = (p.inventory || []).slice(0, 4);
    const invTxt = inv.length ? inv.join(', ') : '없음';
    const eq = p.equipped || {};
    card.innerHTML = `
      <div class="takeover-portrait-wrap">
        <img class="takeover-portrait" src="${p.portrait_url}" alt="${escapeHtml(p.name)}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
        <span class="takeover-emoji-fallback" style="display:none">${p.emoji || '🧑'}</span>
      </div>
      <div class="takeover-info">
        <div class="takeover-name">${escapeHtml(p.name)} <span class="takeover-lvl">Lv.${p.level}</span></div>
        <div class="takeover-sub">${p.race_emoji || ''} ${escapeHtml(raceLabel(p))} · ${escapeHtml(p.character_class)}</div>
        <div class="takeover-stat">HP ${p.hp}/${p.max_hp} · MP ${p.mp}/${p.max_mp}</div>
        <div class="takeover-eq">⚔️ ${escapeHtml(eq.weapon || '-')} · 🛡 ${escapeHtml(eq.armor || '-')}</div>
        <div class="takeover-inv">🎒 ${escapeHtml(invTxt)}</div>
        <div class="takeover-away">${secToKo(p.seconds_away)}</div>
      </div>
      <button class="btn btn-primary takeover-pick-btn" data-pid="${p.player_id}">이 영웅을 이어받기</button>
    `;
    list.appendChild(card);
    card.querySelector('.takeover-pick-btn').addEventListener('click', () => {
      if (!ws) return;
      ws.send(JSON.stringify({
        type: 'takeover_character',
        room_id: roomId,
        dormant_player_id: p.player_id,
      }));
      closeTakeoverModal();
    });
  });

  modal.style.display = 'flex';

  // 새 캐릭으로 입장 버튼 — force_new_character: true 로 재요청
  const newBtn = document.getElementById('takeover-new-btn');
  if (newBtn) {
    newBtn.onclick = () => {
      if (!ws || !_pendingJoin) { closeTakeoverModal(); return; }
      ws.send(JSON.stringify({ ..._pendingJoin, force_new_character: true }));
      closeTakeoverModal();
    };
  }
}
function closeTakeoverModal() {
  const m = document.getElementById('takeover-modal');
  if (m) m.style.display = 'none';
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-takeover-close]')) closeTakeoverModal();
});

/* ── SPECTATOR MODE ENTRY ──────────────── */
function enterSpectatorMode(d) {
  // body / game-screen 에 관전자 클래스 — UI 잠금 + 배너 표시
  document.body.classList.add('spectator-mode');
  const banner = document.getElementById('spectator-banner');
  if (banner) banner.style.display = 'block';
  // 관전자는 entry → game screen 으로 직행
  hide('entry-screen');
  hide('waiting-screen');
  const gs = document.getElementById('game-screen');
  gs.style.display = 'grid';
  gs.classList.add('active');
  // 패널 슬라이드 인
  ['party-panel','narrative-panel','char-panel','action-bar'].forEach((id, i) => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.classList.add('show');
    }, 150 + i * 200);
  });

  document.getElementById('narr-log').innerHTML = '';
  if (Array.isArray(d.players)) {
    refreshPlayers(d.players);
    // 관전자 전용: 내 캐릭터 패널에 안내
    const cb = document.getElementById('char-body');
    if (cb) cb.innerHTML = `
      <div class="spectator-info">
        <div class="spec-title">👁 관전자 모드</div>
        <div class="spec-desc">이름: <b>${escapeHtml(d.spectator_name || '익명')}</b></div>
        <div class="spec-desc">방 코드: <b>${escapeHtml(d.room_id || '')}</b></div>
        <div class="spec-note">• 행동·채팅·주사위 굴리기 불가</div>
        <div class="spec-note">• 진행 상황과 HP/MP 는 실시간으로 보입니다</div>
      </div>
    `;
  }
  updateTimeBadge(d.current_time);
  if (d.last_dm) dmMsg(d.last_dm, false);
  if (Array.isArray(d.chat_log)) {
    document.querySelectorAll('.chat-log').forEach(l => l.innerHTML = '');
    d.chat_log.forEach(appendChatEntry);
  }
  if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players || []);

  // 관전자는 입력/퀵액션/주사위 트레이 전부 잠금
  const lockIds = ['action-input', 'send-btn'];
  lockIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  // 퀵액션/주사위는 막지만, 파티 채팅은 관전자도 허용 (닉 옆 "(관전자)" 라벨로 구분)
  document.querySelectorAll('.q-btn, .dice-btn').forEach(b => b.disabled = true);
  const gci = document.getElementById('game-chat-input');
  const gcs = document.getElementById('game-chat-send-btn');
  if (gci) { gci.disabled = false; gci.placeholder = '관전자로 채팅...'; }
  if (gcs) gcs.disabled = false;
}

/* ── DICE ROLL RENDER ──────────────────── */
function renderDiceRoll(d) {
  // 서사 로그에 주사위 메시지로 기록
  const log = document.getElementById('narr-log');
  if (log) {
    const el = document.createElement('div');
    el.className = 'msg-dice';
    const mine = d.player_id === myId;
    const emoji = d.emoji || '🧑';
    const critical = (d.die === 'd20' && d.result === 20) ? ' crit-high' :
                     (d.die === 'd20' && d.result === 1)  ? ' crit-low' : '';
    el.innerHTML = `
      <span class="dice-roll-icon">🎲</span>
      <span class="dice-roll-who">${emoji} ${escapeHtml(d.name)}</span>
      <span class="dice-roll-die">${escapeHtml(d.die)}</span>
      <span class="dice-roll-result${critical}">${d.result}</span>
      <span class="dice-roll-max">/ ${d.max}</span>
    `;
    if (mine) el.classList.add('mine');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
  // 본인이 굴렸으면 큰 숫자로 토스트
  if (d.player_id === myId) {
    const layer = ensureToastLayer();
    let cls = 'toast-dice';
    if (d.die === 'd20' && d.result === 20) cls += ' dice-crit';
    else if (d.die === 'd20' && d.result === 1) cls += ' dice-fumble';
    pushToast(layer, `🎲 ${d.die}: ${d.result}`, cls);
  }
}

function ensureToastLayer() {
  let layer = document.getElementById('toast-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'toast-layer';
    layer.className = 'toast-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

function pushToast(layer, text, cls) {
  const t = document.createElement('div');
  t.className = `toast ${cls || ''}`;
  t.textContent = text;
  layer.appendChild(t);
  // 진입 애니메이션
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 3200);
}

function isMyName(name) {
  const myCard = document.querySelector('.player-card.mine .pc-name');
  if (!myCard) return false;
  return myCard.textContent.trim().startsWith(name);
}

function flashLevelUp() {
  const panel = document.getElementById('char-panel');
  if (!panel) return;
  panel.classList.remove('level-flash');
  // reflow
  void panel.offsetWidth;
  panel.classList.add('level-flash');
}

/* ── CUSTOM QUICK ACTIONS ──────────────────
   기본 5개 버튼 외에 사용자가 자신만의 행동을 만들어 저장할 수 있음.
   localStorage에 저장되고, 게임 화면 진입 시 quick-row에 추가 렌더링.
*/
const CUSTOM_ACTIONS_KEY = 'trog-custom-actions';
const MAX_CUSTOM_ACTIONS = 6;

function loadCustomActions() {
  try {
    const raw = localStorage.getItem(CUSTOM_ACTIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, MAX_CUSTOM_ACTIONS) : [];
  } catch (_) { return []; }
}

function saveCustomActions(arr) {
  try { localStorage.setItem(CUSTOM_ACTIONS_KEY, JSON.stringify(arr.slice(0, MAX_CUSTOM_ACTIONS))); } catch (_) {}
}

function renderCustomActions() {
  const row = document.getElementById('quick-row-custom');
  if (!row) return;
  row.innerHTML = '';
  const actions = loadCustomActions();
  actions.forEach((a, idx) => {
    const b = document.createElement('button');
    b.className = 'q-btn q-custom';
    b.textContent = `${a.icon || '✨'} ${a.label}`;
    b.title = a.text;
    b.addEventListener('click', () => sendRaw(a.text));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`"${a.label}" 삭제?`)) {
        const cur = loadCustomActions();
        cur.splice(idx, 1);
        saveCustomActions(cur);
        renderCustomActions();
      }
    });
    row.appendChild(b);
  });
  // 추가 버튼 (최대 도달 시 숨김)
  if (actions.length < MAX_CUSTOM_ACTIONS) {
    const add = document.createElement('button');
    add.className = 'q-btn q-add';
    add.textContent = '＋ 나만의 행동';
    add.addEventListener('click', promptNewCustomAction);
    row.appendChild(add);
  }
}

function promptNewCustomAction() {
  const label = prompt('버튼에 표시할 짧은 이름 (예: 은신 기습)');
  if (!label) return;
  const text = prompt('실제 보낼 행동 내용', label);
  if (!text) return;
  const icon = prompt('이모지 아이콘 (선택, 예: 🗡️)', '✨') || '✨';
  const cur = loadCustomActions();
  cur.push({ label: label.slice(0, 16), text: text.slice(0, 200), icon: icon.slice(0, 4) });
  saveCustomActions(cur);
  renderCustomActions();
}

/* ── TYPEWRITER ─────────────────────────── */
function typewrite(el, text, speed) {
  let i = 0;
  const log = document.getElementById('narr-log');
  const timer = setInterval(() => {
    if (i < text.length) {
      el.textContent += text[i++];
      log.scrollTop = log.scrollHeight;
    } else {
      clearInterval(timer);
    }
  }, speed);
}

/* ── AI SCENE IMAGES (Pollinations.ai) ───
   턴 라운드 완료 시 상단 장면 배너 업데이트.
   매 플레이어 액션마다 그 사람 버블에 맥락 이미지 부착.
*/

const IMG_STYLE = 'dark fantasy RPG, Baldur\'s Gate concept art, painterly digital illustration, cinematic rim lighting, moody atmosphere, artstation trending';

// DM 텍스트 → 장면 키워드 매핑
function extractSceneKeywords(text) {
  const s = (text || '').replace(/\[[^\]]*\]/g, '');  // 태그 제거
  const tags = [];
  // 환경
  if (/숲|나무|덤불|수풀/.test(s)) tags.push('dense enchanted forest');
  if (/동굴|지하|굴|어둠 속/.test(s)) tags.push('torchlit cave');
  if (/던전|감옥|지하실/.test(s)) tags.push('stone dungeon corridor');
  if (/산|절벽|봉우리/.test(s)) tags.push('rocky mountain pass');
  if (/강|호수|바다|물가/.test(s)) tags.push('mystic lake shore');
  if (/마을|거리|광장|시장/.test(s)) tags.push('medieval fantasy village');
  if (/성|궁전|탑|요새/.test(s)) tags.push('ancient castle ruins');
  if (/폐허|무너진|잿더미/.test(s)) tags.push('ancient ruins overgrown');
  if (/사막|모래/.test(s)) tags.push('desert wasteland');
  if (/눈|얼음|추위/.test(s)) tags.push('snowy frozen landscape');
  // 상황
  if (/전투|싸움|베|찌|쏘|공격|피가|적이/.test(s)) tags.push('epic battle scene, warriors clashing');
  if (/고블린/.test(s)) tags.push('goblins');
  if (/오크/.test(s)) tags.push('orc warriors');
  if (/용|드래곤/.test(s)) tags.push('dragon');
  if (/언데드|해골|좀비/.test(s)) tags.push('undead skeletons');
  if (/NPC|상인|주민|노파|할아버지|소녀/.test(s)) tags.push('villagers gathered');
  if (tags.length === 0) tags.push('dark fantasy landscape, heroic party on quest');
  return tags.slice(0, 3).join(', ');
}

function extractActionKeywords(actionText, dmText) {
  const a = actionText || '';
  const d = dmText || '';
  const combined = (a + ' ' + d).toLowerCase();
  const actMap = [
    [/공격|베|찌르|쏘|내리친|맞서|돌진|싸움/, 'combat strike, weapons clashing, sparks'],
    [/방어|막아|막는|버티|세우|방패/,         'defending with shield, tense stance'],
    [/치료|회복|치유|마시|감싸|붕대/,         'healing magic, warm golden aura'],
    [/마법|주문|시전|화염|얼음|번개/,         'spellcasting, glowing arcane runes'],
    [/은신|숨|몰래|그림자|매복/,             'stealth, shadowy rogue hiding'],
    [/이동|달린|향한|걸어|나아|뛰어/,         'character striding through landscape'],
    [/대화|말했|물었|설득|협상|이야기/,       'two characters conversing, dialogue scene'],
    [/탐색|살펴|관찰|조사|뒤진|찾아/,         'character examining object, dim light'],
    [/잠입|훔친|소매치기|자물쇠/,            'rogue lockpicking, dim corridor'],
    [/기도|축복|신성|성스러/,                'cleric praying, divine light'],
  ];
  for (const [re, kw] of actMap) {
    if (re.test(combined)) return kw;
  }
  return 'fantasy character action scene';
}

function pollinationsUrl(prompt, w, h, seed) {
  const encoded = encodeURIComponent(`${prompt}, ${IMG_STYLE}`);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}

function hashSeed(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1000000;
}

let _roundCounter = 0;
let _sceneCollapseTimer = null;
const SCENE_VISIBLE_MS = 7000;  // 7초 후 자동 축소

function updateSceneBanner(dmText, timeTag, players) {
  _roundCounter++;
  const banner = document.getElementById('scene-banner');
  const img = document.getElementById('scene-banner-img');
  const label = document.getElementById('scene-banner-text');
  const roundEl = document.getElementById('scene-banner-round');
  if (!banner || !img) return;

  const keywords = extractSceneKeywords(dmText);
  const tod = (timeTag && timeTag.label) ? `, ${timeTag.label}` : '';
  // 파티 구성 (종족들) 을 배경에 살짝 녹여서 일관된 캐릭터 느낌
  const races = (players || []).map(p => RACE_PROMPT[p.race]).filter(Boolean);
  const partyCue = races.length
    ? `, fantasy adventuring party: ${[...new Set(races)].slice(0, 4).join(' and ')}`
    : '';
  const prompt = `wide cinematic landscape map view, ${keywords}${tod}${partyCue}`;
  const seed = hashSeed(prompt + _roundCounter);

  // 점진적 페이드
  banner.style.display = 'block';
  banner.classList.add('scene-loading');
  banner.classList.remove('collapsed');     // 새 장면 → 크게 펼침
  const newImg = new Image();
  newImg.onload = () => {
    img.src = newImg.src;
    banner.classList.remove('scene-loading');
  };
  newImg.src = pollinationsUrl(prompt, 640, 200, seed);

  // 한글 라벨 (장면 요약용)
  const tLabel = (timeTag && timeTag.icon) ? `${timeTag.icon} ${timeTag.label}` : '';
  label.textContent = tLabel || '장면';
  roundEl.textContent = `Round ${_roundCounter}`;

  // 자동 축소 타이머 리셋
  scheduleSceneCollapse();
}

function scheduleSceneCollapse() {
  clearTimeout(_sceneCollapseTimer);
  _sceneCollapseTimer = setTimeout(() => {
    const banner = document.getElementById('scene-banner');
    if (banner) banner.classList.add('collapsed');
  }, SCENE_VISIBLE_MS);
}

// 축소된 배너를 클릭하면 다시 펼침 + 타이머 재시작
document.addEventListener('click', (e) => {
  const banner = e.target.closest('#scene-banner');
  if (!banner || !banner.classList.contains('collapsed')) return;
  banner.classList.remove('collapsed');
  scheduleSceneCollapse();
});

/* 직전 playerMsg 버블에 맥락 이미지 붙이기 */
let _lastActionBubble = null;
let _lastActionText = '';

// 종족별 외형 키워드 (이미지 프롬프트에 삽입해서 맥락 이미지가 종족 반영)
const RACE_PROMPT = {
  '인간': 'human hero, determined eyes',
  '엘프': 'pointed-ear elf, graceful features, ethereal',
  '드워프': 'stocky dwarf, braided beard, rugged',
  '하플링': 'small halfling, nimble, curly hair',
  '오크': 'muscular orc, protruding tusks, green-tinged skin',
  '티플링': 'tiefling with curving horns, reddish-purple skin, glowing amber eyes',
  '드래곤본': 'dragonborn, reptilian scaled face, draconic snout',
  '놈': 'tiny gnome inventor, wild hair, bright curious eyes',
};

// 직업별 장비/실루엣 키워드
const CLASS_PROMPT = {
  '전사': 'heavily armored warrior, longsword, plate armor',
  '마법사': 'arcane wizard, robes, glowing staff',
  '도적': 'hooded rogue, twin daggers, leather armor',
  '성직자': 'devout cleric, holy robes, warhammer',
};

function buildCharacterCue(player) {
  if (!player) return '';
  const r = RACE_PROMPT[player.race] || '';
  const c = CLASS_PROMPT[player.character_class] || '';
  // 닉네임이 특징적(위협적/자조적)이면 톤 가미 — 간단 휴리스틱
  const name = (player.name || '').toLowerCase();
  const tonal = [];
  if (/허접|찐따|바보|노답|꼴보|멍청/.test(player.name || '')) tonal.push('underdog humor, slightly comedic');
  if (/왕|용사|강철|드래곤|슬레이어|대마왕|전설|영웅/.test(player.name || '')) tonal.push('epic heroic aura');
  const parts = [r, c, tonal.join(', ')].filter(Boolean);
  return parts.join(', ');
}

function attachActionImageToLastBubble(actingPlayerId, players, dmText) {
  if (!_lastActionBubble) return;
  const actor = (players || []).find(p => p.player_id === actingPlayerId);
  const charCue = buildCharacterCue(actor);
  const keywords = extractActionKeywords(_lastActionText, dmText);
  // 종족·직업 맥락을 앞쪽에 배치 (이미지 모델이 주제로 인식)
  const prompt = charCue ? `${charCue}, ${keywords}` : keywords;
  const seed = hashSeed(_lastActionText + actingPlayerId);
  const url = pollinationsUrl(prompt, 320, 200, seed);
  if (_lastActionBubble.querySelector('.msg-action-img')) return;
  const img = document.createElement('img');
  img.className = 'msg-action-img portrait-enlarge';
  img.alt = '';
  img.loading = 'lazy';
  img.src = url;
  img.dataset.full = url;
  img.dataset.caption = _lastActionText.slice(0, 80);
  _lastActionBubble.appendChild(img);
}

/* ── WALK ANIMATION TRIGGER ─────────────── */
function triggerWalkAction() {
  document.querySelectorAll('.walk-idle').forEach(el => {
    el.classList.remove('walk-idle');
    el.classList.add('walk-action');
    setTimeout(() => {
      el.classList.remove('walk-action');
      el.classList.add('walk-idle');
    }, 1500);
  });
}

/* ── DRAWING MODAL ──────────────────────── */
const CANVAS_BG_DARK = '#1c1c2e';
const CANVAS_BG_WHITE = '#ffffff';
const modal = document.getElementById('draw-modal');
const canvas = document.getElementById('draw-canvas');
const ctx = canvas.getContext('2d');
let drawing = false;
let brushSize = 3;
let brushColor = '#ddd6c4';
let lastX = 0, lastY = 0;
let currentTool = 'brush';  // 'brush' | 'bucket' | 'eraser'
let canvasBgMode = 'dark';  // 'dark' | 'white' | 'transparent'

/* ── UNDO STACK ─────────────────────────── */
const UNDO_LIMIT = 30;
let _undoStack = [];

function getCurrentCanvasBg() {
  if (canvasBgMode === 'white') return CANVAS_BG_WHITE;
  if (canvasBgMode === 'transparent') return null;
  return CANVAS_BG_DARK;
}

function clearCanvas() {
  const bg = getCurrentCanvasBg();
  if (bg === null) {
    // 투명 배경
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function snapshotCanvas() {
  try {
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    _undoStack.push(snap);
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
  } catch (_) {}
}

function undoCanvas() {
  if (!_undoStack.length) return;
  const prev = _undoStack.pop();
  try { ctx.putImageData(prev, 0, 0); } catch (_) {}
}

function resetUndoStack() {
  _undoStack = [];
}

clearCanvas();
resetUndoStack();

// 내 현재 custom_portrait를 캔버스에 로드 (수정 모드)
function loadMyPortraitIntoCanvas(players) {
  const me = players && players.find(p => p.player_id === myId);
  if (!me || !me.has_custom_portrait) {
    clearCanvas();
    return;
  }
  const img = new Image();
  img.onload = () => {
    clearCanvas();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.onerror = () => clearCanvas();
  img.src = me.portrait_url;  // custom_portrait가 있으면 effective_portrait가 data URL 반환
}

let _lastSeenPlayers = null;

function openDrawModal() {
  modal.style.display = 'flex';
  resetUndoStack();
  loadMyPortraitIntoCanvas(_lastSeenPlayers);
  refreshProfileList();
}
function closeDrawModal() { modal.style.display = 'none'; }

document.getElementById('open-draw-btn').addEventListener('click', openDrawModal);
const openDrawGame = document.getElementById('open-draw-btn-game');
if (openDrawGame) openDrawGame.addEventListener('click', openDrawModal);
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeDrawModal));

/* ── TOOL SWITCH ────────────────────────── */
function setTool(name) {
  currentTool = name;
  document.getElementById('tool-brush-btn').classList.toggle('selected-tool', name === 'brush');
  document.getElementById('tool-bucket-btn').classList.toggle('selected-tool', name === 'bucket');
  document.getElementById('eraser-btn').classList.toggle('selected-tool', name === 'eraser');
  canvas.style.cursor = name === 'bucket' ? 'cell' : 'crosshair';
}
document.getElementById('tool-brush-btn').addEventListener('click', () => setTool('brush'));
document.getElementById('tool-bucket-btn').addEventListener('click', () => setTool('bucket'));

/* ── FLOOD FILL (페인트통) ──────────────── */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.substr(0,2), 16), parseInt(h.substr(2,2), 16), parseInt(h.substr(4,2), 16)];
}

function floodFill(startX, startY, fillHex) {
  const [fr, fg, fb] = hexToRgb(fillHex);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const w = canvas.width, h = canvas.height;
  const idx = (x, y) => (y * w + x) * 4;

  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;
  const s = idx(sx, sy);
  const tr = data[s], tg = data[s+1], tb = data[s+2];
  // 이미 같은 색이면 작업 생략
  if (tr === fr && tg === fg && tb === fb) return;

  const TOL = 12;  // AA 경계 흡수용 허용치
  const matches = (i) => (
    Math.abs(data[i]   - tr) <= TOL &&
    Math.abs(data[i+1] - tg) <= TOL &&
    Math.abs(data[i+2] - tb) <= TOL
  );

  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const i = idx(x, y);
    if (!matches(i)) continue;
    data[i]   = fr;
    data[i+1] = fg;
    data[i+2] = fb;
    data[i+3] = 255;
    stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
  }
  ctx.putImageData(img, 0, 0);
}

/* ── OWNER TOOLS (턴 스킵 등 방장 전용) ── */
function updateOwnerToolsVisibility() {
  const tools = document.getElementById('owner-tools');
  if (!tools) return;
  tools.style.display = (isOwner && !isSpectator) ? 'flex' : 'none';
}
(function bindOwnerTools() {
  const btn = document.getElementById('skip-turn-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!ws || !isOwner) return;
      if (!confirm('현재 차례 플레이어의 턴을 스킵합니까? (DM 호출 없이 다음 사람으로 넘깁니다)')) return;
      ws.send(JSON.stringify({ type: 'skip_turn' }));
    });
  }
})();

/* ── LEAVE ROOM ─────────────────────────── */
function leaveRoom() {
  if (!confirm('방을 나가고 새 캐릭터로 시작할까요?')) return;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave_room' }));
    }
  } catch (_) {}
  // 서버가 left_room 응답 보내줄 때까지 잠깐 대기 후 마무리
  setTimeout(finalizeLeave, 300);
}

function finalizeLeave() {
  document.body.classList.remove('in-game');
  try { if (ws) ws.close(); } catch (_) {}
  clearSession();
  location.href = location.pathname;
}

const leaveBtn = document.getElementById('leave-room-btn');
if (leaveBtn) leaveBtn.addEventListener('click', leaveRoom);

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  const t = e.touches && e.touches[0];
  const cx = (t ? t.clientX : e.clientX) - r.left;
  const cy = (t ? t.clientY : e.clientY) - r.top;
  return [cx * (canvas.width / r.width), cy * (canvas.height / r.height)];
}

function startDraw(e) {
  e.preventDefault();
  const [x, y] = canvasPos(e);
  // 스트로크/채우기 시작 전 스냅샷 — Ctrl+Z 로 되돌릴 수 있게
  snapshotCanvas();
  if (currentTool === 'bucket') {
    // 페인트통: 한 번 클릭으로 플러드필
    floodFill(x, y, brushColor);
    return;
  }
  drawing = true;
  [lastX, lastY] = [x, y];
  // 점 하나 찍기
  ctx.beginPath();
  ctx.arc(lastX, lastY, brushSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = brushColor;
  ctx.fill();
}
function moveDraw(e) {
  if (!drawing || currentTool === 'bucket') return;
  e.preventDefault();
  const [x, y] = canvasPos(e);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = brushColor;
  ctx.lineWidth = brushSize;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  [lastX, lastY] = [x, y];
}
function endDraw() { drawing = false; }

canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', moveDraw);
canvas.addEventListener('mouseup', endDraw);
canvas.addEventListener('mouseleave', endDraw);
canvas.addEventListener('touchstart', startDraw, { passive: false });
canvas.addEventListener('touchmove', moveDraw, { passive: false });
canvas.addEventListener('touchend', endDraw);

document.querySelectorAll('.brush-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.brush-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    brushSize = parseInt(b.dataset.size, 10);
  });
});

document.querySelectorAll('.color-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    brushColor = b.dataset.color;
  });
});

document.getElementById('eraser-btn').addEventListener('click', () => {
  // 투명 배경 모드에서 지우개는 'rgba(0,0,0,0)' 로 작동 불가(fillRect) — destination-out 계열이 필요.
  // 단순화: 투명 배경이면 흰색, 아니면 해당 배경색으로 지움.
  const bg = getCurrentCanvasBg();
  brushColor = bg || '#ffffff';
  setTool('eraser');
  document.querySelectorAll('.color-btn').forEach(x => x.classList.remove('selected'));
});
document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('전체 지웁니다')) {
    snapshotCanvas();
    clearCanvas();
  }
});
document.getElementById('undo-btn')?.addEventListener('click', undoCanvas);

/* ── BACKGROUND MODE ────────────────────── */
document.querySelectorAll('.bg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.bg;
    if (!mode) return;
    document.querySelectorAll('.bg-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const previous = canvasBgMode;
    canvasBgMode = mode;
    canvas.classList.toggle('canvas-checkerboard', mode === 'transparent');
    // 캔버스가 비어있거나(확실한 '이전 배경색'만 있음) 사용자가 명확히 원할 때만 바꾼다.
    // 그린 내용이 있다면 묻기.
    if (previous !== mode) {
      if (confirm('배경을 바꾸면 캔버스가 초기화됩니다. 진행할까요?')) {
        snapshotCanvas();
        clearCanvas();
      } else {
        // 선택 되돌리기
        document.querySelectorAll('.bg-btn').forEach(b => b.classList.remove('selected'));
        const prevBtn = document.querySelector(`.bg-btn[data-bg="${previous}"]`);
        if (prevBtn) prevBtn.classList.add('selected');
        canvasBgMode = previous;
        canvas.classList.toggle('canvas-checkerboard', previous === 'transparent');
      }
    }
  });
});

/* ── CTRL+Z UNDO ────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (modal && modal.style.display !== 'flex') return;  // 드로잉 모달 열렸을 때만
  const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey;
  if (isUndo) {
    e.preventDefault();
    undoCanvas();
  }
});

/* ── RGB PICKER ────────────────────────── */
const rgbPicker = document.getElementById('rgb-picker');
if (rgbPicker) {
  rgbPicker.addEventListener('input', (e) => {
    brushColor = e.target.value;
    document.querySelectorAll('.color-btn').forEach(x => x.classList.remove('selected'));
    // 붓 도구로 자동 전환 (RGB 바꾸면 그리고 싶은 의도)
    if (currentTool === 'eraser') setTool('brush');
  });
}

/* ── AI 초상화로 되돌리기 ─────────────── */
document.getElementById('restore-ai-btn').addEventListener('click', () => {
  if (!ws) return;
  if (!confirm('현재 커스텀 그림을 지우고 AI 생성 초상화로 되돌립니다. 진행할까요?')) return;
  ws.send(JSON.stringify({ type: 'clear_portrait' }));
  clearCanvas();
  closeDrawModal();
});

/* ── PROFILE SAVE / LOAD / DELETE ──────── */
const PROFILE_KEY = 'trog-profiles';

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}
function saveProfiles(obj) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(obj)); } catch (_) {}
}

function refreshProfileList() {
  const sel = document.getElementById('profile-load-select');
  if (!sel) return;
  const profiles = loadProfiles();
  const names = Object.keys(profiles);
  sel.innerHTML = '<option value="">저장된 프로필 불러오기...</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

document.getElementById('profile-save-btn').addEventListener('click', () => {
  const name = prompt('프로필 이름 (예: 내 도적 초상화)');
  if (!name) return;
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) return;
  const profiles = loadProfiles();
  if (profiles[trimmed] && !confirm(`"${trimmed}" 이미 있음. 덮어쓸까요?`)) return;
  profiles[trimmed] = canvas.toDataURL('image/jpeg', 0.7);
  try {
    saveProfiles(profiles);
    refreshProfileList();
    sysMsg(`프로필 저장됨: ${trimmed}`);
  } catch (e) {
    alert('저장 실패 — localStorage 용량 초과일 수 있습니다.');
  }
});

document.getElementById('profile-load-select').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) return;
  const profiles = loadProfiles();
  const dataUrl = profiles[name];
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    clearCanvas();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataUrl;
});

document.getElementById('profile-delete-btn').addEventListener('click', () => {
  const sel = document.getElementById('profile-load-select');
  const name = sel.value;
  if (!name) return alert('삭제할 프로필을 먼저 선택하세요.');
  if (!confirm(`"${name}" 프로필을 삭제합니까?`)) return;
  const profiles = loadProfiles();
  delete profiles[name];
  saveProfiles(profiles);
  refreshProfileList();
});

/* ── PC 파일 저장/불러오기 ──────────────────
   브라우저 localStorage 와 별개로, PC 디스크에 .png 로 저장 & 다시 로드.
   다른 컴퓨터나 백업용.
*/
document.getElementById('file-save-btn').addEventListener('click', () => {
  // PNG로 저장 (무손실, 전송용이 아닌 보관용이라 용량 OK)
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // 기본 파일명: trog-portrait-YYYY-MM-DDTHH-mm-ss.png
    a.download = `trog-portrait-${ts}.png`;
    a.href = dataUrl;
    document.body.appendChild(a);
    a.click();
    a.remove();
    sysMsg('PC에 그림 저장 완료');
  } catch (e) {
    alert('저장 실패: ' + (e && e.message ? e.message : e));
  }
});

document.getElementById('file-load-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    alert('이미지 파일만 가능합니다.');
    e.target.value = '';
    return;
  }
  // 5MB 이상은 거부 (캔버스 로드 느려짐 + 의미 없음)
  if (file.size > 5 * 1024 * 1024) {
    alert('파일이 너무 큽니다 (5MB 초과).');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      // 원본 비율 유지하며 캔버스에 맞춰 그리기 (letterbox 없이 contain fit)
      clearCanvas();
      const cw = canvas.width, ch = canvas.height;
      const ratio = Math.min(cw / img.width, ch / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;
      const x = (cw - w) / 2;
      const y = (ch - h) / 2;
      ctx.drawImage(img, x, y, w, h);
      sysMsg(`PC에서 불러옴: ${file.name}`);
    };
    img.onerror = () => alert('이미지를 읽을 수 없습니다.');
    img.src = ev.target.result;
  };
  reader.onerror = () => alert('파일 읽기 실패');
  reader.readAsDataURL(file);
  // 같은 파일 다시 선택 가능하도록 input 초기화
  e.target.value = '';
});

document.getElementById('draw-save').addEventListener('click', () => {
  if (!ws) return alert('연결되어 있지 않습니다.');
  // 투명 배경이면 PNG (알파 보존), 아니면 JPEG (용량 절감)
  const dataUrl = (canvasBgMode === 'transparent')
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', 0.7);
  ws.send(JSON.stringify({ type: 'set_portrait', portrait: dataUrl }));
  closeDrawModal();
});

/* ── HELPERS ────────────────────────────── */
function show(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}
function hide(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

/* ── PORTRAIT LIGHTBOX ──────────────────── */
document.addEventListener('click', (e) => {
  const img = e.target.closest('.portrait-enlarge');
  if (img && img.dataset.full) {
    // 드로잉 모달이 열려있으면 확대 무시 (모달 안에서 클릭 방지)
    if (modal && modal.style.display === 'flex') return;
    openLightbox(img.dataset.full, img.dataset.caption || '');
  }
  if (e.target.closest('[data-close-lightbox]')) {
    closeLightbox();
  }
});

function openLightbox(src, caption) {
  const lb = document.getElementById('portrait-lightbox');
  if (!lb) return;
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox-caption').textContent = caption || '';
  lb.style.display = 'flex';
}
function closeLightbox() {
  const lb = document.getElementById('portrait-lightbox');
  if (lb) lb.style.display = 'none';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
    // 드로잉 모달은 esc로 닫지 않음 (실수로 그림 날리는 거 방지)
  }
});

/* ── SESSION RESUME BANNER ─────────────────
   이전엔 페이지 로드 시 자동으로 이전 세션에 재입장 → 사용자가 "새 캐릭터 세팅 중인데
   왜 옛날 캐릭터로 뜨지?" 혼동. 이제는 자동 재입장 없이 배너로 명시적 선택만 허용. */
window.addEventListener('DOMContentLoaded', () => {
  const s = loadSession();
  if (!s) return;
  // URL 쿼리 ?fresh=1 이면 즉시 세션 초기화 후 일반 엔트리 화면으로
  if (location.search.includes('fresh=1')) {
    clearSession();
    return;
  }
  const entryWrap = document.querySelector('.entry-wrap');
  if (!entryWrap || document.getElementById('resume-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'resume-banner';
  banner.className = 'resume-banner';
  banner.innerHTML = `
    <div class="resume-banner-title">🕰 이전 세션 발견</div>
    <div class="resume-banner-sub">방 <b>${s.room_id}</b> 에서 플레이 중이던 캐릭터로 돌아갈까요?</div>
    <div class="resume-banner-btns">
      <button id="resume-continue-btn" class="btn btn-primary">▶ 이어하기</button>
      <button id="resume-fresh-btn" class="btn btn-ghost">🆕 새 캐릭터로 시작</button>
    </div>
  `;
  entryWrap.insertBefore(banner, entryWrap.firstChild);
  document.getElementById('resume-continue-btn').onclick = () => {
    // 이어하기 클릭 시에만 실제 rejoin 수행
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'rejoin_room',
      room_id: s.room_id,
      player_id: s.player_id,
    }));
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = () => scheduleReconnect();
  };
  document.getElementById('resume-fresh-btn').onclick = () => {
    clearSession();
    banner.remove();
  };
});
