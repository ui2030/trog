/* ── STATE ──────────────────────────────── */
let ws = null;
let myId = null;
let isOwner = false;

// O-3: 수동 장착 슬롯 추론 — 서버 _NAME_SLOT_HINTS 와 동일 목록 미러(4슬롯).
// 서버가 최종적으로 _correct_slot_by_name 으로 재교정하므로 여기선 UI 힌트 수준.
function guessEquipSlot(name) {
  const n = name || '';
  if (/(방패|실드|버클러|타워실드)/.test(n)) return 'off_hand';
  if (/(갑옷|갑주|경갑|중갑|로브|튜닉|의복|조끼|코트|흉갑|체인메일|판금|가죽갑|사슬갑|투구|헬름|신발|부츠|장화|장갑|건틀릿|망토|방어구|옷(?!감))/.test(n)) return 'armor';
  if (/(반지|목걸이|부적|펜던트|호부|증표|성표|마법서|훈장|배지|장신구)/.test(n)) return 'accessory';
  return 'weapon';
}
// O-4: 이 클라가 현재 탐색의 시작자인지 — 시작 시 exploration_start.starter_id 로 세팅.
let _expIsStarter = false;
// V10-04: 모든 플레이어 카드에 방장(👑) 표시. 서버 broadcast 가 owner_id 동봉.
let currentOwnerId = null;
let isSpectator = false;            // 🆕 관전자 모드 여부
let selectedClass = '전사';
let selectedRace = null;   // 🆕 null 이면 서버가 랜덤 배정, 값 있으면 그 종족으로 고정
let selectedWeapon = null; // 🆕 null 이면 클래스 기본 무기 사용
let selectedAnimal = '늑대'; // 🆕 수인 전용 — 동물 종류 (기본 늑대)
let selectedRatio = 50;    // 🆕 수인 전용 — 인간/동물 비율 (10~90, 기본 반반)
let selectedScenario = null;  // 🆕 시나리오 id — 방 만들 때만 사용. null 이면 서버 기본값.
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
      if (raceHint) raceHint.style.display = 'none';
      // 처음 열면 안내
      if (!selectedRace) {
        // 아무 것도 선택 안 했을 때 힌트
      }
    } else {
      raceGrid.style.display = 'none';
      if (raceHint) raceHint.style.display = 'block';
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
  const manualRaceSelected = !!(raceToggle && raceToggle.checked && selectedRace);
  if (manualRaceSelected) {
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
  // 🆕 방 만들기 때만 시나리오 전송 (join_room 엔 무시됨, 방 만든 사람 선택이 결정)
  if (baseType === 'create_room' && selectedScenario) {
    p.scenario_id = selectedScenario;
  }
  // V44-02/V56-01: create_room 은 전체 시트, join_room 은 종족값 fallback 만 동봉.
  // 단, 사용자가 종족 수동 선택을 꺼서 "랜덤" UI 상태라면 imported_sheet 의 종족값은 보내지 않는다.
  if (_pendingImportedSheet) {
    const sheet = _importedSheetForPayload(baseType, manualRaceSelected);
    if (sheet) p.imported_sheet = sheet;
  }
  return p;
}

// V44-02: import 모달 적용 후 보관되는 시트 데이터. create_room 클릭 시 동봉.
// 사용자가 폼을 더 수정하면 이름/직업/종족 은 폼 값이 우선 — imported_sheet 의 stats/장비/인벤만 의미.
let _pendingImportedSheet = null;

function _hasImportValue(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function _importedSheetForPayload(baseType, manualRaceSelected) {
  if (!_pendingImportedSheet) return null;
  const sheet = { ..._pendingImportedSheet };
  if (manualRaceSelected) {
    sheet.race = selectedRace;
    if (selectedRace === '수인') {
      sheet.race_animal = selectedAnimal;
      sheet.race_ratio = selectedRatio;
    } else {
      sheet.race_animal = null;
      sheet.race_ratio = null;
    }
  } else {
    delete sheet.race;
    delete sheet.race_animal;
    delete sheet.race_ratio;
  }
  if (baseType !== 'create_room') {
    const identity = {
      race: sheet.race,
      race_animal: sheet.race_animal,
      race_ratio: sheet.race_ratio,
    };
    return Object.values(identity).some(_hasImportValue) ? identity : null;
  }
  return Object.values(sheet).some(_hasImportValue) ? sheet : null;
}

/* ── 시나리오 뱃지 갱신 (대기실·게임 공통) ── */
let _currentScenario = null;   // V11-02: 게임 중 클릭 → summary 모달
function applyScenarioBadge(scenario) {
  if (!scenario) return;
  _currentScenario = scenario;
  const label = `${scenario.emoji || '📖'} ${scenario.name || ''}`;
  const tip = scenario.summary || '';
  for (const id of ['waiting-scenario-badge', 'game-scenario-badge']) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = label;
      el.title = tip + '\n(클릭으로 자세히)';
      el.style.display = '';
      el.style.cursor = 'pointer';
      if (!el.dataset.scenarioBound) {
        el.dataset.scenarioBound = '1';
        el.addEventListener('click', _showScenarioModal);
      }
    }
  }
  // V20-01: 시나리오별 추가 quick-action 렌더 — quick-row-custom (사용자 정의 행 옆) 에 prepend.
  _renderScenarioQuickActions(scenario.quick_actions || []);
}

// 🆕 E-2 — 진행 막 배지 (대기실·게임 공통). current_act(1~3) 수신 시 갱신.
let _currentAct = 1;
function applyActBadge(act) {
  const n = Math.max(1, Math.min(3, act | 0));
  _currentAct = n;
  for (const id of ['waiting-act-badge', 'game-act-badge']) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = `제${n}막`;
      el.style.display = '';
    }
  }
  _syncMiniInfoBadge();  // M-1: 모바일 통합 미니 배지 갱신
}

// M-1: 모바일 헤더 다이어트 — [제N막 · 시간대] 통합 미니 배지 1개. 탭하면 숨긴
// 정보(시나리오·라운드·경과시간)를 sysToast 로 노출 (B-4 title→toast 패턴).
let _lastTimeLabel = '';
function _ensureMiniInfoBadge() {
  let b = document.getElementById('mini-info-badge');
  if (!b) {
    const header = document.querySelector('#narrative-panel .panel-header');
    if (!header) return null;
    b = document.createElement('span');
    b.id = 'mini-info-badge';
    b.title = '탭하면 시나리오·라운드·경과시간';
    b.addEventListener('click', _showMiniInfoToast);
    header.appendChild(b);
  }
  return b;
}
function _syncMiniInfoBadge() {
  const b = _ensureMiniInfoBadge();
  if (!b) return;
  const parts = [`제${_currentAct}막`];
  if (_lastTimeLabel) parts.push(_lastTimeLabel);
  b.textContent = parts.join(' · ');
}
function _showMiniInfoToast() {
  const bits = [];
  if (_currentScenario && _currentScenario.name) {
    bits.push(`${_currentScenario.emoji || '📖'} ${_currentScenario.name}`);
  }
  bits.push(`제${_currentAct}막`);
  if (_prevRoundNumber > 0) bits.push(`라운드 ${_prevRoundNumber}`);
  if (_sessionStartedAt) {
    const sec = Math.floor((Date.now() - _sessionStartedAt) / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    bits.push(m >= 60 ? `${Math.floor(m/60)}시간 ${m%60}분 경과`
                      : `${m}분 ${String(s).padStart(2,'0')}초 경과`);
  }
  sysToast(bits.join('  ·  '), 'toast-item', 'ℹ');
}

// V20-01: 시나리오 전용 quick-action 버튼 렌더 — quick-row-custom 위에 별도 행 추가.
function _renderScenarioQuickActions(actions) {
  let row = document.getElementById('quick-row-scenario');
  if (!actions || !actions.length) {
    if (row) row.remove();
    return;
  }
  if (!row) {
    row = document.createElement('div');
    row.id = 'quick-row-scenario';
    row.className = 'quick-row quick-row-scenario';
    const customRow = document.getElementById('quick-row-custom');
    if (customRow && customRow.parentElement) {
      customRow.parentElement.insertBefore(row, customRow);
    } else {
      const bar = document.getElementById('action-bar');
      if (bar) bar.appendChild(row); else return;
    }
  }
  row.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'q-btn q-btn-scenario';
    btn.textContent = a.label || (a.icon || '·') + ' ' + (a.action || '').slice(0, 12);
    btn.title = a.action || a.label || '';
    btn.dataset.action = a.action || '';
    btn.addEventListener('click', () => {
      if (btn.dataset.action) sendRaw(btn.dataset.action);
    });
    row.appendChild(btn);
  });
}

// V11-02: 시나리오 자세히 보기 모달 — 게임 중 시나리오 정보가 어땠는지 다시 확인.
function _showScenarioModal() {
  if (!_currentScenario) return;
  let modal = document.getElementById('scenario-info-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'scenario-info-modal';
    modal.className = 'modal scenario-info-modal';
    // V37-04: ARIA — role/aria-modal/labelledby 추가.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'scenario-info-title');
    modal.innerHTML = `
      <div class="modal-backdrop" data-close-scenario></div>
      <div class="modal-box">
        <div class="modal-title">
          <span id="scenario-info-title"></span>
          <button class="modal-close" data-close-scenario aria-label="닫기">✕</button>
        </div>
        <div class="modal-hint" id="scenario-info-summary"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-close-scenario>닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close-scenario]').forEach(el =>
      el.addEventListener('click', () => modal.style.display = 'none')
    );
  }
  document.getElementById('scenario-info-title').textContent =
    `${_currentScenario.emoji || '📖'} ${_currentScenario.name || '시나리오'}`;
  document.getElementById('scenario-info-summary').textContent =
    _currentScenario.summary || '(설명 없음)';
  modal.style.display = 'flex';
}

/* ── 시나리오 카탈로그 로드 & 카드 UI ───────── */
(async function loadScenarios() {
  const container = document.getElementById('scenario-cards');
  const summary = document.getElementById('scenario-summary');
  if (!container) return;
  let data;
  try {
    const resp = await fetch('/scenarios');
    data = await resp.json();
  } catch (e) {
    console.warn('[scenarios] fetch 실패, 기본 볼카르만 노출:', e);
    data = { scenarios: [{ id: 'volkar', name: '볼카르의 부활', emoji: '🌑', summary: '기본 시나리오' }], default: 'volkar' };
  }
  const scenarios = [
    // "🎲 랜덤" 을 첫 항목으로 — 서버가 방 만들 때 무작위 선택
    { id: 'random', name: '랜덤', emoji: '🎲', summary: '서버가 매 방마다 시나리오를 무작위로 선택합니다.' },
    ...(data.scenarios || []),
  ];
  selectedScenario = data.default || 'volkar';  // 초기 선택 = 서버 기본값
  container.innerHTML = '';
  scenarios.forEach(sc => {
    const card = document.createElement('div');
    card.className = 'scenario-card' + (sc.id === selectedScenario ? ' selected' : '');
    card.dataset.id = sc.id;
    card.dataset.summary = sc.summary || '';
    card.innerHTML = `
      <span class="scenario-card-emoji">${sc.emoji || '📜'}</span>
      <span class="scenario-card-name">${escapeHtml(sc.name)}</span>
    `;
    card.addEventListener('click', () => {
      container.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedScenario = sc.id;
      if (summary) summary.textContent = card.dataset.summary;
    });
    container.appendChild(card);
  });
  // 초기 요약 표시
  const current = scenarios.find(s => s.id === selectedScenario);
  if (summary && current) summary.textContent = current.summary || '';
})();


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
  // V6-01: 한글 IME 조합 중(isComposing) Enter 무시 — 한글 입력 마침과 충돌 방지.
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) document.getElementById('join-room-btn').click();
});

/* ── SPECTATOR ENTRY ────────────────────── */
function doSpectate() {
  const code = (document.getElementById('spectate-code').value || '').trim().toUpperCase();
  if (!code) return alert('관전할 방 코드를 입력하세요.');
  // 관전자 이름은 user name 칸이 있으면 그대로, 없으면 익명.
  const nm = (document.getElementById('player-name').value || '').trim().slice(0, 16);
  connect({ type: 'join_as_spectator', room_id: code, spectator_name: nm });
}
const spectateBtn = document.getElementById('spectate-btn');
if (spectateBtn) spectateBtn.addEventListener('click', doSpectate);
const spectateCodeInp = document.getElementById('spectate-code');
if (spectateCodeInp) {
  spectateCodeInp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) doSpectate();
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
  // V14-01: 슬래시 명령어 처리 — /help /me /scenario /clear
  if (_handleChatSlashCommand(text, inp)) return;
  wsSendSafe({ type: 'chat_message', text });  // V33-07
  inp.value = '';
}

// V14-01: 슬래시 명령어 — chat-input / game-chat-input 공통.
// `/help` 도움말, `/me <행동>` 이모트 (별표로 감싸 보냄), `/scenario` 시나리오 정보,
// `/clear` 채팅 로그 비우기 (서버는 안 건드림 — 본인 화면만)
function _handleChatSlashCommand(text, inp) {
  if (!text.startsWith('/')) return false;
  const sp = text.indexOf(' ');
  const cmd = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
  const rest = (sp === -1 ? '' : text.slice(sp + 1)).trim();
  if (cmd === '/help' || cmd === '/?') {
    if (typeof _showHelpModal === 'function') _showHelpModal();
    inp.value = '';
    return true;
  }
  if (cmd === '/me' && rest) {
    if (!ws) return false;
    wsSendSafe({ type: 'chat_message', text: `*${rest}*` });  // V33-07
    inp.value = '';
    return true;
  }
  if (cmd === '/scenario') {
    if (typeof _showScenarioModal === 'function') _showScenarioModal();
    inp.value = '';
    return true;
  }
  if (cmd === '/clear') {
    document.querySelectorAll('.chat-log').forEach(l => l.innerHTML = '');
    sysToast('본인 화면 채팅만 비웠습니다 (다른 사람엔 영향 없음)', 'toast-item', '🧹');
    inp.value = '';
    return true;
  }
  // V18-02: /d20 /d6 등 빠른 주사위 굴림 — dice-row 와 같은 결과 (서버 권위).
  const diceMatch = cmd.match(/^\/d(4|6|8|10|12|20|100)$/);
  if (diceMatch) {
    const die = 'd' + diceMatch[1];
    wsSendSafe({ type: 'dice_roll', die });  // V33-07
    inp.value = '';
    return true;
  }
  if (cmd === '/roll') {
    wsSendSafe({ type: 'dice_roll', die: 'd20' });  // V33-07
    inp.value = '';
    return true;
  }
  return false;
}
const chatSendBtn = document.getElementById('chat-send-btn');
if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);
const chatInput = document.getElementById('chat-input');
if (chatInput) {
  chatInput.addEventListener('keydown', e => {
    // V6-01: 한글 IME 조합 중 Enter 무시.
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendChat();
  });
}

// V5-04: 채팅 타임스탬프. 서버가 entry.ts (epoch sec, float) 동봉하므로
// HH:MM 으로 렌더. 같은 분 내 연속 발화면 시간 생략(노이즈↓), 5분 이상 갭 또는
// 분 단위가 바뀐 경우만 표시.
function _fmtChatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
// V17-03: 채팅 텍스트의 `*emote*` 부분을 italic 으로 렌더 (V14-01 /me 와 짝).
// XSS 방지를 위해 escapeHtml 후 안전한 *...* 만 <em>...</em> 변환.
function _renderChatText(raw) {
  const safe = escapeHtml(String(raw || ''));
  // *something* (lazy, 같은 라인 내) → <em>...</em>
  return safe.replace(/\*([^*\n]{1,200})\*/g, '<em class="chat-emote">$1</em>');
}
// V13-01: 본인 이름 채팅 멘션 감지 — 다른 사람 채팅에 내 이름 포함되면 mention 클래스 + 토스트.
// 정확 매칭만 (3자 이상). 다중 occur 도 1회만 토스트.
function _myDisplayName() {
  const me = (Array.isArray(_lastSeenPlayers) ? _lastSeenPlayers : []).find(p => p.player_id === myId);
  return me && me.name && me.name.length >= 2 ? me.name : '';
}
const _CHAT_LOG_CAP = 150;
const _CHAT_LOG_KEEP = 100;
function appendChatEntry(entry) {
  // 대기실 채팅, 게임 채팅 양쪽에 모두 추가
  const logs = document.querySelectorAll('.chat-log');
  if (!logs.length) return;
  const isMine = entry.player_id === myId;
  const isSpec = !!entry.is_spectator;
  const emoji = escapeHtml(isSpec ? '👁' : (entry.race_emoji || entry.emoji || '🧑'));
  const specBadge = isSpec ? '<span class="chat-spec-badge">(관전자)</span>' : '';
  const tsStr = _fmtChatTs(entry.ts);
  // V13-01: 멘션 감지
  const myName = _myDisplayName();
  const isMention = !isMine && myName && entry.text && entry.text.indexOf(myName) !== -1;
  logs.forEach(log => {
    // 직전 entry 와 같은 분이면 timestamp 숨김 — 화면 가독성 위해.
    let showTs = !!tsStr;
    if (showTs) {
      const last = log.lastElementChild;
      if (last && last.dataset && last.dataset.tsMin === tsStr) showTs = false;
    }
    const row = document.createElement('div');
    row.className = 'chat-entry'
      + (isMine ? ' mine' : '')
      + (isSpec ? ' spectator' : '')
      + (isMention ? ' mention' : '');
    if (tsStr) row.dataset.tsMin = tsStr;
    row.innerHTML = `
      <span class="chat-name">${emoji} ${escapeHtml(entry.name)}${specBadge}</span>
      <span class="chat-text">${_renderChatText(entry.text)}</span>
      ${showTs ? `<span class="chat-ts" title="${tsStr}">${tsStr}</span>` : ''}
    `;
    log.appendChild(row);
    // V6-02 패턴: 채팅 로그도 무한 누적 방지. 150 초과 시 오래된 것 batch 트림(→100).
    if (log.children.length > _CHAT_LOG_CAP) {
      while (log.children.length > _CHAT_LOG_KEEP && log.firstElementChild) {
        log.removeChild(log.firstElementChild);
      }
    }
    log.scrollTop = log.scrollHeight;
  });
  // V8-11: 채팅 unread badge — 게임 채팅(char-panel)이 모바일에서 닫혀있고 본인 메시지가 아닐 때 카운트.
  if (!isMine) _bumpChatUnread();
  // V13-01: 멘션 시 토스트 + (백그라운드면) title 깜빡 + 진동
  if (isMention) {
    const layer = ensureToastLayer();
    pushToast(layer, `💬 ${entry.name}이(가) 당신을 부릅니다: ${entry.text.slice(0, 40)}`, 'toast-mention');
    if (document.hidden) _flashTitle('💬 멘션 — TROG');
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([60, 30, 60]); } catch (_) {}
    }
  }
}

// V8-11 + V21-01 helpers — 채팅 unread.
// 게임 중일 때만 카운트. 모바일은 char-panel.drawer-open 시 reset, 데스크톱은
// 채팅창이 항상 보이지만 panel 안 game-chat-log 가 사용자 시야 밖일 수 있어 panel
// header 의 미러 배지로 알림 (사용자가 panel 클릭/포커스 시 reset).
let _chatUnread = 0;
function _bumpChatUnread() {
  // 게임 화면이 아니면(대기실 채팅) 신경 X — char-panel 자체가 게임에서만 의미.
  if (!document.body.classList.contains('in-game')) return;
  // 모바일에서 panel 이미 열려있으면 사용자가 보고 있음 — count X.
  const charPanel = document.getElementById('char-panel');
  const isMobile = typeof isMobileViewport === 'function' && isMobileViewport();
  if (isMobile && charPanel && charPanel.classList.contains('drawer-open')) return;
  // 데스크톱: game-chat-input 이 포커스된 상태라면 사용자가 채팅 보고 있는 셈 — count X.
  if (!isMobile) {
    const ae = document.activeElement;
    if (ae && (ae.id === 'game-chat-input' || ae.id === 'chat-input')) return;
  }
  _chatUnread++;
  _renderChatUnreadBadge();
  if (isMobile) {
    // 새 채팅 도착도 edge-tab-char 펄스 트리거
    _markDrawerEvent('char-panel', 'edge-tab-char', 'mobile-mini-hud');
  }
}
function _resetChatUnread() {
  _chatUnread = 0;
  _renderChatUnreadBadge();
}
function _renderChatUnreadBadge() {
  const tab = document.getElementById('edge-tab-char');
  // V21-01: char-panel 헤더에도 미러링 — 데스크톱 (drawer 미사용) 에서도 보이도록.
  const headerBadge = document.getElementById('char-panel-unread');
  if (tab) {
    let badge = tab.querySelector('.unread-badge');
    if (_chatUnread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        tab.appendChild(badge);
      }
      badge.textContent = _chatUnread > 99 ? '99+' : String(_chatUnread);
    } else if (badge) {
      badge.remove();
    }
  }
  if (headerBadge) {
    if (_chatUnread > 0) {
      headerBadge.textContent = _chatUnread > 99 ? '99+' : String(_chatUnread);
      headerBadge.style.display = '';
    } else {
      headerBadge.style.display = 'none';
    }
  }
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
  // V14-01: 슬래시 명령어 처리
  if (_handleChatSlashCommand(text, inp)) return;
  wsSendSafe({ type: 'chat_message', text });  // V33-07
  inp.value = '';
}
(function bindGameChatImmediate() {
  const btn = document.getElementById('game-chat-send-btn');
  const inp = document.getElementById('game-chat-input');
  if (btn) btn.addEventListener('click', sendGameChat);
  // V6-01: 한글 IME 조합 중 Enter 무시.
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendGameChat(); });
  // V21-01: 데스크톱에서 game-chat-input 포커스 = 채팅 읽고 있는 것 → unread 초기화.
  if (inp) inp.addEventListener('focus', () => { if (typeof _resetChatUnread === 'function') _resetChatUnread(); });
})();

// V26-01: 한글 IME composition 진행 중 input 옅은 보더 — 사용자가 자기 한글 조합 상태 인지.
(function bindImeIndicator() {
  ['action-input', 'chat-input', 'game-chat-input'].forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.addEventListener('compositionstart', () => inp.classList.add('ime-active'));
    inp.addEventListener('compositionend', () => inp.classList.remove('ime-active'));
  });
})();

// 🆕 B-1: iOS 소프트키보드 가림 방지 — visualViewport 로 하단 입력창을 키보드 위로 보정.
// (body.in-game{overflow:hidden;height:100dvh} 라 키보드가 떠도 레이아웃이 안 줄어드는 문제.)
(function bindKeyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return; // 데스크톱/미지원 → no-op
  const targetFor = {
    'action-input': () => document.getElementById('action-bar'),
    'chat-input': (inp) => inp.closest('.chat-input-row'),
    'game-chat-input': (inp) => inp.closest('.chat-input-row'),
  };
  let activeEl = null; // 현재 리프트 대상 컨테이너 (전역 1개 — focus 전환 안전)
  const apply = () => {
    if (!activeEl) return;
    const offset = window.innerHeight - vv.height - vv.offsetTop;
    // offset<=50 (데스크톱/키보드 닫힘) 이면 반드시 원복 — 잔여 transform 방지.
    activeEl.style.transform = offset > 50 ? `translateY(${-offset}px)` : '';
  };
  const clear = () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    if (activeEl) { activeEl.style.transform = ''; activeEl = null; }
  };
  Object.keys(targetFor).forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.addEventListener('focus', () => {
      clear(); // 이전 대상 정리 후 재바인딩
      activeEl = targetFor[id](inp);
      if (!activeEl) return;
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    });
    inp.addEventListener('blur', clear);
  });
  // 화면 전환/탭 이탈 시 blur 가 안 와도 리스너·transform 잔여 정리.
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
})();

// 🆕 B-4: hover 전용 title 툴팁을 터치 기기에서 탭으로 노출 (위임 click → sysToast).
if (window.matchMedia('(pointer: coarse)').matches) {
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest('.eq-slot, .monster-speed, .stat-locked, .stat-equip-bonus');
    if (!el) return; // 첫 매치만 처리 (중첩 중복 toast 방지)
    const tip = el.getAttribute('title') || el.getAttribute('data-tip');
    if (tip) sysToast(tip);
  });
}

document.getElementById('send-btn').addEventListener('click', sendAction);
document.getElementById('action-input').addEventListener('keydown', e => {
  // V6-01: 한글 IME 조합 중 Enter 무시 — 한글 마지막 글자가 미완성 상태로 잘리는 버그 차단.
  // isComposing(표준) + keyCode 229(legacy WebKit) 둘 다 체크.
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { sendAction(); return; }
  // V8-09: ↑/↓ 로 history 회상. IME 조합 중엔 무시 (입력 방해 방지).
  if (e.isComposing || e.keyCode === 229) return;
  const inp = e.currentTarget;
  if (e.key === 'ArrowUp') {
    if (!_actionHistory.length) return;
    if (_actionHistoryIdx === -1) _actionDraftBeforeHistory = inp.value;
    _actionHistoryIdx = Math.min(_actionHistory.length - 1, _actionHistoryIdx + 1);
    inp.value = _actionHistory[_actionHistoryIdx];
    e.preventDefault();
    // 커서 끝으로
    setTimeout(() => { try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch(_) {} }, 0);
  } else if (e.key === 'ArrowDown') {
    if (_actionHistoryIdx <= -1) return;
    _actionHistoryIdx -= 1;
    inp.value = (_actionHistoryIdx === -1) ? _actionDraftBeforeHistory : _actionHistory[_actionHistoryIdx];
    e.preventDefault();
    setTimeout(() => { try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch(_) {} }, 0);
  } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
    // 사용자가 직접 입력 시작 → history 모드 해제
    _actionHistoryIdx = -1;
  }
});

// V8-08: 행동 입력 글자수 카운터. 400자 상한 근처(>= 320 = 80%) 갈 때만 노출.
// 평소엔 숨김 — 입력칸이 작아 보여 부담스럽지 않게.
(function bindActionCounter() {
  const inp = document.getElementById('action-input');
  if (!inp) return;
  const counter = document.createElement('span');
  counter.id = 'action-counter';
  counter.className = 'action-counter';
  counter.style.display = 'none';
  // 입력칸 옆에 살짝 띄움 — action-bar 안. send-btn 직전에 삽입.
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn && sendBtn.parentElement) sendBtn.parentElement.insertBefore(counter, sendBtn);
  const update = () => {
    const len = inp.value.length;
    const max = parseInt(inp.getAttribute('maxlength') || '400', 10);
    if (len >= max * 0.8) {
      counter.style.display = '';
      counter.textContent = `${len}/${max}`;
      counter.classList.toggle('counter-warn', len >= max * 0.95);
    } else {
      counter.style.display = 'none';
    }
  };
  inp.addEventListener('input', update);
})();

// V23-01: 채팅 input placeholder 도 가끔 회전 — /help /me /d20 등 명령어 힌트.
// 처음 도착한 사용자가 슬래시 명령어 존재를 모를 수 있음.
const _CHAT_INPUT_HINTS = [
  '메시지 입력... (/help 로 명령어)',
  '메시지 입력... (/me 행동 으로 이모트)',
  '메시지 입력... (/d20 으로 주사위)',
  '메시지 입력... (/scenario 로 시나리오 정보)',
  '메시지 입력...',
];
// V41-03: 핸들 보관 + visibility 가드. 백그라운드 시 wakeup 회피로 모바일 배터리 부담 ↓.
let _chatPlaceholderTimer = null;
function _startChatPlaceholderHint() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  let idx = 0;
  if (_chatPlaceholderTimer) clearInterval(_chatPlaceholderTimer);
  _chatPlaceholderTimer = setInterval(() => {
    if (document.hidden) return;  // V41-03: 백그라운드면 skip (wakeup 절약)
    if (inp.value || document.activeElement === inp) return;
    idx = (idx + 1) % _CHAT_INPUT_HINTS.length;
    inp.placeholder = _CHAT_INPUT_HINTS[idx];
  }, 12000);
}
_startChatPlaceholderHint();

// V22-03: 채팅 입력 글자수 카운터 (chat-input + game-chat-input). 80% 부터 노출.
(function bindChatCounters() {
  ['chat-input', 'game-chat-input'].forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    const counter = document.createElement('span');
    counter.className = 'action-counter chat-counter';
    counter.style.display = 'none';
    if (inp.parentElement) inp.parentElement.insertBefore(counter, inp.nextSibling);
    inp.addEventListener('input', () => {
      const len = inp.value.length;
      const max = parseInt(inp.getAttribute('maxlength') || '200', 10);
      if (len >= max * 0.8) {
        counter.style.display = '';
        counter.textContent = `${len}/${max}`;
        counter.classList.toggle('counter-warn', len >= max * 0.95);
      } else {
        counter.style.display = 'none';
      }
    });
  });
})();

document.querySelectorAll('.q-btn').forEach(btn => {
  // data-action 없는 버튼(#linger-btn, #pass-turn-btn 등)은 별도 핸들러가 처리하므로 스킵.
  if (!btn.dataset.action) return;
  btn.addEventListener('click', () => sendRaw(btn.dataset.action));
});

// 🆕 v6: 관망/진행 — 행동 없이 DM 이 장면 진행. 본인 차례에서만 가능.
document.getElementById('linger-btn')?.addEventListener('click', () => {
  if (isSpectator) return;
  if (_amIDead && _amIDead()) { sysToast('사망 상태 — 관망 불가', 'toast-error', '💀'); return; }
  if (!ws) return;
  wsSendSafe({ type: 'linger_action' });  // V33-07
});

// 🆕 v6: 내 턴 패스 — LLM 호출 없이 다음 사람으로. (방장 skip 과 달리 본인만 패스 가능)
document.getElementById('pass-turn-btn')?.addEventListener('click', () => {
  if (isSpectator) return;
  if (!ws) return;
  // V38-02: 솔로 1명만 있는 방에서 패스는 자기에게 다시 옴 → 무한 루프. 명시적 차단.
  const aliveCount = (_lastSeenPlayers || []).filter(p => !p.is_dead).length;
  if (aliveCount <= 1) {
    sysToast('파티에 1명뿐이라 패스가 의미 없습니다 — 행동을 입력하거나 관망(🌫)을 누르세요',
             'toast-error', '⏭');
    return;
  }
  if (!confirm('정말 본인 턴을 그냥 넘기시겠습니까? (이번 차례에 아무 일도 일어나지 않습니다)')) return;
  wsSendSafe({ type: 'pass_turn' });  // V33-07
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
  wsSendSafe({ type: 'dice_roll', die });  // V33-07
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

// V8-09 + V34-05: 행동 입력 history — ↑/↓ 키로 최근 20개 액션 회상.
// V34-05: 방 코드 단위로 키 분리 — 한 PC 에서 여러 캐릭터 플레이 시 다른 사람 액션 노출 차단.
// 방 코드가 아직 없으면 'lobby' 라는 placeholder bucket 사용 (entry 단계라 거의 사용 안 됨).
const _ACTION_HISTORY_KEY_PREFIX = 'trog_action_history_v2_';
const _ACTION_HISTORY_LEGACY_KEY = 'trog_action_history_v1';  // 폐기 — 자동 cleanup
const _ACTION_HISTORY_MAX = 20;
function _actionHistoryKey() {
  const code = (typeof currentRoomCode === 'string' && currentRoomCode) ? currentRoomCode : 'lobby';
  return _ACTION_HISTORY_KEY_PREFIX + code;
}
function _loadActionHistory() {
  try {
    const raw = localStorage.getItem(_actionHistoryKey());
    return raw ? JSON.parse(raw) || [] : [];
  } catch (_) { return []; }
}
function _saveActionHistory(arr) {
  try { localStorage.setItem(_actionHistoryKey(), JSON.stringify(arr)); } catch (_) {}
}
// 기존 v1 단일 키 cleanup — 다른 사람 캐릭터 액션이 남아있을 수 있음.
try { localStorage.removeItem(_ACTION_HISTORY_LEGACY_KEY); } catch (_) {}
let _actionHistory = _loadActionHistory();
let _actionHistoryIdx = -1;        // -1 = 현재 입력 (history 미열람), 0 = 가장 최근
let _actionDraftBeforeHistory = '';  // 사용자가 ↑ 누르기 전 입력칸 보존
// 방 코드가 채워지는 시점(rejoin/create/join) 에 history 다시 로드.
function _reloadActionHistoryForRoom() {
  _actionHistory = _loadActionHistory();
  _actionHistoryIdx = -1;
  _actionDraftBeforeHistory = '';
}

function sendAction() {
  if (isSpectator) return;
  // 🆕 사망 시 행동 차단 — 채팅(chat_message)은 별개로 가능.
  if (_amIDead()) {
    sysToast('사망 상태 — 행동 불가. 동료의 부활 또는 구원의 빛 대기', 'toast-error', '💀');
    return;
  }
  const inp = document.getElementById('action-input');
  const val = inp.value.trim();
  if (!val) return;
  // V8-09: history 에 push (직전과 같으면 중복 제거)
  if (!_actionHistory.length || _actionHistory[0] !== val) {
    _actionHistory.unshift(val);
    if (_actionHistory.length > _ACTION_HISTORY_MAX) _actionHistory.length = _ACTION_HISTORY_MAX;
    _saveActionHistory(_actionHistory);
  }
  _actionHistoryIdx = -1;
  _actionDraftBeforeHistory = '';
  sendRaw(val);
  inp.value = '';
}

function sendRaw(action) {
  if (!ws || isSpectator) return;
  if (_amIDead()) return;  // 안전망 (퀵액션 버튼 등도 막힘)
  // V33-07: WS 끊김 시 큐에 적재 → 재연결 onopen 에서 flush.
  wsSendSafe({ type: 'player_action', action });
  showDmTyping(true);
  // V6-07: DM 응답 도착 전까지 행동 입력/전송 잠금 — 같은 턴에 5번 연타하면
  // 큐에 5개 행동이 쌓이는 문제 방지. dm_response/dm_error 도달 시 해제.
  _setActionBarBusy(true);
}

/* ── V33-07: WS 재시도 큐 ───────────────────────
 * 사용자 의도 메시지(player_action / chat_message / linger / pass / dice_roll) 가
 * ws.send 직전 끊겼거나 readyState != OPEN 일 때 큐에 적재 → onopen 시 순차 flush.
 * 30초 이상 묵힌 메시지는 폐기 (사용자 의도 만료).
 * 서버 측 dedup 은 기존 spam 방어(V28-01/02) + 액션 쿨다운(3초) 으로 자연 차단됨.
 */
const _WS_RETRY_TTL_MS = 30000;
const _wsRetryQueue = [];
function wsSendSafe(msg) {
  const isOpen = ws && ws.readyState === WebSocket.OPEN;
  if (isOpen) {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (_) {
      // send 자체 실패 — 큐로 폴백
    }
  }
  _wsRetryQueue.push({ msg, ts: Date.now() });
  // 큐가 너무 길면 가장 오래된 것부터 폐기 (메시지 폭주 방지)
  while (_wsRetryQueue.length > 20) _wsRetryQueue.shift();
  if (!isOpen) {
    sysToast('연결 끊김 — 메시지 큐에 적재 (재연결 시 자동 전송)', 'toast-item', '📨');
  }
  return false;
}
function _flushWsRetryQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  let flushed = 0;
  let expired = 0;  // V36-04: 만료된 메시지 카운트 — silent drop 방지.
  while (_wsRetryQueue.length) {
    const item = _wsRetryQueue.shift();
    if (now - item.ts > _WS_RETRY_TTL_MS) { expired++; continue; }
    try { ws.send(JSON.stringify(item.msg)); flushed++; }
    catch (_) { _wsRetryQueue.unshift(item); break; }  // 도중 실패 시 순서 보존
  }
  if (flushed > 0) {
    sysToast(`재연결 후 ${flushed}개 메시지 자동 재전송 완료`, 'toast-item', '📨');
  }
  if (expired > 0) {
    // narr-log 보존 — 사용자가 "왜 내 행동이 처리 안 됐지?" 회상에서 이 시점을 추적 가능해야.
    sysMsg(`연결 끊김이 길어 ${expired}개 미전송 메시지 폐기됨 — 다시 시도해주세요`);
  }
}

// V6-07 helper: action-bar 의 busy 상태(클래스 + input/btn disabled)를 토글.
// updateTurnIndicator 의 lock 로직과 별도 — 그쪽은 턴/사망 기반.
let _dmResponding = false;
let _dmBusyTimeoutHandle = null;
const _DM_BUSY_HARD_TIMEOUT_MS = 200000;  // LLM_TIMEOUT_SEC=180 보다 약간 여유
function _setActionBarBusy(on) {
  _dmResponding = !!on;
  const bar = document.getElementById('action-bar');
  const inp = document.getElementById('action-input');
  const sendBtn = document.getElementById('send-btn');
  if (bar) bar.classList.toggle('dm-busy', _dmResponding);
  // V36-03: body 에도 클래스 mirror — 글로벌 단축키 핸들러가 lock 인지하도록.
  document.body.classList.toggle('action-busy', _dmResponding);
  // 안전망: 응답이 영영 안 오는 경우(네트워크 글리치, 서버 크래시) 스스로 잠금 해제.
  if (_dmBusyTimeoutHandle) { clearTimeout(_dmBusyTimeoutHandle); _dmBusyTimeoutHandle = null; }
  if (_dmResponding) {
    if (inp) {
      inp.dataset.prevPlaceholder = inp.placeholder || '';
      inp.placeholder = '⏳ DM 응답 대기 중...';
      inp.disabled = true;
    }
    if (sendBtn) sendBtn.disabled = true;
    document.querySelectorAll('.q-btn').forEach(b => b.disabled = true);
    _dmBusyTimeoutHandle = setTimeout(() => {
      console.warn('[V6-07] DM busy 안전망 타임아웃 — 입력 해제');
      _setActionBarBusy(false);
      sysToast('DM 응답 지연 — 입력 잠금 해제. 다시 시도하거나 네트워크 확인', 'toast-error', '⏱');
    }, _DM_BUSY_HARD_TIMEOUT_MS);
  } else {
    // 해제는 updateTurnIndicator 가 다시 호출되며 정확한 상태로 동기화.
    // 그러나 즉시 placeholder 만 복원 — turn 갱신 사이의 짧은 공백 메우기.
    if (inp && inp.dataset.prevPlaceholder !== undefined) {
      inp.placeholder = inp.dataset.prevPlaceholder;
    }
  }
}

/* 🆕 내 캐릭터가 사망 상태인지 — _lastSeenPlayers 에서 조회. 없으면 false. */
function _amIDead() {
  if (!Array.isArray(_lastSeenPlayers)) return false;
  const me = _lastSeenPlayers.find(p => p.player_id === myId);
  return !!(me && me.is_dead);
}

/* ── WEBSOCKET ──────────────────────────── */
// V23-01: WebSocket close code 사람말 변환 (사용자 안내).
// V51-01: 4000 (session replaced) 매핑 추가 — 서버가 same player_id 중복 접속 검출 시 보냄.
// V52-01 후속: session_replaced case 가 alert+reload 로 단순화돼 _wsCloseReason 4000 은 사실상
// 안 도달하지만, 향후 4000 으로 close 되는 다른 경로 대비 매핑 유지.
function _wsCloseReason(ev) {
  if (!ev) return '';
  const code = ev.code;
  if (code === 1000) return '정상 종료.';
  if (code === 1001) return '서버 재시작.';
  if (code === 1006) return '네트워크 단절.';
  if (code === 1011) return '서버 내부 오류.';
  if (code === 1012) return '서버 재시작.';
  if (code === 1013) return '서버 과부하.';
  if (code === 4000) return '다른 곳에서 같은 캐릭터로 접속됨.';
  return '예기치 못한 단절(code ' + code + ').';
}

// V10-01: WS 연결 상태 상시 표시 dot — 우상단 작은 점. green=연결, yellow=재시도, red=끊김.
// 데스크톱·모바일 모두 노출. 자세한 sysMsg 와 별도로 즉시 시각 인지.
function _ensureConnDot() {
  let dot = document.getElementById('ws-conn-dot');
  if (!dot) {
    dot = document.createElement('div');
    dot.id = 'ws-conn-dot';
    dot.className = 'ws-conn-dot dot-state-init';
    dot.title = 'WebSocket 연결 상태 (클릭으로 자세히)';
    // V21-05: 클릭 시 연결 상세 토스트 — 마지막 pong 경과시간 + 재연결 시도 횟수.
    dot.style.pointerEvents = 'auto';
    dot.style.cursor = 'help';
    dot.addEventListener('click', () => {
      try {
        const layer = ensureToastLayer();
        const ageSec = _lastPongAt ? Math.floor((Date.now() - _lastPongAt) / 1000) : 0;
        const state = dot.classList.contains('dot-state-open') ? '연결됨'
                    : dot.classList.contains('dot-state-reconnecting') ? '재연결 중'
                    : dot.classList.contains('dot-state-closed') ? '끊김'
                    : '준비';
        pushToast(layer,
          `🔌 ${state} · 마지막 응답 ${ageSec}s 전 · 재시도 ${_reconnectAttempts || 0}회`,
          'toast-item');
      } catch (_) {}
    });
    document.body.appendChild(dot);
  }
  return dot;
}
// V16-03: WS heartbeat — 30s 간격 ping, 75s 동안 pong 없으면 좀비 의심하고 강제 재연결.
// TCP keep-alive 가 모바일 캐리어망 NAT 에서 종종 무효 → 앱 레벨 ping 필요.
let _lastPongAt = 0;
let _heartbeatTimer = null;
const _HEARTBEAT_INTERVAL_MS = 30000;
const _HEARTBEAT_DEAD_AFTER_MS = 75000;
function _startHeartbeat() {
  // V54-01: 강제 재연결은 old ws.onclose 를 detach 할 수 있으므로, onopen 때마다
  // 기존 heartbeat 를 새 소켓 기준으로 재시작한다. stale pong age 로 새 ws 를 즉시 닫는 회귀 방지.
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _lastPongAt = Date.now();
  _heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    // 마지막 pong 가 오래 됐으면 좀비 connection 의심
    const age = Date.now() - _lastPongAt;
    // V21-13: pong age 시각화 — 35초 이상이면 dot 에 stale 클래스 부여 (전조 표시)
    const dot = document.getElementById('ws-conn-dot');
    if (dot) dot.classList.toggle('dot-stale', age > 35000 && dot.classList.contains('dot-state-open'));
    if (age > _HEARTBEAT_DEAD_AFTER_MS) {
      console.warn('[V16-03] heartbeat dead — forcing reconnect');
      try { ws.close(); } catch (_) {}
      _lastPongAt = Date.now();  // 다음 cycle 까지 재진단 안 하도록 reset
    }
  }, _HEARTBEAT_INTERVAL_MS);
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// V55-01: transient UI/network timers cleanup helper.
// 여러 close/error/rejoin 경로에 같은 정리가 흩어져 V52/V54 류 stale-state 회귀가 생기기 쉬웠다.
function cleanupTransientUiState(reason = '', opts = {}) {
  const clearActionBusy = opts.clearActionBusy !== false;
  const clearStream = opts.clearStream !== false;
  try { showDmTyping(false); } catch (_) {}
  if (clearActionBusy) {
    try { _setActionBarBusy(false); } catch (_) {}
  }
  if (clearStream) {
    try { _clearDmStreamPlaceholder(null); } catch (_) {}
  }
  try { _stopGameStartingHintTicker(); } catch (_) {}
  if (opts.stopHeartbeat) {
    try { _stopHeartbeat(); } catch (_) {}
  }
  if (reason) console.debug('[cleanupTransientUiState]', reason);
  // 🆕 [L] DM 서술 종료 → 낙서 버튼 펄스 해제(남의 턴 조건은 유지)
  _ddDmPending = false;
  try { refreshDoodlePulse(); } catch (_) {}
}

function resetSpectatorUiState() {
  isSpectator = false;
  document.body.classList.remove('spectator-mode');
  const banner = document.getElementById('spectator-banner');
  if (banner) banner.style.display = 'none';
  const actionInput = document.getElementById('action-input');
  const sendBtn = document.getElementById('send-btn');
  if (actionInput) actionInput.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
  document.querySelectorAll('.q-btn, .dice-btn').forEach(b => { b.disabled = false; });
  const gci = document.getElementById('game-chat-input');
  if (gci && gci.placeholder === '관전자로 채팅...') gci.placeholder = '파티 채팅...';
}

function _setConnState(state) {
  const dot = _ensureConnDot();
  dot.classList.remove('dot-state-init', 'dot-state-open', 'dot-state-reconnecting', 'dot-state-closed');
  dot.classList.add('dot-state-' + state);
  const titles = {
    open: '연결됨',
    reconnecting: '재연결 시도 중...',
    closed: '연결 끊김',
    init: '연결 준비',
  };
  dot.title = `WebSocket: ${titles[state] || state}`;
}

// 🆕 옛 ws 의 핸들러를 명시적으로 끊어 좀비 메시지 방지. close() 는 비동기라 onclose/onmessage 가
// 신 ws 와 동시에 살아있을 수 있음 → 새 ws 만들기 전 항상 호출.
function _detachWsHandlers(oldWs) {
  if (!oldWs) return;
  try {
    oldWs.onopen = null;
    oldWs.onmessage = null;
    oldWs.onclose = null;
    oldWs.onerror = null;
  } catch (_) {}
}

function _replaceWebSocketSilently(oldWs) {
  if (!oldWs) return;
  _detachWsHandlers(oldWs);
  try {
    if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
      oldWs.close(1000, 'client replacing socket');
    }
  } catch (_) {}
}

// 🆕 재연결 백오프 (3s → 6s → 12s → … → 60s 캡). 서버 영구 다운 시 무한 3초 재시도 방지.
let _reconnectAttempts = 0;
const RECONNECT_MAX_DELAY = 60000;
function _resetReconnectBackoff() { _reconnectAttempts = 0; }

function connect(firstMsg) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _replaceWebSocketSilently(ws);
  _setConnState('reconnecting');  // V10-01: 연결 시도 중 = yellow 펄스
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    _resetReconnectBackoff();
    _setConnState('open');
    _startHeartbeat();
    ws.send(JSON.stringify(firstMsg));
    // V33-07: 재연결 후 끊겨있는 동안 큐에 쌓인 사용자 의도 메시지 flush.
    // setTimeout 으로 0ms 지연 → firstMsg(rejoin/create) 처리가 먼저 안착되도록.
    setTimeout(_flushWsRetryQueue, 50);
  };
  ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn('[ws] bad frame:', err); } };
  ws.onclose = (ev) => {
    // V6-04: WS 끊기는 즉시 dm-typing 인디케이터 정리 — 안 그러면 "DM 응답 중" 인 채로
    // 멈춰있어서 사용자가 "끊겼다는 건지 응답 중인지" 혼동.
    _setConnState('closed');
    cleanupTransientUiState('ws.onclose', { stopHeartbeat: true });  // V48/V54/V55 cleanup
    // V23-01: close code 별 더 친절한 메시지.
    if (!reconnectTimer) {
      const reason = _wsCloseReason(ev);
      sysMsg('서버 연결 끊김 — ' + reason + ' 재연결 시도 중...');
    }
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect(immediate = false) {
  if (reconnectTimer) return;
  const s = loadSession();
  if (!s) return;
  let delay;
  if (immediate) {
    delay = 50;
  } else {
    // 지수 백오프: 3s, 6s, 12s, 24s, 48s, 60s(cap)
    const base = 3000 * Math.pow(2, _reconnectAttempts);
    delay = Math.min(base, RECONNECT_MAX_DELAY);
    _reconnectAttempts++;
  }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      cleanupTransientUiState('scheduleReconnect before detach', { stopHeartbeat: true });
      _replaceWebSocketSilently(ws);   // 이전 ws 핸들러 차단 + 소켓 종료 — 좀비 메시지/서버 잔류 방지
      _setConnState('reconnecting');
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      _resetReconnectBackoff();
      _setConnState('open');
      _startHeartbeat();
      sysMsg('재연결됨 — 세션 복구 중');
      ws.send(JSON.stringify({
        type: 'rejoin_room',
        room_id: s.room_id,
        player_id: s.player_id,
      }));
    };
    ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn('[ws] bad frame:', err); } };  // V41-03
    ws.onclose = () => {
      _setConnState('closed');
      cleanupTransientUiState('reconnect ws.onclose', { stopHeartbeat: true });
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }, delay);
}

/* ── 모바일 앱 전환 대응 ─────────────────────
   모바일 브라우저는 백그라운드 탭의 WS 를 30~60초 안에 강제 종료하고,
   백그라운드 setTimeout 을 쓰로틀링해서 기존 scheduleReconnect(3초 타이머)가 제때 안 풀림.
   → 탭이 장시간 백그라운드 → 포그라운드로 돌아올 때만 WS 좀비 의심·강제 재연결.
   짧은 전환·포커스 변경에는 손대지 않음 (멀쩡한 WS 를 끊어버려 역효과). */
// 🆕 5분 (300s) — 모바일 백그라운드 → 포그라운드 복귀 시 멀쩡한 WS 도 강제 종료해
// 재연결 알림이 도배되던 UX 결함 해소. 그 이하 시간엔 WS 가 살아있을 가능성 높으니 그대로 둠.
const MOBILE_BG_ZOMBIE_THRESHOLD_MS = 300000;  // 5분 이상 숨겨졌으면 WS 좀비 의심선
let _lastHiddenAt = 0;

(function bindReconnectTriggers() {
  const reconnectIfNeeded = (why, suspectZombie) => {
    const s = loadSession();
    if (!s) return;  // 세션 없으면 재연결 대상 아님
    // CLOSED/CLOSING — 확실히 죽어있으면 즉시 재연결
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log(`[RECONNECT] ${why} — WS 죽어있음, 즉시 재연결`);
      scheduleReconnect(true);
      return;
    }
    // OPEN 인데 좀비 의심되는 경우만 강제 close + 재연결. 짧은 탭 전환·네트워크 깜빡임엔 건드리지 않음.
    if (suspectZombie && ws.readyState === WebSocket.OPEN) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log(`[RECONNECT] ${why} — WS OPEN 이지만 좀비 의심 (장시간 백그라운드), 재연결 유도`);
      try { ws.close(); } catch (_) {}
      scheduleReconnect(true);
    }
    // CONNECTING / 짧은 OPEN 은 그대로 둔다
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      _lastHiddenAt = Date.now();
    } else {
      // visible 복귀 — 얼마나 숨겨져있었는지로 판단
      const hiddenMs = _lastHiddenAt ? (Date.now() - _lastHiddenAt) : 0;
      let suspectZombie = hiddenMs >= MOBILE_BG_ZOMBIE_THRESHOLD_MS;
      // V49-02: 5분 임계 (보수적) 미만이라도 백그라운드 동안 setInterval throttle 로 heartbeat
      // ticker 가 firing 안 돼서 _lastPongAt 가 75s 이상 오래된 경우 → 즉시 dead 판정.
      // 다음 heartbeat ticker firing (최대 30s 후) 까지 기다리지 않고, 사용자가 첫 행동
      // 시도하기 전에 reconnect 시작 → silent fail 차단.
      if (!suspectZombie && ws && ws.readyState === WebSocket.OPEN) {
        const pongAge = _lastPongAt ? (Date.now() - _lastPongAt) : 0;
        if (pongAge > _HEARTBEAT_DEAD_AFTER_MS) {
          suspectZombie = true;
        }
      }
      reconnectIfNeeded(`탭 복귀 (hidden=${hiddenMs}ms)`, suspectZombie);
      _lastHiddenAt = 0;
    }
  });
  // 네트워크 끊김 → 복구. 이때는 거의 확실히 WS 가 죽어있으므로 좀비 의심 on.
  window.addEventListener('online', () => reconnectIfNeeded('네트워크 복구', true));
})();

/* ── MESSAGE HANDLER ────────────────────── */
function handle(d) {
  // V16-03: pong 도착 — 모든 메시지가 사실상 살아있다는 신호이므로 type 무관 _lastPongAt 갱신.
  // 명시적 pong 도 보냄 (서버에 ping 응답).
  _lastPongAt = Date.now();
  if (d.type === 'pong') return;  // 추가 처리 없음
  // 서버가 players 동봉하는 모든 브로드캐스트에 monsters 필드를 자동 포함해서 보냄.
  // 타입별 case 마다 호출하지 않아도 되도록 switch 앞에서 일괄 렌더.
  if (Array.isArray(d.monsters)) renderMonsters(d.monsters);
  // V10-04: 모든 broadcast 에 owner_id 동봉됨 (server broadcast helper). 추적해서 카드에 👑.
  if (d.owner_id !== undefined) currentOwnerId = d.owner_id;
  if (d.new_owner_id !== undefined) currentOwnerId = d.new_owner_id;
  // 🆕 E-2 — current_act 동봉 브로드캐스트/복원 응답 모두에서 막 배지 갱신 (누락 시 기존값 유지).
  if (typeof d.current_act === 'number') applyActBadge(d.current_act);
  switch (d.type) {
    case 'room_created':
      resetSpectatorUiState();
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      _reloadActionHistoryForRoom();  // V34-05
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      showWaiting(d.room_id, d.players);
      updateOwnerToolsVisibility();
      if (d.scenario) applyScenarioBadge(d.scenario);
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
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
      resetSpectatorUiState();
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      _reloadActionHistoryForRoom();  // V34-05
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      if (d.scenario) applyScenarioBadge(d.scenario);
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
      if (d.started) {
        showGame(d.players);
        updateTimeBadge(d.current_time);
        // 🆕 지금까지의 서사 로그 전부 재생 (신규 입장자도 이전 대화 볼 수 있음)
        replayNarrativeLog(d.narrative_log, d.players);
        // 🆕 마지막 장면 이미지 복원
        if (d.current_scene_url) {
          updateSceneBanner('', d.current_time, d.players, d.current_scene_url);
        }
        if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
        // 🆕 진행 중 탐색 오버레이 동기화 (게임 중 신규 입장자) — rejoin 과 동일
        if (d.exploration) showExplorationOverlay(d.exploration, true);
        else hideExplorationOverlay();
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
      // V7-06: 재연결 직후 dm-typing / dm-busy 잔류 정리. 끊긴 시점에 응답 대기 중이었으면
      // 클라가 그 상태로 멈춰있을 수 있음.
      cleanupTransientUiState('rejoin_ok');
      resetSpectatorUiState();
      myId = d.player_id;
      isOwner = !!d.is_owner;
      currentRoomCode = d.room_id || '';
      _reloadActionHistoryForRoom();  // 2026-05-11: rejoin 경로에서 누락 — 이전 방 history 잔류 차단
      saveSession(d.room_id, d.player_id);
      revealMyRace(d.players);
      if (d.scenario) applyScenarioBadge(d.scenario);
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
      if (d.started) {
        showGame(d.players);
        updateTimeBadge(d.current_time);
        // 🆕 narrative_log 있으면 그걸로 전체 재생 (없으면 last_dm 폴백)
        if (Array.isArray(d.narrative_log) && d.narrative_log.length) {
          replayNarrativeLog(d.narrative_log, d.players);
        } else if (d.last_dm) {
          dmMsg(d.last_dm, false);
        }
        // 🆕 마지막 장면 이미지 복원
        if (d.current_scene_url) {
          updateSceneBanner('', d.current_time, d.players, d.current_scene_url);
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
      // 🆕 진행 중 탐색 오버레이 복원 (새로고침/재접속)
      if (d.exploration) showExplorationOverlay(d.exploration, true);
      else hideExplorationOverlay();
      break;

    case 'exploration_start':
      showExplorationOverlay(d, false);
      break;
    case 'explore_progress':
      updateExplorationProgress(d);
      break;
    case 'exploration_end':
      endExploration(d);
      break;

    case 'chat_broadcast':
      if (d.entry) appendChatEntry(d.entry);
      break;

    // 🆕 [L] 공동 낙서판
    case 'doodle_stroke':
      _doodleApplyStroke(d.stroke);
      break;
    case 'doodle_state':
      _doodleSetState(d.strokes);
      break;
    case 'doodle_clear':
      _doodleHandleClear();
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

    case 'dm_pending':
      // 🆕 A-1 — 남이 행동해서 DM 이 서술 중. 행동자 본인은 sendRaw 에서 이미 typing 켬(서버가 exclude).
      // 대기자에게도 진행 표시를 띄워 "파티가 멈춘 건지" 혼동 방지.
      if (d.acting_player_id && d.acting_player_id !== myId) {
        _ddDmPending = true;
        try { refreshDoodlePulse(); } catch (_) {}
        showDmTyping(true);
        const nm = d.acting_player_name || '누군가';
        const badge = ensureTurnBadge();
        badge.textContent = `⏳ ${nm} 행동 중`;
        badge.className = 'turn-badge';
        badge.style.display = 'inline-block';
        const bar = document.getElementById('action-bar');
        if (bar && bar.classList.contains('locked')) {
          bar.style.setProperty('--turn-banner',
            `"⏳ ${nm.replace(/"/g, '\\"')} 행동 중 — DM이 서술하고 있습니다…"`);
        }
      }
      break;

    case 'turn_afk_warning':
      // 🆕 A-2 — 내 턴인데 방치 중. 곧 자동 스킵된다는 경고.
      sysToast(`⏰ ${d.seconds_left || 30}초 안에 행동하지 않으면 턴이 넘어갑니다`, 'toast-error', '⏰');
      break;

    case 'monsters_cleared':
      // 🆕 방장이 [적 퇴장] 누락된 몬스터들을 강제 정리. 카드는 broadcast 자동주입(빈 monsters)로 사라짐.
      if (Array.isArray(d.cleared) && d.cleared.length) {
        sysMsg(`🗑 방장이 잔존 몬스터 카드 정리 — ${d.cleared.join(', ')}`);
      }
      if (Array.isArray(d.players)) refreshPlayers(d.players);
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
      // V48-01: game_starting 후 LLM 시작 실패 → 서버가 모두 unready 로 ready_updated 송출.
      // 이때 V47-04 ticker 가 살아있으면 ready-hint 가 1초 후 다시 ticker 텍스트로 덮어씌워져
      // updateReadyBtnState 가 세팅한 안내가 사라짐. ticker 정리해 자연 흐름 복구.
      _stopGameStartingHintTicker();
      refreshWaitingList(d.players);
      updateReadyBtnState(d.players);
      renderPregameStats(d.players);  // 🆕 다른 사람 능력치 변동도 반영 (본인 패널 없으면 숨김)
      break;

    case 'pregame_stat_changed':
      // 🆕 본인이든 남이든 누군가 능력치 조정함 → 패널 + 대기실 카드 갱신
      if (Array.isArray(d.players)) {
        refreshWaitingList(d.players);
        renderPregameStats(d.players);
      }
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
      _stopGameStartingHintTicker();  // V47-04: ticker stop
      showGame(d.players);
      updateTimeBadge(d.current_time);
      showDmTyping(false);
      setTimeout(() => dmMsg(d.dm_text, true), 1800);
      // V47-03: 인트로 후에도 onboarding 토스트 발화 — 사용자가 인트로만 읽고 화면 떠나도 한 번만.
      // dm_response 안 오는 케이스 (인트로만 보고 닫음) 에 대비.
      setTimeout(() => _fireFirstGameTipsAfterIntro(), 3500);
      // 🆕 LLM 이 발급한 SCENE URL 이 있으면 첫 장면을 즉시 띄움
      if (d.scene_image_url) {
        updateSceneBanner(d.dm_text, d.current_time, d.players, d.scene_image_url);
      }
      if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players);
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
      break;

    case 'action_taken':
      // V16-A: 본인 액션이면 메시지 버블에 pending 마크 — DM 응답 도착하면 ✓로 전환.
      playerMsg(d.player_name, d.action, d.player_emoji, d.portrait_url, d.player_id === myId);
      break;

    case 'action_cancelled':
      // V32-03: 서버가 player_action 처리 task 를 취소함. 입력 잠금 해제 + pending 버블 시각 정리.
      cleanupTransientUiState('action_cancelled');
      {
        // pending 클래스는 본인 버블에만 붙어있음 (V16-A). 다른 사람 취소면 sysMsg 만.
        const pending = document.querySelector('#narr-log .msg-player.mine.pending');
        if (pending && d.player_id === myId) {
          pending.classList.remove('pending');
          pending.classList.add('cancelled');
          const badge = pending.querySelector('.msg-pending-badge');
          if (badge) { badge.textContent = '✕'; badge.title = '취소됨'; }
        }
      }
      if (d.player_id === myId) {
        sysMsg('행동 취소됨 — 텍스트가 입력칸으로 복원되어 있습니다.');
      } else {
        sysMsg(`${d.player_name || '플레이어'} 가 직전 행동을 취소했습니다.`);
      }
      break;

    case 'dm_chunk':
      // V42-03: streaming partial 도착 — placeholder bubble 누적.
      _appendDmStreamChunk(d.stream_id, d.delta || '', d.acting_player_id);
      break;

    case 'dm_stream_end':
      // V42-03: stream 종료 신호 — placeholder 는 dm_response 도달 시 교체됨.
      // 취소 케이스만 즉시 placeholder 제거 (dm_response 안 옴).
      if (d.cancelled) _clearDmStreamPlaceholder(d.stream_id);
      break;

    case 'dm_response':
      // V42-03: streaming partial placeholder 가 있으면 제거 후 정식 렌더 (포맷팅 적용).
      cleanupTransientUiState('dm_response');  // stream/typing/busy 정리
      _expWarmFallback();  // N-1.2 응답당 1장 지형 폴백 CDN 예열
      _markDrawerEvent('party-panel', 'edge-tab-party');  // V8-10
      _markDrawerEvent('char-panel', 'edge-tab-char', 'mobile-mini-hud');
      // V46-02: 첫 dm_response 도달 시 onboarding 토스트 발화 — 인트로 + spawn 토스트 가라앉은 후.
      _fireFirstGameTipsAfterIntro();
      // V16-A: 본인 액션의 pending 인디케이터 정리 → ✓ 잠깐 표시 후 사라짐.
      if (d.acting_player_id === myId) _resolveLastPendingBubble();
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
      // 🆕 Phase 3 — 라운드 순서 표시 갱신
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
      // 🆕 SCENE 태그가 있으면 매 응답마다 배너 갱신 (LLM 이 영문으로 직접 발급한 URL),
      // 없으면 기존 동작 — 라운드 완료 시에만 한글 키워드 추출로 폴백.
      if (d.scene_image_url) {
        updateSceneBanner(d.text, d.current_time, d.players, d.scene_image_url);
      } else if (d.round_complete) {
        updateSceneBanner(d.text, d.current_time, d.players);
      }
      break;

    case 'monster_turn':
      // 🆕 Phase 3 — 몬스터 자동 행동 차례. DM 응답과 비슷하게 본문 표시하되 시각적으로 구분.
      showDmTyping(false);  // 🆕 A-1 안전망 — dm_pending 로 켜진 typing 이 남아있으면 정리
      monsterTurnMsg(d.monster_name, d.text);
      // 🆕 몬스터 차례에서도 SCENE URL 이 있으면 배너 갱신
      if (d.scene_image_url) {
        updateSceneBanner(d.text, null, _lastSeenPlayers || [], d.scene_image_url);
      }
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.events) showEventToasts(d.events);
      // 🆕 라운드 종료 tick (DOT 등) 도 토스트로 표시
      if (Array.isArray(d.round_tick_events) && d.round_tick_events.length) {
        showEventToasts({
          monster_events: d.round_tick_events.filter(e => ['tick','status_expired','defeated'].includes(e.kind)),
          xp_events:      d.round_tick_events.filter(e => ['kill','assist'].includes(e.kind)),
        });
      }
      // 라운드 트래커 + 다음 차례 갱신 (몬스터 체인 진행 중에도 UI 가 따라가도록)
      if (Array.isArray(d.round_order)) updateRoundOrderUI(d.round_order, d.round_idx, d.round_number);
      if (d.turn_player_id !== undefined) updateTurnIndicator(d.turn_player_id, d.players || _lastSeenPlayers || []);
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
      // V30-01: 본인이면 char-panel 짧은 ✨ flash (레벨업 flash 와 같은 mechanism 재사용).
      if (d.player_id === myId && typeof flashLevelUp === 'function') {
        setTimeout(flashLevelUp, 60);
      }
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
        if (typeof d.gold_delta === 'number') {
          const sign = d.gold_delta > 0 ? '+' : '';
          pushToast(layer, `💰 ${d.player_name} '${d.item}' 개봉: 골드 ${sign}${d.gold_delta} (현재 ${d.gold} G)`, 'toast-item-mine');
        } else {
          pushToast(layer, `🧪 ${d.player_name} 이(가) '${d.item}' 사용 (남은 ${d.remaining})`, 'toast-item-mine');
        }
      }
      break;

    case 'item_equipped':
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_name && d.item) {
        const layer = ensureToastLayer();
        const replacedNote = d.replaced ? ` ('${d.replaced}' → 인벤)` : '';
        pushToast(layer, `🛡 ${d.player_name} '${d.item}' 장착${replacedNote}`, 'toast-item-mine');
      }
      break;

    case 'item_unequipped':   // 🆕 [P-2] 슬롯 해제 → 소지품 회수
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_name && d.item) {
        const layer = ensureToastLayer();
        pushToast(layer, `🚫 ${d.player_name} '${d.item}' 해제 → 🎒 소지품`, 'toast-item-mine');
      }
      break;

    case 'shop_bought':
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_name && d.item) {
        const layer = ensureToastLayer();
        pushToast(layer, `🧪 ${d.player_name} 상점에서 '${d.item}' 구매 (-${d.price}G, 잔액 ${d.gold}G)`, 'toast-item-mine');
      }
      break;

    case 'potion_used':
      if (Array.isArray(d.players)) {
        refreshPlayers(d.players);
        refreshCharPanel(d.players);
      }
      if (d.player_name && d.item) {
        const layer = ensureToastLayer();
        pushToast(layer, `🧪 ${d.player_name} '${d.item}' 사용 (남은 ${d.remaining})`, 'toast-item-mine');
      }
      break;

    case 'use_item_confirm': {
      // 🆕 서버가 "이건 장비입니다. 장착할까요?" 회신 — 사용자에게 confirm 후 action:'equip' 재전송.
      const ok = confirm(d.message || `'${d.item_name}' 은(는) 장비입니다. 장착하시겠습니까?`);
      if (ok && ws && ws.readyState === WebSocket.OPEN && d.item_name) {
        // 슬롯 추론 (O-3: 서버 목록과 동일한 guessEquipSlot 사용)
        const slot = guessEquipSlot(d.item_name);
        ws.send(JSON.stringify({ type: 'use_item', item_name: d.item_name, action: 'equip', slot }));
      }
      break;
    }

    case 'kicked':
      alert(`방장(${d.by || '알 수 없음'})에 의해 강퇴되었습니다.`);
      clearSession();
      try { if (ws) ws.close(); } catch (_) {}
      location.href = location.pathname;
      break;

    case 'session_replaced':
      // V51-01 + V52-01: 같은 캐릭터로 다른 PC/탭에서 접속 → 서버가 이 세션 종료.
      // 클라 case 없으면 ws.close(4000) 직후 자동 reconnect → 핑퐁 발생.
      // 단순 entry 이동만으로는 in-game 도중 timer/state (_dmTypingTimer, _titleBlinkTimer,
      // _chatPlaceholderTimer, _dmStreamState.watchdog, _drawAutosaveTimer, currentOwnerId 등)
      // 가 stale 잔류 → 사용자가 새 캐릭으로 다시 시작 시 영향. kicked 패턴처럼 alert + reload
      // 로 100% 깨끗한 state 보장 (안정성 우선, 메모리 누수 0).
      clearSession();
      try { if (ws) ws.close(); } catch (_) {}
      alert(d.message || '다른 곳에서 같은 캐릭터로 접속해 이 세션이 종료됩니다.');
      location.href = location.pathname;
      break;

    case 'left_room':
      // 서버가 퇴장 확정 — 클라이언트는 finalizeLeave에서 이미 대응 중
      break;

    case 'error':
      cleanupTransientUiState(`error:${d.code || 'unknown'}`);  // V6/V48/V55
      sysMsg(`⚠ ${d.message}`);
      // 대기실 등 narr-log 없는 화면에서도 보이게 토스트로도 띄우기
      pushErrorToast(d.message);
      break;

    case 'game_starting':
      // 전원 준비됨 → DM 호출 중. 대기실 준비 힌트에 표시
      // V47-04: elapsed 카운터 + 분위기 메시지 회전 — 솔로 또는 다인 모두 LLM 30~60s 대기 동안 진행 인지.
      _startGameStartingHintTicker();
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
    raceDesc = `${me.race_animal}의 피가 ${bucket} 수준으로 드러난다`;
  }
  document.getElementById('my-race-name').textContent = raceName;
  document.getElementById('my-race-desc').textContent = raceDesc;
  document.getElementById('draw-title').textContent = `${raceName} ${me.character_class} 그리기`;
  document.getElementById('draw-hint').textContent = `${raceDesc} — 자유롭게 그려보세요`;
}

/* ── WAITING SCREEN ─────────────────────── */
function showWaiting(roomId, players) {
  // 대기실은 게임 아님 — 엣지 탭/HUD 숨김
  resetSpectatorUiState();
  document.body.classList.remove('in-game');
  hide('entry-screen');
  hide('game-screen');
  show('waiting-screen');
  document.getElementById('game-screen').style.display = '';

  const drcEl = document.getElementById('display-room-code');
  if (drcEl) drcEl.textContent = roomId;
  // V5-01: 대기실에서도 방 코드 클릭 → 클립보드 복사. 친구에게 공유하는 시점이 정작 대기실인데
  // 이전엔 복사 기능이 게임 진입 후의 헤더 뱃지에만 있어서 손으로 받아 적어야 했음.
  if (drcEl && !drcEl.dataset.copyBound) {
    drcEl.dataset.copyBound = '1';
    drcEl.style.cursor = 'pointer';
    drcEl.title = '클릭해 방 코드 복사';
    drcEl.addEventListener('click', () => {
      const code = drcEl.textContent.replace(/[^A-Za-z0-9]/g, '');
      if (!code || code.length < 4) return;
      const showCopied = () => {
        const orig = drcEl.textContent;
        drcEl.textContent = '✓ 복사됨';
        drcEl.classList.add('copied');
        setTimeout(() => {
          drcEl.textContent = orig;
          drcEl.classList.remove('copied');
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(showCopied, () => {
          sysToast('복사 실패 — 수동으로 기억하세요: ' + code, 'toast-error', '⚠');
        });
      } else {
        // 구버전 브라우저 fallback — execCommand
        const ta = document.createElement('textarea');
        ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showCopied(); }
        catch { sysToast('복사 실패 — 수동: ' + code, 'toast-error', '⚠'); }
        finally { document.body.removeChild(ta); }
      }
    });
  }
  refreshWaitingList(players);
  updateReadyBtnState(players);
  renderPregameStats(players);  // 🆕 포인트 바이 패널
  // 방 코드 기억 — 나중에 game 진입 시 헤더 뱃지에 주입
  currentRoomCode = roomId;
}

/* 🆕 포인트 바이 능력치 조정 패널 — 본인 카드만 표시. race_mod_applied 면 숨김. */
function renderPregameStats(players) {
  const box = document.getElementById('pregame-stats-box');
  const list = document.getElementById('pregame-stats-list');
  const totalEl = document.getElementById('pregame-total');
  if (!box || !list) return;
  const me = (players || []).find(p => p.player_id === myId);
  if (!me || me.race_mod_applied) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  const stats = [
    ['strength',     '근력', 'STR'],
    ['intelligence', '지능', 'INT'],
    ['wisdom',       '지혜', 'WIS'],
    ['dexterity',    '기교', 'DEX'],
    ['charisma',     '매력', 'CHA'],
    ['constitution', '건강', 'CON'],
  ];
  const total = (typeof me.ability_total === 'number')
    ? me.ability_total
    : stats.reduce((s, [k]) => s + (Number(me[k]) || 10), 0);
  if (totalEl) {
    totalEl.textContent = total;
    totalEl.classList.toggle('warn', total !== 60);
  }
  // 🆕 영점(10) 기준 대칭 modifier — 서버 ability_modifier 와 일치해야 함.
  const _mod = (s) => s >= 10 ? Math.floor((s - 10) / 2) : -Math.floor((10 - s) / 2);
  list.innerHTML = stats.map(([key, label, sub]) => {
    const val = Number(me[key]) || 10;
    const minus = val > 7;
    const plus  = val < 13;
    const mod = _mod(val);
    const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
    return `
      <div class="pregame-row">
        <span class="pg-lbl">${label} <span class="pg-sub">${sub}</span></span>
        <button class="pg-btn pg-minus${minus ? '' : ' disabled'}" data-stat="${key}" data-delta="-1" ${minus ? '' : 'disabled'}>−</button>
        <span class="pg-val">${val} <span class="pg-mod">(${modStr})</span></span>
        <button class="pg-btn pg-plus${plus ? '' : ' disabled'}" data-stat="${key}" data-delta="1" ${plus ? '' : 'disabled'}>+</button>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.pg-btn:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const stat = btn.dataset.stat;
      const delta = parseInt(btn.dataset.delta, 10);
      ws.send(JSON.stringify({ type: 'adjust_pregame_stat', stat, delta }));
    });
  });
}

// V47-04: game_starting 진입 후 LLM 응답 대기 동안 ready-hint 갱신 — elapsed 카운터 +
// 분위기 메시지 회전 (V8-07 패턴 재사용). game_started 도착 시 자동 stop.
let _gameStartingTickerHandle = null;
let _gameStartingStartedAt = 0;
const _GAME_STARTING_TIPS = [
  '🎲 DM이 서사를 준비 중입니다',
  '📜 던전 마스터가 두루마리를 살피는 중',
  '🕯️ 운명의 흐름이 짜여지는 중',
  '🌫 안개 너머에서 첫 장면이 모이는 중',
];
function _stopGameStartingHintTicker() {
  if (_gameStartingTickerHandle) {
    clearInterval(_gameStartingTickerHandle);
    _gameStartingTickerHandle = null;
  }
}
function _startGameStartingHintTicker() {
  _stopGameStartingHintTicker();
  _gameStartingStartedAt = Date.now();
  const hint = document.getElementById('ready-hint');
  if (!hint) return;
  let idx = 0;
  const render = () => {
    const sec = Math.floor((Date.now() - _gameStartingStartedAt) / 1000);
    const tip = _GAME_STARTING_TIPS[idx % _GAME_STARTING_TIPS.length];
    let extra = '';
    if (sec >= 60) extra = ' ⚠ 응답이 늦습니다 — 새로고침 시도 가능';
    else if (sec >= 30) extra = ' (응답 콜드 스타트)';
    hint.textContent = `${tip}... (${sec}s)${extra}`;
  };
  render();
  _gameStartingTickerHandle = setInterval(() => {
    const sec = Math.floor((Date.now() - _gameStartingStartedAt) / 1000);
    if (sec > 0 && sec % 5 === 0) idx++;
    render();
  }, 1000);
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
  if (hint) {
    // V46-07: 솔로(1명) 케이스 — "모두" 표현이 헷갈림. "눌러서 모험 시작" 으로 명확화.
    if (total <= 1) {
      hint.textContent = me.is_ready ? '잠시 후 모험이 시작됩니다...' : '눌러서 혼자 모험 시작 — AI 던전 마스터 동행';
    } else {
      hint.textContent = `${readyCount} / ${total} 준비됨 — 모두 누르면 자동 시작`;
    }
  }
}

function refreshWaitingList(players) {
  _lastSeenPlayers = players;
  const list = document.getElementById('waiting-list');
  if (!list) return;
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
  const ownerBadge = p.player_id === currentOwnerId ? ' <span class="pc-owner-crown" title="방장">👑</span>' : '';
  const readyCheck = p.is_ready ? '<span class="waiting-ready">✓</span>' : '';
  // 방장이고 본인이 아니면 강퇴 버튼 노출
  const kickBtn = (isOwner && p.player_id !== myId)
    ? `<button class="waiting-kick" data-kick="${p.player_id}" title="강퇴">✕</button>`
    : '';
  el.innerHTML = `
    <img src="${escapeHtml(p.portrait_url)}" alt="${escapeHtml(p.name)}" class="waiting-portrait portrait-enlarge"
         data-full="${escapeHtml(p.portrait_url)}" data-caption="${escapeHtml(p.name)} — ${escapeHtml(p.race + ' ' + p.character_class)}"
         onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span style="font-size:1.5rem;display:none">${escapeHtml(p.emoji || '')}</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700">${ownerBadge}${escapeHtml(p.name)}${meTag}${customBadge}</div>
      <div style="color:var(--muted);font-size:.78rem">${escapeHtml(p.race_emoji || '')} ${escapeHtml(raceLabel(p))} · ${escapeHtml(p.character_class || '')}</div>
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

// V17-02: action-input placeholder 예시 회전 — 매 8초마다 다른 행동 예시.
// 사용자가 "뭘 입력해야 하지" 막연할 때 영감 주기. 본인 차례 + busy 아닐 때만 갱신.
const _ACTION_INPUT_EXAMPLES = [
  '예: 검을 뽑아 전방의 고블린을 공격한다',
  '예: 주변을 조심스럽게 살펴본다',
  '예: 동료에게 작전을 속삭인다',
  '예: 함정을 해제하려 시도한다',
  '예: 마법 주문을 외치며 손을 뻗는다',
  '예: 횃불을 들어 어둠을 비춘다',
  '예: NPC에게 정보를 캐묻는다',
  '예: 보물상자 자물쇠를 살핀다',
  '예: 적의 약점을 찾아 노린다',
  '예: 다친 동료에게 다가가 응급처치한다',
];
let _placeholderRotateTimer = null;
let _placeholderRotateIdx = 0;
function _startPlaceholderRotation() {
  if (_placeholderRotateTimer) return;
  _placeholderRotateTimer = setInterval(() => {
    const inp = document.getElementById('action-input');
    if (!inp || inp.disabled || inp.value || _dmResponding) return;
    _placeholderRotateIdx = (_placeholderRotateIdx + 1) % _ACTION_INPUT_EXAMPLES.length;
    inp.placeholder = '행동을 입력하세요... ' + _ACTION_INPUT_EXAMPLES[_placeholderRotateIdx];
  }, 8000);
}

// V17-01: 세션 경과 시간 표시 — 게임 진입 시작점 기록 후 헤더에 mm:ss 카운터.
let _sessionStartedAt = 0;
let _sessionTimerInterval = null;
function _startSessionTimer() {
  if (_sessionStartedAt) return;
  _sessionStartedAt = Date.now();
  if (_sessionTimerInterval) clearInterval(_sessionTimerInterval);
  _sessionTimerInterval = setInterval(_renderSessionTimer, 1000);
  _renderSessionTimer();
}
function _renderSessionTimer() {
  if (!_sessionStartedAt) return;
  const sec = Math.floor((Date.now() - _sessionStartedAt) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const txt = m >= 60
    ? `${Math.floor(m/60)}h ${m%60}m`
    : `${m}m ${String(s).padStart(2,'0')}s`;
  let badge = document.getElementById('session-timer-badge');
  if (!badge) {
    const header = document.querySelector('#narrative-panel .panel-header');
    if (!header) return;
    badge = document.createElement('span');
    badge.id = 'session-timer-badge';
    badge.className = 'session-timer-badge';
    badge.title = '게임 세션 경과 시간';
    header.appendChild(badge);
  }
  badge.textContent = `⏱ ${txt}`;
}

function showGame(players) {
  // 모바일 엣지 탭/HUD 는 body.in-game 상태일 때만 나타남 (엔트리/대기실에선 안 보임)
  document.body.classList.add('in-game');
  _startSessionTimer();  // V17-01
  _startPlaceholderRotation();  // V17-02
  // V43-02 + V46-02: 처음 게임 진입한 사용자 가이드 토스트 — 즉시 발화 시 DM 인트로 + monster spawn 토스트와
  // 충돌해 7개 stack 폭주. 첫 dm_response 도달 후 idle 시점에 발화 (_armFirstGameTips 가 dm_response 핸들러에서 호출).
  _armFirstGameTips();
  // 🆕 게임 진입 시점에 몬스터 영역 placeholder 강제 표시 — 첫 dm_response 오기 전에도 자리 보임
  renderMonsters([]);
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
          () => { sysToast('복사 실패 — 수동으로 기억하세요: ' + currentRoomCode, 'toast-error', '⚠'); }
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
    setTimeout(() => document.getElementById(id)?.classList.add('show'), delay);
  });

  renderCustomActions();
  initMobileDrawers();
  initActionMore();  // M-2: 모바일 "⋯ 더보기" 접이식
}

// M-2 Tier3: 모바일 액션바 부가도구(턴 스킵·몬스터 정리·주사위·나만의 행동 관리)를
// "⋯ 더보기"로 접는다. DOM 재구조화 없이 action-bar 에 클래스만 토글 → 데스크톱 무영향.
function initActionMore() {
  const bar = document.getElementById('action-bar');
  if (!bar) return;
  let open = false;
  try { open = localStorage.getItem('trog-action-more-open') === '1'; } catch (_) {}
  bar.classList.toggle('more-collapsed', !open);  // 기본 접힘
  let btn = document.getElementById('action-more-toggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'action-more-toggle';
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const collapsed = bar.classList.toggle('more-collapsed');
      try { localStorage.setItem('trog-action-more-open', collapsed ? '0' : '1'); } catch (_) {}
      _syncActionMoreLabel();
    });
    bar.appendChild(btn);  // 최종 위치는 CSS order 가 결정
  }
  _syncActionMoreLabel();
}
function _syncActionMoreLabel() {
  const bar = document.getElementById('action-bar');
  const btn = document.getElementById('action-more-toggle');
  if (!bar || !btn) return;
  btn.textContent = bar.classList.contains('more-collapsed') ? '⋯ 더보기' : '⋯ 접기';
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
  document.getElementById('edge-tab-party')?.addEventListener('click', () => {
    toggleDrawer('party-panel');
    document.getElementById('edge-tab-party')?.classList.remove('has-event');
  });
  document.getElementById('edge-tab-char')?.addEventListener('click', () => {
    toggleDrawer('char-panel');
    document.getElementById('edge-tab-char')?.classList.remove('has-event');
    document.getElementById('mobile-mini-hud')?.classList.remove('has-event');
    _resetChatUnread();  // V8-11: 패널 열면 unread 초기화
  });
  // 좌상단 미니 HUD 클릭 → 내 캐릭터 상세
  document.getElementById('mobile-mini-hud')?.addEventListener('click', () => toggleDrawer('char-panel'));
  // V32-02: drawer swipe-to-close. party=좌측이라 좌→로 스와이프, char=우측이라 우→로 스와이프.
  // backdrop tap 외에 손가락 큰 모션으로도 닫힘 (모바일 ergonomics).
  _bindDrawerSwipeClose('party-panel', 'left');
  _bindDrawerSwipeClose('char-panel', 'right');
}

// V32-02 helper: 단일 panel 에 swipe-to-close 핸들러 부착.
// direction='left' → 좌측에서 슬라이드인. dx < -threshold 이면 닫힘.
// direction='right' → 우측에서 슬라이드인. dx > +threshold 이면 닫힘.
// drawer-open 일 때만 동작 (CSS-bound). 수직 스크롤이 우세하면 무시.
function _bindDrawerSwipeClose(panelId, direction) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const SWIPE_THRESHOLD = 60;       // px
  const VERTICAL_SLOP   = 1.2;      // |dy| > |dx| * 1.2 면 수직 우세 → 무시
  let startX = 0, startY = 0, tracking = false;
  panel.addEventListener('touchstart', (e) => {
    if (!panel.classList.contains('drawer-open')) return;
    if (!isMobileViewport()) return;
    if (!e.touches || e.touches.length !== 1) { tracking = false; return; }
    // 입력 칸 안에서 시작한 터치는 무시 (텍스트 selection 등 native 동작 보존).
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      tracking = false; return;
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const ch = (e.changedTouches && e.changedTouches[0]) || null;
    if (!ch) return;
    const dx = ch.clientX - startX;
    const dy = ch.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) * VERTICAL_SLOP) return;  // 수직 스크롤 우세
    if (direction === 'left'  && dx < -SWIPE_THRESHOLD) closeAllDrawers();
    if (direction === 'right' && dx >  SWIPE_THRESHOLD) closeAllDrawers();
  }, { passive: true });
  // touchcancel 시 트래킹 정리
  panel.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
}

/* ── 좌상단 미니 HUD 갱신 (HP/MP 아크 + 초상화 + 레벨) ── */
function updateMiniHud(me) {
  if (!me) return;
  const hud = document.getElementById('mobile-mini-hud');
  const img = document.getElementById('mini-hud-portrait');
  const lvlEl = document.getElementById('mini-hud-lvl');
  if (img && me.portrait_url && img.src !== me.portrait_url) img.src = me.portrait_url;
  if (lvlEl) lvlEl.textContent = `Lv.${me.level || 1}`;

  const hp    = typeof me.hp === 'number' ? me.hp : 0;
  const maxHp = typeof me.max_hp === 'number' ? me.max_hp : 1;
  const mp    = typeof me.mp === 'number' ? me.mp : 0;
  const maxMp = typeof me.max_mp === 'number' ? me.max_mp : 1;

  // V5-05: 사망/위독 상태 시각 강조. HP=0 → 💀 오버레이 + 그레이스케일.
  // HP<=20% → 빨간 펄스 보더(임박한 위험 인지). 회복되면 즉시 해제.
  if (hud) {
    const isDead = hp <= 0 && maxHp > 0;
    const isCritical = !isDead && (hp / maxHp) <= 0.2;
    hud.classList.toggle('hud-dead', isDead);
    hud.classList.toggle('hud-critical', isCritical);
  }

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

// V8-10: 모바일에서 panel 드로어 닫혀있을 때 새 이벤트 도착 시 edge-tab/HUD 펄스.
// 드로어 열려있거나 데스크톱이면 펄스 X (사용자가 이미 보고 있음).
function _markDrawerEvent(panelId, ...indicatorIds) {
  if (typeof isMobileViewport === 'function' && !isMobileViewport()) return;
  const panel = document.getElementById(panelId);
  if (panel && panel.classList.contains('drawer-open')) return;
  for (const id of indicatorIds) {
    const el = document.getElementById(id);
    if (el) el.classList.add('has-event');
  }
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
  // M-2: 모바일↔데스크톱 경계를 넘으면 커스텀 칩 위치(프리셋 줄 ↔ 커스텀 줄) 재배치.
  if (typeof renderCustomActions === 'function' && isMobileViewport() !== _customRenderMobile) {
    renderCustomActions();
  }
});
// V21-03: orientationchange (모바일 가로↔세로 전환) — 양쪽 drawer 둘 다 열려있는
// 비정상 상태가 있을 수 있어 closeAll. unread/has-event 상태도 갱신 trigger.
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (typeof closeAllDrawers === 'function') closeAllDrawers();
    // 회전 후 mini-HUD 위치 reflow trigger (브라우저 의존)
    const hud = document.getElementById('mobile-mini-hud');
    if (hud) { hud.style.display = 'none'; void hud.offsetWidth; hud.style.display = ''; }
    // V47-06: iOS Safari 가 회전 도중 진행 중 stroke 의 pointercancel 을 누락하는 케이스 →
    // drawing 플래그 영구 stuck. 강제 endDraw 로 다음 stroke 가 비정상 직선 안 그어지게.
    try { if (typeof endDraw === 'function') endDraw(); } catch (_) {}
  }, 80);
});

// V22-01: navigator.onLine 변화 — 인터넷 단절 / 복구 즉시 시각화.
// WS reconnect 보다 먼저 잡혀서 사용자가 "아 인터넷이 끊긴 거구나" 명확.
window.addEventListener('online', () => {
  // V36-05: 정책 일관성 — "방 상태 변화" 카테고리(연결/방장/사망/이탈) 는 sysMsg + 토스트 둘 다.
  // V16-01 위급 패턴 매칭으로 sysMsg 가 자동 토스트 발화 → 한 발 호출이지만 두 채널 모두 노출.
  sysMsg('인터넷 연결 복구 — 서버 재연결 시도 중');
});
window.addEventListener('offline', () => {
  sysMsg('인터넷 연결 끊김 — 복구되면 자동 재시도');
  try { if (typeof _setConnState === 'function') _setConnState('closed'); } catch (_) {}
});

// ESC 로도 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllDrawers();
});

/* ── PLAYER / CHAR PANELS ───────────────── */

/* ── 몬스터 카드 렌더링 ──
   DM 이 `[적 등장 / 적 HP / 적 상태 / 적 퇴장]` 태그로 갱신. 비어있으면 섹션 숨김.
   서버가 broadcast 에 monsters 필드를 자동 주입하므로 players 핸들러 옆에서 함께 호출. */
// V7-01: 몬스터 HP 변화 추적용 — 직전 렌더 시점 HP 보관. 새 렌더에서 줄었으면 hit-flash + delta.
const _prevMonsterHp = new Map();   // monster_id -> hp
function renderMonsters(monsters) {
  const section = document.getElementById('monster-section');
  const list = document.getElementById('monster-list');
  if (!section || !list) return;
  const arr = Array.isArray(monsters) ? monsters : [];
  // 🆕 항상 영역 노출 — 사용자 요청: "전투 안 할 때도 몬스터 칸 자리는 만들어둬"
  section.style.display = '';
  if (!arr.length) {
    // 비어있을 때는 placeholder. 50/50 레이아웃에서 빈 자리도 자리값 차지.
    list.innerHTML = '<div class="monster-empty">전투 없음 — 적 등장 시 여기 표시</div>';
    _prevMonsterHp.clear();
    return;
  }
  list.innerHTML = '';
  arr.forEach(m => {
    const hp = Number(m.hp) || 0;
    const max = Math.max(1, Number(m.max_hp) || 1);
    const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
    const hpCls = pct >= 60 ? 'hp-hi' : (pct >= 25 ? 'hp-mid' : 'hp-lo');
    const statusChips = renderStatusChips(m.status_effects);  // 🆕 적의 버프/디버프 칩
    // 🆕 속도 뱃지 — initiative 의 기준. 명시 안 되면 표시 생략 (기본 10 도 표시).
    const spd = (typeof m.speed === 'number') ? m.speed : null;
    const speedBadge = (spd !== null) ? `<span class="monster-speed" title="속도 — 턴 순서(initiative) 기준">⚡${spd}</span>` : '';
    const mid = m.monster_id || m.id || m.name;
    const prevHp = _prevMonsterHp.has(mid) ? _prevMonsterHp.get(mid) : hp;
    const delta = hp - prevHp;     // 음수 = 피격, 양수 = 회복
    const hitFlash = (delta < 0) ? ' hit-flash' : (delta > 0 ? ' heal-flash' : '');
    const deltaOverlay = (delta !== 0)
      ? `<span class="hp-delta ${delta < 0 ? 'dmg' : 'heal'}">${delta < 0 ? delta : '+' + delta}</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'monster-card' + (hp <= 0 ? ' defeated' : '') + hitFlash;
    card.innerHTML = `
      <div class="monster-row">
        <span class="monster-name">👹 ${escapeHtml(m.name || '?')}</span>
        ${speedBadge}
        <span class="monster-hp-text">${hp} / ${max}</span>
        ${deltaOverlay}
      </div>
      <div class="monster-hp-bar"><div class="monster-hp-fill ${hpCls}" style="width:${pct}%"></div></div>
      ${statusChips}
      ${m.status_note ? `<div class="monster-status">${escapeHtml(m.status_note)}</div>` : ''}
    `;
    list.appendChild(card);
    _prevMonsterHp.set(mid, hp);
  });
  // 죽거나 사라진 몬스터의 prev 정리.
  const liveIds = new Set(arr.map(m => m.monster_id || m.id || m.name));
  for (const id of [..._prevMonsterHp.keys()]) {
    if (!liveIds.has(id)) _prevMonsterHp.delete(id);
  }
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
      <img class="dormant-portrait" src="${escapeHtml(d.portrait_url || '')}" alt="${escapeHtml(d.name)}"
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

/* 버프/디버프 효과 텍스트에서 스탯 모디파이어 추출.
   지원 형태: "공격력 +10", "공격 +5", "방어 -3", "HP +20", "마력/MP -5".
   반환: {max_hp, max_mp, attack, defense} — 실제로 찾은 스탯만 키가 있음. */
function extractBuffDelta(statuses) {
  const out = { max_hp: 0, max_mp: 0, attack: 0, defense: 0 };
  if (!Array.isArray(statuses)) return out;
  const keyMap = [
    [/공격(?:력)?/, 'attack'],
    [/방어(?:력)?/, 'defense'],
    [/(?:최대\s*)?HP|체력/i, 'max_hp'],
    [/(?:최대\s*)?MP|마력|마나/i, 'max_mp'],
  ];
  const numRe = /([+\-−])\s*(\d+)/g;
  for (const st of statuses) {
    const src = `${st.name || ''} ${st.effect || ''}`;
    // 사인별로 구간을 찾아서 바로 앞 키워드에 귀속. 간단히 문자열을 "A +10, B -3" 식으로 쪼갬.
    // 너무 복잡한 자연어는 놓칠 수 있지만, "공격력 +10, 다음 공격 2배" 같은 일반 케이스는 잡힘.
    numRe.lastIndex = 0;
    let match;
    while ((match = numRe.exec(src)) !== null) {
      const sign = (match[1] === '+' ? 1 : -1);
      const n = parseInt(match[2], 10) || 0;
      if (!n) continue;
      // 이 숫자 바로 앞의 최대 12자 구간에서 스탯 키워드를 찾아 귀속.
      const lookback = src.slice(Math.max(0, match.index - 12), match.index);
      for (const [re, key] of keyMap) {
        if (re.test(lookback)) { out[key] += sign * n; break; }
      }
    }
  }
  return out;
}

/* 기본값 + 버프 델타 를 "15 (+10)" / "15 (-3)" / "15" 로 렌더. */
function renderStatWithBuff(base, delta) {
  if (!delta) return `${base}`;
  const sign = delta > 0 ? '+' : '';
  const cls = delta > 0 ? 'stat-buff-pos' : 'stat-buff-neg';
  return `${base} <span class="${cls}">(${sign}${delta})</span>`;
}

/* 🆕 장비 보너스 + 버프 둘 다 합쳐서 effective stat 표시.
   표시: 효과있는 합산값 (기본+장비). 버프는 추가로 (+N) 분리 표기.
   tooltip 에 'base 15 + 장비 +5 [+ 버프 +3]' 분해 표시.
   - base: 기본 능력치 값
   - buffDelta: 상태이상 버프/디버프로 인한 가감
   - equipBonus: 장비 보너스 (양수만 의미있음, equipment_bonuses 에서 옴)
*/
function renderStatWithEquip(base, buffDelta, equipBonus) {
  const eq = equipBonus || 0;
  const buf = buffDelta || 0;
  const eff = base + eq;     // 장비까지 적용된 표시값
  let out;
  if (buf) {
    const sign = buf > 0 ? '+' : '';
    const cls = buf > 0 ? 'stat-buff-pos' : 'stat-buff-neg';
    out = `${eff} <span class="${cls}">(${sign}${buf})</span>`;
  } else {
    out = `${eff}`;
  }
  if (eq) {
    out += ` <span class="stat-equip-bonus" title="기본 ${base} + 장비 +${eq}">🛡+${eq}</span>`;
  }
  return out;
}

function renderStatusChips(statuses, comboBuffs) {
  // 🆕 combo_buffs (장비 조합 영구 버프) 도 같이 렌더 — 칩 모양은 동일, 클래스만 다름.
  const list = [];
  if (Array.isArray(comboBuffs)) {
    comboBuffs.forEach(cb => list.push({ ...cb, _kind: 'combo' }));
  }
  if (Array.isArray(statuses)) {
    statuses.forEach(st => list.push({ ...st, _kind: 'status' }));
  }
  if (!list.length) return '';
  const chips = list.map(item => {
    if (item._kind === 'combo') {
      // 영구 버프 — turns 표시 안 함, 🔗 chain 아이콘
      const tip = `${item.name} (영구 — 장비 조합)\n${item.effect}`;
      return `<span class="status-chip combo-buff" title="${escapeHtml(tip)}">
                ${item.icon || '🔗'} ${escapeHtml(item.name)}
                <span class="status-turns">∞</span>
              </span>`;
    }
    // 일반 buff/debuff
    const cls = item.kind === '버프' ? 'buff' : 'debuff';
    const emoji = item.kind === '버프' ? '✨' : '☠';
    // V9-02: 1턴 남으면 expiring 클래스로 깜빡 — 사라지기 직전임을 인지하게.
    const expiring = item.turns_remaining === 1 ? ' expiring' : '';
    const tip = item.effect
      ? `${item.name} (${item.turns_remaining}턴)\n${item.effect}`
      : `${item.name} (${item.turns_remaining}턴)`;
    return `<span class="status-chip ${cls}${expiring}" title="${escapeHtml(tip)}">
              ${emoji} ${escapeHtml(item.name)}
              <span class="status-turns">${item.turns_remaining}턴</span>
            </span>`;
  }).join('');
  return `<div class="status-row">${chips}</div>`;
}

// V7-02: 플레이어 HP 변화 추적 — 직전 렌더 HP 와 비교해 hit-flash/heal-flash 적용.
const _prevPlayerHp = new Map();   // player_id -> hp
// V9-03: is_dead transition 추적 — false→true 시 사망 토스트, true→false 시 부활 토스트.
const _prevPlayerDead = new Map(); // player_id -> bool
function refreshPlayers(players) {
  _lastSeenPlayers = players;
  const list = document.getElementById('party-list');
  if (!list) return;
  list.innerHTML = '';
  const panel = document.getElementById('party-panel');
  if (panel) panel.classList.toggle('collapsed-cards', _partyCollapsed);
  const liveIds = new Set();
  players.forEach((p, i) => {
    liveIds.add(p.player_id);
    // V9-03: 사망/부활 transition 감지
    const wasDead = _prevPlayerDead.get(p.player_id);
    if (wasDead === false && p.is_dead) {
      const layer = ensureToastLayer();
      if (p.player_id === myId) {
        pushToast(layer, `💀 당신이 쓰러졌습니다 — 동료의 부활을 기다리세요`, 'toast-death');
        sysMsg('💀 당신이 쓰러졌습니다. 행동 불가, 채팅은 가능. 성직자/구원의 빛/부활약 등이 필요합니다.');
      } else {
        pushToast(layer, `💀 ${p.name} 이(가) 쓰러졌습니다`, 'toast-death');
      }
    } else if (wasDead === true && !p.is_dead) {
      const layer = ensureToastLayer();
      pushToast(layer, `✨ ${p.player_id === myId ? '당신이' : p.name + ' 이(가)'} 다시 일어섰습니다`, 'toast-revive');
    }
    _prevPlayerDead.set(p.player_id, !!p.is_dead);
    const hpPct = statPct(p.hp, p.max_hp);
    const hpCol = hpPct > 60 ? 'var(--hp-hi)' : hpPct > 30 ? 'var(--hp-mid)' : 'var(--hp-lo)';
    const mp    = typeof p.mp === 'number' ? p.mp : 0;
    const maxMp = typeof p.max_mp === 'number' ? p.max_mp : 0;
    const mpPct = statPct(mp, maxMp);
    const kickBtn = (isOwner && !isSpectator && p.player_id !== myId)
      ? `<button class="pc-kick" data-kick-pid="${p.player_id}" title="강퇴 / 턴 자동 스킵">✕</button>`
      : '';
    const statusChips = renderStatusChips(p.status_effects, p.combo_buffs);

    // V7-02: HP 델타 계산
    const prevHp = _prevPlayerHp.has(p.player_id) ? _prevPlayerHp.get(p.player_id) : p.hp;
    const hpDelta = p.hp - prevHp;
    const hitCls = (hpDelta < 0) ? ' hit-flash' : (hpDelta > 0 ? ' heal-flash' : '');

    const card = document.createElement('div');
    // V7-05: HP 25% 이하면 critical 클래스 — CSS 에서 빨간 펄스 보더. 사망(.dead)은 우선.
    const isCritical = !p.is_dead && p.max_hp > 0 && (p.hp / p.max_hp) <= 0.25;
    // 🆕 사망 플레이어 카드 — .dead 클래스로 그레이스케일·💀 뱃지 (CSS 에서 처리).
    card.className = 'player-card'
      + (p.player_id === myId ? ' mine' : '')
      + (p.is_dead ? ' dead' : '')
      + (isCritical ? ' critical' : '')
      + hitCls;
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
            <img src="${escapeHtml(p.portrait_url)}" alt="${escapeHtml(p.name)}" class="pc-compact-portrait portrait-enlarge"
                 data-full="${escapeHtml(p.portrait_url)}" data-caption="${escapeHtml(p.name)}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
            <span class="pc-emoji-fallback" style="display:none">${escapeHtml(p.emoji)}</span>
            <div class="pc-compact-name">${p.player_id === currentOwnerId ? '<span class="pc-owner-crown">👑</span>' : ''}${escapeHtml(p.name)} <span class="pc-lvl">Lv.${p.level}</span></div>
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
              <img src="${escapeHtml(p.portrait_url)}" alt="${escapeHtml(p.name)}" class="pc-portrait portrait-enlarge" data-full="${escapeHtml(p.portrait_url)}" data-caption="${escapeHtml(p.name)} — ${escapeHtml(p.race + ' ' + p.character_class + ' · Lv.' + p.level)}"
                   onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
              <span class="pc-emoji-fallback" style="display:none">${escapeHtml(p.emoji)}</span>
            </div>
          </div>
          <div class="pc-info">
            <div class="pc-name">
              ${p.player_id === currentOwnerId ? '<span class="pc-owner-crown" title="방장">👑</span>' : ''}
              ${escapeHtml(p.name)}
              <span class="pc-lvl">Lv.${p.level}</span>
              ${p.player_id === myId ? '<span style="color:var(--gold);font-size:.7rem">(나)</span>' : ''}
            </div>
            <div class="pc-class">${escapeHtml(p.race_emoji || '')} ${escapeHtml(raceLabel(p))} · ${escapeHtml(p.character_class)}</div>
          </div>
          ${kickBtn}
        </div>
        <div class="hp-label">HP ${p.hp} / ${p.max_hp}</div>
        <div class="hp-track"><div class="hp-fill" style="width:${hpPct}%;background:${hpCol}"></div></div>
        <div class="mp-label">MP ${mp} / ${maxMp}</div>
        <div class="mp-track"><div class="mp-fill" style="width:${mpPct}%"></div></div>
        <div class="pc-gold" title="소지 금액">💰 ${(typeof p.gold === 'number' ? p.gold : 0)} G</div>
        ${statusChips}
      `;
    }
    list.appendChild(card);
    // V7-02: prev HP 갱신 — 다음 렌더에서 델타 비교용
    _prevPlayerHp.set(p.player_id, p.hp);
  });
  // 떠난 플레이어의 prev 정리.
  for (const pid of [..._prevPlayerHp.keys()]) {
    if (!liveIds.has(pid)) _prevPlayerHp.delete(pid);
  }
  for (const pid of [..._prevPlayerDead.keys()]) {
    if (!liveIds.has(pid)) _prevPlayerDead.delete(pid);
  }

}

// V22-02 / kick: 파티 리스트 클릭은 매 렌더마다 리스너 재부착하지 않고 컨테이너 위임 1회로.
(function bindPartyListClicks() {
  document.addEventListener('click', (e) => {
    const kickBtn = e.target.closest('.pc-kick');
    if (kickBtn) {
      e.stopPropagation();
      const tid = kickBtn.dataset.kickPid;
      if (!tid || !ws) return;
      const target = (_lastSeenPlayers || []).find(x => x.player_id === tid);
      const nm = target ? target.name : '이 플레이어';
      if (confirm(`${nm}을(를) 강퇴합니까? (게임 중이면 턴이 자동 스킵됩니다)`)) {
        ws.send(JSON.stringify({ type: 'kick_player', target_id: tid }));
      }
      return;
    }
    // 모바일에서 본인 카드(.player-card.mine) 탭 시 char-panel 펼침 — 빠른 시트 액세스.
    const mineCard = e.target.closest('.player-card.mine');
    if (mineCard) {
      if (e.target.closest('.portrait-enlarge')) return;
      if (typeof isMobileViewport === 'function' && isMobileViewport()) {
        if (typeof toggleDrawer === 'function') toggleDrawer('char-panel');
      }
    }
  });
})();

(function bindPartyCollapse() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'party-collapse-btn') {
      setPartyCollapsed(!_partyCollapsed);
    }
  });
})();

// 🆕 미니 상점 카탈로그 — 서버 SHOP_CATALOG 와 일치해야 함 (가격/효과 표기용).
const SHOP_ITEMS = [
  { key: 'heal_s', name: '회복 물약',      price: 60,  effect: 'HP +40' },
  { key: 'heal_l', name: '고급 회복 물약', price: 150, effect: 'HP +100' },
  { key: 'mana_s', name: '마나 물약',      price: 60,  effect: 'MP +40' },
];
const POTION_NAMES = new Set(SHOP_ITEMS.map(s => s.name));

function refreshCharPanel(players) {
  const me = players.find(p => p.player_id === myId);
  if (!me) return;
  updateMiniHud(me);  // 모바일 좌상단 HUD 도 같이 갱신
  const hpPct = statPct(me.hp, me.max_hp);
  const hpCol = hpPct > 60 ? 'var(--hp-hi)' : hpPct > 30 ? 'var(--hp-mid)' : 'var(--hp-lo)';

  // 🆕 MP 진행도
  const mp    = typeof me.mp === 'number' ? me.mp : 0;
  const maxMp = typeof me.max_mp === 'number' ? me.max_mp : 0;
  const mpPct = statPct(mp, maxMp);

  // 🆕 버프/디버프 수치 효과 추출 — "공격력 +10" 같은 걸 숫자로 만들어 스탯에 (+10) 로 병기.
  // 서버는 여전히 base stat 만 관리 (서사·밸런스 영향 최소). UI 표시에만 쓰는 시뮬레이션.
  const buffDelta = extractBuffDelta(me.status_effects);
  // 🆕 장비 효과 보너스 (서버 to_dict 에서 받음). 없으면 빈 객체.
  const eqBonuses = (me && typeof me.equipment_bonuses === 'object' && me.equipment_bonuses) || {};

  // XP 진행도: 다음 레벨까지 비율
  const xpNeeded = (me.xp_to_next || 0) + (me.xp - xpBaseForLevel(me.level));
  const xpProgress = xpNeeded > 0
    ? Math.round(((me.xp - xpBaseForLevel(me.level)) / xpNeeded) * 100)
    : 0;

  // 🆕 장착 장비 3슬롯 — 효과 툴팁: 알려진 효과 or "효과: 아직 잘 모르겠다"
  const eq = me.equipped || {};
  // 🆕 [P-2] 슬롯 탭 → 해제/교체 시트. slotKey 는 서버 슬롯명(main_hand/off_hand/armor/accessory).
  //   본인 살아있을 때만 탭 가능(관전자는 char-panel 자체가 안 뜸, 사망은 dim + 가드).
  const tappable = !isSpectator && !me.is_dead;
  const slot = (icon, label, item, slotKey) => {
    // item 은 문자열 또는 {name, effect} 딕트 허용
    const data = (item && typeof item === 'object') ? item : { name: item || '', effect: null };
    const name = data.name || '';
    const tapAttrs = tappable ? ` data-eq-slot="${slotKey}" role="button" tabindex="0"` : '';
    if (!name) {
      return `<div class="eq-slot eq-empty${tappable ? ' eq-tappable' : ''}" title="${tappable ? '탭해서 장비 장착' : '비어 있음'}"${tapAttrs}>
                <span class="eq-icon">${icon}</span>
                <span class="eq-label">${label}</span>
                <span class="eq-item eq-empty-cta">${tappable ? '＋ 비어 있음' : '—'}</span>
              </div>`;
    }
    const effect = data.effect;
    const tip = (effect
      ? `${name}\n효과: ${effect}`
      : `${name}\n효과: 아직 잘 모르겠다`) + (tappable ? '\n(탭 → 해제/교체)' : '');
    const cls = effect ? 'has-effect' : 'effect-unknown';
    const effLine = effect
      ? `<span class="eq-effect">${escapeHtml(effect)}</span>`
      : `<span class="eq-effect eq-unk">효과: 아직 잘 모르겠다</span>`;
    return `<div class="eq-slot ${cls}${tappable ? ' eq-tappable' : ''}" title="${escapeHtml(tip)}"${tapAttrs}>
              <div class="eq-row">
                <span class="eq-icon">${icon}</span>
                <span class="eq-label">${label}</span>
                <span class="eq-item">${escapeHtml(name)}</span>
              </div>
              ${effLine}
            </div>`;
  };
  // 🆕 4슬롯 — main_hand(왼손)/off_hand(오른손)/armor/accessory.
  // 구버전 save 호환: weapon → main_hand 폴백.
  const mainH = eq.main_hand || eq.weapon;   // 구버전 호환
  const offH  = eq.off_hand;
  // 🆕 양손 동일 무기(쌍단검·쌍검 등) → 표시 통합
  const isDual = mainH && offH
                 && typeof mainH === 'object' && typeof offH === 'object'
                 && mainH.name && mainH.name === offH.name;
  const equipHtml = isDual
    ? `<div class="equipment">
        <div class="eq-title">🛡 장착 중${tappable ? ' <span class="eq-hint-tap">— 슬롯을 탭해 해제·교체</span>' : ''}</div>
        ${slot('⚔️⚔️', '양손 (쌍)', mainH, 'main_hand')}
        ${slot('🛡',  '방어구', eq.armor, 'armor')}
        ${slot('💎', '장신구', eq.accessory, 'accessory')}
      </div>`
    : `<div class="equipment">
        <div class="eq-title">🛡 장착 중${tappable ? ' <span class="eq-hint-tap">— 슬롯을 탭해 해제·교체</span>' : ''}</div>
        ${slot('🗡️', '왼손',   mainH, 'main_hand')}
        ${slot('🛡',  '오른손', offH, 'off_hand')}
        ${slot('🥋', '방어구', eq.armor, 'armor')}
        ${slot('💎', '장신구', eq.accessory, 'accessory')}
      </div>`;

  const inv = Array.isArray(me.inventory) ? me.inventory : [];
  // 인벤토리 요소는 이제 {name, effect, quantity, kind} 딕트. (구 포맷 '문자열'도 방어적으로 처리)
  // kind: 'consumable' | 'equipment' | 'quest'
  const renderItem = (it) => {
    const obj = (typeof it === 'string') ? { name: it, effect: null, quantity: 1, kind: 'consumable' } : (it || {});
    const name = obj.name || '';
    const effect = obj.effect;
    const qty = (typeof obj.quantity === 'number' && obj.quantity > 0) ? obj.quantity : 1;
    const kind = obj.kind || 'consumable';
    const qtyHtml = qty > 1 ? `<span class="inv-item-qty">×${qty}</span>` : '';
    const title = effect
      ? `${name}${qty > 1 ? ' ×' + qty : ''}\n효과: ${effect}`
      : `${name}${qty > 1 ? ' ×' + qty : ''}\n(효과 미확인)`;
    // kind 기반 버튼 분기 — 모바일에서 "사용" 한 번 눌렀는데 장비 장착되는 혼선 방지.
    let actionBtn = '';
    let kindBadge = '';
    if (kind === 'equipment') {
      actionBtn = `<button class="inv-equip-btn" data-equip-item="${escapeHtml(name)}" title="이 장비를 장착 (기존 장비는 인벤토리로 회수)">장착</button>`;
      kindBadge = '<span class="inv-kind-badge inv-kind-equip" title="장비">🛡 장비</span>';
    } else if (kind === 'quest') {
      actionBtn = '';
      kindBadge = '<span class="inv-kind-badge inv-kind-quest" title="퀘스트 아이템 — 사용/장착 불가">📜 퀘스트</span>';
    } else if (POTION_NAMES.has(name)) {
      // 🆕 상점 물약 — 서버 직접 HP/MP 적용 경로(use_potion). DM 위임 안 함.
      actionBtn = `<button class="inv-use-btn" data-potion-item="${escapeHtml(name)}" title="즉시 사용 — 서버가 HP/MP 적용">사용</button>`;
      kindBadge = '<span class="inv-kind-badge inv-kind-consume" title="물약 — 즉시 효과">🧪 물약</span>';
    } else {
      actionBtn = `<button class="inv-use-btn" data-use-item="${escapeHtml(name)}" title="이 아이템을 1개 사용">사용</button>`;
      kindBadge = '<span class="inv-kind-badge inv-kind-consume" title="소모품 — 사용 시 1개 소비">🍶 소모품</span>';
    }
    // data-effect-toggle: 모바일에서 hover 가 안 되는 환경 대응 — 카드 자체를 탭하면 효과 표시 토글.
    return `
      <div class="inv-item ${effect ? 'has-effect' : 'effect-unknown'}" data-effect-toggle="1" title="${escapeHtml(title)}">
        <div class="inv-item-head">
          <div class="inv-item-name">${escapeHtml(name)}${qtyHtml}${kindBadge}</div>
          ${actionBtn}
        </div>
        <div class="inv-item-effect">${effect ? escapeHtml(effect) : '<span class="unk">? 아직 알 수 없음</span>'}</div>
      </div>
    `;
  };
  // 🆕 종류별 정렬 + 그룹화 — 장비 → 소모품 → 퀘스트 순.
  // 각 그룹 헤더는 클릭 시 접기/펼치기 (localStorage 로 상태 기억).
  const groups = { equipment: [], consumable: [], quest: [] };
  inv.forEach(it => {
    const obj = (typeof it === 'string')
      ? { name: it, effect: null, quantity: 1, kind: 'consumable' }
      : (it || {});
    const k = (obj.kind === 'equipment' || obj.kind === 'quest') ? obj.kind : 'consumable';
    groups[k].push(obj);
  });
  // 각 그룹 내부는 이름순으로 정렬 (안정적 표시)
  Object.values(groups).forEach(arr =>
    arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'))
  );

  const collapsedGroups = (() => {
    try { return JSON.parse(localStorage.getItem('trog-inv-collapsed') || '{}') || {}; }
    catch (_) { return {}; }
  })();

  const groupSection = (key, title, icon, items) => {
    if (!items.length) return '';
    const isCollapsed = !!collapsedGroups[key];
    const itemsHtml = items.map(renderItem).join('');
    return `
      <div class="inv-group ${isCollapsed ? 'collapsed' : ''}" data-inv-group="${key}">
        <div class="inv-group-header" data-toggle-inv-group="${key}">
          <span class="inv-group-chev">${isCollapsed ? '▶' : '▼'}</span>
          <span class="inv-group-title">${icon} ${title} <span class="inv-group-count">${items.length}</span></span>
        </div>
        <div class="inv-group-body">${itemsHtml}</div>
      </div>`;
  };

  const invHtml = inv.length
    ? `<div class="inventory">
         <div class="inv-title">🎒 소지품 (${inv.length})</div>
         ${groupSection('equipment', '장비',   '🛡', groups.equipment)}
         ${groupSection('consumable', '소모품', '🍶', groups.consumable)}
         ${groupSection('quest',      '퀘스트', '📜', groups.quest)}
       </div>`
    : `<div class="inventory inv-empty">🎒 소지품 없음</div>`;

  // 🆕 미니 상점 — 서버 고정가 물약. 접이식 (localStorage 상태 공유).
  const shopCollapsed = !!collapsedGroups['shop'];
  const myGold = (typeof me.gold === 'number' ? me.gold : 0);
  const shopRows = SHOP_ITEMS.map(s => {
    const afford = myGold >= s.price;
    return `
      <div class="shop-item">
        <span class="shop-item-name">${escapeHtml(s.name)} <span class="shop-item-eff">${escapeHtml(s.effect)}</span></span>
        <button class="shop-buy-btn${afford ? '' : ' disabled'}" data-shop-buy="${s.key}"${afford ? '' : ' disabled'} title="${afford ? '구매' : '골드 부족'}">${s.price}G</button>
      </div>`;
  }).join('');
  const shopHtml = `
    <div class="inv-group inventory shop-box ${shopCollapsed ? 'collapsed' : ''}" data-inv-group="shop">
      <div class="inv-group-header" data-toggle-inv-group="shop">
        <span class="inv-group-chev">${shopCollapsed ? '▶' : '▼'}</span>
        <span class="inv-group-title">🧪 상점 <span class="inv-group-count">${SHOP_ITEMS.length}</span></span>
      </div>
      <div class="inv-group-body">${shopRows}</div>
    </div>`;

  const myStatusChips = renderStatusChips(me.status_effects, me.combo_buffs);

  document.getElementById('char-body').innerHTML = `
    <div class="char-avatar">
      <div class="char-sprite-wrap">
        <div class="char-sprite walk-idle">
          <img src="${escapeHtml(me.portrait_url)}" alt="${escapeHtml(me.name)}" class="char-portrait portrait-enlarge" data-full="${escapeHtml(me.portrait_url)}" data-caption="${escapeHtml(me.name)} — ${escapeHtml(me.race + ' ' + me.character_class + ' · Lv.' + me.level)}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
          <span class="char-emoji-fallback" style="display:none">${escapeHtml(me.emoji || '')}</span>
        </div>
      </div>
    </div>
    <div class="char-name">${escapeHtml(me.name)} <button class="char-export-btn" id="char-export-btn" title="캐릭터 정보 복사">📋</button></div>
    <div class="char-sub">${escapeHtml(me.race_emoji || '')} ${escapeHtml(raceLabel(me))} · ${escapeHtml(me.character_class || '')} · <span class="lvl-chip">Lv.${me.level}</span></div>

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
      // 🆕 6 ability score 행 — STR/INT/WIS/DEX/CHA/CON. 매력은 + 버튼 disabled (생성 시 고정).
      // 🆕 ability_modifier — 영점(10) 기준 대칭. 서버 ability_modifier 와 일치해야 함.
      // | 점수 | 7  | 8  | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
      // | mod  | -1 | -1 | 0 | 0  | 0  | +1 | +1 | +2 | +2 | +3 |
      const _abilMod = (score) => {
        const s = Number(score) || 10;
        return s >= 10 ? Math.floor((s - 10) / 2) : -Math.floor((10 - s) / 2);
      };
      const _modStr = (score) => {
        const m = _abilMod(score);
        return m >= 0 ? `+${m}` : `${m}`;
      };
      const abilityRow = (key, label, sub, hint, locked) => {
        const score = (typeof me[key] === 'number') ? me[key] : 10;
        const eqB = eqBonuses[key] || 0;
        const eff = score + eqB;
        const lockBadge = locked
          ? '<span class="stat-locked" title="매력은 생성 시 고정 — 레벨업으로 올릴 수 없음">🔒</span>'
          : '';
        const btn = locked
          ? '<button class="stat-plus disabled" type="button" disabled title="매력은 레벨업 불가">＋</button>'
          : plusBtn(key, 1, hint);
        // 🆕 장비 보너스 있으면 합산값 + 🛡 표시 (modifier 도 effective 기준)
        const valHtml = eqB
          ? `${eff} <span class="stat-mod">(${_modStr(eff)})</span>` +
            ` <span class="stat-equip-bonus" title="기본 ${score} + 장비 +${eqB}">🛡+${eqB}</span>`
          : `${score} <span class="stat-mod">(${_modStr(score)})</span>`;
        return `
          <div class="stat-row stat-row-plus stat-ability">
            <span class="stat-lbl">${label} <span class="stat-sub">${sub}</span> ${lockBadge}</span>
            <span class="stat-val">${valHtml}</span>
            ${btn}
          </div>`;
      };
      return `
        <div class="stat-detail">
          <div class="stat-detail-title">⚙ 세부 스탯</div>
          ${banner}
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">체력 <span class="stat-sub">max HP</span></span>
            <span class="stat-val">${renderStatWithBuff(me.max_hp, buffDelta.max_hp)}</span>
            ${plusBtn('max_hp', 5, '최대 HP 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">마력 <span class="stat-sub">max MP</span></span>
            <span class="stat-val">${renderStatWithBuff(me.max_mp, buffDelta.max_mp)}</span>
            ${plusBtn('max_mp', 5, '최대 MP 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">공격 <span class="stat-sub">ATK</span></span>
            <span class="stat-val">${renderStatWithEquip(me.attack, buffDelta.attack, eqBonuses.attack)}</span>
            ${plusBtn('attack', 1, '공격력 증가')}
          </div>
          <div class="stat-row stat-row-plus">
            <span class="stat-lbl">방어 <span class="stat-sub">DEF</span></span>
            <span class="stat-val">${renderStatWithEquip(me.defense, buffDelta.defense, eqBonuses.defense)}</span>
            ${plusBtn('defense', 1, '방어력 증가')}
          </div>
          <div class="stat-section-divider">— 6 능력치 (D&D 표준) —</div>
          ${abilityRow('strength',     '근력', 'STR', '근력 — 물리 공격, 들기', false)}
          ${abilityRow('intelligence', '지능', 'INT', '지능 — 마법, 지식', false)}
          ${abilityRow('wisdom',       '지혜', 'WIS', '지혜 — 인지, 의지', false)}
          ${abilityRow('dexterity',    '기교', 'DEX', '기교 — 속도(턴순서), 회피', false)}
          ${abilityRow('charisma',     '매력', 'CHA', '매력 — 사교 (생성 시 고정)', true)}
          ${abilityRow('constitution', '건강', 'CON', '건강 — HP·독 저항', false)}
          <div class="stat-row"><span class="stat-lbl">XP</span><span class="stat-val">${me.xp} <span class="xp-next">(다음까지 ${me.xp_to_next || 0})</span></span></div>
          <div class="xp-track"><div class="xp-fill" style="width:${xpProgress}%"></div></div>
          <div class="stat-row stat-gold"><span class="stat-lbl">💰 소지 금액</span><span class="stat-val">${(typeof me.gold === 'number' ? me.gold : 0)} G</span></div>
        </div>
      `;
    })()}

    ${myStatusChips}
    ${equipHtml}
    ${invHtml}
    ${shopHtml}
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

  // 🆕 인벤 그룹 헤더 — 클릭 시 접기/펼치기 (localStorage 영구 기억).
  document.querySelectorAll('#char-body [data-toggle-inv-group]').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const key = hdr.dataset.toggleInvGroup;
      const group = hdr.parentElement;
      if (!group) return;
      const willCollapse = !group.classList.contains('collapsed');
      group.classList.toggle('collapsed', willCollapse);
      const chev = hdr.querySelector('.inv-group-chev');
      if (chev) chev.textContent = willCollapse ? '▶' : '▼';
      // localStorage 에 상태 저장
      try {
        const s = JSON.parse(localStorage.getItem('trog-inv-collapsed') || '{}') || {};
        s[key] = willCollapse;
        localStorage.setItem('trog-inv-collapsed', JSON.stringify(s));
      } catch (_) {}
    });
  });

  // 사용/장착 버튼 + 인벤 카드 클릭(효과 토글) 위임 바인딩.
  // 효과 토글: 모바일에서 hover 가 안 되니, 카드 자체를 탭하면 .show-effect 클래스로 펼침.
  // 사용/장착 버튼은 자체 stopPropagation 으로 토글에서 제외.
  document.querySelectorAll('#char-body .inv-item[data-effect-toggle]').forEach(card => {
    card.addEventListener('click', (e) => {
      // 버튼 영역 클릭이면 토글 안 함 (버튼 자체 핸들러가 처리)
      if (e.target.closest('.inv-use-btn,.inv-equip-btn')) return;
      card.classList.toggle('show-effect');
    });
  });

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
      // 2-클릭 confirm
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
      clearTimeout(Number(btn.dataset.timeoutId || 0));
      btn.dataset.confirming = '';
      btn.classList.remove('confirming');
      try {
        ws.send(JSON.stringify({ type: 'use_item', item_name: item, action: 'use' }));
      } catch (err) {
        console.error('[use_item] send failed:', err);
        const layer = ensureToastLayer();
        pushToast(layer, `⚠ 전송 실패: ${err.message || err}`, 'toast-error');
      }
    });
  });

  // 🆕 물약 사용 버튼 — 서버 use_potion 으로 HP/MP 즉시 적용.
  document.querySelectorAll('#char-body [data-potion-item]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSpectator) return;
      const item = btn.dataset.potionItem;
      if (!item) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const layer = ensureToastLayer();
        pushToast(layer, '⚠ 서버 연결 끊김 — 잠시 후 다시 시도', 'toast-error');
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'use_potion', item_name: item }));
      } catch (err) {
        console.error('[use_potion] send failed:', err);
      }
    });
  });

  // 🆕 상점 구매 버튼 — 서버 shop_buy 로 골드 차감 + 인벤 지급.
  document.querySelectorAll('#char-body .shop-buy-btn:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSpectator) return;
      const key = btn.dataset.shopBuy;
      if (!key || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'shop_buy', item_key: key }));
      } catch (err) {
        console.error('[shop_buy] send failed:', err);
      }
    });
  });

  // 장착 버튼 — kind='equipment' 인 인벤 항목에만 노출됨.
  // 슬롯 자동 결정: 이름 키워드로 weapon/armor/accessory 추론. 미상이면 weapon.
  document.querySelectorAll('#char-body .inv-equip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSpectator) return;
      const item = btn.dataset.equipItem;
      if (!item || !ws || ws.readyState !== WebSocket.OPEN) return;
      // 슬롯 추론 (O-3: 서버 목록과 동일한 guessEquipSlot 사용)
      const slot = guessEquipSlot(item);
      // 1-클릭 confirm
      if (btn.dataset.confirming !== '1') {
        btn.dataset.confirming = '1';
        const originalText = btn.textContent;
        btn.textContent = '장착?';
        btn.classList.add('confirming');
        const tid = setTimeout(() => {
          btn.dataset.confirming = '';
          btn.textContent = originalText;
          btn.classList.remove('confirming');
        }, 2000);
        btn.dataset.timeoutId = String(tid);
        return;
      }
      clearTimeout(Number(btn.dataset.timeoutId || 0));
      btn.dataset.confirming = '';
      btn.classList.remove('confirming');
      try {
        ws.send(JSON.stringify({ type: 'use_item', item_name: item, action: 'equip', slot }));
      } catch (err) {
        console.error('[equip_item] send failed:', err);
      }
    });
  });

  // 🆕 [P-2] 장비 슬롯 탭 → 해제/교체 시트. me(현재 캐릭터)를 closure 로 넘김.
  if (tappable) {
    document.querySelectorAll('#char-body .eq-slot[data-eq-slot]').forEach(el => {
      const openIt = (e) => { e.stopPropagation(); openEquipPicker(el.dataset.eqSlot, me); };
      el.addEventListener('click', openIt);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(e); }
      });
    });
  }

  // V13-02: 캐릭터 시트 텍스트 export — 본인 정보 한꺼번에 클립보드 복사.
  // 친구에게 공유하거나 별도 노트 기록할 때 사용.
  const exportBtn = document.getElementById('char-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lines = [];
      lines.push(`=== ${me.name} (Lv.${me.level} ${me.character_class}) ===`);
      lines.push(`종족: ${raceLabel(me)}`);
      // V36-02: 수인 동물·비율 별도 라인 — V33-03 import 가 entry-form 의 동물·슬라이더까지 자동 채울 수 있게 명시.
      if (me.race === '수인' && me.race_animal) {
        const ratioStr = (typeof me.race_ratio === 'number') ? ` · 동물성 ${me.race_ratio}%` : '';
        lines.push(`종족-상세: ${me.race_animal}${ratioStr}`);
      }
      // V21-11: 시나리오 + 시간/일차 + 세션 경과 동봉 (캐릭터 시트의 컨텍스트)
      if (_currentScenario && _currentScenario.name) {
        lines.push(`시나리오: ${_currentScenario.emoji || ''} ${_currentScenario.name}`);
      }
      const tBadge = document.getElementById('time-badge');
      if (tBadge && tBadge.textContent && tBadge.style.display !== 'none') {
        lines.push(`시간: ${tBadge.textContent}`);
      }
      if (_sessionStartedAt) {
        const sec = Math.floor((Date.now() - _sessionStartedAt) / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        lines.push(`세션 경과: ${m}m ${String(s).padStart(2,'0')}s`);
      }
      lines.push(`HP: ${me.hp}/${me.max_hp}   MP: ${me.mp || 0}/${me.max_mp || 0}`);
      lines.push(`공격: ${me.attack}   방어: ${me.defense}`);
      lines.push(`STR ${me.strength} INT ${me.intelligence} WIS ${me.wisdom} DEX ${me.dexterity} CHA ${me.charisma} CON ${me.constitution}`);
      lines.push(`XP: ${me.xp} (다음 레벨까지 ${me.xp_to_next})`);
      lines.push(`💰 ${me.gold || 0} G`);
      const eq = me.equipped || {};
      const eqNames = [];
      const slotName = { main_hand: '왼손', off_hand: '오른손', weapon: '무기', armor: '방어구', accessory: '장신구' };
      for (const k of ['main_hand', 'off_hand', 'weapon', 'armor', 'accessory']) {
        const v = eq[k];
        if (v && (v.name || typeof v === 'string')) {
          eqNames.push(`${slotName[k] || k}: ${v.name || v}`);
        }
      }
      if (eqNames.length) lines.push(`장착: ${eqNames.join(' | ')}`);
      const inv = (me.inventory || []).map(it => {
        const name = (typeof it === 'string') ? it : (it.name || '?');
        const qty = (typeof it === 'object' && it.quantity > 1) ? `×${it.quantity}` : '';
        return `${name}${qty}`;
      });
      if (inv.length) lines.push(`소지품 (${inv.length}): ${inv.join(', ')}`);
      // V36-02: 상태효과 / 콤보 버프 — 시점 컨텍스트로 노트 기록에 의미.
      // V38-04: status_effects 는 List[{kind, name, turns_remaining, effect}] 구조 — 배열 처리 정확화.
      const stArr = Array.isArray(me.status_effects) ? me.status_effects : [];
      const stEntries = stArr.map(st => {
        if (!st) return '';
        const nm = st.name || '?';
        const tr = (typeof st.turns_remaining === 'number') ? st.turns_remaining : '';
        const kindMark = st.kind === 'debuff' ? '🔻' : '✨';
        return tr !== '' ? `${kindMark}${nm}(${tr}턴)` : `${kindMark}${nm}`;
      }).filter(Boolean);
      if (stEntries.length) lines.push(`상태효과: ${stEntries.join(', ')}`);
      const cb = me.combo_buffs;
      if (cb && Array.isArray(cb) && cb.length) {
        lines.push(`콤보버프: ${cb.map(b => (typeof b === 'string') ? b : (b.name || '?')).join(', ')}`);
      }
      const txt = lines.join('\n');
      const showCopied = () => {
        const layer = ensureToastLayer();
        pushToast(layer, '📋 캐릭터 정보 복사됨', 'toast-item-mine');
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(showCopied, () => alert(txt));
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showCopied(); } catch (_) { alert(txt); }
        finally { document.body.removeChild(ta); }
      }
    });
  }
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

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function statPct(current, max) {
  const den = Number(max);
  if (!Number.isFinite(den) || den <= 0) return 0;
  return clampPct((Number(current) || 0) / den * 100);
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
  // V35-02 + V36-07: 라인당 italic 매치 cap (4회) — `*BUG*` 처럼 다발 노출 시 over-styling 방지.
  // V36-07: 한국어 종결자 (… 。 、 ) 닫는 따옴표 (」』) 도 lookahead 에 포함 — false-negative 보완.
  // U+2026 = …, U+3002 = 。, U+FF61 = ｡, U+300D = 」, U+300F = 』
  const _ITALIC_END = '$|\\s|[.,!?:;\\u2026\\u3002\\u3001\\uff61\\u300d\\u300f]';
  const _italicAst = new RegExp('(^|\\s)\\*([^*\\n\\s][^*\\n]*?)\\*(?=' + _ITALIC_END + ')', 'g');
  const _italicUnd = new RegExp('(^|\\s)_([^_\\n\\s][^_\\n]*?)_(?=' + _ITALIC_END + ')', 'g');
  h = h.split('\n').map(line => {
    let count = 0;
    let l = line.replace(_italicAst, (m, p1, p2) => {
      if (count++ >= 4) return m;
      return `${p1}<em>${p2}</em>`;
    });
    count = 0;
    l = l.replace(_italicUnd, (m, p1, p2) => {
      if (count++ >= 4) return m;
      return `${p1}<em>${p2}</em>`;
    });
    return l;
  }).join('\n');
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
  // 메타 태그 전반 제거 — 서버가 파싱·토스트로 이미 처리했으므로 본문에 중복 노출 금지.
  // 이전엔 HP/XP/획득 3종만 걸러서 MP/버프/디버프/적 *이 본문에 그대로 새어나옴.
  text = text
    // [이름 HP: X → Y]
    .replace(/\[[^\]]+?\s+HP\s*[:：][^\]]*?\]/g, '')
    // [이름 MP: X → Y]
    .replace(/\[[^\]]+?\s+MP\s*[:：][^\]]*?\]/g, '')
    // [이름 XP +N]  (이름 있음)
    .replace(/\[[^\]]+?\s+XP\s*\+\s*\d+\]/g, '')
    // [XP +N]  (이름 없는 고아 태그 — 서버에서 acting_player 로 복구됨. 표시에선 그냥 제거.)
    .replace(/\[\s*XP\s*\+\s*\d+\s*\]/g, '')
    // [이름 획득: 아이템] / [이름 획득: 아이템 | 효과]
    .replace(/\[[^\]]+?\s+획득\s*[:：][^\]]*?\]/g, '')
    // [이름 사용: 아이템]
    .replace(/\[[^\]]+?\s+사용\s*[:：][^\]]*?\]/g, '')
    // [이름 장비 해제: slot]
    .replace(/\[[^\]]+?\s+장비\s*해제\s*[:：][^\]]*?\]/g, '')
    // [캠페인 종료: 분기키]
    .replace(/\[캠페인\s*종료\s*[:：]\s*[a-zA-Z_]+\s*\]/g, '')
    // 🆕 E-2 [진행: N막] — 배지/토스트로 처리, 본문에선 숨김
    .replace(/\[\s*진행\s*[:：]\s*[1-3]\s*막\s*\]/g, '')
    // [이름 버프/디버프: 효과명 N턴 | 설명]
    .replace(/\[[^\]]+?\s+(?:버프|디버프)\s*[:：][^\]]*?\]/g, '')
    // [적 등장/HP/상태/퇴장/버프/디버프: ...]
    .replace(/\[적\s+(?:등장|HP|상태|퇴장|버프|디버프)\s*[:：][^\]]*?\]/g, '')
    // [장비 효과: ...] / [아이템 효과: ...]
    .replace(/\[(?:장비|아이템)\s*효과\s*[:：][^\]]*?\]/g, '')
    // 플레이어 주사위 (DM 주사위는 formatDmInline 에서 뱃지로 변환)
    .replace(/\[🎲d\d+\s*[:：]\s*\d+\]/g, '');

  // 빈 줄 기준 단락 분리, 단일 \n도 단락 취급
  const paragraphs = text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs.map(p => {
    // 문단 전체가 대사면 speech block
    const m = p.match(/^[「"'](.+)["'」]$/s);
    const isSpeech = !!m;
    return { text: p, isSpeech };
  });
}

/* ── V42-03: streaming DM placeholder ───────────────────
 * 서버가 LLM_STREAMING=1 일 때 dm_chunk 이벤트로 partial text 보내옴.
 * narr-log 끝에 임시 .msg-dm-stream 버블 만들어 누적 텍스트 plain 으로 노출.
 * partial 은 [...] 태그가 깨져있을 수 있으므로 formatDmInline 적용 X — 단순 textContent.
 * dm_response 도달 시 _clearDmStreamPlaceholder 가 제거하고 dmMsg 가 포맷팅된 정식 버블 추가.
 */
const _dmStreamState = { id: null, el: null, textEl: null, lastChunkAt: 0, watchdog: null };
const _DM_STREAM_WATCHDOG_MS = 60000;  // V47-07: 60s 무 chunk + 무 dm_response → placeholder 강제 제거
function _appendDmStreamChunk(streamId, delta, actingId) {
  const log = document.getElementById('narr-log');
  if (!log) return;
  // 새 stream 이거나 placeholder 가 사라졌으면 신규 생성
  if (_dmStreamState.id !== streamId || !_dmStreamState.el || !_dmStreamState.el.isConnected) {
    _clearDmStreamPlaceholder(null);
    const wrap = document.createElement('div');
    wrap.className = 'msg-dm msg-dm-stream';
    wrap.dataset.streamId = streamId;
    const para = document.createElement('div');
    para.className = 'dm-para dm-stream-text';
    wrap.appendChild(para);
    log.appendChild(wrap);
    _dmStreamState.id = streamId;
    _dmStreamState.el = wrap;
    _dmStreamState.textEl = para;
  }
  // 누적
  _dmStreamState.textEl.textContent = (_dmStreamState.textEl.textContent || '') + delta;
  _dmStreamState.lastChunkAt = Date.now();
  // V47-07: watchdog (재)예약 — 60s 동안 새 chunk + dm_response 모두 없으면 placeholder 강제 제거.
  // 서버 측 broadcast 가 close 된 ws 로 인해 swallow 된 케이스 (V46-05 보완).
  if (_dmStreamState.watchdog) clearTimeout(_dmStreamState.watchdog);
  _dmStreamState.watchdog = setTimeout(() => {
    if (!_dmStreamState.el) return;
    const sinceLast = Date.now() - _dmStreamState.lastChunkAt;
    if (sinceLast >= _DM_STREAM_WATCHDOG_MS) {
      cleanupTransientUiState('dm_stream_watchdog');
      // V48-02: placeholder 만 지우면 dm-typing 인디케이터·입력 잠금이 남아 사용자가 다시 행동
      // 못함. V25-01 수동 [입력 잠금 풀기] 버튼이 있긴 하지만 watchdog 가 자동 발화한 케이스에선
      // 자동 해제가 자연스러움. 서버 stream 이 60s 침묵 = 사실상 끊긴 상태로 간주.
      sysToast('DM 응답 진행 정지 — 잠시 후 다시 시도하세요', 'toast-error', '⏱');
    }
  }, _DM_STREAM_WATCHDOG_MS);
  // 사용자가 위로 스크롤 중이 아니면 따라가기
  if (_isAtBottom(log)) log.scrollTop = log.scrollHeight;
}
function _clearDmStreamPlaceholder(streamId) {
  // streamId === null → 활성 placeholder 무조건 제거 (dm_response 진입).
  // streamId 지정 → 해당 stream 만 제거 (취소 케이스).
  if (!_dmStreamState.el) return;
  if (streamId !== null && _dmStreamState.id !== streamId) return;
  try { _dmStreamState.el.remove(); } catch (_) {}
  if (_dmStreamState.watchdog) { clearTimeout(_dmStreamState.watchdog); _dmStreamState.watchdog = null; }
  _dmStreamState.id = null;
  _dmStreamState.el = null;
  _dmStreamState.textEl = null;
  _dmStreamState.lastChunkAt = 0;
}

function dmMsg(text, animate = true) {
  const log = document.getElementById('narr-log');
  const wasAtBottom = _isAtBottom(log);  // V11-05: 사용자가 위로 스크롤 중이면 강제 스크롤 X
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
  _capNarrLog(log);
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
  else _setJumpToLatest(true);
  triggerWalkAction();
}

/* 🆕 Phase 3 — 몬스터 자동 행동 메시지. DM 응답과 시각적으로 구분 (붉은 톤 + 👹 헤더). */
function monsterTurnMsg(monsterName, text) {
  const log = document.getElementById('narr-log');
  if (!log) return;
  const wasAtBottom = _isAtBottom(log);
  const wrap = document.createElement('div');
  wrap.className = 'msg-monster-turn';
  const header = document.createElement('div');
  header.className = 'mt-header';
  header.textContent = `👹 ${monsterName}의 차례`;
  wrap.appendChild(header);

  const blocks = formatDmBlocks(text);  // 메타 태그 자동 strip 재사용
  blocks.forEach((b, i) => {
    const p = document.createElement('div');
    p.className = b.isSpeech ? 'mt-para mt-speech' : 'mt-para';
    p.innerHTML = formatDmInline(b.text);
    p.style.animationDelay = `${Math.min(i * 0.15, 1.5)}s`;
    p.classList.add('fade-in');
    wrap.appendChild(p);
  });
  log.appendChild(wrap);
  _capNarrLog(log);
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
  else _setJumpToLatest(true);
}

/* 🆕 Phase 3 — 라운드 순서 패널 갱신. round_order 가 있으면 상단에 작은 트랙 표시. */
// V9-01: round_number 가 증가할 때마다 "라운드 N" 토스트. 처음 진입(prev=0) 도 발화.
let _prevRoundNumber = 0;
function _maybeAnnounceRound(roundNumber) {
  const n = Number(roundNumber) || 0;
  if (n > 0 && n !== _prevRoundNumber) {
    if (n > _prevRoundNumber) {
      const layer = ensureToastLayer();
      pushToast(layer, `⚔ 라운드 ${n} 시작`, 'toast-round');
    }
    _prevRoundNumber = n;
  } else if (n === 0) {
    _prevRoundNumber = 0;  // 전투 종료 → 다음 시작 다시 알림
  }
}

function updateRoundOrderUI(roundOrder, roundIdx, roundNumber) {
  _maybeAnnounceRound(roundNumber);
  let panel = document.getElementById('round-order-panel');
  if (!Array.isArray(roundOrder) || roundOrder.length === 0) {
    if (panel) panel.style.display = 'none';
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'round-order-panel';
    panel.className = 'round-order-panel';
    // narrative-panel 의 panel-header 끝에 끼워넣음
    const ph = document.querySelector('#narrative-panel .panel-header');
    if (ph) ph.appendChild(panel); else return;
  }
  panel.style.display = '';
  // 🆕 헤더 폭 절약 — 이름은 한국어 2자, 영문 4자까지만 보이게 잘라서 표시.
  // 풀네임은 title(툴팁)에 보존. current actor 만 한 글자 더 노출 (가독성).
  const truncate = (s, isCur) => {
    if (!s) return '?';
    const max = isCur ? 4 : 3;
    return s.length > max ? s.slice(0, max) + '…' : s;
  };
  // 🆕 플레이어 아이콘은 종족 emoji 로 — _lastSeenPlayers 에서 race_emoji 조회.
  // 일반 'X' 아이콘 대신 인간/엘프/티플링/곰수인 등 종족 이모지로 한눈에 구분.
  const playerById = {};
  (Array.isArray(_lastSeenPlayers) ? _lastSeenPlayers : []).forEach(p => {
    if (p && p.player_id) playerById[p.player_id] = p;
  });
  const items = roundOrder.map((a, i) => {
    const isCur = (i === roundIdx);
    const isPlayer = (a.kind === 'player');
    let icon;
    if (isPlayer) {
      const p = playerById[a.id];
      icon = (p && p.race_emoji) || '🧑';
    } else {
      icon = '👹';
    }
    const cls = `ro-item${isCur ? ' current' : ''}${isPlayer ? ' player' : ' monster'}`;
    const init = (typeof a.initiative === 'number') ? a.initiative : '?';
    const fullName = a.name || '?';
    return `<span class="${cls}" title="${escapeHtml(fullName)} initiative=${init}"><span class="ro-icon">${icon}</span><span class="ro-name">${escapeHtml(truncate(fullName, isCur))}</span></span>`;
  }).join('');
  panel.innerHTML = `<span class="ro-label">⏱R${roundNumber || 1}</span>${items}`;
}

// V6-02: narr-log 무한 누적 방지. 30분 세션이면 sysMsg + playerMsg + dmMsg 합쳐
// 100~200 개 노드. 모바일·저사양 기기에서 스크롤 끊김 + 메모리 누수. 기준은 250개
// (대화 흐름 충분히 보존, 전투 1~2 라운드 분량 다 살아남음). 초과 시 가장 오래된
// 25% 자르기 — append 중심에 두고 batch 트림으로 layout 충격 줄임.
const _NARR_LOG_CAP = 250;
const _NARR_LOG_TRIM = 60;
function _capNarrLog(log) {
  if (!log) return;
  if (log.children.length <= _NARR_LOG_CAP) return;
  for (let i = 0; i < _NARR_LOG_TRIM; i++) {
    if (log.firstElementChild) log.removeChild(log.firstElementChild);
  }
  // 자른 사실을 한 번 알림 (재컷 시엔 sysMsg 가 즉시 또 잘릴 수 있어 console 만)
  console.log('[narr-log] auto-trim oldest', _NARR_LOG_TRIM, 'entries');
}

// V11-05: 스마트 자동 스크롤 + "↓ 새 메시지" 점프 버튼.
// 사용자가 위로 스크롤해서 과거 읽고 있는데 새 DM 응답이 강제로 내려보내던 문제 차단.
// 바닥(±80px) 근처면 자동 스크롤 유지, 멀어졌으면 보존 + 우하단 점프 버튼 노출.
const _SCROLL_AT_BOTTOM_TOLERANCE = 80;
function _isAtBottom(log) {
  if (!log) return true;
  return (log.scrollHeight - log.scrollTop - log.clientHeight) <= _SCROLL_AT_BOTTOM_TOLERANCE;
}
function _smartScrollToBottom(log, force = false) {
  if (!log) return;
  if (force || _isAtBottom(log)) {
    log.scrollTop = log.scrollHeight;
    _setJumpToLatest(false);
  } else {
    _setJumpToLatest(true);
  }
}
function _setJumpToLatest(visible) {
  let btn = document.getElementById('jump-to-latest-btn');
  if (visible) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'jump-to-latest-btn';
      btn.className = 'jump-to-latest-btn';
      btn.type = 'button';
      btn.textContent = '↓ 최신';
      btn.title = '최신 메시지로 이동';
      btn.addEventListener('click', () => {
        const log = document.getElementById('narr-log');
        if (log) log.scrollTop = log.scrollHeight;
        _setJumpToLatest(false);
      });
      const panel = document.getElementById('narrative-panel') || document.body;
      panel.appendChild(btn);
    }
    btn.style.display = '';
  } else if (btn) {
    btn.style.display = 'none';
  }
}
// 사용자가 직접 바닥까지 스크롤하면 점프 버튼 자동 숨김.
(function bindNarrLogScroll() {
  const tryBind = () => {
    const log = document.getElementById('narr-log');
    if (!log) { setTimeout(tryBind, 500); return; }
    log.addEventListener('scroll', () => {
      if (_isAtBottom(log)) _setJumpToLatest(false);
    });
  };
  tryBind();
})();

// V16-A: pending bubble resolve — DM 응답 도착 시 ⏳ → ✓ 잠깐 표시 후 fade.
function _resolveLastPendingBubble() {
  const log = document.getElementById('narr-log');
  if (!log) return;
  const pending = log.querySelector('.msg-player.pending');
  if (!pending) return;
  pending.classList.remove('pending');
  pending.classList.add('resolved');
  const badge = pending.querySelector('.msg-pending-badge');
  if (badge) {
    badge.textContent = '✓';
    badge.title = 'DM 응답 도착';
    setTimeout(() => {
      badge.style.transition = 'opacity .8s';
      badge.style.opacity = '0';
      setTimeout(() => { try { badge.remove(); } catch (_) {} }, 900);
    }, 1500);
  }
}

function playerMsg(name, action, emoji, portraitUrl, isMineFlag) {
  const log = document.getElementById('narr-log');
  // V27-01: 본인 액션은 항상 force scroll-to-bottom — 보낸 직후 자기가 보낸 게 안 보이는 어색함 차단.
  // 다른 사람의 액션은 V11-05 스마트 스크롤 (위로 스크롤 중이면 보존).
  const wasAtBottom = isMineFlag ? true : _isAtBottom(log);
  const el = document.createElement('div');
  el.className = 'msg-player' + (isMineFlag ? ' mine pending' : '');
  const portraitHtml = portraitUrl
    ? `<img class="msg-portrait portrait-enlarge" src="${escapeHtml(portraitUrl)}" alt="${escapeHtml(name)}"
            data-full="${escapeHtml(portraitUrl)}" data-caption="${escapeHtml(name)}"
            onerror="this.style.display='none'">`
    : '';
  // V16-A: 본인 메시지면 pending 인디케이터 (⏳) — DM 응답 도착 시 ✓ 로 전환됨
  const pendingBadge = isMineFlag
    ? '<span class="msg-pending-badge" title="DM 응답 대기 중">⏳</span>'
    : '';
  el.innerHTML = `
    ${portraitHtml}
    <div class="msg-body">
      <div class="msg-header">${escapeHtml(emoji || '')} <span class="msg-name">${escapeHtml(name)}</span>${pendingBadge}</div>
      <div class="msg-action">${escapeHtml(action)}</div>
    </div>
  `;
  log.appendChild(el);
  _capNarrLog(log);
  // 이 버블을 기억해둬서 DM 응답 오면 맥락 이미지 부착
  _lastActionBubble = el;
  _lastActionText = action;
  // V32-03: 본인 액션이면 1.5초 내 ✕ 취소 버튼 노출 — 클릭 시 서버에 cancel_action.
  if (isMineFlag) _attachCancelActionButton(el, action);
  // V27-01: 본인이면 항상 바닥, 아니면 wasAtBottom 일 때만.
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
  else _setJumpToLatest(true);
  triggerWalkAction();
}

// V32-03: pending bubble 에 1.5초 노출되는 ✕ 취소 버튼 부착.
// 클릭 시 ws cancel_action 전송 + 텍스트를 action-input 으로 복원 (재편집 가능).
// 입력 잠금 해제는 서버 action_cancelled 응답 도달 시 처리 (race 방지 — 서버 권위).
function _attachCancelActionButton(bubbleEl, originalText) {
  const header = bubbleEl.querySelector('.msg-header');
  if (!header) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-action-cancel';
  btn.textContent = '✕ 취소';
  btn.title = '1초 내 취소 — DM 응답 도달 전이라면 처리 중단';
  let consumed = false;
  btn.addEventListener('click', () => {
    if (consumed) return;
    consumed = true;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel_action' }));
      }
    } catch (_) {}
    // 텍스트를 입력칸으로 복원 — 사용자가 즉시 재편집/재전송 가능.
    const inp = document.getElementById('action-input');
    if (inp && originalText && !inp.value) inp.value = originalText;
    // 버튼 즉시 숨김 (서버 응답 기다리지 않고 시각 피드백 우선).
    try { btn.remove(); } catch (_) {}
  });
  header.appendChild(btn);
  // 시각 cue: 1.5초 후 자동 제거 (CSS animation 과도 짝).
  setTimeout(() => { try { btn.remove(); } catch (_) {} }, 1500);
}

// V16-01: sysMsg 위급 키워드 자동 토스트 병행 — narr-log 흐름 속에 묻혀
// 사용자가 놓치는 case 차단. 이미 다른 토스트 발화하는 path (사망/멘션 등)
// 와 중복은 _toastedSysMsgKeys 로 단기 dedup.
const _SYSMSG_URGENT_PATTERNS = [
  { re: /연결\s*끊김/, cls: 'toast-error', icon: '⚠' },
  { re: /재연결|연결\s*복구/, cls: 'toast-item', icon: '🔌' },
  { re: /방장이 없|새 방장이 되|방장에서 강등/, cls: 'toast-item', icon: '👑' },
  { re: /턴이 스킵|턴을 스킵/, cls: 'toast-item', icon: '⏭' },
  { re: /돌아왔습니다|이어받았습니다|파티를 떠/, cls: 'toast-item', icon: '🚪' },
  // V41-03: /실패/ 가 너무 광범위해 narrative 의 "행동 실패" 같은 자연어도 매칭 → 카테고리 한정.
  { re: /지원하지 않|연결\s*실패|전송\s*실패|복사\s*실패|승계\s*실패|로드\s*실패|오류|폐기/, cls: 'toast-error', icon: '⚠' },
];
const _toastedSysMsgKeys = new Set();
function sysMsg(text) {
  const log = document.getElementById('narr-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'msg-sys';
  el.textContent = `— ${text} —`;
  log.appendChild(el);
  _capNarrLog(log);
  log.scrollTop = log.scrollHeight;
  // V16-01: 위급 키워드 매칭 시 토스트 병행 (단, 같은 텍스트 5초 내 중복 방지).
  for (const pat of _SYSMSG_URGENT_PATTERNS) {
    if (pat.re.test(text)) {
      const key = pat.re.source + '|' + text;
      if (_toastedSysMsgKeys.has(key)) return;
      _toastedSysMsgKeys.add(key);
      setTimeout(() => _toastedSysMsgKeys.delete(key), 5000);
      try {
        const layer = ensureToastLayer();
        pushToast(layer, `${pat.icon} ${text}`, pat.cls);
      } catch (_) {}
      return;
    }
  }
}

// V33-02: 임시 안내(복사 실패, 입력 잠금 해제, 인터넷 단절 등) 는 narr-log 에 남길 가치가 없다.
// sysMsg 가 전부 narr-log 에 들어가 모험 회상이 노이즈에 묻히던 문제 해소 — 토스트 only 함수 분리.
// 호출처가 의도를 명확히 선택할 수 있게 sysMsg / sysToast 두 갈래.
function sysToast(text, cls = 'toast-item', icon = '') {
  try {
    const layer = ensureToastLayer();
    const display = icon ? `${icon} ${text}` : text;
    pushToast(layer, display, cls);
  } catch (_) {}
}

// V5-03: DM 응답 대기 중 경과시간 카운터.
// 이전엔 "🎲 던전 마스터가 주사위를 굴리는 중" 만 점멸하여 사용자가 5초 후엔
// "멈췄나?" 의심함. 이제 (12s) 처럼 경과 표시 + 30초 넘어가면 차분한 안내, 60초+ 면
// 강한 경고 클래스 추가. LLM_TIMEOUT_SEC=180 까지는 정상 범위라 결과 도달 가능.
let _dmTypingTimer = null;
let _dmTypingStartedAt = 0;
// V8-07: DM 응답 대기 중 차분한 분위기 메시지 사이클. 콜드 스타트(60s+) 시 사용자가 "멈췄나?"
// 의심하는 걸 막고 분위기 살리는 용. 5초마다 회전.
const _DM_TYPING_TIPS = [
  '🎲 던전 마스터가 주사위를 굴리는 중',
  '📜 던전 마스터가 두루마리를 살피는 중',
  '🕯️ 던전 마스터가 운명의 흐름을 가늠하는 중',
  '🪶 던전 마스터가 다음 장을 적는 중',
  '🌫 던전 마스터가 안개 너머를 들여다보는 중',
];
function showDmTyping(on) {
  const t = document.getElementById('dm-typing');
  if (!t) return;
  if (on) {
    t.style.display = 'block';
    _dmTypingStartedAt = Date.now();
    if (_dmTypingTimer) clearInterval(_dmTypingTimer);
    const renderTip = (idx, sec) => {
      const tip = _DM_TYPING_TIPS[idx % _DM_TYPING_TIPS.length];
      // V41-03: renderTip 이 innerHTML 통째 교체로 bail 버튼을 지우던 사고 차단.
      // 기존 bail 버튼이 있으면 detach 후 새 콘텐츠 set, 그 다음 다시 append.
      const oldBail = t.querySelector('.dm-typing-bail');
      t.innerHTML = `<span class="dots">${tip}</span> <span class="dm-elapsed" id="dm-elapsed">(${sec}s)</span>`;
      if (oldBail) t.appendChild(oldBail);
    };
    renderTip(0, 0);
    t.classList.remove('dm-typing-slow', 'dm-typing-very-slow');
    let tipIdx = 0;
    _dmTypingTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - _dmTypingStartedAt) / 1000);
      const el = document.getElementById('dm-elapsed');
      if (el) el.textContent = `(${sec}s)`;
      // 5초마다 다음 tip
      const nextIdx = Math.floor(sec / 5);
      if (nextIdx !== tipIdx) {
        tipIdx = nextIdx;
        renderTip(tipIdx, sec);
      }
      if (sec >= 60) {
        t.classList.add('dm-typing-very-slow');
        // V25-01: 60s+ 시 [잠금 해제] 버튼 노출 — 사용자가 명백히 응답 안 올거라 판단하면 즉시 입력 풀기.
        // 단, 응답이 도착하면 dm-busy 해제는 자동이므로 가짜 cancel 이 아니라 "포기" 의미.
        if (!t.querySelector('.dm-typing-bail')) {
          const bail = document.createElement('button');
          bail.type = 'button';
          bail.className = 'dm-typing-bail';
          bail.textContent = '⏹ 입력 잠금 풀기';
          bail.title = '서버는 계속 처리 중일 수 있지만 입력 칸은 즉시 해제';
          bail.addEventListener('click', (e) => {
            e.stopPropagation();
            showDmTyping(false);
            if (typeof _setActionBarBusy === 'function') _setActionBarBusy(false);
            sysToast('입력 잠금 수동 해제 — 서버 응답이 뒤늦게 도착할 수 있음', 'toast-item', '🔓');
          });
          t.appendChild(bail);
        }
      } else if (sec >= 30) {
        t.classList.add('dm-typing-slow');
      }
      // V24-02: 200초 (LLM_TIMEOUT_SEC + 여유) 넘으면 자동 dismiss + 안내.
      // _setActionBarBusy 가 별도로 처리하긴 하지만 dm-typing 도 일관성 유지.
      if (sec >= 200) {
        showDmTyping(false);
        sysToast('DM 응답이 너무 오래 걸립니다. 행동을 다시 시도해주세요', 'toast-error', '⏱');
      }
    }, 500);
  } else {
    t.style.display = 'none';
    if (_dmTypingTimer) { clearInterval(_dmTypingTimer); _dmTypingTimer = null; }
    t.classList.remove('dm-typing-slow', 'dm-typing-very-slow');
  }
}

function updateTimeBadge(t) {
  const badge = document.getElementById('time-badge');
  if (!badge) return;
  if (!t || !t.icon) { badge.style.display = 'none'; _lastTimeLabel = ''; _syncMiniInfoBadge(); return; }
  // V15-01: day 표시 — V4 ⑩ 의 day 카운터를 시각화. 1일차면 생략, 2일차부터 노출.
  const dayPart = (typeof t.day === 'number' && t.day > 1) ? ` · ${t.day}일차` : '';
  _lastTimeLabel = `${t.icon} ${t.label}`;  // M-1: 미니 배지용 (day 는 생략해 짧게)
  _syncMiniInfoBadge();
  badge.textContent = `${t.icon} ${t.label}${dayPart}`;
  badge.title = (t.day && t.day > 1) ? `모험 ${t.day}일차` : '시간대';
  badge.style.display = 'inline-block';
  // V18-01: 시간대별 background body class (CSS 가 미세 색조 변경)
  const tod = (t.icon || '').trim();
  const todMap = {
    '🌅': 'tod-dawn', '☀️': 'tod-day', '🌞': 'tod-noon',
    '🌆': 'tod-dusk', '🌙': 'tod-night', '🌌': 'tod-midnight',
  };
  document.body.classList.remove('tod-dawn','tod-day','tod-noon','tod-dusk','tod-night','tod-midnight');
  if (todMap[tod]) document.body.classList.add(todMap[tod]);
}

/* ── TURN INDICATOR ─────────────────────── */
function updateTurnIndicator(turnPlayerId, players) {
  currentTurnPlayerId = turnPlayerId;
  // 파티 패널 카드에 current-turn 클래스
  document.querySelectorAll('.player-card').forEach(c => c.classList.remove('current-turn'));
  if (turnPlayerId) {
    const card = Array.from(document.querySelectorAll('.player-card'))
      .find(c => c.dataset.pid === turnPlayerId);
    if (card) card.classList.add('current-turn');
  }
  // action-bar lock — 내 차례가 아니거나 사망 상태면 잠금.
  // 🆕 사망 우선 — 죽은 사람은 차례가 자동 스킵되므로 바 placeholder 도 다르게.
  const dead = _amIDead();
  const myTurn = !turnPlayerId || turnPlayerId === myId;
  const lock = !myTurn || dead;
  const bar = document.getElementById('action-bar');
  const inp = document.getElementById('action-input');
  const sendBtn = document.getElementById('send-btn');
  if (bar) {
    bar.classList.toggle('locked', lock);
    // 🆕 lock 배너 텍스트를 CSS 변수로 동적 주입 — "⏳ {이름}의 차례" 형식.
    // CSS 의 ::before content: var(--turn-banner) 가 이걸 읽음.
    if (lock) {
      const turnName = (players || []).find(p => p.player_id === turnPlayerId);
      let bannerText;
      if (dead) {
        bannerText = '💀 사망 — 부활 대기 중';
      } else if (turnName && turnName.name) {
        bannerText = `⏳ ${turnName.name} 의 차례 — 기다리세요`;
      } else {
        bannerText = '⏳ DM 진행 중';
      }
      // CSS content: value 는 따옴표 포함 문자열 형태라야 함
      bar.style.setProperty('--turn-banner', `"${bannerText.replace(/"/g, '\\"')}"`);
    } else {
      bar.style.removeProperty('--turn-banner');
    }
  }
  if (inp) {
    inp.disabled = lock;
    const name = (players || []).find(p => p.player_id === turnPlayerId);
    inp.placeholder = dead
      ? '💀 사망 — 동료의 부활 또는 구원 아이템을 기다리세요. 채팅은 가능합니다.'
      : (myTurn
          ? '행동을 입력하세요... (예: 검을 뽑아 전방의 고블린을 공격한다)'
          : `${name ? name.name : '누군가'}의 차례 — 잠시 기다리세요`);
  }
  if (sendBtn) sendBtn.disabled = lock;
  // 퀵액션 버튼도 같이 잠금
  document.querySelectorAll('.q-btn').forEach(b => b.disabled = lock);
  // V7-03: 내 턴 시작 시 데스크톱에서만 자동 포커스 — 모바일에선 키보드 자동 팝업이 침해적.
  // _dmResponding 중에는 disabled 라 포커스 의미 없음. dm_busy 상태도 회피.
  if (!lock && !_dmResponding && inp && !document.activeElement?.matches('input, textarea')) {
    if (typeof isMobileViewport === 'function' && !isMobileViewport()) {
      // 약간 딜레이로 다른 핸들러의 disabled 변경 후 포커스 안전.
      setTimeout(() => { try { inp.focus(); } catch (_) {} }, 50);
    }
  }
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
  // V11-01: 다른 탭/배경 상태에서 내 차례가 시작되면 브라우저 title 깜빡 + 모바일 진동(가능 시).
  // dead 면 자동 스킵되니 알림 X.
  _maybeNotifyMyTurnStart(myTurn, dead);
  // 🆕 [L] 낙서 버튼 펄스(남의 턴이면 강조) + 오버레이 내 '당신 차례' 배너 갱신
  try { refreshDoodlePulse(); _ddUpdateTurnBanner(); } catch (_) {}
}

// V11-03: 단축키 도움말 모달 — `?` 또는 Shift+/ 키. 입력칸 포커스 중엔 무시.
function _showHelpModal() {
  let modal = document.getElementById('help-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'help-modal';
    modal.className = 'modal help-modal';
    // V37-04: ARIA — role/aria-modal/labelledby 추가.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'help-modal-title');
    modal.innerHTML = `
      <div class="modal-backdrop" data-close-help></div>
      <div class="modal-box">
        <div class="modal-title" id="help-modal-title">
          ⌨ 단축키 / 사용법
          <button class="modal-close" data-close-help aria-label="닫기">✕</button>
        </div>
        <div class="modal-hint help-content">
          <h3>채팅 명령어</h3>
          <ul>
            <li><kbd>/help</kbd> — 이 도움말</li>
            <li><kbd>/me &lt;행동&gt;</kbd> — 이모트 ("*칼을 휘두른다*", italic 렌더)</li>
            <li><kbd>/scenario</kbd> — 시나리오 자세히 보기</li>
            <li><kbd>/clear</kbd> — 본인 화면의 채팅 비우기</li>
            <li><kbd>/d20</kbd>, <kbd>/d6</kbd>, <kbd>/roll</kbd> — 주사위 굴림 (서버 권위)</li>
          </ul>
          <h3>대기실</h3>
          <ul>
            <li><kbd>r</kbd> — ready / not-ready 토글</li>
          </ul>
          <h3>게임 중 입력 빠른 포커스</h3>
          <ul>
            <li><kbd>a</kbd> — 행동 입력 포커스</li>
            <li><kbd>c</kbd> — 파티 채팅 포커스 (모바일은 char-panel 펼침)</li>
          </ul>
          <h3>키보드</h3>
          <ul>
            <li><kbd>Enter</kbd> — 행동/채팅 전송</li>
            <li><kbd>↑</kbd> / <kbd>↓</kbd> — 행동 입력 칸에서 최근 액션 회상</li>
            <li><kbd>1</kbd>~<kbd>5</kbd> — 퀵액션 (탐색·대화·공격·치료·매복) 빠른 발동</li>
            <li><kbd>6</kbd> — 관망/진행</li>
            <li><kbd>i</kbd> / <kbd>p</kbd> — 모바일에서 내 캐릭터 / 파티 패널 토글</li>
            <li><kbd>Esc</kbd> — 모달 / 드로어 / 라이트박스 닫기</li>
            <li><kbd>?</kbd> — 이 도움말 열기</li>
            <li><kbd>Ctrl+Z</kbd> — 그림 모달에서 되돌리기</li>
          </ul>
          <h3>마우스 / 터치</h3>
          <ul>
            <li>방 코드 <b>클릭</b> — 클립보드 복사</li>
            <li>시나리오 뱃지 <b>클릭</b> — 시나리오 자세히</li>
            <li>플레이어 / 몬스터 카드 — 상태 칩 hover 로 효과 자세히</li>
            <li>토스트 <b>클릭</b> — 즉시 닫기</li>
            <li>모바일 좌측 ⚔ 탭 — 파티 패널 열기</li>
            <li>모바일 우측 🎒 탭 — 내 캐릭터 열기</li>
            <li>모바일 좌상단 원 HUD — 내 캐릭터 열기 (HP/MP 아크)</li>
          </ul>
          <h3>전투 시각 신호</h3>
          <ul>
            <li>👹 몬스터 카드 셰이크 + 빨간 ±N — 피해</li>
            <li>플레이어 카드 빨간 펄스 — HP 25% 이하 위독</li>
            <li>💀 회색조 — 사망 (부활 필요)</li>
            <li>상태 칩 깜빡 — 1턴 남아 곧 만료</li>
            <li>👑 — 방장 표시</li>
            <li>우상단 점 — 서버 연결 상태 (초록=정상)</li>
          </ul>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-close-help>닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close-help]').forEach(el =>
      el.addEventListener('click', () => modal.style.display = 'none')
    );
  }
  modal.style.display = 'flex';
}
document.addEventListener('keydown', (e) => {
  // 입력 중이면 무시
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  // V36-03: 한글 IME 조합 직후 keyup 이 글로벌로 흘러 c/a/1-6 가 잘못 발화되는 사고 차단.
  // 또한 DM 응답 대기 중 (action-bar busy) 엔 게임 단축키 lock — body.action-busy 체크.
  if (e.isComposing || e.keyCode === 229) return;
  if (document.body.classList.contains('action-busy')
      && /^([cCaApPiI1-6])$/.test(e.key)) return;
  // V22-04: 대기실에서 R 키 = ready 토글
  const waitingActive = document.getElementById('waiting-screen')?.classList.contains('active');
  if ((e.key === 'r' || e.key === 'R') && waitingActive) {
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn && !readyBtn.disabled) { e.preventDefault(); readyBtn.click(); }
    return;
  }
  if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    _showHelpModal();
  } else if (e.key === 'Escape') {
    const helpModal = document.getElementById('help-modal');
    if (helpModal && helpModal.style.display === 'flex') {
      helpModal.style.display = 'none';
    }
    const sceneInfo = document.getElementById('scenario-info-modal');
    if (sceneInfo && sceneInfo.style.display === 'flex') {
      sceneInfo.style.display = 'none';
    }
  } else if (/^[1-5]$/.test(e.key)) {
    // V12-02: 1-5 숫자 키 = 퀵액션 5종 (탐색/대화/공격/치료/매복). data-action 가진 .q-btn 만 매칭.
    if (!document.body.classList.contains('in-game')) return;
    const idx = parseInt(e.key, 10) - 1;
    const qBtns = Array.from(document.querySelectorAll('.q-btn[data-action]')).filter(b => !b.disabled);
    const btn = qBtns[idx];
    if (btn) { e.preventDefault(); btn.click(); }
  } else if (e.key === '6') {
    if (!document.body.classList.contains('in-game')) return;
    const lb = document.getElementById('linger-btn');
    if (lb && !lb.disabled) { e.preventDefault(); lb.click(); }
  } else if (e.key === 'i' || e.key === 'I') {
    // V12-03: i 키 = 내 캐릭터 패널 토글 (모바일에서 빠른 인벤토리 확인)
    if (!document.body.classList.contains('in-game')) return;
    if (typeof toggleDrawer === 'function' && typeof isMobileViewport === 'function' && isMobileViewport()) {
      e.preventDefault();
      toggleDrawer('char-panel');
    }
  } else if (e.key === 'p' || e.key === 'P') {
    // V12-03: p 키 = 파티 패널 토글
    if (!document.body.classList.contains('in-game')) return;
    if (typeof toggleDrawer === 'function' && typeof isMobileViewport === 'function' && isMobileViewport()) {
      e.preventDefault();
      toggleDrawer('party-panel');
    }
  } else if (e.key === 'c' || e.key === 'C') {
    // V29-01: c 키 = 채팅 입력 포커스 (게임 중 빠른 채팅 진입). 모바일은 char-panel 열고 포커스.
    if (!document.body.classList.contains('in-game')) return;
    e.preventDefault();
    const isMobile = typeof isMobileViewport === 'function' && isMobileViewport();
    if (isMobile) {
      const charPanel = document.getElementById('char-panel');
      if (charPanel && !charPanel.classList.contains('drawer-open') && typeof toggleDrawer === 'function') {
        toggleDrawer('char-panel');
      }
      setTimeout(() => document.getElementById('game-chat-input')?.focus(), 250);
    } else {
      document.getElementById('game-chat-input')?.focus();
    }
  } else if (e.key === 'a' || e.key === 'A') {
    // V29-02: a 키 = action-input 포커스 (Tab 없이 키보드만 사용 시 빠른 진입).
    if (!document.body.classList.contains('in-game')) return;
    const inp = document.getElementById('action-input');
    if (inp && !inp.disabled) { e.preventDefault(); inp.focus(); }
  }
});

// V11-01: 내 차례 시작 알림 — 화면 안 보고있을 때 (document.hidden) title 깜빡 + vibrate.
let _wasMyTurn = null;       // null=미확정, true/false 직전 상태
let _origDocTitle = '';
let _titleBlinkTimer = null;
function _maybeNotifyMyTurnStart(myTurn, dead) {
  if (dead) { _wasMyTurn = false; return; }
  if (myTurn === true && _wasMyTurn === false) {
    // 비-내턴 → 내턴 transition
    if (document.hidden || document.visibilityState === 'hidden') {
      _flashTitle('▶ 당신 차례 — TROG');
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([80, 40, 80]); } catch (_) {}
    }
  }
  _wasMyTurn = !!myTurn;
}
function _flashTitle(alertText) {
  if (!_origDocTitle) _origDocTitle = document.title || 'TROG';
  if (_titleBlinkTimer) clearInterval(_titleBlinkTimer);
  let toggle = false;
  _titleBlinkTimer = setInterval(() => {
    document.title = (toggle = !toggle) ? alertText : _origDocTitle;
  }, 900);
}
// 사용자가 다시 탭 보면 깜빡 중지 + 원복
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _titleBlinkTimer) {
    clearInterval(_titleBlinkTimer);
    _titleBlinkTimer = null;
    if (_origDocTitle) document.title = _origDocTitle;
  }
});

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
  // 🆕 E-1 — 본인 HP 변화 연출 (전투 최중요 숫자). 타인 것은 파티 패널 HP 바가 커버하니 렌더 안 함.
  (events.hp_affected || []).forEach(ev => {
    if (!ev || !isMyName(ev.name) || !ev.delta) return;  // 본인만, 무변화 skip
    if (ev.delta < 0) {
      pushToast(layer, `💔 ${ev.delta} HP (${ev.hp}/${ev.max_hp})`, 'toast-debuff');
      flashDamage(false);
    } else {
      pushToast(layer, `💚 +${ev.delta} HP (${ev.hp}/${ev.max_hp})`, 'toast-buff');
      flashDamage(true);
    }
  });
  // 🆕 E-2 — 막 전환 순간 안내 토스트 (배지 갱신은 applyActBadge 가 별도로 처리)
  if (events.act_changed && events.act_changed >= 2) {
    pushToast(layer, `📖 제${events.act_changed}막 — 이야기가 깊어집니다`, 'toast-levelup');
  }
  (events.xp_events || []).forEach(ev => {
    const mine = isMyName(ev.name);
    // 🆕 처치/어시스트 자동 XP 는 출처를 명시 ("👹 고블린 A 처치")
    let label;
    if (ev.kind === 'kill' && ev.monster) {
      label = `⚔ ${ev.name} +${ev.amount} XP (${ev.monster} 처치)`;
    } else if (ev.kind === 'assist' && ev.monster) {
      label = `🤝 ${ev.name} +${ev.amount} XP (${ev.monster} 어시스트)`;
    } else {
      label = `✨ ${ev.name} +${ev.amount} XP`;
    }
    pushToast(layer, label, mine ? 'toast-xp-mine' : 'toast-xp');
    if (ev.new_level) {
      // 레벨업 스탯 증가분 표기 (누적: 여러 레벨 한번에 올라도 합쳐 보여줌)
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
    if (ev.converted_to_gold || ev.kind === 'currency') return;
    const mine = isMyName(ev.name);
    // [P-1] 획득물은 자동 장착 없이 전부 소지품으로 — 문구로 명시.
    const dest = ev.kind === 'equipment' ? ' → 🎒 소지품 (장착은 슬롯/장착 버튼)' : ' → 🎒 소지품';
    pushToast(layer, `🎁 ${ev.name} 획득: ${ev.item}${dest}`, mine ? 'toast-item-mine' : 'toast-item');
  });
  // 🆕 장비 해제 (무기 투척·파괴·분실)
  const slotLabel = { weapon: '무기', main_hand: '왼손', off_hand: '오른손', dual: '양손', armor: '방어구', accessory: '장신구' };
  (events.unequipped || []).forEach(ev => {
    const mine = isMyName(ev.name);
    const lab = slotLabel[ev.slot] || ev.slot;
    pushToast(layer, `🗑 ${ev.name} ${lab} 해제: ${ev.prev}`, mine ? 'toast-item-mine' : 'toast-item');
  });
  // 🆕 V7 장비 강화 — 슬롯의 장비 이름·효과가 atomic 교체됨 (강화·업그레이드·리네임)
  (events.equipment_upgrades || []).forEach(ev => {
    const mine = isMyName(ev.name);
    const lab = slotLabel[ev.slot] || ev.slot;
    const dual = ev.dual_synced ? ' (양손)' : '';
    pushToast(layer,
      `⚒ ${ev.name} ${lab}${dual} 강화: ${ev.prev_name} → ${ev.new_name}`,
      mine ? 'toast-item-mine' : 'toast-item');
  });
  // 🆕 상태 효과 적용 토스트 — 플레이어 대상
  (events.statuses_applied || []).forEach(st => {
    const emoji = st.kind === '버프' ? '✨' : '☠';
    const cls = st.kind === '버프' ? 'toast-buff' : 'toast-debuff';
    const desc = st.effect ? ` — ${st.effect}` : '';
    pushToast(layer, `${emoji} ${st.player_name} ${st.kind}: ${st.name} (${st.turns}턴)${desc}`, cls);
  });
  (events.statuses_expired || []).forEach(st => {
    pushToast(layer, `⌛ ${st.player_name} ${st.kind} '${st.name}' 해제`, 'toast-xp');
  });
  // 🆕 즉시 해제 (정화·해독·축복 종료) — 서사·수치 어긋남 해소
  (events.statuses_cleared || []).forEach(st => {
    pushToast(layer, `🧼 ${st.player_name} '${st.name}' 즉시 해제`, 'toast-xp');
  });
  // 🆕 골드 변동 — 거래·전리품·보상
  (events.gold_events || []).forEach(g => {
    const mine = isMyName(g.name);
    const sign = g.delta > 0 ? '+' : '';
    const cls = g.delta >= 0 ? 'toast-item-mine' : 'toast-debuff';
    const icon = g.delta >= 0 ? '💰' : '💸';
    pushToast(layer, `${icon} ${g.name} 골드 ${sign}${g.delta} (현재 ${g.gold} G)`, mine ? cls : 'toast-item');
  });
  // 🆕 캠페인 종료 — DM 이 아크 엔딩 태그를 찍음. 엔딩 오버레이로 크게 보여줌.
  if (events.campaign_ending) {
    showCampaignEnding(events.campaign_ending);
  }
  // 🆕 새로 사망한 플레이어 알림
  (events.newly_dead || []).forEach(name => {
    pushToast(layer, `💀 ${name} 쓰러졌다`, 'toast-error');
  });
  // 🆕 TPK 처리 알림 — 구원 발동 vs 비극 종결
  if (events.tpk_handled) {
    if (events.tpk_had_rescue) {
      pushToast(layer, '✨ 구원의 빛이 임했다 — 누군가 일어선다', 'toast-buff');
    } else {
      pushToast(layer, '🕯 파티 전멸 — 이야기가 막을 내린다', 'toast-error');
      // V39-01: TPK 비극 시 dead-state 무한 잠금 회피 — 사용자에게 명시 옵션 제공.
      // campaign_ending 오버레이가 이미 발화하면 (LLM이 분기 종결) 그쪽으로 위임 — 중복 모달 방지.
      if (!events.campaign_ending) {
        setTimeout(() => _showTpkOptionModal(), 1500);
      }
    }
  }
  // 🆕 몬스터 이벤트 — buff/debuff 적용, DOT tick 피해, 처치, 신규 등장
  (events.monster_events || []).forEach(ev => {
    if (ev.kind === 'spawn') {
      // 🆕 적 등장 토스트 — 모바일에서도 즉시 알림 (party-panel 드로어 안 열어도 보임)
      const spd = ev.speed ? ` ⚡${ev.speed}` : '';
      pushToast(layer, `👹 ${ev.name} 등장 (HP ${ev.hp}${spd})`, 'toast-debuff');
      _maybeShowCombatTutorial();  // 🆕 E-3 — 첫 전투 규칙 안내 (1회)
    } else if (ev.kind === 'debuff') {
      const desc = ev.effect ? ` — ${ev.effect}` : '';
      pushToast(layer, `☠ ${ev.name} 디버프: ${ev.effect_name} (${ev.turns}턴)${desc}`, 'toast-debuff');
    } else if (ev.kind === 'buff') {
      const desc = ev.effect ? ` — ${ev.effect}` : '';
      pushToast(layer, `✨ ${ev.name} 버프: ${ev.effect_name} (${ev.turns}턴)${desc}`, 'toast-buff');
    } else if (ev.kind === 'tick') {
      pushToast(layer, `🩸 ${ev.name} -${ev.damage} HP (지속 피해, ${ev.hp}/${ev.max_hp})`, 'toast-debuff');
    } else if (ev.kind === 'defeated') {
      const tag = ev.by_dot ? ' 💀 (지속 피해로 사망)' : ' 💀';
      pushToast(layer, `${ev.name} 처치${tag}`, 'toast-xp');
    } else if (ev.kind === 'leave') {
      pushToast(layer, `🌫 ${ev.name} 이탈/소멸`, 'toast-info');
    }
  });
}

function pushErrorToast(message) {
  const layer = ensureToastLayer();
  pushToast(layer, `⚠ ${message}`, 'toast-error');
}

// 🆕 E-3 — 첫 전투 등장 시 1회성 규칙 안내 (탭/8초 닫힘, localStorage 로 브라우저 단위 영구 1회).
let _combatTutShown = false;
function _maybeShowCombatTutorial() {
  if (_combatTutShown) return;
  if (localStorage.getItem('trog_combat_tut')) return;
  _combatTutShown = true;
  localStorage.setItem('trog_combat_tut', '1');
  const layer = ensureToastLayer();
  const t = document.createElement('div');
  t.className = 'toast toast-buff toast-combat-tut';
  t.innerHTML = '⚔ <b>전투 시작!</b><br>① 행동 순서는 민첩(DEX) 순<br>② 내 차례에만 행동할 수 있어요<br>③ 파티 채팅은 언제든 OK';
  const close = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
  t.addEventListener('click', close);
  layer.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(close, 8000);
}

/* ── 🆕 탐색 미니게임 오버레이 ──────────────────
 * 확산성 밀리언아서류 탐색 — DM 이 [탐색] 태그로 열면 화면 중앙 오버레이가 뜨고,
 * [🔍 탐색] 버튼을 탭할 때마다 게이지가 차며 아이템/골드/함정/적이 툭 튀어나온다.
 * 게이지는 파티 공유(누가 탭하든 같이 참). 서버 explore_tap 이 각본을 재생.
 */
let _explorationTotal = 0;
let _explorationTapLock = false;
let _explorationEnded = false;  // 🆕 종료 연출(1.4~2.2s) 동안 탭·리플 무시
// 🆕 배경 3단계 프리로드 상태 — Pollinations 첫 로드 ~44초라 순차 프리로드 후 진행률 따라 스왑.
let _expStageUrls = [];    // 단계별 이미지 URL (최대 3)
let _expStageLoaded = [];  // 단계별 로드 완료 여부
let _expStageShown = -1;   // 현재 표시 중인 단계 (-1 = 폴백 배경)
let _expPreloadGen = 0;    // 세대 카운터 — 오버레이 닫힘/새 탐색 시 증가시켜 stale onload 무시

// 🆕 [N] 배경 선(先)생성 — Pollinations 는 같은 URL(프롬프트+시드)을 CDN 에 캐시하므로
//   "미리 생성" = URL 을 미리 한 번 요청해두는 것. 아래 3겹(프리워밍·재사용·지형 폴백)으로 대기 체감 제거.
const EXP_PREWARM = true;          // N-1.2 평시(dm_response) 저우선 워밍 on/off 레버
let _expLastTerrain = 'dirt';      // N-1.2 마지막 탐색 지형 (없으면 dirt) — _expTerrain 은 종료 시 리셋되므로 별도 보관
let _expWarmIdx = 0;               // 폴백 2장 라운드로빈 인덱스
const _expWarmedFallbacks = new Set();  // N-3 워밍 완료된 폴백 URL — 완료분만 즉시 배경으로 사용
// N-3 지형별 고정 시드 폴백 풀 — 오버레이 열리는 즉시(워밍돼 있으면) 배경으로 깔고, 본 이미지 로드 시 크로스페이드.
const _EXP_FALLBACK_STYLE = 'digital painting, fantasy concept art, cinematic lighting, atmospheric, no text';
const _EXP_TERRAIN_FALLBACK = {
  stone: ['ancient stone castle hall, torchlight, mist', 'ruined stone temple corridor, shafts of light'],
  dirt:  ['dirt trail through wilderness at dusk, overcast sky', 'muddy road winding into distant hills'],
  grass: ['lush green meadow with wildflowers, sunlight', 'deep enchanted forest clearing, sunbeams'],
  wood:  ['old wooden mansion interior, candlelight, dust', 'weathered ship deck below, wooden beams'],
  cave:  ['dark underground cavern, glowing crystals', 'deep mine tunnel, lantern light, damp rock'],
};
const _EXP_FB_SEED = { stone: 41000, dirt: 42000, grass: 43000, wood: 44000, cave: 45000 };
function _expFallbackUrl(terrain, i) {
  const t = _EXP_TERRAIN_FALLBACK[terrain] ? terrain : 'dirt';
  const pool = _EXP_TERRAIN_FALLBACK[t];
  const idx = ((i % pool.length) + pool.length) % pool.length;
  const prompt = encodeURIComponent(pool[idx] + ', ' + _EXP_FALLBACK_STYLE);
  const seed = _EXP_FB_SEED[t] + idx;
  return `https://image.pollinations.ai/prompt/${prompt}?width=768&height=384&seed=${seed}&nologo=true&model=flux`;
}
// N-1.2 응답당 1장 저우선 워밍 — 마지막(또는 기본) 지형 폴백 2장을 라운드로빈으로 CDN 예열.
function _expWarmFallback() {
  if (!EXP_PREWARM) return;
  const url = _expFallbackUrl(_expLastTerrain, _expWarmIdx);
  _expWarmIdx = (_expWarmIdx + 1) % 2;
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => _expWarmedFallbacks.add(url);
  im.src = url;  // 응답당 1장 초과 금지 — 외부 서비스 예의
}

function _ensureExplorationOverlay() {
  let ov = document.getElementById('exploration-overlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'exploration-overlay';
  ov.className = 'exp-overlay';
  ov.style.display = 'none';
  ov.innerHTML = `
    <div class="exp-panel">
      <div class="exp-bg"><img class="exp-bg-img" alt=""></div>
      <div class="exp-header">
        <span class="exp-place"></span>
        <div class="exp-header-right">
          <span class="exp-danger"></span>
          <div class="exp-ctrls">
            <button class="exp-btn exp-mute" type="button" title="소리 켜기/끄기">🔊</button>
            <button class="exp-btn exp-abort" type="button" title="탐색 중단" aria-label="탐색 중단" style="display:none">⏹<span class="exp-btn-label"> 탐색 중단</span></button>
            <button class="exp-btn exp-collapse" type="button" title="접기" aria-label="접기">⌄<span class="exp-btn-label"> 접기</span></button>
          </div>
        </div>
      </div>
      <div class="exp-bg-loading" style="display:none">🎨 배경 그리는 중…</div>
      <div class="exp-pop-area"></div>
      <div class="exp-gauge"><div class="exp-gauge-fill"></div><span class="exp-gauge-text"></span></div>
      <div class="exp-hint">화면을 탭해 앞으로 나아가세요 — 함께 두드리면 같이 전진합니다</div>
    </div>`;
  document.body.appendChild(ov);
  // 🆕 밀리언아서식 — 화면 어디든 탭하면 전진 (pointerdown = 마우스+터치 공용, click 지연 없음)
  ov.addEventListener('pointerdown', _onExploreTapPointer);
  // 🆕 헤더 버튼은 탭-전진으로 새지 않게 pointerdown 을 여기서 멈춤.
  const ctrls = ov.querySelector('.exp-ctrls');
  ctrls.addEventListener('pointerdown', e => e.stopPropagation());
  ov.querySelector('.exp-collapse').addEventListener('click', _collapseExploration);
  ov.querySelector('.exp-mute').addEventListener('click', _toggleExpMute);
  ov.querySelector('.exp-abort').addEventListener('click', _abortExploration);
  return ov;
}

// 🆕 접힘 상태 — 오버레이를 로컬로 숨기고 작은 플로팅 버튼만 남김. explore_progress 는 계속 _expLast 로 수신.
let _expCollapsed = false;
let _expLast = { pos: 0, total: 0 };
let _expMuted = localStorage.getItem('trog_exp_mute') === '1';
let _expHintTimer = null;  // 🆕 시작 안내 자동 페이드 타이머

// 🆕 시작 안내를 서서히 숨김 + "본 적 있음" 기억 (재탐색 땐 더 빨리 사라짐)
function _fadeExpHint() {
  _expHintTimer = null;
  const h = document.querySelector('#exploration-overlay .exp-hint');
  if (h) h.classList.add('exp-hint-hidden');
  try { localStorage.setItem('trog_exp_hint_seen', '1'); } catch (e) {}
}

function _expFloatBtn() {
  let b = document.getElementById('exp-float-btn');
  if (b) return b;
  b = document.createElement('button');
  b.id = 'exp-float-btn';
  b.className = 'exp-float-btn';
  b.type = 'button';
  b.textContent = '🔍 탐색 중 — 펼치기';
  b.style.display = 'none';
  b.addEventListener('click', _expandExploration);
  document.body.appendChild(b);
  return b;
}

function _collapseExploration() {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  _expCollapsed = true;
  ov.classList.remove('exp-in');
  ov.style.display = 'none';
  _expCancelSteps();
  _expFloatBtn().style.display = '';
}

function _expandExploration() {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  _expCollapsed = false;
  _expFloatBtn().style.display = 'none';
  ov.style.display = 'flex';
  requestAnimationFrame(() => ov.classList.add('exp-in'));
  // 접혀 있는 동안 밀린 최신 진행 상태 반영 (게이지 + 카메라)
  _renderExpGauge(_expLast.pos, _expLast.total);
  const prog = _expLast.total > 0 ? Math.min(1, _expLast.pos / _expLast.total) : 0;
  ov.style.setProperty('--exp-progress', prog);
}

function _toggleExpMute() {
  _expMuted = !_expMuted;
  localStorage.setItem('trog_exp_mute', _expMuted ? '1' : '0');
  _syncMuteBtn();
}

function _syncMuteBtn() {
  const b = document.querySelector('#exploration-overlay .exp-mute');
  if (b) b.textContent = _expMuted ? '🔇' : '🔊';
}

function _abortExploration() {
  if (!isOwner && !_expIsStarter) return;  // O-4: 방장 또는 시작자만
  wsSendSafe({ type: 'explore_abort' });
}

function _onExploreTapPointer(e) {
  if (_explorationEnded) return;               // 종료 연출 중 — 탭·리플 모두 무시
  if (isSpectator || _amIDead()) return;       // 사망자/관전자 무반응
  if (_expHintTimer) { clearTimeout(_expHintTimer); _expHintTimer = null; _fadeExpHint(); }  // 🆕 첫 탭 = 안내 즉시 페이드
  _expAudio();  // 🆕 첫 사용자 제스처에서 AudioContext 생성/resume (발소리 언락)
  // 리플은 쿨다운 중에도 그려줌 (연타 손맛) — 서버 전송만 0.3s 락
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    _expRipple(e.clientX, e.clientY);
  }
  _sendExploreTap();
}

function _expRipple(x, y) {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  const r = document.createElement('div');
  r.className = 'exp-ripple';
  r.style.left = x + 'px';
  r.style.top = y + 'px';
  ov.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
  setTimeout(() => r.remove(), 700);  // animationend 미발화 보험
}

// ── 🆕 발소리 합성 (Web Audio, 외부 파일 없음) — 실패는 조용히 무시, 게임 동작 영향 0 ──
let _expAC = null;          // AudioContext 전역 1개 재사용
let _expStepTimers = [];    // 예약된 발걸음 타이머 (숨김 시 취소)
let _expTerrain = 'dirt';   // 🆕 현재 탐색 지형 (서버 exploration_start/복원에서 설정)

function _expAudio() {
  try {
    if (!_expAC) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _expAC = new AC();
    }
    if (_expAC.state === 'suspended') _expAC.resume();
    return _expAC;
  } catch (e) { return null; }
}

// 🆕 지형별 발소리 파라미터 — thump(f0→f1 Hz, tg gain, td 감쇠) + 노이즈(nd 길이, ft/ff/fq 필터, atk 어택, ng gain)
//   stone=또렷한 뚜벅(즉발) / dirt=뭉근한 저벅(기본) / grass=사각 스침 / wood=통통 공명 / cave=stone+메아리
const _EXP_STEP_RECIPES = {
  stone: { f0: 110, f1: 55, tg: 1.0,  td: 0.18, nd: 0.12, ft: 'lowpass',  ff: 350, fq: 1, atk: 0.005, ng: 0.5 },
  dirt:  { f0: 90,  f1: 50, tg: 0.4,  td: 0.12, nd: 0.15, ft: 'lowpass',  ff: 500, fq: 1, atk: 0.02,  ng: 0.4 },
  grass: { f0: 90,  f1: 60, tg: 0.15, td: 0.05, nd: 0.20, ft: 'lowpass',  ff: 900, fq: 1, atk: 0.03,  ng: 0.3 },
  wood:  { f0: 160, f1: 80, tg: 0.8,  td: 0.12, nd: 0.08, ft: 'bandpass', ff: 250, fq: 2, atk: 0.005, ng: 0.5 },
};

function _expFootstep(vol = 1, terrain = 'dirt') {
  if (_expMuted) return;
  const ac = _expAudio();
  if (!ac) return;
  try {
    const t = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = 0.25 * vol;  // 파티원 걸음도 같이 들리므로 낮게. vol 로 걸음별 감쇠.
    master.connect(ac.destination);
    const vary = () => 0.9 + Math.random() * 0.2;  // ±10% — 기계적 반복감 방지
    const P = _EXP_STEP_RECIPES[terrain === 'cave' ? 'stone' : terrain] || _EXP_STEP_RECIPES.dirt;
    // cave = stone 레시피 + 메아리: 입구를 delay(0.18s)+feedback(0.3) 에 병렬 분기 — 2회쯤 울리고 소멸.
    // 노드는 매 호출 생성 후 참조가 끊겨 원샷 소스 종료와 함께 GC — 컨텍스트에 누적되지 않음.
    let out = master;
    if (terrain === 'cave') {
      const dl = ac.createDelay(0.5);
      dl.delayTime.value = 0.18;
      const fb = ac.createGain();
      fb.gain.value = 0.3;
      dl.connect(fb); fb.connect(dl);   // feedback 루프
      dl.connect(master);
      out = ac.createGain();
      out.connect(master);              // 원음
      out.connect(dl);                  // 메아리 분기
    }
    // 저역 thump
    const o = ac.createOscillator();
    const og = ac.createGain();
    o.frequency.setValueAtTime(P.f0 * vary(), t);
    o.frequency.exponentialRampToValueAtTime(P.f1 * vary(), t + Math.min(0.08, P.td));
    og.gain.setValueAtTime(P.tg * vary(), t);
    og.gain.exponentialRampToValueAtTime(0.001, t + P.td);
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + P.td + 0.02);
    // 🆕 모바일 스피커 가청용 중역 배음 — thump 3배음(사인) gain 0.3배, 같은 엔벨로프.
    // 저음(50~60Hz)은 폰 스피커에서 거의 무음이라 165Hz대 성분을 겹쳐 함께 들리게. PC 저음 품질은 유지.
    const om = ac.createOscillator();
    const omg = ac.createGain();
    om.type = 'sine';
    om.frequency.setValueAtTime(P.f0 * 3 * vary(), t);
    om.frequency.exponentialRampToValueAtTime(P.f1 * 3 * vary(), t + Math.min(0.08, P.td));
    omg.gain.setValueAtTime(P.tg * 0.3 * vary(), t);
    omg.gain.exponentialRampToValueAtTime(0.001, t + P.td);
    om.connect(omg); omg.connect(out);
    om.start(t); om.stop(t + P.td + 0.02);
    // 노이즈 (재질 질감)
    const nb = ac.createBuffer(1, Math.floor(ac.sampleRate * P.nd), ac.sampleRate);
    const data = nb.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const ns = ac.createBufferSource();
    ns.buffer = nb;
    const flt = ac.createBiquadFilter();
    flt.type = P.ft; flt.frequency.value = P.ff; flt.Q.value = P.fq;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.001, t);
    ng.gain.linearRampToValueAtTime(P.ng * vary(), t + P.atk);
    ng.gain.exponentialRampToValueAtTime(0.001, t + P.nd);
    ns.connect(flt); flt.connect(ng); ng.connect(out);
    ns.start(t);
  } catch (e) { /* 무시 */ }
}

// 한 탭 = 뚜벅뚜벅 5~6걸음 — bob 박자(~300ms)에 맞춰 스케줄.
// 화면 흔들림 감쇠와 동조: 뒤 걸음일수록 소리도 점점 작아지며 멎음.
function _expScheduleSteps() {
  _expCancelSteps();
  const n = 5 + (Math.random() < 0.5 ? 0 : 1);
  for (let i = 0; i < n; i++) {
    const delay = i * (400 + (Math.random() * 40 - 20));
    const vol = 1 - (i / n) * 0.6;  // 첫 걸음 100% → 마지막 걸음 ~40%
    _expStepTimers.push(setTimeout(() => { if (!_explorationEnded) _expFootstep(vol, _expTerrain); }, delay));
  }
}

function _expCancelSteps() {
  _expStepTimers.forEach(clearTimeout);
  _expStepTimers = [];
}

// 이벤트 칸 도착 보너스음 — item/gold=밝은 딩 2음, trap=낮은 쿵, enemy=불협 2음
function _expEventSound(type) {
  if (_expMuted) return;
  const ac = _expAudio();
  if (!ac) return;
  try {
    const master = ac.createGain();
    master.gain.value = 0.25;
    master.connect(ac.destination);
    const t = ac.currentTime;
    const tone = (freq, at, dur) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.6, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + dur);
      o.connect(g); g.connect(master);
      o.start(at); o.stop(at + dur + 0.02);
    };
    if (type === 'item' || type === 'gold' || type === 'discovery') { tone(880, t, 0.05); tone(1320, t + 0.05, 0.09); }
    else if (type === 'trap') { tone(60, t, 0.15); tone(165, t, 0.12); }  // 🆕 165Hz 중역 = 모바일 가청
    else if (type === 'enemy') { tone(220, t, 0.25); tone(233, t, 0.25); }
  } catch (e) { /* 무시 */ }
}

function _sendExploreTap() {
  if (isSpectator || _amIDead()) return;
  if (_explorationTapLock) return;
  _explorationTapLock = true;  // 클라 측 0.3초 debounce (서버도 0.3초 쿨다운)
  setTimeout(() => { _explorationTapLock = false; }, 300);
  wsSendSafe({ type: 'explore_tap' });
}

const _DANGER_LABEL = { '하': '🟢 위험도 하', '중': '🟡 위험도 중', '상': '🔴 위험도 상' };

function showExplorationOverlay(d, restore) {
  const ov = _ensureExplorationOverlay();
  _explorationTotal = d.total || 0;
  _expIsStarter = !!(d.starter_id && myId && d.starter_id === myId);  // O-4: 시작자 중단권
  ov.querySelector('.exp-place').textContent = '🗺 ' + (d.place || '탐색');
  ov.querySelector('.exp-danger').textContent = _DANGER_LABEL[d.danger] || '';
  const img = ov.querySelector('.exp-bg-img');
  // 🆕 Pollinations 신규 이미지는 요청 시점에 생성 시작 → 첫 로드 ~44초 (실측).
  // 즉시 폴백(현재 장면 배너) 표시 → 단계 이미지(최대 3장) 순차 프리로드 → 도착/진행률 따라 스왑.
  _expPreloadGen++;
  _expTerrain = d.terrain || 'dirt';  // 🆕 지형 발소리 재질 (복원 포함) — 폴백 계산보다 먼저
  _expLastTerrain = _expTerrain;      // N-1.2 워밍 타겟 갱신
  // N-3 폴백: 현재 배너(즉시) 우선, 없으면 워밍 완료된 지형 폴백 URL 만 즉시 배경으로 사용.
  //   (미예열 폴백을 깔면 오히려 빈 배경이 길어짐 → 워밍 완료분만.)
  const banner = document.getElementById('scene-banner-img');
  const bannerSrc = (banner && banner.getAttribute('src')) ? banner.src : '';
  const fbUrl = _expFallbackUrl(_expTerrain, 0);
  const fallbackSrc = bannerSrc || (_expWarmedFallbacks.has(fbUrl) ? fbUrl : '');
  img.style.opacity = '';
  if (fallbackSrc) { img.src = fallbackSrc; img.style.display = ''; }
  else { img.removeAttribute('src'); img.style.display = 'none'; }
  _expStageUrls = (Array.isArray(d.image_urls) && d.image_urls.length
    ? d.image_urls : (d.image_url ? [d.image_url] : [])).slice(0, 3);
  _expStageLoaded = _expStageUrls.map(() => false);
  _expStageShown = -1;
  // 🎨 "그리는 중" 칩 — 폴백이 깔려 있으면 띄우지 않는다(체감 제거). 폴백도 본이미지도 없을 때만.
  const chip = ov.querySelector('.exp-bg-loading');
  chip.style.display = (!fallbackSrc && _expStageUrls.length && _expStageUrls[0] !== fallbackSrc) ? '' : 'none';
  // N-1.1 프리워밍: 스테이지 URL 전부 즉시 병렬 fire (기존 순차 체이닝 제거). 표시 게이팅은 그대로.
  for (let i = 0; i < _expStageUrls.length; i++) _expPreloadStage(i, _expPreloadGen);
  // 카메라 진행도 초기화 (재접속 복원 포함 — 현재 pos/total 로)
  ov.style.setProperty('--exp-progress', (d.total > 0 ? Math.min(1, (d.pos || 0) / d.total) : 0));
  ov.querySelector('.exp-pop-area').innerHTML = '';
  _renderExpGauge(d.pos || 0, d.total || 0);
  _explorationEnded = false;  // 🆕 종료 플래그 리셋 (새 탐색/복원)
  _expLast = { pos: d.pos || 0, total: d.total || 0 };  // 접힘 대비 최신값 시드
  // 새 탐색/복원은 항상 펼친 상태로 시작 — 잔류 접힘/플로팅 버튼 정리
  _expCollapsed = false;
  const fb = document.getElementById('exp-float-btn');
  if (fb) fb.style.display = 'none';
  _syncMuteBtn();  // 🆕 음소거 버튼 라벨 동기화
  // 🆕 탐색 중단 버튼 — 방장 또는 시작자에게 (관전자 제외). O-4
  const abortBtn = ov.querySelector('.exp-abort');
  if (abortBtn) abortBtn.style.display = ((isOwner || _expIsStarter) && !isSpectator) ? '' : 'none';
  // 사망/관전자는 탭 무반응 — 힌트 문구로 안내. 포인터 타입에 따라 탭/클릭 (P3-J).
  const tapVerb = window.matchMedia('(pointer: coarse)').matches ? '탭' : '클릭';
  const hint = ov.querySelector('.exp-hint');
  hint.textContent = (isSpectator || _amIDead())
    ? '관전 중…'
    : `화면을 ${tapVerb}해 앞으로 나아가세요 — 함께 두드리면 같이 전진합니다`;
  // 🆕 시작 안내 자동 페이드 — 재진입 시 타이머·opacity 리셋 후 재예약 (본 적 있으면 2초, 처음 4초)
  hint.classList.remove('exp-hint-hidden');
  if (_expHintTimer) clearTimeout(_expHintTimer);
  let seen = false; try { seen = localStorage.getItem('trog_exp_hint_seen') === '1'; } catch (e) {}
  _expHintTimer = setTimeout(_fadeExpHint, seen ? 2000 : 4000);
  ov.style.display = 'flex';
  if (!restore) requestAnimationFrame(() => ov.classList.add('exp-in'));
  else ov.classList.add('exp-in');
}

// 🆕 [N] 단계 이미지 병렬 프리로드 — 각 스테이지를 독립적으로 fire (stale 는 gen 으로 무시).
//   본이미지(0단계)는 onerror/8초 타임아웃 시 1회 재시도(폴백은 그대로 유지). retried=재시도분 표시.
function _expPreloadStage(idx, gen, retried) {
  if (gen !== _expPreloadGen || idx >= _expStageUrls.length) return;
  const pre = new Image();
  let settled = false;  // 이 Image 의 원요청/재시도 late 콜백 중복 방지
  pre.onload = () => {
    if (gen !== _expPreloadGen || settled) return;  // 오버레이 닫힘/새 탐색·중복 — 무시
    settled = true;
    _expStageLoaded[idx] = true;
    const ov = document.getElementById('exploration-overlay');
    if (!ov || ov.style.display === 'none') return;
    // 첫 장 도착 → 폴백에서 즉시 스왑
    if (idx === 0 && _expStageShown < 0) {
      _expStageShown = 0;
      _expSwapBg(_expStageUrls[0]);
    } else if (idx > _expStageShown) {
      // 늦게 온 상위 단계: 이미 진행률이 그 문턱을 지났으면 즉시 승격 (다음 tap 안 기다림)
      const prog = _expLast.total > 0 ? Math.min(1, _expLast.pos / _expLast.total) : 0;
      const want = prog >= 0.75 ? 2 : prog >= 0.4 ? 1 : 0;
      if (want >= idx) { _expStageShown = idx; _expSwapBg(_expStageUrls[idx]); }
    }
  };
  pre.onerror = () => {
    if (gen !== _expPreloadGen || settled) return;
    settled = true;
    if (idx === 0 && !retried) _expPreloadStage(0, gen, true);  // 본이미지 1회 재시도 (폴백 유지)
  };
  // 본이미지 8초 타임아웃 → 아직 미로드면 1회 재시도 (Pollinations 첫 생성이 늦는 케이스)
  if (idx === 0 && !retried) {
    setTimeout(() => {
      if (gen !== _expPreloadGen || settled || _expStageLoaded[0]) return;
      settled = true;
      _expPreloadStage(0, gen, true);
    }, 8000);
  }
  pre.src = _expStageUrls[idx];
}

// 🆕 배경 페이드 스왑 — 0.6s 페이드아웃 → src 교체(프리로드 완료라 즉시) → 페이드인.
function _expSwapBg(url) {
  const ov = document.getElementById('exploration-overlay');
  if (!ov || ov.style.display === 'none') return;
  const img = ov.querySelector('.exp-bg-img');
  if (img.src === url) { img.style.opacity = ''; return; }
  img.style.opacity = '0';
  setTimeout(() => {
    if (ov.style.display === 'none') return;
    img.src = url;
    img.style.display = '';
    img.style.opacity = '';
  }, 620);
}

function _renderExpGauge(pos, total) {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  const pct = total > 0 ? Math.min(100, Math.round((pos / total) * 100)) : 0;
  ov.querySelector('.exp-gauge-fill').style.width = pct + '%';
  ov.querySelector('.exp-gauge-text').textContent = `${pos} / ${total}`;
}

function updateExplorationProgress(d) {
  _expLast = { pos: d.pos, total: d.total };  // 🆕 접힘 상태에서도 최신 진행값 보존 (펼치면 복원)
  // 🆕 접힘 상태 플로팅 버튼에도 진행률 표시 (버튼 텍스트 갱신 — 오버레이가 숨겨도 진행이 보임)
  const fb = document.getElementById('exp-float-btn');
  if (fb && d.total > 0) fb.textContent = `🔍 탐색 ${d.pos}/${d.total} — 펼치기`;
  const ov = document.getElementById('exploration-overlay');
  if (!ov || ov.style.display === 'none') return;  // 없거나 접힘 — 펼칠 때 _expLast 로 복원
  _renderExpGauge(d.pos, d.total);
  // 🆕 카메라 push-in: 진행도 0~1 을 CSS 변수로 — 탭마다 배경이 안쪽으로 걸어 들어감.
  const prog = d.total > 0 ? Math.min(1, (d.pos || 0) / d.total) : 0;
  ov.style.setProperty('--exp-progress', prog);
  // 🆕 보행 bob — 이미지가 아닌 컨테이너에 (img transform 카메라와 충돌 방지)
  const bg = ov.querySelector('.exp-bg');
  if (bg) { bg.classList.remove('exp-step'); void bg.offsetWidth; bg.classList.add('exp-step'); }
  // 🆕 발소리 3~4걸음 + 이벤트 칸 보너스음 (종료 연출 중엔 스케줄 금지)
  if (!_explorationEnded) {
    _expScheduleSteps();
    const evType = (d.event || {}).type;
    if (evType === 'item' || evType === 'gold' || evType === 'trap' || evType === 'enemy' || evType === 'discovery') {
      _expEventSound(evType);
    }
  }
  // 🆕 진행률 40%/75% 통과 시 다음 단계 배경으로 크로스페이드 — 이미 로드된 경우만 (안 왔으면 다음 탭 때 재확인)
  const stage = prog >= 0.75 ? 2 : prog >= 0.4 ? 1 : 0;
  if (stage > _expStageShown && _expStageLoaded[stage]) {
    _expStageShown = stage;
    _expSwapBg(_expStageUrls[stage]);
  }
  _popExploreEvent(d.event || {}, d.tapper_name);
  // HP/골드/인벤 변동 반영 — 파티/캐릭터 패널 갱신
  if (Array.isArray(d.players)) { refreshPlayers(d.players); refreshCharPanel(d.players); }
  const ev = d.event || {};
  // 기존 토스트 경로 재사용 (아이템·골드)
  if ((ev.items && ev.items.length) || (ev.gold_events && ev.gold_events.length)) {
    showEventToasts({ items: ev.items || [], gold_events: ev.gold_events || [] });
  }
}

let _expLastEventPopAt = 0;  // 🆕 마지막 보상/함정 팝 시각 — flavor/empty 가 즉시 덮지 못하게

function _popExploreEvent(ev, who) {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  const isEvent = (ev.type === 'item' || ev.type === 'gold' || ev.type === 'trap' || ev.type === 'enemy' || ev.type === 'discovery');
  // 보상/함정 팝은 최소 1.2s 노출 — 그 사이 도착한 flavor/empty 는 무시 (이벤트 팝끼리는 즉시 교체).
  if (!isEvent && (performance.now() - _expLastEventPopAt) < 1200) return;
  const area = ov.querySelector('.exp-pop-area');
  const panel = ov.querySelector('.exp-panel');
  const card = document.createElement('div');
  card.className = 'exp-pop';
  const w = escapeHtmlStr(who || '');
  const t = ev.type;
  if (t === 'item') {
    card.classList.add('exp-pop-item');
    card.innerHTML = `<div class="exp-pop-icon">🎁</div><div class="exp-pop-name">${escapeHtmlStr(ev.name || '')}</div><div class="exp-pop-who">${w} 발견!</div>`;
  } else if (t === 'gold') {
    card.classList.add('exp-pop-gold');
    card.innerHTML = `<div class="exp-pop-icon">💰</div><div class="exp-pop-name">골드 +${parseInt(ev.amount, 10) || 0}</div><div class="exp-pop-who">파티 전원</div>`;
  } else if (t === 'trap') {
    card.classList.add('exp-pop-trap');
    const dmg = parseInt(ev.damage, 10) || 0;
    const save = ev.save;
    if (save && save.kind === 'spot') {
      // 지혜/지능으로 미리 발견 — 완전 회피 (무피해)
      card.classList.add('exp-pop-saved');
      card.innerHTML = `<div class="exp-pop-icon">🛡</div><div class="exp-pop-name">${escapeHtmlStr(ev.text || '함정!')}</div><div class="exp-pop-who">${w} — 미리 발견해 피했다! (${escapeHtmlStr(save.label)} ${parseInt(save.value, 10) || 0})</div>`;
    } else if (save && save.kind === 'dodge') {
      // 기교로 낚아챔/회피 — 절반 경감
      card.classList.add('exp-pop-saved');
      card.innerHTML = `<div class="exp-pop-icon">🤺</div><div class="exp-pop-name">${escapeHtmlStr(ev.text || '함정!')}</div><div class="exp-pop-who">${w} — 쳐냈다! 절반만 -${dmg} HP (${escapeHtmlStr(save.label)} ${parseInt(save.value, 10) || 0})</div>`;
      if (panel) { panel.classList.remove('exp-shake'); void panel.offsetWidth; panel.classList.add('exp-shake'); }
    } else {
      card.innerHTML = `<div class="exp-pop-icon">💥</div><div class="exp-pop-name">${escapeHtmlStr(ev.text || '함정!')}</div><div class="exp-pop-who">${w} -${dmg} HP</div>`;
      if (panel) { panel.classList.remove('exp-shake'); void panel.offsetWidth; panel.classList.add('exp-shake'); }
    }
  } else if (t === 'discovery') {
    // 심심한 칸에서 스텟으로 뭔가를 얻음 — 초록 톤 재사용
    card.classList.add('exp-pop-saved');
    const val = parseInt(ev.value, 10) || 0;
    if (ev.kind === 'vigor') {
      // 건강 → HP 소량 회복
      const heal = parseInt(ev.heal, 10) || 0;
      card.innerHTML = `<div class="exp-pop-icon">💚</div><div class="exp-pop-name">기운을 되찾다! +${heal} HP</div><div class="exp-pop-who">${w} — 건강 ${val} 덕분</div>`;
    } else {
      const icon = ev.kind === 'nimble' ? '🤸' : ev.kind === 'force' ? '💪' : '🔎';
      const amt = parseInt(ev.amount, 10) || 0;
      card.innerHTML = `<div class="exp-pop-icon">${icon}</div><div class="exp-pop-name">숨겨진 것을 발견! +${amt} 골드</div><div class="exp-pop-who">${w} — ${escapeHtmlStr(ev.label || '')} ${val} 덕분</div>`;
    }
  } else if (t === 'enemy') {
    card.classList.add('exp-pop-enemy');
    // 🆕 조우 진입 판정 결과 — 스텟으로 기습/약점간파/매복간파 성공 or 기습당함
    let sub = `HP ${parseInt(ev.hp, 10) || 0} — 조우!`;
    const enc = ev.encounter;
    if (enc && enc.kind) {
      const good = { surprise: '🗡 기습 성공!', weakness: '👁 약점 간파!', spotted: '🛡 매복 간파!' }[enc.kind];
      if (good) sub += `<br><span class="exp-enc-good">${good} (${escapeHtmlStr(enc.label || '')} ${parseInt(enc.value, 10) || 0})</span>`;
      else if (enc.kind === 'ambushed') sub += `<br><span class="exp-enc-bad">⚠ 기습당함! 적이 선제</span>`;
    }
    card.innerHTML = `<div class="exp-pop-icon">👹</div><div class="exp-pop-name">${escapeHtmlStr(ev.name || '적')}</div><div class="exp-pop-who">${sub}</div>`;
    if (panel) { panel.classList.remove('exp-shake-hard'); void panel.offsetWidth; panel.classList.add('exp-shake-hard'); }
  } else if (t === 'flavor') {
    card.classList.add('exp-pop-flavor');
    card.textContent = ev.text || '…';
  } else {
    card.classList.add('exp-pop-flavor');
    card.textContent = '…';
  }
  area.innerHTML = '';
  area.appendChild(card);
  if (isEvent) _expLastEventPopAt = performance.now();
}

function endExploration(d) {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  // 접혀 있으면 종료 연출 볼 수 없음 — 바로 정리(플로팅 버튼 포함).
  if (_expCollapsed) { hideExplorationOverlay(); return; }
  const reason = d.reason;
  _explorationEnded = true;  // 🆕 종료 연출 동안 탭·리플 무시 (show 에서 리셋)
  const area = ov.querySelector('.exp-pop-area');
  if (area) {
    const msg = reason === 'enemy'
      ? `⚔ ${escapeHtmlStr(d.enemy_name || '적')} 출현! 전투 준비!`
      : reason === 'expired'
        ? '🌫 탐색이 중단되었다'
        : `✅ 탐색 완료 — ${escapeHtmlStr(d.summary || '')}`;
    area.innerHTML = `<div class="exp-pop exp-pop-end">${msg}</div>`;
  }
  // 잠시 결과를 보여준 뒤 오버레이 닫기 (적 조우는 조금 더 짧게 — 전투 화면으로).
  const delay = reason === 'enemy' ? 1400 : 2200;
  setTimeout(hideExplorationOverlay, delay);
}

function hideExplorationOverlay() {
  const ov = document.getElementById('exploration-overlay');
  if (!ov) return;
  ov.classList.remove('exp-in');
  ov.style.display = 'none';
  _explorationTapLock = false;
  if (_expHintTimer) { clearTimeout(_expHintTimer); _expHintTimer = null; }  // 🆕 힌트 페이드 타이머 정리
  // 🆕 프리로드·로딩 칩·카메라·발소리 예약 정리 — 다음 탐색 때 잔류 방지
  _expCancelSteps();
  _expTerrain = 'dirt';
  _expPreloadGen++;
  _expStageUrls = []; _expStageLoaded = []; _expStageShown = -1;
  const chip = ov.querySelector('.exp-bg-loading');
  if (chip) chip.style.display = 'none';
  ov.style.setProperty('--exp-progress', 0);
  const bg = ov.querySelector('.exp-bg');
  if (bg) bg.classList.remove('exp-step');
  // 🆕 접힘/플로팅 버튼/팝 타임스탬프 리셋 — 다음 탐색 잔류 방지
  _expCollapsed = false;
  _expLastEventPopAt = 0;
  const fb = document.getElementById('exp-float-btn');
  if (fb) fb.style.display = 'none';
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
  _capNarrLog(log);
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
    // 🆕 4슬롯 호환 — eq[slot] 은 {name, effect} 딕트, 구버전 weapon 폴백
    const eqName = (s) => {
      const v = (typeof s === 'object' && s !== null) ? s.name : s;
      return v || '-';
    };
    const eqMain = eqName(eq.main_hand || eq.weapon);
    const eqArmor = eqName(eq.armor);
    card.innerHTML = `
      <div class="takeover-portrait-wrap">
        <img class="takeover-portrait" src="${escapeHtml(p.portrait_url)}" alt="${escapeHtml(p.name)}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
        <span class="takeover-emoji-fallback" style="display:none">${escapeHtml(p.emoji || '🧑')}</span>
      </div>
      <div class="takeover-info">
        <div class="takeover-name">${escapeHtml(p.name)} <span class="takeover-lvl">Lv.${p.level}</span></div>
        <div class="takeover-sub">${escapeHtml(p.race_emoji || '')} ${escapeHtml(raceLabel(p))} · ${escapeHtml(p.character_class)}</div>
        <div class="takeover-stat">HP ${p.hp}/${p.max_hp} · MP ${p.mp}/${p.max_mp}</div>
        <div class="takeover-eq">🗡️ ${escapeHtml(eqMain)} · 🥋 ${escapeHtml(eqArmor)}</div>
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
  // 🆕 진행 중 탐색 오버레이 동기화 (관전 진입) — 탭 불가·관전 힌트는 showExplorationOverlay 가 처리
  if (d.exploration) showExplorationOverlay(d.exploration, true);

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
    _capNarrLog(log);
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

// V7-04: 토스트 동시 표시 상한 — 전투 중 XP/처치/DOT 등 동시 발화 시 6개 초과면
// 가장 오래된 것부터 즉시 제거. 화면 가림 방지.
const _TOAST_MAX_VISIBLE = 6;
function pushToast(layer, text, cls) {
  // 기존 토스트가 너무 많으면 오래된 것부터 강제 제거
  while (layer.children.length >= _TOAST_MAX_VISIBLE) {
    const oldest = layer.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
  const t = document.createElement('div');
  t.className = `toast ${cls || ''}`;
  t.textContent = text;
  // 클릭하면 즉시 닫기 (사용자가 빨리 정리하고 싶을 때)
  t.addEventListener('click', () => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 200);
  });
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

// 🆕 E-1 — 본인 피격/회복 시 캐릭터 패널·미니HUD 붉은/초록 플래시.
// reduced-motion 은 전역 @media(animation-duration:0.01ms) 가 자동 무력화.
function flashDamage(heal) {
  const cls = heal ? 'heal-flash' : 'damage-flash';
  ['char-panel', 'mobile-mini-hud'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('damage-flash', 'heal-flash');
    void el.offsetWidth;  // reflow — 연속 피격에도 애니 재시작
    el.classList.add(cls);
  });
}

/* ── 캠페인 엔딩 오버레이 ──────────────────
   DM 이 [캠페인 종료: 분기키] 태그 찍으면 이 화면이 뜸. "크레딧 롤" 은 아니고
   시나리오 요약 + 선택한 분기 + 새 캠페인 시작 버튼. */
// V39-01: TPK 비극 후 dead-state — campaign_ending 도 안 발화한 case 에 대비한 안내 모달.
// 파티 전원이 사망 + rescue 없음 + DM 도 분기 종결 못 찍었을 때, 사용자가 "이제 어쩌지" 멍해지는
// 상태를 차단. 새 캠페인 시작 / 관전자 모드 전환 / 닫기 (현 화면 유지) 3 옵션.
function _showTpkOptionModal() {
  if (document.getElementById('tpk-option-modal')) return;  // 중복 방지
  const m = document.createElement('div');
  m.id = 'tpk-option-modal';
  m.className = 'modal';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.setAttribute('aria-labelledby', 'tpk-option-title');
  m.style.display = 'flex';
  m.innerHTML = `
    <div class="modal-backdrop" data-tpk-close></div>
    <div class="modal-box">
      <div class="modal-title" id="tpk-option-title">
        🕯 파티 전멸
        <button class="modal-close" data-tpk-close type="button" aria-label="닫기">✕</button>
      </div>
      <div class="modal-hint">
        모든 동료가 쓰러졌습니다. 부활을 도울 동료가 남아있지 않습니다.<br>
        DM 이 분기 결말을 못 찍었으니 이야기는 여기서 멈춥니다.
      </div>
      <div class="modal-footer">
        <button id="tpk-restart-btn" class="btn btn-primary">🎲 새 캠페인 시작</button>
        <button id="tpk-spectate-btn" class="btn btn-secondary">👁 관전자 모드로 보기</button>
        <button class="btn btn-ghost" data-tpk-close>닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(m);
  m.querySelectorAll('[data-tpk-close]').forEach(b =>
    b.addEventListener('click', () => m.remove()));
  document.getElementById('tpk-restart-btn').addEventListener('click', () => {
    clearSession();
    location.href = location.pathname;
  });
  document.getElementById('tpk-spectate-btn').addEventListener('click', () => {
    // 같은 방을 관전자로 재접속 — 사망 캐릭은 자동 dormant 화 됨.
    const code = currentRoomCode || '';
    clearSession();
    if (code) {
      sessionStorage.setItem('trog_pending_spectate', code);
    }
    location.href = location.pathname;
  });
}

function showCampaignEnding(ending) {
  if (!ending) return;
  // 기존 오버레이 제거 (중복 방지)
  const old = document.getElementById('campaign-ending-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'campaign-ending-overlay';
  overlay.className = 'campaign-ending-overlay';
  const isTpk = ending.branch === 'tpk';
  const title = `${escapeHtml(ending.scenario_emoji || '📜')} ${escapeHtml(ending.scenario_name || '캠페인 종료')}`;
  const branchLabel = ending.branch_known
    ? `분기: <b>${escapeHtml(ending.branch)}</b>`
    : `분기: <b>${escapeHtml(ending.branch)}</b> (미등록 분기 — DM 이 자유롭게 종결)`;
  const desc = ending.description || 'DM 이 엔딩을 그려냈습니다.';
  overlay.innerHTML = `
    <div class="ce-card">
      <div class="ce-title">${isTpk ? '🕯 세션 종료' : '🏁 캠페인 완주'}</div>
      <div class="ce-scenario">${title}</div>
      <div class="ce-branch">${branchLabel}</div>
      <div class="ce-desc">${escapeHtml(desc)}</div>
      <div class="ce-footer">${isTpk ? '파티의 여정은 여기서 막을 내립니다.' : '모든 이야기는 여기까지. 수고하셨습니다.'}</div>
      <div class="ce-actions">
        <button id="ce-new-btn" class="btn btn-primary">🎲 새 캠페인 시작</button>
        <button id="ce-dismiss-btn" class="btn btn-secondary">엔딩 닫고 여운 즐기기</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('ce-dismiss-btn').addEventListener('click', () => overlay.remove());
  document.getElementById('ce-new-btn').addEventListener('click', () => {
    clearSession();
    location.href = location.pathname;
  });
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

// 🆕 B-5: 커스텀 행동 삭제 — 우클릭·✕ 버튼 공용 경로.
function deleteCustomAction(idx, label) {
  if (!confirm(`"${label}" 삭제?`)) return;
  const cur = loadCustomActions();
  cur.splice(idx, 1);
  saveCustomActions(cur);
  renderCustomActions();
}

// M-2: 모바일에선 커스텀 칩을 프리셋 줄(#quick-row-preset) 뒤에 이어붙여 "한 줄"로,
// '＋ 나만의 행동' 추가 버튼만 #quick-row-custom(더보기)에 남긴다. 데스크톱은 종전대로.
let _customRenderMobile = null;
function renderCustomActions() {
  const row = document.getElementById('quick-row-custom');
  if (!row) return;
  const mobile = typeof isMobileViewport === 'function' && isMobileViewport();
  _customRenderMobile = mobile;
  const presetRow = document.getElementById('quick-row-preset');
  // 이전 렌더가 프리셋 줄에 남긴 커스텀 칩 제거 (모바일↔데스크톱 전환 안전)
  if (presetRow) presetRow.querySelectorAll('.q-custom').forEach(el => el.remove());
  row.innerHTML = '';
  const actions = loadCustomActions();
  const chipTarget = (mobile && presetRow) ? presetRow : row;
  actions.forEach((a, idx) => {
    const b = document.createElement('button');
    b.className = 'q-btn q-custom';
    b.title = a.text;
    const label = document.createElement('span');
    label.textContent = `${a.icon || '✨'} ${a.label}`;
    b.appendChild(label);
    b.addEventListener('click', () => sendRaw(a.text));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      deleteCustomAction(idx, a.label);
    });
    // 🆕 B-5: 모바일용 삭제 ✕ (우클릭 불가 대응) — 같은 삭제 경로 재사용.
    const del = document.createElement('span');
    del.className = 'qa-del';
    del.textContent = '✕';
    del.title = '이 행동 삭제';
    del.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault(); // 부모 버튼의 sendRaw 방지
      deleteCustomAction(idx, a.label);
    });
    b.appendChild(del);
    chipTarget.appendChild(b);
  });
  // 추가 버튼 (최대 도달 시 숨김) — 항상 #quick-row-custom 에 (모바일=더보기 안)
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
// 모바일은 본문 공간이 부족하니 더 빨리 축소 (3초). 데스크탑은 7초.
const SCENE_VISIBLE_MS = (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) ? 3000 : 7000;

function updateSceneBanner(dmText, timeTag, players, directUrl) {
  // directUrl 가 있으면 LLM 이 SCENE 태그로 영문 묘사를 써준 것 — 그대로 사용 (최우선).
  // 없으면 기존 한글 키워드 추출 폴백.
  _roundCounter++;
  const banner = document.getElementById('scene-banner');
  const img = document.getElementById('scene-banner-img');
  const label = document.getElementById('scene-banner-text');
  const roundEl = document.getElementById('scene-banner-round');
  if (!banner || !img) return;
  // V19-01: scene-banner 이미지에 portrait-enlarge 클래스 + data-full 추가 → 클릭 시 lightbox.
  if (!img.classList.contains('portrait-enlarge')) {
    img.classList.add('portrait-enlarge');
    img.style.cursor = 'zoom-in';
  }

  let url;
  if (directUrl) {
    url = directUrl;
  } else {
    const keywords = extractSceneKeywords(dmText);
    const tod = (timeTag && timeTag.label) ? `, ${timeTag.label}` : '';
    // 파티 구성 (종족들) 을 배경에 살짝 녹여서 일관된 캐릭터 느낌
    const races = (players || []).map(p => RACE_PROMPT[p.race]).filter(Boolean);
    const partyCue = races.length
      ? `, fantasy adventuring party: ${[...new Set(races)].slice(0, 4).join(' and ')}`
      : '';
    const prompt = `wide cinematic landscape map view, ${keywords}${tod}${partyCue}`;
    const seed = hashSeed(prompt + _roundCounter);
    url = pollinationsUrl(prompt, 640, 200, seed);
  }

  // 점진적 페이드
  banner.style.display = 'block';
  banner.classList.add('scene-loading');
  banner.classList.remove('collapsed');     // 새 장면 → 크게 펼침
  const newImg = new Image();
  newImg.onload = () => {
    img.src = newImg.src;
    banner.classList.remove('scene-loading');
    // V19-01: lightbox 용 data-full / data-caption 갱신
    img.dataset.full = newImg.src;
    img.dataset.caption = `장면 — Round ${_roundCounter}`;
  };
  newImg.onerror = () => {
    // 그림 실패해도 배너는 라벨만 남기기 (깨진 아이콘 방지)
    banner.classList.remove('scene-loading');
  };
  newImg.src = url;

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

function attachActionImageToLastBubble(actingPlayerId, players, dmText) {
  if (!_lastActionBubble) return;
  if (_lastActionBubble.querySelector('.msg-action-img')) return;
  const actor = (players || []).find(p => p.player_id === actingPlayerId);
  // 플레이어가 직접 그린/AI 생성한 자기 프로필을 그대로 노출 — 액션마다 다른 캐릭터가 뜨는 혼란 제거.
  const url = actor && actor.portrait_url;
  if (!url) return;
  const img = document.createElement('img');
  img.className = 'msg-action-img portrait-enlarge';
  img.alt = '';
  img.loading = 'lazy';
  img.src = url;
  img.dataset.full = url;
  img.dataset.caption = `${actor.name || ''} — ${_lastActionText.slice(0, 80)}`;
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

// V6-05: 드로잉 진행 중 작업물 보호.
// (a) localStorage 자동 저장 (15초 간격, 마지막 저장 후 변경 있을 때만)
// (b) beforeunload 가드 — 미저장 변경 있으면 브라우저 닫기 경고
// (c) 모달 닫을 때 변경 있으면 confirm
const DRAW_AUTOSAVE_KEY = 'trog_draw_autosave_v1';
const DRAW_AUTOSAVE_INTERVAL_MS = 15000;
let _drawDirty = false;        // 마지막 저장 / 모달 열기 이후 펜질 한 번이라도 했나
let _drawAutosaveTimer = null;
let _drawSavedClean = true;    // 사용자가 명시적 "저장" 했는지 (closeDrawModal confirm 면제 플래그)
function _markDrawDirty() {
  _drawDirty = true;
  _drawSavedClean = false;
}
function _captureDrawAutosave() {
  if (!_drawDirty) return;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    localStorage.setItem(DRAW_AUTOSAVE_KEY, JSON.stringify({
      ts: Date.now(),
      data: dataUrl,
      bg: canvasBgMode,
    }));
    _drawDirty = false;
  } catch (_) { /* 용량 부족 등 무시 */ }
}
function _hasDrawAutosave() {
  try {
    const raw = localStorage.getItem(DRAW_AUTOSAVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function _clearDrawAutosave() {
  try { localStorage.removeItem(DRAW_AUTOSAVE_KEY); } catch (_) {}
}

function openDrawModal() {
  modal.style.display = 'flex';
  resetUndoStack();
  // 자동 저장된 미완성 작품 발견 시 사용자에게 복구 의사 묻기.
  const recovered = _hasDrawAutosave();
  if (recovered && recovered.data) {
    const ageMin = Math.max(1, Math.round((Date.now() - recovered.ts) / 60000));
    if (confirm(`이전에 작업하다 만 그림이 발견되었습니다 (${ageMin}분 전).\n복구할까요?\n(취소 = 무시하고 새로 시작)`)) {
      const img = new Image();
      img.onload = () => {
        clearCanvas();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        snapshotCanvas();
      };
      img.onerror = () => loadMyPortraitIntoCanvas(_lastSeenPlayers);
      img.src = recovered.data;
    } else {
      _clearDrawAutosave();
      loadMyPortraitIntoCanvas(_lastSeenPlayers);
    }
  } else {
    loadMyPortraitIntoCanvas(_lastSeenPlayers);
  }
  refreshProfileList();
  _drawDirty = false;
  _drawSavedClean = true;
  if (_drawAutosaveTimer) clearInterval(_drawAutosaveTimer);
  _drawAutosaveTimer = setInterval(_captureDrawAutosave, DRAW_AUTOSAVE_INTERVAL_MS);
}
function closeDrawModal(forced = false) {
  // 변경 있고 명시적 저장 안 했으면 한 번 확인.
  if (!forced && _drawDirty && !_drawSavedClean) {
    if (!confirm('아직 저장하지 않은 변경이 있습니다. 정말 닫을까요?\n(자동 저장본은 다음에 모달 열 때 복구 가능)')) {
      return;
    }
    // 닫기 직전 한 번 더 자동 저장 (확인 시).
    _captureDrawAutosave();
  }
  modal.style.display = 'none';
  if (_drawAutosaveTimer) { clearInterval(_drawAutosaveTimer); _drawAutosaveTimer = null; }
}
window.addEventListener('beforeunload', (e) => {
  if (modal && modal.style.display === 'flex' && _drawDirty && !_drawSavedClean) {
    _captureDrawAutosave();   // 혹시라도 닫기 직전에 저장 시도
    e.preventDefault();
    e.returnValue = '';        // Chrome 표준 prompt 트리거
    return '';
  }
});

document.getElementById('open-draw-btn').addEventListener('click', openDrawModal);
const openDrawGame = document.getElementById('open-draw-btn-game');
if (openDrawGame) openDrawGame.addEventListener('click', openDrawModal);
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => closeDrawModal(false)));

/* ── TOOL SWITCH ────────────────────────── */
function setTool(name) {
  currentTool = name;
  document.getElementById('tool-brush-btn').classList.toggle('selected-tool', name === 'brush');
  document.getElementById('tool-bucket-btn').classList.toggle('selected-tool', name === 'bucket');
  document.getElementById('eraser-btn').classList.toggle('selected-tool', name === 'eraser');
  const eyeBtn = document.getElementById('tool-eyedropper-btn');
  if (eyeBtn) eyeBtn.classList.toggle('selected-tool', name === 'eyedropper');
  // 도구별 커서: 채우기·스포이드 = cell(픽셀 지목), 그 외(붓/지우개) = crosshair
  canvas.style.cursor = (name === 'bucket' || name === 'eyedropper') ? 'cell' : 'crosshair';
}
document.getElementById('tool-brush-btn').addEventListener('click', () => setTool('brush'));
document.getElementById('tool-bucket-btn').addEventListener('click', () => setTool('bucket'));
const _eyeBtn = document.getElementById('tool-eyedropper-btn');
if (_eyeBtn) _eyeBtn.addEventListener('click', () => setTool('eyedropper'));

/* ── 스포이드: 캔버스 픽셀 → 색 추출 ──────── */
function pickColorAt(x, y) {
  const sx = Math.max(0, Math.min(canvas.width  - 1, Math.floor(x)));
  const sy = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
  const px = ctx.getImageData(sx, sy, 1, 1).data;
  // 알파 0 = 빈 픽셀 → 추출하지 말고 안내만
  if (px[3] === 0) return null;
  const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  return hex;
}

function applyPickedColor(hex) {
  brushColor = hex;
  // 미리 선택된 팔레트 일치하면 그 버튼 highlight, 아니면 모두 해제
  let matched = false;
  document.querySelectorAll('.color-btn').forEach(b => {
    const on = (b.dataset.color || '').toLowerCase() === hex.toLowerCase();
    b.classList.toggle('selected', on);
    if (on) matched = true;
  });
  if (!matched) {
    // RGB 피커 input 도 동기화 (있으면)
    const rgb = document.getElementById('rgb-picker');
    if (rgb) rgb.value = hex;
  }
  // 스포이드 한 번 쓰고 나면 자동으로 붓 모드로 — 바로 그릴 수 있게.
  setTool('brush');
}

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
  if (tools) tools.style.display = (isOwner && !isSpectator) ? 'flex' : 'none';
  try { _ddUpdateOwnerUI(); } catch (_) {}   // 🆕 [L] 낙서판 전체지우기 버튼도 방장만
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
  // 🆕 몬스터 카드 강제 정리 — DM 이 [적 퇴장] 을 빠뜨렸을 때 잔존 카드 청소
  const cb = document.getElementById('clear-monsters-btn');
  if (cb) {
    cb.addEventListener('click', () => {
      if (!ws || !isOwner) return;
      if (!confirm('남아있는 몬스터 카드를 모두 정리할까요? (DM 이 깜빡 잊었을 때 사용)')) return;
      ws.send(JSON.stringify({ type: 'clear_monsters' }));
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
  // V17: 세션/placeholder 타이머 정지 + 재진입 가드 리셋 (재입장 시 재시작되도록).
  if (_sessionTimerInterval) { clearInterval(_sessionTimerInterval); _sessionTimerInterval = null; }
  _sessionStartedAt = 0;
  if (_placeholderRotateTimer) { clearInterval(_placeholderRotateTimer); _placeholderRotateTimer = null; }
  try { if (ws) ws.close(); } catch (_) {}
  clearSession();
  location.href = location.pathname;
}

const leaveBtn = document.getElementById('leave-room-btn');
if (leaveBtn) leaveBtn.addEventListener('click', leaveRoom);

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  // V45-01: pointer 이벤트 통합. e.clientX/Y 가 표준 — touch event 의 .touches 분기 제거.
  // 기존 touchstart 와 호환 유지 — touches 가 있으면 첫 터치 좌표 사용.
  const t = e.touches && e.touches[0];
  const cx = (t ? t.clientX : e.clientX) - r.left;
  const cy = (t ? t.clientY : e.clientY) - r.top;
  return [cx * (canvas.width / r.width), cy * (canvas.height / r.height)];
}

function startDraw(e) {
  e.preventDefault();
  const [x, y] = canvasPos(e);
  // 스포이드는 캔버스를 변형하지 않음 — snapshot 도 패스.
  if (currentTool === 'eyedropper') {
    const picked = pickColorAt(x, y);
    if (picked) applyPickedColor(picked);
    // 빈 픽셀이면 무시 (현재 색 유지)
    return;
  }
  // 스트로크/채우기 시작 전 스냅샷 — Ctrl+Z 로 되돌릴 수 있게
  snapshotCanvas();
  _markDrawDirty();   // V6-05: 자동 저장 / 닫기 confirm 트리거
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

// V45-01: pointer 이벤트 통합 — touch + mouse 동시 발화로 인한 stroke 중복 차단.
// touchAction: 'none' 으로 ghost click + 모바일 스크롤 회피.
// pointer events 미지원 환경(매우 오래된 브라우저)을 위한 mouse/touch fallback 도 유지.
if (window.PointerEvent) {
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', startDraw);
  canvas.addEventListener('pointermove', moveDraw);
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  // V46-06: pointerleave 제거 — 모바일에서 큰 곡선 그리다 가장자리 1px 만 벗어나도 stroke 끊김.
  // 대신 window 의 pointerup 으로 캔버스 밖에서 손 떼도 정상 종료. 그림판 UX 표준.
  window.addEventListener('pointerup', endDraw);
} else {
  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);
}

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
    // 색 선택 = "이제 이 색으로 그리겠다" 의도. 지우개·스포이드 등 다른 도구 활성 상태였으면
    // 자동으로 붓 모드로 복귀 — 이전엔 지우개 켠 채 색만 바뀌어 사용자가 혼란.
    if (currentTool !== 'brush') setTool('brush');
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
    _markDrawDirty();
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
    // 붓 도구로 자동 전환 (RGB 바꾸면 그리고 싶은 의도) — 지우개·스포이드 둘 다 해제.
    if (currentTool !== 'brush') setTool('brush');
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
  // V6-05: 명시적 저장 완료 → autosave 정리, dirty 플래그 해제, confirm 면제.
  _drawSavedClean = true;
  _drawDirty = false;
  _clearDrawAutosave();
  closeDrawModal(true);  // forced — confirm 스킵
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
    // 이어하기 클릭 시에만 실제 rejoin 수행. 공통 connect 경로를 사용해 heartbeat/reconnect/old socket 정리를 일원화.
    connect({
      type: 'rejoin_room',
      room_id: s.room_id,
      player_id: s.player_id,
    });
  };
  document.getElementById('resume-fresh-btn').onclick = () => {
    clearSession();
    banner.remove();
  };
});

/* ── V32-04: 서버 빌드 버전 폴링 + 새로고침 prompt ──
   V31-01 의 /version 엔드포인트 후속. 90초마다 폴링해 SERVER_VERSION 변경 감지 시
   sticky 토스트로 "새로고침 권장" 안내. 자동 reload 는 안 함 — 게임 중일 수 있음. */
let _serverVersion = null;
let _versionPollTimer = null;
let _reloadPromptShown = false;
const _VERSION_POLL_MS = 90 * 1000;
// V49-01: dismiss 시 폴링 영구 중단이 아닌 30분 snooze. 게임 중이라 잠시 미루고 싶은 사용자 의도 보존.
const _RELOAD_PROMPT_SNOOZE_MS = 30 * 60 * 1000;
let _reloadPromptSnoozeTimer = null;

async function _pollServerVersion() {
  try {
    const resp = await fetch('/version', { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    const v = data && data.version;
    if (!v) return;
    if (_serverVersion === null) { _serverVersion = v; return; }
    if (v !== _serverVersion && !_reloadPromptShown) {
      _reloadPromptShown = true;
      _showReloadPrompt();
    }
  } catch (_) { /* 일시적 네트워크 오류 — 다음 틱 재시도 */ }
}

function _showReloadPrompt() {
  const layer = ensureToastLayer();
  const t = document.createElement('div');
  t.className = 'toast toast-reload';
  // sticky: pushToast 의 setTimeout 자동 dismiss 회피하려고 직접 구성.
  const msg = document.createElement('span');
  msg.textContent = '🔄 새 빌드 도착 — 새로고침 권장';
  const btnReload = document.createElement('button');
  btnReload.type = 'button';
  btnReload.className = 'toast-reload-btn';
  btnReload.textContent = '지금 새로고침';
  btnReload.addEventListener('click', () => location.reload());
  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'toast-reload-dismiss';
  btnClose.setAttribute('aria-label', '닫기');
  btnClose.textContent = '✕';
  btnClose.addEventListener('click', () => {
    t.classList.remove('show');
    setTimeout(() => { try { t.remove(); } catch (_) {} }, 200);
    // V49-01: 폴링 유지 + 30분 후 _reloadPromptShown 재오픈 — 게임 중 dismiss 한 사용자가
    // 30분 뒤에도 새 빌드를 인지할 수 있게. 30분 안에 또 다른 빌드가 도착해도 한 토스트만.
    if (_reloadPromptSnoozeTimer) clearTimeout(_reloadPromptSnoozeTimer);
    _reloadPromptSnoozeTimer = setTimeout(() => {
      _reloadPromptShown = false;
      _reloadPromptSnoozeTimer = null;
      // 다음 폴링 틱에서 v !== _serverVersion 비교가 다시 발화. 단 이미 baseline 갱신은 안 됐으므로
      // 다음 _pollServerVersion 호출에서 그대로 재트리거. 즉시 한 번 polling 호출해서 빠른 재안내.
      _pollServerVersion();
    }, _RELOAD_PROMPT_SNOOZE_MS);
  });
  t.appendChild(msg);
  t.appendChild(btnReload);
  t.appendChild(btnClose);
  layer.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
}

function _startVersionPolling() {
  if (_versionPollTimer) return;
  _pollServerVersion();
  _versionPollTimer = setInterval(_pollServerVersion, _VERSION_POLL_MS);
}

window.addEventListener('DOMContentLoaded', _startVersionPolling);

// V50-01: entry 화면 우상단 ? 버튼 → 도움말 모달. 신규 사용자가 ? 단축키 모를 때 진입.
window.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('entry-help-btn');
  if (btn) btn.addEventListener('click', () => { if (typeof _showHelpModal === 'function') _showHelpModal(); });
});

/* ── V33-03: 캐릭터 시트 import ───────────────────────
 * V13-02 export 역방향. export 텍스트를 파싱해 entry-form 의 이름/직업/종족
 * (수인일 경우 동물·비율까지) 자동 채우기. 스탯·장비·인벤은 신규 방에선 시작값으로 초기화.
 * 서버 측 stats import 는 다음 패치에서 (밸런스 검증·schema 검증 필요).
 */
const _IMPORT_CLASSES = ['전사', '마법사', '도적', '성직자'];
const _IMPORT_RACES = ['인간', '엘프', '드워프', '하플링', '오크', '티플링', '드래곤본', '놈', '수인'];
const _IMPORT_ANIMALS = ['늑대', '여우', '호랑이', '고양이', '토끼', '곰'];

function parseImportedSheet(raw) {
  const out = {
    name: null, klass: null, level: null, race: null, animal: null, ratio: null,
    // V44-01: stats / 장비 / 인벤 / xp / gold 도 추출 — 서버 import 2단계 입력으로 사용.
    hp: null, max_hp: null, mp: null, max_mp: null,
    attack: null, defense: null,
    str: null, int: null, wis: null, dex: null, cha: null, con: null,
    xp: null, gold: null,
    equipped: null, inventory: null,
    warnings: [],
  };
  if (!raw || typeof raw !== 'string') {
    out.warnings.push('빈 텍스트입니다.');
    return out;
  }
  const text = raw.replace(/\r\n/g, '\n');
  // 헤더: === 이름 (Lv.5 전사) ===  또는  === 이름 (Lv.5 ?) === 같이 손상돼도 best-effort.
  const head = text.match(/===\s*([^\n=()]+?)\s*\(Lv\.?\s*(\d+)\s+([^)]+)\)\s*===/);
  if (head) {
    out.name = head[1].trim().slice(0, 12);
    const lvNum = parseInt(head[2], 10);
    if (!isNaN(lvNum)) out.level = lvNum;
    const klassRaw = head[3].trim();
    if (_IMPORT_CLASSES.includes(klassRaw)) out.klass = klassRaw;
    else out.warnings.push(`알 수 없는 직업: ${klassRaw}`);
  } else {
    out.warnings.push('헤더(=== 이름 (Lv.X 직업) ===) 를 찾지 못함');
    // best-effort: 첫 줄에서 이름만이라도 추출
    const fallback = text.split('\n')[0].replace(/=/g, '').trim();
    if (fallback && fallback.length <= 24) out.name = fallback.slice(0, 12);
  }
  // 종족: 인간   /   종족: 수인 (늑대) / 동물성 70%   같은 변형 허용.
  // V36-02: 별도 '종족-상세: 늑대 · 동물성 70%' 라인도 인지.
  const raceMatch = text.match(/^종족\s*:\s*([^\n]+)/m);
  const raceDetailMatch = text.match(/^종족-상세\s*:\s*([^\n]+)/m);
  if (raceMatch) {
    const line = raceMatch[1];
    for (const r of _IMPORT_RACES) {
      if (line.includes(r)) { out.race = r; break; }
    }
    if (out.race === '수인') {
      const detailLine = raceDetailMatch ? raceDetailMatch[1] : '';
      const probe = detailLine || line;
      for (const a of _IMPORT_ANIMALS) {
        if (probe.includes(a)) { out.animal = a; break; }
      }
      // 비율 추출: 동물성 N% / 인간성 N% / "고양이·인간형·25%" 같은 bare N% 모두 인지.
      const r1 = probe.match(/동물성\s*(\d{1,3})%/);
      const r2 = probe.match(/인간성\s*(\d{1,3})%/);
      const r3 = probe.match(/(\d{1,3})\s*%/);
      if (r1) {
        const n = parseInt(r1[1], 10);
        if (!isNaN(n)) out.ratio = Math.max(10, Math.min(90, n));
      } else if (r2) {
        const n = parseInt(r2[1], 10);
        if (!isNaN(n)) out.ratio = Math.max(10, Math.min(90, 100 - n));
      } else if (r3) {
        const n = parseInt(r3[1], 10);
        if (!isNaN(n)) out.ratio = Math.max(10, Math.min(90, n));
      }
      if (!out.animal) out.warnings.push('수인 동물 종류를 찾지 못함 (기본 늑대)');
    }
  } else {
    out.warnings.push('종족 정보 미발견');
  }
  // V44-01: HP / MP / 공격 / 방어 / 능력치 / XP / 골드 / 장비 / 인벤 추출.
  const hpM = text.match(/^HP\s*:\s*(\d+)\s*\/\s*(\d+)\s+MP\s*:\s*(\d+)\s*\/\s*(\d+)/m);
  if (hpM) {
    out.hp = parseInt(hpM[1], 10);
    out.max_hp = parseInt(hpM[2], 10);
    out.mp = parseInt(hpM[3], 10);
    out.max_mp = parseInt(hpM[4], 10);
  }
  const adM = text.match(/^공격\s*:\s*(\d+)\s+방어\s*:\s*(\d+)/m);
  if (adM) {
    out.attack = parseInt(adM[1], 10);
    out.defense = parseInt(adM[2], 10);
  }
  const stM = text.match(/^STR\s+(\d+)\s+INT\s+(\d+)\s+WIS\s+(\d+)\s+DEX\s+(\d+)\s+CHA\s+(\d+)\s+CON\s+(\d+)/m);
  if (stM) {
    out.str = parseInt(stM[1], 10);
    out.int = parseInt(stM[2], 10);
    out.wis = parseInt(stM[3], 10);
    out.dex = parseInt(stM[4], 10);
    out.cha = parseInt(stM[5], 10);
    out.con = parseInt(stM[6], 10);
  }
  const xpM = text.match(/^XP\s*:\s*(\d+)/m);
  if (xpM) out.xp = parseInt(xpM[1], 10);
  const goldM = text.match(/^💰\s*(\d+)\s*G/m);
  if (goldM) out.gold = parseInt(goldM[1], 10);
  // 장착: 왼손: 녹슨 장검 | 오른손: 낡은 방패 | 방어구: 가죽 흉갑
  // 슬롯 한국어 → 영문 키 매핑.
  const SLOT_MAP = { '왼손': 'main_hand', '오른손': 'off_hand', '무기': 'main_hand', '방어구': 'armor', '장신구': 'accessory' };
  const eqM = text.match(/^장착\s*:\s*([^\n]+)/m);
  if (eqM) {
    const eq = {};
    eqM[1].split('|').forEach(part => {
      const m = part.trim().match(/^([^:]+?)\s*:\s*(.+)$/);
      if (!m) return;
      const slot = SLOT_MAP[m[1].trim()];
      const name = m[2].trim().slice(0, 40);
      if (slot && name) eq[slot] = { name, effect: '' };  // effect 는 export 에 누락 — 빈값
    });
    if (Object.keys(eq).length) out.equipped = eq;
  }
  // 소지품 (3): 회복약×2, 마나포션, 두루마리
  const invM = text.match(/^소지품\s*\([^)]*\)\s*:\s*([^\n]+)/m);
  if (invM) {
    const items = [];
    invM[1].split(',').forEach(part => {
      const t = part.trim();
      if (!t) return;
      const qm = t.match(/^(.+?)\s*[×x]\s*(\d+)$/);
      if (qm) {
        items.push({ name: qm[1].trim().slice(0, 40), quantity: Math.max(1, Math.min(99, parseInt(qm[2], 10))), effect: '' });
      } else {
        items.push({ name: t.slice(0, 40), quantity: 1, effect: '' });
      }
    });
    if (items.length) out.inventory = items.slice(0, 30);  // 30개 cap
  }
  return out;
}

function _renderImportPreview(parsed) {
  const box = document.getElementById('import-sheet-preview');
  if (!box) return;
  if (!parsed.name && !parsed.klass && !parsed.race) {
    box.style.display = 'none';
    return;
  }
  const rows = [];
  const row = (k, v) => `<div class="ips-row"><span class="ips-key">${k}</span><span class="ips-val">${escapeHtml(v)}</span></div>`;
  if (parsed.name)  rows.push(row('이름', parsed.name + (parsed.level ? ` (이전 Lv.${parsed.level})` : '')));
  if (parsed.klass) rows.push(row('직업', parsed.klass));
  if (parsed.race) {
    let raceDisp = parsed.race;
    if (parsed.race === '수인') {
      raceDisp += parsed.animal ? ` (${parsed.animal})` : ' (동물 미지정 → 늑대)';
      if (parsed.ratio != null) raceDisp += ` · 동물성 ${parsed.ratio}%`;
    }
    rows.push(row('종족', raceDisp));
  }
  let html = rows.join('');
  if (parsed.warnings.length) {
    html += `<div class="ips-warn">⚠ ${parsed.warnings.map(escapeHtml).join(' · ')}</div>`;
  }
  html += `<div class="ips-warn">ℹ 신규 방에서는 Lv.1 시작값으로 새로 출발합니다 (스탯/장비/인벤 초기화).</div>`;
  box.innerHTML = html;
  box.style.display = 'block';
}

function _applyImportedSheetToForm(parsed) {
  if (parsed.name) {
    const nm = document.getElementById('player-name');
    if (nm) nm.value = parsed.name;
  }
  if (parsed.klass) {
    document.querySelectorAll('.class-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.class === parsed.klass);
    });
    // class 선택 후 weapon-grid 갱신 코드는 click 이벤트에 의존 → 직접 click 시뮬레이션이 안전.
    const card = document.querySelector(`.class-card[data-class="${parsed.klass}"]`);
    if (card) card.click();
  }
  if (parsed.race) {
    const toggle = document.getElementById('race-manual-toggle');
    if (toggle && !toggle.checked) toggle.click();  // race-grid 노출
    selectedRace = parsed.race;
    document.querySelectorAll('.race-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.race === parsed.race);
    });
    const rcard = document.querySelector(`.race-card[data-race="${parsed.race}"]`);
    if (rcard) rcard.click();
    if (parsed.race === '수인') {
      const animal = parsed.animal || '늑대';
      selectedAnimal = animal;
      document.querySelectorAll('.beastfolk-animal').forEach(c => {
        c.classList.toggle('selected', c.dataset.animal === animal);
      });
      const acard = document.querySelector(`.beastfolk-animal[data-animal="${animal}"]`);
      if (acard) acard.click();
      if (parsed.ratio != null) {
        selectedRatio = Math.max(BEASTFOLK_RATIO_MIN, Math.min(BEASTFOLK_RATIO_MAX, parseInt(parsed.ratio, 10)));
        const slider = document.getElementById('beastfolk-ratio-slider');
        if (slider) {
          slider.value = String(selectedRatio);
          slider.dispatchEvent(new Event('input'));
        }
      }
    }
  }
}

/* ── V41-01: ARIA focus trap 헬퍼 일반화 ───────────────────────
 * import-sheet 모달 전용으로 작성됐던 trap 로직을 일반 헬퍼로 분리.
 * 모든 모달이 동일한 패턴 (open: focus 첫 요소 + 이전 focus 보존, close: 복귀,
 * Tab cycle: first<->last) 으로 동작하게 한다.
 *
 * 사용:
 *   const ctl = bindModalA11y(modalEl, { initialFocusSelector: 'textarea' });
 *   ctl.open(); ctl.close();
 */
function bindModalA11y(modal, opts = {}) {
  if (!modal) return { open() {}, close() {} };
  const closeSelectors = opts.closeSelectors || ['[data-close]', '.modal-close', '.modal-backdrop'];
  let _prevFocus = null;
  let _trapBound = false;

  function _focusables() {
    const list = modal.querySelectorAll(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(list).filter(el => !el.disabled && el.offsetParent !== null);
  }
  function _onKey(e) {
    if (modal.style.display === 'none') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const list = _focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  }
  function open() {
    _prevFocus = document.activeElement;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    if (!_trapBound) { document.addEventListener('keydown', _onKey); _trapBound = true; }
    setTimeout(() => {
      const initial = opts.initialFocusSelector
        ? modal.querySelector(opts.initialFocusSelector)
        : _focusables()[0];
      try { initial && initial.focus(); } catch (_) {}
    }, 50);
  }
  function close() {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (_trapBound) { document.removeEventListener('keydown', _onKey); _trapBound = false; }
    try { if (_prevFocus && typeof _prevFocus.focus === 'function') _prevFocus.focus(); } catch (_) {}
  }
  // 백드롭/닫기 버튼 자동 바인드 (이미 바인드돼있으면 내부 close 도 호출되도록 추가만).
  closeSelectors.forEach(sel => {
    modal.querySelectorAll(sel).forEach(el =>
      el.addEventListener('click', () => close())
    );
  });
  return { open, close };
}

function _initImportSheetUI() {
  const openBtn = document.getElementById('import-sheet-btn');
  const modal = document.getElementById('import-sheet-modal');
  const analyzeBtn = document.getElementById('import-sheet-analyze');
  const applyBtn = document.getElementById('import-sheet-apply');
  const ta = document.getElementById('import-sheet-text');
  if (!openBtn || !modal) return;
  let lastParsed = null;
  // V41-01: 일반화된 헬퍼 사용. data-import-close 도 포함.
  const ctl = bindModalA11y(modal, {
    initialFocusSelector: '#import-sheet-text',
    closeSelectors: ['[data-import-close]'],
  });
  openBtn.addEventListener('click', () => ctl.open());
  analyzeBtn && analyzeBtn.addEventListener('click', () => {
    const parsed = parseImportedSheet(ta ? ta.value : '');
    lastParsed = parsed;
    _renderImportPreview(parsed);
    const ok = !!(parsed.name || parsed.klass || parsed.race);
    if (applyBtn) applyBtn.disabled = !ok;
    if (!ok) sysToast('파싱 실패 — 시트 텍스트를 다시 확인하세요', 'toast-error', '⚠');
  });
  applyBtn && applyBtn.addEventListener('click', () => {
    if (!lastParsed) return;
    _applyImportedSheetToForm(lastParsed);
    // V44-02: stats/level/장비/인벤도 보관 — create_room 시 서버에 동봉.
    _pendingImportedSheet = _toServerImportedSheet(lastParsed);
    ctl.close();
    const note = _pendingImportedSheet
      ? '시트 정보를 폼에 채웠고 스탯/장비/인벤도 새 방에 적용됩니다 (Lv 5 cap)'
      : '시트 이름·직업·종족을 폼에 채웠습니다';
    sysToast(note, 'toast-item-mine', '📥');
  });
}

// V44-02: 클라 parsed → 서버 imported_sheet (서버가 검증·cap 적용 전 raw 데이터).
// 최소한 stats/level/equipped/inventory 중 하나라도 있어야 서버에 보낼 가치 있음.
function _toServerImportedSheet(parsed) {
  if (!parsed) return null;
  const hasIdentity = parsed.race != null || parsed.animal != null || parsed.ratio != null;
  const hasStats = parsed.level != null || parsed.hp != null || parsed.str != null;
  const hasGear = parsed.equipped || parsed.inventory;
  if (!hasIdentity && !hasStats && !hasGear) return null;
  // 서버가 인지할 raw payload — 검증 + max_import_level cap 은 서버 측에서.
  return {
    race: parsed.race, race_animal: parsed.animal, race_ratio: parsed.ratio,
    level: parsed.level, xp: parsed.xp, gold: parsed.gold,
    hp: parsed.hp, max_hp: parsed.max_hp, mp: parsed.mp, max_mp: parsed.max_mp,
    attack: parsed.attack, defense: parsed.defense,
    strength: parsed.str, intelligence: parsed.int, wisdom: parsed.wis,
    dexterity: parsed.dex, charisma: parsed.cha, constitution: parsed.con,
    equipped: parsed.equipped, inventory: parsed.inventory,
  };
}
window.addEventListener('DOMContentLoaded', _initImportSheetUI);

/* ── V43-01: 신규 방문자 onboarding 배너 ───────────────────────
 * 첫 방문 (localStorage flag 없음) 시 entry 화면에 짧은 3-step 안내. 닫으면 영구 dismiss.
 * 사용자가 한 번 게임 만들거나 들어가면 자동으로 dismissed 처리 (anyway 베테랑 됨).
 */
const _ONBOARDING_KEY = 'trog_onboarding_seen_v1';
function _initOnboardingBanner() {
  const banner = document.getElementById('onboarding-banner');
  const dismiss = document.getElementById('onboarding-dismiss');
  if (!banner) return;
  let seen = false;
  try { seen = localStorage.getItem(_ONBOARDING_KEY) === '1'; } catch (_) {}
  if (seen) return;
  banner.style.display = 'block';
  const markSeen = () => {
    banner.style.display = 'none';
    try { localStorage.setItem(_ONBOARDING_KEY, '1'); } catch (_) {}
  };
  dismiss && dismiss.addEventListener('click', markSeen);
  // 방 만들기 / 입장 / 관전 버튼 누르면 자동 dismiss (이미 사용 중이라 안내 불필요).
  ['create-room-btn', 'join-room-btn', 'spectate-btn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', markSeen, { once: true });
  });
}
window.addEventListener('DOMContentLoaded', _initOnboardingBanner);

// V43-02 + V46-02: 첫 게임 진입 시 한 번만 가이드 토스트.
// V46-02: 즉시 발화 시 DM 인트로/monster spawn 토스트와 stack 폭주 → 첫 dm_response 도달 후
// idle 1.5s 시점부터 시작. 토스트 3개 사이 간격도 5s 로 늘림 (이전 4s/3s).
const _FIRST_GAME_TIPS_KEY = 'trog_first_game_tips_seen_v1';
let _firstGameTipsArmed = false;
function _armFirstGameTips() {
  let seen = false;
  try { seen = localStorage.getItem(_FIRST_GAME_TIPS_KEY) === '1'; } catch (_) {}
  if (seen) { _firstGameTipsArmed = false; return; }
  _firstGameTipsArmed = true;  // dm_response 핸들러가 _fireFirstGameTipsAfterIntro 호출
}
function _fireFirstGameTipsAfterIntro() {
  if (!_firstGameTipsArmed) return;
  _firstGameTipsArmed = false;
  try { localStorage.setItem(_FIRST_GAME_TIPS_KEY, '1'); } catch (_) {}
  // 인트로 도착 후 1.5s 부터 발화 — 인트로 텍스트 + monster spawn 토스트 가라앉을 시간.
  setTimeout(() => {
    sysToast('💬 입력칸에 자유롭게 행동을 써보세요. 예: "검을 뽑아 주변을 살핀다"', 'toast-item', '');
  }, 1500);
  setTimeout(() => {
    sysToast('🎲 아래 주사위 / 빠른 액션 버튼으로도 행동 가능', 'toast-item', '');
  }, 6500);
  setTimeout(() => {
    sysToast('❓ ? 키 누르면 단축키 / 명령어 도움말', 'toast-item', '');
  }, 11500);
}

// V39-01 후속: TPK 모달의 "관전자 모드로 보기" 가 sessionStorage 에 방코드 적재 후 reload.
// 다음 로드 시 해당 코드를 spectate-code 입력 칸에 자동 채워 사용자 클릭만으로 진입.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const code = sessionStorage.getItem('trog_pending_spectate');
    if (code) {
      const inp = document.getElementById('spectate-code');
      if (inp) {
        inp.value = code;
        inp.focus();
      }
      sessionStorage.removeItem('trog_pending_spectate');
      sysToast('이전 방을 관전자 모드로 다시 들어가려면 [관전] 클릭', 'toast-item', '👁');
    }
  } catch (_) {}
});

/* ══════════════════════════════════════════════════
   [L] 공동 낙서판 — 기다리는 시간에 다 같이 그림.
   LLM 무관 순수 소셜. 좌표는 0..1 정규화라 리사이즈에도 재현 가능.
   ════════════════════════════════════════════════ */
let _ddCanvas = null, _ddCtx = null;
let _ddStrokes = [];              // 정규화 좌표 획 [{pid,color,w,pts:[[x,y]..]}]
let _ddColor = '#111111', _ddW = 3;
let _ddDrawing = false, _ddCur = null, _ddOpen = false, _ddDmPending = false;
const _DD_REF = 640;             // 굵기 픽셀 스케일 기준 폭 (캔버스가 커지면 선도 비례)

function _ddClampPos(e) {
  const r = _ddCanvas.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width;
  let y = (e.clientY - r.top) / r.height;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}
function _ddDrawStroke(s) {
  if (!_ddCtx || !s || !Array.isArray(s.pts) || !s.pts.length) return;
  const w = _ddCanvas.clientWidth, h = _ddCanvas.clientHeight;
  _ddCtx.lineJoin = _ddCtx.lineCap = 'round';
  _ddCtx.strokeStyle = s.color;
  _ddCtx.lineWidth = Math.max(1, s.w * w / _DD_REF);
  _ddCtx.beginPath();
  _ddCtx.moveTo(s.pts[0][0] * w, s.pts[0][1] * h);
  for (let i = 1; i < s.pts.length; i++) _ddCtx.lineTo(s.pts[i][0] * w, s.pts[i][1] * h);
  if (s.pts.length === 1) _ddCtx.lineTo(s.pts[0][0] * w + 0.01, s.pts[0][1] * h);  // 점 하나
  _ddCtx.stroke();
}
function _ddRenderAll() {
  if (!_ddCtx) return;
  _ddCtx.clearRect(0, 0, _ddCanvas.clientWidth, _ddCanvas.clientHeight);
  for (const s of _ddStrokes) _ddDrawStroke(s);
}
function _ddResize() {
  if (!_ddCanvas) return;
  const stage = _ddCanvas.parentElement;
  const availW = stage.clientWidth, availH = stage.clientHeight;
  if (availW < 2 || availH < 2) return;
  const ratio = 16 / 10;
  let w = availW, h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }
  const dpr = window.devicePixelRatio || 1;
  _ddCanvas.style.width = w + 'px';
  _ddCanvas.style.height = h + 'px';
  _ddCanvas.width = Math.round(w * dpr);
  _ddCanvas.height = Math.round(h * dpr);
  _ddCtx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 이후 모든 좌표는 CSS 픽셀 기준
  _ddRenderAll();
}
function _ddDownsample(pts, max) {
  if (pts.length <= max) return pts;
  const out = [], step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}
function _ddTrim() {   // 서버 캡과 동일 — 재렌더 비용 상한 유지
  while (_ddStrokes.length > 1200) _ddStrokes.shift();
  let total = _ddStrokes.reduce((a, s) => a + s.pts.length, 0);
  while (total > 30000 && _ddStrokes.length) total -= _ddStrokes.shift().pts.length;
}
function _ddDown(e) {
  if (!_ddOpen) return;
  e.preventDefault();
  _ddDrawing = true;
  const p = _ddClampPos(e);
  _ddCur = { pid: myId, color: _ddColor, w: _ddW, pts: [p] };
  _ddDrawStroke(_ddCur);  // 점 하나 즉시
}
function _ddMove(e) {
  if (!_ddDrawing || !_ddCur) return;
  e.preventDefault();
  const p = _ddClampPos(e);
  const pts = _ddCur.pts, last = pts[pts.length - 1];
  const w = _ddCanvas.clientWidth, h = _ddCanvas.clientHeight;
  _ddCtx.lineJoin = _ddCtx.lineCap = 'round';
  _ddCtx.strokeStyle = _ddCur.color;
  _ddCtx.lineWidth = Math.max(1, _ddCur.w * w / _DD_REF);
  _ddCtx.beginPath();
  _ddCtx.moveTo(last[0] * w, last[1] * h);
  _ddCtx.lineTo(p[0] * w, p[1] * h);
  _ddCtx.stroke();
  pts.push(p);
}
function _ddUp() {
  if (!_ddDrawing) return;
  _ddDrawing = false;
  const cur = _ddCur; _ddCur = null;
  if (!cur || !cur.pts.length) return;
  if (cur.pts.length === 1) cur.pts.push(cur.pts[0].slice());   // 최소 2점(서버 검증)
  let pts = cur.pts.length > 60 ? _ddDownsample(cur.pts, 60) : cur.pts;
  pts = pts.map(p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
  const stroke = { pid: myId, color: cur.color, w: cur.w, pts };
  _ddStrokes.push(stroke); _ddTrim();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'doodle_stroke', color: cur.color, w: cur.w, pts }));
  }
}
// ── 수신 핸들러 (dispatch 에서 호출) ──
function _doodleApplyStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.pts)) return;
  _ddStrokes.push(stroke); _ddTrim();
  if (_ddOpen) _ddDrawStroke(stroke);
}
function _doodleSetState(strokes) {
  _ddStrokes = Array.isArray(strokes) ? strokes.slice() : [];
  _ddTrim();
  if (_ddOpen) _ddRenderAll();
}
function _doodleHandleClear() {
  _ddStrokes = [];
  if (_ddCtx && _ddCanvas) _ddCtx.clearRect(0, 0, _ddCanvas.clientWidth, _ddCanvas.clientHeight);
}
// ── 펄스 강조 + 내 턴 배너 ──
function refreshDoodlePulse() {
  const btn = document.getElementById('doodle-btn');
  if (!btn) return;
  const notMyTurn = !!(currentTurnPlayerId && currentTurnPlayerId !== myId);
  btn.classList.toggle('pulse', (notMyTurn || _ddDmPending) && !_ddOpen);
}
function _ddUpdateTurnBanner() {
  const b = document.getElementById('doodle-turn-banner');
  if (!b) return;
  const myTurn = !!myId && currentTurnPlayerId === myId && !isSpectator;
  b.style.display = (_ddOpen && myTurn) ? 'block' : 'none';
}
function _ddUpdateOwnerUI() {
  const c = document.getElementById('doodle-clear-btn');
  if (c) c.style.display = (isOwner && !isSpectator) ? 'inline-block' : 'none';
}
function _doodleOpen() {
  const ov = document.getElementById('doodle-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  _ddOpen = true;
  _ddUpdateOwnerUI();
  _ddUpdateTurnBanner();
  refreshDoodlePulse();
  requestAnimationFrame(_ddResize);
}
function _doodleClose() {
  const ov = document.getElementById('doodle-overlay');
  if (ov) ov.style.display = 'none';
  _ddOpen = false;
  refreshDoodlePulse();
}
(function _ddInit() {
  _ddCanvas = document.getElementById('doodle-canvas');
  if (!_ddCanvas) return;
  _ddCtx = _ddCanvas.getContext('2d');
  const btn = document.getElementById('doodle-btn');
  if (btn) btn.addEventListener('click', () => (_ddOpen ? _doodleClose() : _doodleOpen()));
  const closeBtn = document.getElementById('doodle-close');
  if (closeBtn) closeBtn.addEventListener('click', _doodleClose);
  const ov = document.getElementById('doodle-overlay');
  if (ov) ov.addEventListener('pointerdown', (e) => { if (e.target === ov) _doodleClose(); });
  document.querySelectorAll('#doodle-colors .dd-color').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#doodle-colors .dd-color').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      _ddColor = b.dataset.color;
    });
  });
  document.querySelectorAll('#doodle-widths .dd-width').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#doodle-widths .dd-width').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      _ddW = parseInt(b.dataset.w, 10);
    });
  });
  const clearBtn = document.getElementById('doodle-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!isOwner || isSpectator) return;
    if (!confirm('낙서판을 전체 지웁니다. (모두에게 적용)')) return;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'doodle_clear' }));
  });
  // 캔버스 그리기 — pointer 이벤트(터치+마우스 통합). 캔버스 밖에서 손 떼도 종료.
  _ddCanvas.addEventListener('pointerdown', _ddDown);
  _ddCanvas.addEventListener('pointermove', _ddMove);
  _ddCanvas.addEventListener('pointerup', _ddUp);
  _ddCanvas.addEventListener('pointercancel', _ddUp);
  window.addEventListener('pointerup', _ddUp);
  window.addEventListener('resize', () => { if (_ddOpen) _ddResize(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _ddOpen) _doodleClose(); });
})();
