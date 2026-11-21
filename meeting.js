/* Meeting workflow. The browser keeps the current meeting, archived materials and visitor directory. */
const MEETING_ITEMS = [
  ['handbook', '会议手册'],
  ['roster', '会议名单'],
  ['notice', '会议通知'],
  ['seat_plan', '会议座位图'],
  ['table_tents', '桌签'],
  ['dining_plan', '就餐餐桌图'],
];
const MATERIAL_TITLES = Object.fromEntries(MEETING_ITEMS);
const VISITOR_KEY = 'zongzhi.visitors.v1';
const MATERIAL_LIBRARY_KEY = 'zongzhi.meeting-material-library.v1';
let productionRun = null;
let currentMaterialTab = '';
let editingMeetingMaterial = '';
let editingIntakeStep = null;
let meetingFeedback = '';

function meetingEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function meetingArray(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeMeetingLibrary(key, entries) {
  try {
    localStorage.setItem(key, JSON.stringify(entries));
    return true;
  } catch (_) {
    meetingFeedback = '浏览器存储空间不足，本次入库未完成。请保留已生成的材料。';
    return false;
  }
}

function getMeetingRecord() {
  if (active?.assistant !== 'meeting') return null;
  const r = active.meetingRecord ??= {
    facts: {...active.meetingFacts}, participants: [], meal: {required: null, special_diet: ''},
  };
  if (!r.production) {
    for (const [key, content] of Object.entries(r.materials || {})) {
      if (MATERIAL_TITLES[key] && content) archiveMeetingMaterial(r, key, content);
    }
    r.materials = {};
    r.production = {started: false, asked: false, tentAsked: false, notes: {}, references: {}};
  }
  return r;
}

function persistMeetingRecord(r) {
  active.meetingFacts = {...r.facts};
  active.meetingName = r.facts.topic || '';
  const visitors = meetingArray(VISITOR_KEY);
  let changed = false;
  for (const person of r.participants) {
    if (person.type !== 'visitor' || !person.company || !person.name || !person.title) continue;
    const key = (person.company + '|' + person.name).toLowerCase().replace(/\s/g, '');
    const existing = visitors.findIndex(visitor => visitor.key === key);
    const previous = visitors[existing];
    const entry = {
      ...previous, ...person, key,
      meetings: [...new Set([...(previous?.meetings || []), active.id])],
      updatedAt: new Date().toISOString(),
    };
    if (existing >= 0) visitors.splice(existing, 1);
    visitors.unshift(entry);
    changed = true;
  }
  if (changed) writeMeetingLibrary(VISITOR_KEY, visitors);
  $('workspaceSubtitle').textContent = active.meetingName ? '当前会议 · ' + active.meetingName : assistants.meeting.tagline;
  saveHistory();
}

function archiveMeetingMaterial(r, key, content) {
  const library = meetingArray(MATERIAL_LIBRARY_KEY);
  const existing = library.findIndex(item => item.meetingId === active.id && item.type === key);
  const previous = library[existing];
  const entry = {
    meetingId: active.id,
    meetingName: r.facts?.topic || active.meetingName || '待命名会议',
    type: key,
    title: MATERIAL_TITLES[key],
    updatedAt: new Date().toISOString(),
    versions: [...(previous?.versions || [])],
  };
  if (entry.versions.at(-1)?.content === content) return;
  entry.versions.push({content, updatedAt: entry.updatedAt});
  if (existing >= 0) library.splice(existing, 1);
  library.unshift(entry);
  writeMeetingLibrary(MATERIAL_LIBRARY_KEY, library);
}

function meetingIntake(r) {
  const f = r.facts;
  const info = [['日期', f.date], ['时间', f.time], ['会议室', f.location], ['主题', f.topic]];
  const peopleMissing = r.participants.some(p => !p.name || !['sei', 'visitor'].includes(p.type)
    || (p.type === 'visitor' && (!p.company || !p.title)));
  const count = String(f.attendee_count ?? '').trim();
  const countMismatch = /^\d+$/.test(count) && Number(count) !== r.participants.length;
  return [
    {
      title: '会议基本信息', requirement: '获得会议日期、时间、会议室和会议主题。',
      missing: info.filter(([, value]) => !value).map(([label]) => label),
    },
    {
      title: '参会人信息', requirement: '主办方（SEI）记录姓名，外部参会方记录公司、姓名和职务。',
      missing: [
        ...(!r.participants.length || peopleMissing ? ['完整参会名单'] : []),
        ...(countMismatch ? [`已登记 ${r.participants.length} 人，需与 ${count} 人的总数核对`] : []),
      ],
    },
    {
      title: '用餐安排', requirement: '确认是否用餐。如需用餐，记录清真、忌口等要求，或明确无特殊要求。',
      missing: typeof r.meal.required !== 'boolean' ? ['是否用餐']
        : r.meal.required && !r.meal.special_diet ? ['特殊餐饮需求'] : [],
    },
  ];
}

function meetingReady(r) {
  return meetingIntake(r).every(step => step.missing.length === 0);
}

function meetingNextMaterial(r) {
  return MEETING_ITEMS.find(([key]) => (key !== 'dining_plan' || r.meal.required === true) && !r.materials[key])?.[0];
}

function resetMeetingSessions() {
  pauseMeetingRun();
  currentMaterialTab = '';
  editingMeetingMaterial = '';
  editingIntakeStep = null;
  meetingFeedback = '';
}

function pauseMeetingRun() {
  if (!productionRun) return false;
  productionRun.controller.abort();
  productionRun = null;
  return true;
}

function changedMeetingFacts(r, prior) {
  const snapshot = JSON.stringify([r.facts, r.participants, r.meal]);
  if (snapshot === prior) return false;
  if (Object.keys(r.materials).length) {
    // Prior versions remain in the library. Generations based on superseded intake are no longer current.
    r.materials = {};
    r.production.started = false;
    r.production.needsResume = true;
    currentMaterialTab = '';
    editingMeetingMaterial = '';
  }
  if (!meetingReady(r)) r.production.asked = false;
  return true;
}

function askMeetingStart(r) {
  if (!meetingReady(r) || r.production.started || r.production.asked) return;
  r.production.asked = true;
  makeMessage('三项会议信息都已收集齐全。请问现在开始制作会议材料吗？', 'assistant');
}

function meetingPhase(r) {
  if (!meetingReady(r)) return '收集资料';
  if (!r.production.started) return r.production.asked ? '等待确认开始' : '资料已齐';
  if (!meetingNextMaterial(r)) return '全部完成';
  if (productionRun) return '正在制作';
  if (meetingNextMaterial(r) === 'table_tents' && r.production.tentAsked && !r.tentLanguage) return '等待确认桌签语言';
  return '已暂停，等待确认继续';
}

async function runMeetingProduction() {
  const r = getMeetingRecord();
  if (!r || productionRun || busy || editingMeetingMaterial || !meetingReady(r)) return;
  if (!meetingNextMaterial(r)) return;
  r.production.started = true;
  r.production.needsResume = false;
  persistMeetingRecord(r);
  const run = {session: active, controller: new AbortController(), key: ''};
  productionRun = run;
  try {
    let key;
    while ((key = meetingNextMaterial(r))) {
      if (key === 'table_tents' && !r.tentLanguage) {
        r.production.tentAsked = true;
        persistMeetingRecord(r);
        makeMessage('前面的材料已为您整理好。请问桌签只需要中文，还是需要中英文两套？', 'assistant');
        return;
      }
      run.key = key;
      renderMeetingWorkflow();
      const response = await request('/api/meeting/material', {
        key, profile: r, materials: r.materials, instructions: r.production.notes[key] || '',
        reference: r.production.references[key] || '',
      }, {signal: run.controller.signal});
      if (productionRun !== run || active !== run.session) return;
      if (response.key !== key || !response.content) throw new Error('材料生成结果为空');
      r.materials[key] = response.content;
      archiveMeetingMaterial(r, key, response.content);
      persistMeetingRecord(r);
      currentMaterialTab = key;
      renderMeetingWorkflow();
    }
    makeMessage('本场会议所需材料已全部制作完成，并为您保存入库。您可在右侧逐份审阅和修改，也可以打包下载 PDF 或 Word。', 'assistant');
  } catch (error) {
    if (productionRun !== run || active !== run.session || error.name === 'AbortError') return;
    makeMessage(`${MATERIAL_TITLES[run.key]}暂未生成：${error.message}。已完成的材料已保留，您可以继续重试。`, 'assistant');
  } finally {
    if (productionRun === run) {
      productionRun = null;
      renderMeetingWorkflow();
    }
  }
}

async function recoverSavedMeetingBasics(session) {
  const record = getMeetingRecord();
  if (!record || record.basicsRecovered || !meetingIntake(record)[0].missing.length) return;
  const messages = session.messages.filter(message => message.role === 'user');
  if (!messages.length) return;
  try {
    const {facts} = await request('/api/meeting/recover-basics', {messages});
    if (active !== session) return;
    for (const key of ['topic', 'date', 'time', 'location']) {
      if (!record.facts[key] && facts?.[key]) record.facts[key] = facts[key];
    }
    record.basicsRecovered = true;
    persistMeetingRecord(record);
    if (active === session) {
      askMeetingStart(record);
      renderMeetingWorkflow();
    }
  } catch (_) {
    // A temporary failure leaves recovery available when the meeting is reopened.
  }
}

function applyMeetingPatch(r, patch) {
  if (!patch) return false;
  let changed = false;
  for (const [field, value] of Object.entries(patch.facts || {})) {
    const normalized = field === 'attendee_count' ? String(value) : value;
    if (r.facts[field] !== normalized) {
      r.facts[field] = normalized;
      changed = true;
    }
  }
  if (Array.isArray(patch.participants) && JSON.stringify(r.participants) !== JSON.stringify(patch.participants)) {
    const identity = person => [person.type, person.company || '', person.name, person.title || '', person.english_name || ''];
    if (JSON.stringify(r.participants.map(identity)) !== JSON.stringify(patch.participants.map(identity))) changed = true;
    r.participants = patch.participants;
  }
  if (patch.meal) {
    const meal = {...r.meal};
    if (typeof patch.meal.required === 'boolean') meal.required = patch.meal.required;
    if (patch.meal.special_diet) meal.special_diet = patch.meal.special_diet;
    if (meal.required === false) meal.special_diet = '';
    if (JSON.stringify(meal) !== JSON.stringify(r.meal)) {
      r.meal = meal;
      changed = true;
    }
  }
  return changed;
}

async function reviseMeetingMaterial(r, revision) {
  const key = revision.key;
  if (!MATERIAL_TITLES[key]) return false;
  const instructions = revision.instruction;
  r.production.notes[key] = [r.production.notes[key], instructions].filter(Boolean).join('\n').slice(-2400);
  persistMeetingRecord(r);
  if (!r.materials[key]) {
    makeMessage(`已记下对${MATERIAL_TITLES[key]}的修改要求，继续制作时会按这个要求处理。`, 'assistant');
    return true;
  }
  const session = active;
  const pending = makeMessage(`正在修改${MATERIAL_TITLES[key]}…`, 'pending', false);
  try {
    const out = await request('/api/meeting/material', {
      key, revision: true, profile: r, materials: r.materials, instructions,
    });
    if (active !== session) return false;
    r.materials[key] = out.content;
    currentMaterialTab = key;
    archiveMeetingMaterial(r, key, out.content);
    persistMeetingRecord(r);
    makeMessage(`${MATERIAL_TITLES[key]}已修改并入库，请您审阅。`, 'assistant');
    return true;
  } finally {
    pending.remove();
  }
}

async function sendMeetingMessage(text, options = {}) {
  if (busy || editingMeetingMaterial) return;
  let session = active;
  let r = getMeetingRecord();
  const runningKey = productionRun?.key || '';
  const wasRunning = pauseMeetingRun();
  const priorPhase = meetingPhase(r);
  busy = true;
  $('chatSend').disabled = true;
  let resume = false;
  try {
    if (!options.skipMatch && !r.production.asked && !session.messages.some(m => m.role === 'user')) {
      const match = await findPreviousMeeting(text);
      if (active !== session) return;
      if (match?.conversation && match.conversation.id !== session.id) {
        startSession('meeting', '', match.conversation, {homeHandoff: session.homeHandoff});
        session = active;
        r = getMeetingRecord();
      } else if (match?.clarify) {
        pendingMeetingRequest = text;
        makeMessage('我查到几条可能相关的会议。请从左侧选择已有会议，或点击“新建会议”继续。', 'assistant', false);
        return;
      }
    }
    makeMessage(text, 'user');
    if (wasRunning) makeMessage('已暂停制作，我先处理您刚补充的意见。', 'assistant');
    renderMeetingWorkflow();
    const pending = makeMessage('正在为您整理…', 'pending', false);
    let out;
    try {
      out = await request('/api/ai/chat', {
        assistant: 'meeting', messages: session.messages.slice(-30), shared_memory: readSharedMemory(),
        home_handoff: session.homeHandoff || '',
        meeting_memory: {
          profile: r, phase: priorPhase, current_material: runningKey || meetingNextMaterial(r),
          materials: r.materials, today: new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'}),
        },
      });
    } finally {
      pending.remove();
    }
    if (active !== session) return;
    mergeSharedMemory(out.shared_memory_patch);
    const before = JSON.stringify([r.facts, r.participants, r.meal]);
    const hadMaterials = Object.keys(r.materials).length > 0;
    const changed = applyMeetingPatch(r, out.meeting);
    const revision = out.meeting?.revision;
    if (changed) {
      changedMeetingFacts(r, before);
      persistMeetingRecord(r);
    }
    makeMessage(out.reply, 'assistant');
    if (revision) await reviseMeetingMaterial(r, revision);
    if (active !== session) return;

    const awaitingLanguage = r.production.tentAsked && meetingNextMaterial(r) === 'table_tents' && !r.tentLanguage;
    if (!wasRunning && !revision && !changed && awaitingLanguage && out.meeting?.tent_language) {
      r.tentLanguage = out.meeting.tent_language;
      persistMeetingRecord(r);
      resume = true;
    } else if (wasRunning || (changed && hadMaterials) || (revision && r.production.started)) {
      r.production.needsResume = true;
      persistMeetingRecord(r);
      if (meetingReady(r) && meetingNextMaterial(r)) {
        makeMessage('请问是否按更新后的要求继续制作？', 'assistant');
      }
    } else if (!changed && !revision && meetingReady(r)) {
      resume = (out.meeting?.action === 'start' && (r.production.asked || priorPhase === '等待确认开始'))
        || (out.meeting?.action === 'resume' && r.production.started);
    }
    if (!resume && !r.production.needsResume) askMeetingStart(r);
  } catch (error) {
    if (active === session) {
      makeMessage('这次暂未处理完成：' + error.message, 'assistant');
      if (wasRunning) makeMessage('制作仍在暂停。您可以重试修改，确认后再继续制作。', 'assistant');
    }
  } finally {
    busy = false;
    $('chatSend').disabled = false;
    if (active === session) renderMeetingWorkflow();
  }
  if (resume && active === session) runMeetingProduction();
}

function renderMeetingAttendees(r) {
  const people = r.participants.map((person, index) => {
    const role = {visitor: '访客', sei: 'SEI'}[person.type] || '待确认身份';
    const name = [role, person.company, person.name, person.title].filter(Boolean).map(meetingEscape).join(' · ');
    return `<div class="attendee-item"><span>${name}</span><button type="button" class="workflow-btn" data-remove-attendee="${index}">移除</button></div>`;
  }).join('');
  const visitors = meetingArray(VISITOR_KEY);
  return `<div class="attendee-row">
    <label class="workflow-field">身份<select id="attendeeType"><option value="sei">主办方（SEI）</option><option value="visitor">外部参会方</option></select></label>
    <label class="workflow-field" id="companyField" hidden>公司<input id="attendeeCompany" maxlength="160"></label>
    <label class="workflow-field">姓名<input id="attendeeName" maxlength="160"></label>
    <label class="workflow-field" id="titleField" hidden>职务<input id="attendeeTitle" maxlength="160"></label>
    <button type="button" class="workflow-btn" data-meeting-action="add-attendee">添加</button>
  </div>
  <div class="attendee-list">${people || '<span class="workflow-hint">尚未添加参会人。</span>'}</div>
  <details class="visitor-directory">
    <summary>查询访客人员库 · ${visitors.length} 人</summary>
    <label class="workflow-field">公司、姓名或职务<input id="visitorLookup" autocomplete="off"></label>
    <div class="visitor-matches" id="visitorMatches">${visitorMatches('')}</div>
  </details>`;
}

function visitorMatches(query) {
  const results = meetingArray(VISITOR_KEY).filter(v =>
    [v.company, v.name, v.title].join(' ').toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20);
  return results.map(v => `<button class="visitor-match" data-use-visitor="${meetingEscape(v.key)}" type="button">${meetingEscape(v.company)} · ${meetingEscape(v.name)} · ${meetingEscape(v.title)}</button>`).join('')
    || '<span class="workflow-hint">暂无匹配访客。</span>';
}

function meetingLibraryMatches(query, type) {
  const results = meetingArray(MATERIAL_LIBRARY_KEY).filter(item => item.type === type
    && [item.meetingName, item.title].join(' ').toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20);
  return results.map(item => {
    const content = item.versions?.at(-1)?.content;
    if (!content) return '';
    return `<details class="library-item">
      <summary>${meetingEscape(item.meetingName)} · ${meetingEscape(MATERIAL_TITLES[type])}</summary>
      <pre class="material-content">${meetingEscape(content)}</pre>
      ${item.meetingId === active.id ? '' : `<button type="button" class="workflow-btn" data-library-reference="${meetingEscape(item.meetingId)}" data-material-type="${type}">用作本场同类材料参考</button>`}
    </details>`;
  }).join('') || '<span class="workflow-hint">暂无匹配材料。</span>';
}

function renderMeetingLibrary(r, selected) {
  const type = selected || meetingNextMaterial(r) || 'handbook';
  return `<details class="material-library" id="meetingMaterialLibrary">
    <summary>查询会议材料库</summary>
    <div class="workflow-grid">
      <label class="workflow-field">材料类型<select id="meetingLibraryType">
        ${MEETING_ITEMS.map(([key, title]) => `<option value="${key}" ${type === key ? 'selected' : ''}>${title}</option>`).join('')}
      </select></label>
      <label class="workflow-field">会议名称<input id="meetingLibraryQuery" autocomplete="off"></label>
    </div>
    <div class="library-list" id="meetingLibraryMatches">${meetingLibraryMatches('', type)}</div>
  </details>`;
}

function renderIntakeFields(step, r) {
  const f = r.facts;
  if (step === 0) {
    return `<div class="workflow-grid">
      <label class="workflow-field">会议主题<input id="meetingTopic" maxlength="250" value="${meetingEscape(f.topic)}"></label>
      <label class="workflow-field">会议室<input id="meetingRoom" maxlength="250" value="${meetingEscape(f.location)}"></label>
      <label class="workflow-field">会议日期<input id="meetingDate" type="date" value="${meetingEscape(f.date)}"></label>
      <label class="workflow-field">会议时间<input id="meetingTime" type="time" value="${meetingEscape(f.time)}"></label>
    </div>`;
  }
  if (step === 1) {
    return `<label class="workflow-field intake-person-count">参会人数（可选）
      <input id="meetingCount" type="number" min="1" max="100" value="${meetingEscape(f.attendee_count)}">
    </label>${renderMeetingAttendees(r)}`;
  }
  return `<div class="workflow-grid">
    <label class="workflow-field">是否用餐<select id="mealRequired">
      <option value="">待确认</option>
      <option value="yes" ${r.meal.required === true ? 'selected' : ''}>用餐</option>
      <option value="no" ${r.meal.required === false ? 'selected' : ''}>不用餐</option>
    </select></label>
    <label class="workflow-field" id="dietField" ${r.meal.required === true ? '' : 'hidden'}>特殊餐饮需求
      <input id="mealDiet" maxlength="500" value="${meetingEscape(r.meal.special_diet)}" placeholder="如有清真、忌口等要求请填写；没有请填“无”">
    </label>
  </div>`;
}

function renderMeetingIntake(r, steps, startAction, productionVisible) {
  const next = steps.findIndex(step => step.missing.length > 0);
  const stepIndex = editingIntakeStep ?? next;
  const isEditing = editingIntakeStep !== null;
  const step = steps[stepIndex];
  const previousForm = $('meetingIntakeFields');
  const keepOpen = previousForm?.dataset.step === String(stepIndex) && previousForm.open;
  const f = r.facts;
  const summaries = [
    [f.topic, f.date, f.time, f.location].filter(Boolean).join(' · '),
    r.participants.map(person => person.name).filter(Boolean).slice(0, 3).join('、') + ' · ' + r.participants.length + ' 人',
    r.meal.required ? ('用餐 · ' + (r.meal.special_diet === '无' ? '无特殊要求' : r.meal.special_diet)) : '不用餐',
  ];
  const prompts = [
    '您可以把会议主题、时间和地点直接告诉赛博小潘。',
    '您可以直接贴名单，或从访客库选取曾来访的人员。',
    '请告诉我是否安排用餐。有特殊要求的话，也可以一起说明。',
  ];
  const confirmed = steps.map((item, index) => {
    if (item.missing.length || (isEditing && index === stepIndex)) return '';
    return `<li class="intake-confirmed">
      <span class="meeting-step-number intake-check" aria-label="已确认">✓</span>
      <div><strong>${index + 1} · ${item.title}</strong><p>${meetingEscape(summaries[index])}</p></div>
      <div class="intake-confirmed-actions">
        ${index === 0 && f.location ? `<button type="button" class="workflow-btn room-preview-button" data-room-preview="true" aria-label="查看${meetingEscape(f.location)}会议室俯视示意图">查看会议室</button>` : ''}
        <button type="button" class="workflow-btn intake-edit" data-intake-step="${index}" aria-label="修改${item.title}">修改</button>
      </div>
    </li>`;
  }).join('');
  return `<section class="workflow-card">
    <div class="meeting-section-head"><h3>会议信息收集</h3>
      <span class="meeting-section-meta">${next < 0 ? '资料齐全' : '第 ' + (stepIndex + 1) + ' 步'}</span>
    </div>
    ${confirmed ? `<ol class="meeting-step-list intake-confirmed-list" aria-label="已确认的信息">${confirmed}</ol>` : ''}
    ${step ? `<div class="intake-current">
      <div class="intake-current-heading"><span class="meeting-step-number">${stepIndex + 1}</span>
        <strong>${step.title}</strong></div>
      ${!isEditing ? `<p>${prompts[stepIndex]}</p>
        ${stepIndex === 0 && summaries[0] ? `<p class="intake-captured">已填：${meetingEscape(summaries[0])}</p>` : ''}` : ''}
      <details class="meeting-intake-fields" id="meetingIntakeFields" data-step="${stepIndex}" ${isEditing || keepOpen ? 'open' : ''}>
        <summary>${isEditing ? '修改已确认信息' : '手动补充'}</summary>
        <div class="meeting-intake-body">
          ${renderIntakeFields(stepIndex, r)}
          <div class="workflow-actions">
            <button type="button" class="workflow-btn primary" data-meeting-action="save-intake">保存${step.title.replace('信息','')}</button>
            ${isEditing ? '<button type="button" class="workflow-btn" data-meeting-action="cancel-intake-edit">返回当前步骤</button>' : ''}
          </div>
        </div>
      </details>
    </div>` : !productionVisible ? `<div class="intake-ready" role="status">
      <p>会议信息已收齐。准备好后，可以开始制作材料。</p>
      ${startAction}
    </div>` : ''}
  </section>`;
}

function renderMeetingWorkflow() {
  const r = getMeetingRecord();
  if (!r) return;
  const root = $('meetingWorkflow');
  const intake = meetingIntake(r);
  const ready = intake.every(step => !step.missing.length);
  const productionVisible = ready && r.production.started;
  const next = meetingNextMaterial(r);
  const runningKey = productionRun?.key;
  const completed = MEETING_ITEMS.filter(([key]) => r.materials[key] && (key !== 'dining_plan' || r.meal.required));
  const selected = completed.some(([key]) => key === currentMaterialTab) ? currentMaterialTab : completed[0]?.[0];
  const editing = Boolean(selected && editingMeetingMaterial === selected);
  const oldDraft = $('meetingMaterialEditor')?.value;
  const libraryOpen = $('meetingMaterialLibrary')?.open;
  const visitorOpen = root.querySelector('.visitor-directory')?.open;
  const libraryQuery = $('meetingLibraryQuery')?.value;
  const libraryType = $('meetingLibraryType')?.value;
  const disabled = busy || editing ? 'disabled' : '';
  const needsLanguage = ready && r.production.started && r.production.tentAsked && next === 'table_tents' && !r.tentLanguage;
  const currentAction = ready && next && !productionRun && !needsLanguage
    ? `<button type="button" class="workflow-btn primary" data-meeting-action="start" ${disabled}>${r.production.started || r.production.needsResume ? '继续制作' : '开始制作'}</button>` : '';
  const title = !ready ? '收集中' : !next ? '全部材料已完成' : runningKey ? '正在制作 ' + MATERIAL_TITLES[runningKey]
    : needsLanguage ? '请确认桌签语言' : r.production.started ? '制作已暂停'
      : '资料已收齐，等待确认';
  $('resultState').textContent = title;
  $('resultState').classList.toggle('ready', ready && !next);
  $('resultDescription').textContent = r.facts.topic || '新会议';
  $('resultPlaceholder').hidden = true;
  $('resultContent').hidden = true;
  $('resultRequest').hidden = true;
  root.hidden = false;
  root.innerHTML = `
    ${renderMeetingIntake(r, intake, currentAction, productionVisible)}
    ${productionVisible ? `    <section class="workflow-card">
      <div class="meeting-section-head"><h3>会议材料制作</h3>
        <span class="meeting-section-meta">${completed.length} / ${r.meal.required === false ? 5 : 6} 已完成</span></div>
      <ol class="meeting-step-list production">${MEETING_ITEMS.map(([key, label], index) => {
        const skipped = key === 'dining_plan' && r.meal.required === false;
        const status = skipped ? '无需制作' : r.materials[key] ? '已完成'
          : runningKey === key ? '制作中' : needsLanguage && key === next ? '待确认语言'
            : ready && key === next && r.production.started ? '待继续' : '待制作';
        return `<li><span class="meeting-step-number">${index + 1}</span><strong>${label}</strong>
          <span class="meeting-step-status ${r.materials[key] && !skipped ? 'done' : ''} ${runningKey === key ? 'running' : ''}">${status}</span></li>`;
      }).join('')}</ol>
      ${currentAction}
      ${needsLanguage ? `<div class="workflow-actions">
        <button type="button" class="workflow-btn" data-language="zh" ${disabled}>仅中文桌签</button>
        <button type="button" class="workflow-btn primary" data-language="zh-en" ${disabled}>中英文桌签</button>
      </div>` : ''}
      ${runningKey ? '<button type="button" class="workflow-btn" data-meeting-action="pause">暂停制作</button>' : ''}
    </section>
    ${completed.length ? `<section class="workflow-card">
      <h3>已完成材料</h3>
      <div class="material-tabs" role="tablist" aria-label="会议材料">${completed.map(([key, label]) =>
        `<button type="button" class="material-tab ${selected === key ? 'active' : ''}" role="tab" aria-selected="${selected === key}" aria-controls="meetingMaterialPanel" data-material-tab="${key}" ${editing && selected !== key ? 'disabled' : ''}>${label}</button>`
      ).join('')}</div>
      <div id="meetingMaterialPanel" role="tabpanel" aria-label="${MATERIAL_TITLES[selected]}">
        ${selected === 'seat_plan' ? '<p class="workflow-hint">模拟座位图，供您预览和编辑。</p>' : ''}
        ${editing ? `<textarea id="meetingMaterialEditor" class="material-editor" rows="12" maxlength="18000" aria-label="编辑${MATERIAL_TITLES[selected]}">${meetingEscape(oldDraft ?? r.materials[selected])}</textarea>`
          : `<pre class="material-content">${meetingEscape(r.materials[selected])}</pre>`}
      </div>
      <div class="workflow-actions">
        <button type="button" class="workflow-btn" data-edit-material="${selected}" ${busy ? 'disabled' : ''}>${editing ? '保存' : '编辑'}</button>
        ${editing ? '<button type="button" class="workflow-btn" data-meeting-action="cancel-edit">取消</button>' : ''}
      </div>
      ${ready && !next && !editing && !busy ? `<div class="workflow-actions meeting-download">
        <label class="workflow-field">下载格式<select id="meetingDownloadFormat"><option value="pdf">PDF</option><option value="docx">Word</option></select></label>
        <button type="button" class="workflow-btn primary" data-meeting-action="download">下载</button>
      </div>` : ''}
    </section>` : ''}
    ${renderMeetingLibrary(r, selected)}` : ''}
    <p class="workflow-hint" id="meetingFeedback" role="status" ${meetingFeedback ? '' : 'hidden'}>${meetingEscape(meetingFeedback)}</p>
  `;
  if (libraryOpen && $('meetingMaterialLibrary')) $('meetingMaterialLibrary').open = true;
  const visitorDirectory = root.querySelector('.visitor-directory');
  if (visitorOpen && visitorDirectory) visitorDirectory.open = true;
  if (libraryQuery !== undefined && $('meetingLibraryQuery')) {
    $('meetingLibraryQuery').value = libraryQuery;
    if ([...$('meetingLibraryType').options].some(option => option.value === libraryType)) $('meetingLibraryType').value = libraryType;
    refreshMeetingLibrary();
  }
}

function readMeetingIntake(r) {
  for (const [field, id] of Object.entries({
    topic: 'meetingTopic', location: 'meetingRoom', date: 'meetingDate', time: 'meetingTime', attendee_count: 'meetingCount',
  })) {
    const input = $(id);
    if (!input) continue;
    const value = input.value.trim();
    if (value) r.facts[field] = value;
    else delete r.facts[field];
  }
  if (!$('mealRequired')) return;
  const meal = $('mealRequired').value;
  r.meal.required = meal ? meal === 'yes' : null;
  r.meal.special_diet = meal === 'yes' ? $('mealDiet').value.trim() : '';
}

function updateMeetingIntake(r, changeAttendees) {
  if (busy) return;
  const wasRunning = pauseMeetingRun();
  const before = JSON.stringify([r.facts, r.participants, r.meal]);
  readMeetingIntake(r);
  if (changeAttendees) changeAttendees(r.participants);
  const changed = changedMeetingFacts(r, before);
  persistMeetingRecord(r);
  if ((changed || wasRunning) && r.production.needsResume && meetingReady(r)) {
    makeMessage('会议信息已更新。请问是否按更新后的信息继续制作？', 'assistant');
  } else if (wasRunning) {
    makeMessage('已暂停制作，请确认是否继续。', 'assistant');
  } else if (editingIntakeStep === null) {
    askMeetingStart(r);
  }
  renderMeetingWorkflow();
}

function refreshMeetingLibrary() {
  $('meetingLibraryMatches').innerHTML = meetingLibraryMatches($('meetingLibraryQuery').value, $('meetingLibraryType').value);
}

async function downloadMeetingBundle(r, button) {
  if (!meetingReady(r) || meetingNextMaterial(r)) return;
  const format = $('meetingDownloadFormat').value;
  button.disabled = true;
  try {
    if (location.protocol === 'file:') throw new Error('请通过网站或本地服务下载。');
    const response = await fetch('/api/meeting/download', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({format, profile: r, materials: r.materials}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '打包失败');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = (r.facts.topic || '会议').replace(/[\\/:*?"<>|]/g, '_') + '_会议材料.' + format;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    meetingFeedback = '暂未下载：' + error.message;
    if (active?.meetingRecord === r) renderMeetingWorkflow();
  } finally {
    button.disabled = false;
  }
}

function setAttendeeType() {
  const visitor = $('attendeeType').value === 'visitor';
  $('companyField').hidden = !visitor;
  $('titleField').hidden = !visitor;
}

function initMeetingWorkflow() {
  const root = $('meetingWorkflow');
  $('meetingRoomClose').addEventListener('click', () => $('meetingRoomDialog').close());
  $('meetingRoomDialog').addEventListener('click', event => {
    if (event.target === $('meetingRoomDialog')) $('meetingRoomDialog').close();
  });
  root.addEventListener('change', event => {
    if (event.target.id === 'attendeeType') setAttendeeType();
    if (event.target.id === 'mealRequired') $('dietField').hidden = event.target.value !== 'yes';
    if (event.target.id === 'meetingLibraryType') refreshMeetingLibrary();
  });
  root.addEventListener('input', event => {
    if (event.target.id === 'visitorLookup') $('visitorMatches').innerHTML = visitorMatches(event.target.value);
    if (event.target.id === 'meetingLibraryQuery') refreshMeetingLibrary();
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const r = getMeetingRecord();
    if (!r) return;
    const d = button.dataset;
    if (d.roomPreview) {
      const room = r.facts.location;
      if (!room) return;
      $('meetingRoomDialogTitle').textContent = `${room} · 会议室俯视示意`;
      $('meetingRoomDialog').showModal();
    } else if (d.intakeStep !== undefined) {
      editingIntakeStep = Number(d.intakeStep);
      renderMeetingWorkflow();
      $('meetingIntakeFields')?.querySelector('summary').focus();
    } else if (d.materialTab) {
      currentMaterialTab = d.materialTab;
      renderMeetingWorkflow();
    } else if (d.editMaterial) {
      if (editingMeetingMaterial) {
        const content = $('meetingMaterialEditor').value.trim();
        if (!content) return $('meetingMaterialEditor').focus();
        r.materials[d.editMaterial] = content;
        editingMeetingMaterial = '';
        archiveMeetingMaterial(r, d.editMaterial, content);
        persistMeetingRecord(r);
        if (meetingNextMaterial(r) && r.production.started) {
          makeMessage('修改已保存入库。请问是否继续制作其余材料？', 'assistant');
        }
      } else {
        if (pauseMeetingRun()) makeMessage('已暂停制作，您可以先修改这份材料。', 'assistant');
        editingMeetingMaterial = d.editMaterial;
        currentMaterialTab = d.editMaterial;
      }
      renderMeetingWorkflow();
      $('meetingMaterialEditor')?.focus();
    } else if (d.language) {
      r.tentLanguage = d.language;
      makeMessage(d.language === 'zh' ? '桌签只需要中文。' : '桌签需要中英文两套。', 'user');
      persistMeetingRecord(r);
      runMeetingProduction();
    } else if (d.removeAttendee !== undefined) {
      if (busy) return;
      editingIntakeStep = 1;
      updateMeetingIntake(r, list => list.splice(Number(d.removeAttendee), 1));
    } else if (d.useVisitor) {
      const visitor = meetingArray(VISITOR_KEY).find(entry => entry.key === d.useVisitor);
      if (!visitor) return;
      $('attendeeType').value = 'visitor';
      setAttendeeType();
      $('attendeeCompany').value = visitor.company;
      $('attendeeName').value = visitor.name;
      $('attendeeTitle').value = visitor.title;
      $('attendeeName').focus();
    } else if (d.libraryReference) {
      const entry = meetingArray(MATERIAL_LIBRARY_KEY).find(item => item.meetingId === d.libraryReference && item.type === d.materialType);
      if (!entry?.versions?.length) return;
      if (productionRun?.key === entry.type && pauseMeetingRun()) {
        makeMessage('已暂停本份材料，确认继续后会使用您选择的参考稿。', 'assistant');
      }
      r.production.references[entry.type] = entry.versions.at(-1).content.slice(0, 3800);
      meetingFeedback = `已将「${entry.meetingName}」的${MATERIAL_TITLES[entry.type]}添加为参考。`;
      persistMeetingRecord(r);
      renderMeetingWorkflow();
    } else if (d.meetingAction === 'add-attendee') {
      const type = $('attendeeType').value;
      const name = $('attendeeName').value.trim();
      const company = type === 'visitor' ? $('attendeeCompany').value.trim() : '';
      const title = type === 'visitor' ? $('attendeeTitle').value.trim() : '';
      if (!name || (type === 'visitor' && (!company || !title))) {
        alert(type === 'visitor' ? '请填写公司、姓名和职务。' : '请填写参会人姓名。');
        return;
      }
      const prior = meetingArray(VISITOR_KEY).find(v => v.name === name && v.company === company);
      if (busy) return;
      editingIntakeStep = 1;
      updateMeetingIntake(r, list => {
        if (!list.some(p => p.type === type && p.name === name && p.company === company)) {
          list.push({type, company, name, title, english_name: prior?.english_name || ''});
        }
      });
    } else if (d.meetingAction === 'save-intake') {
      if (busy) return;
      editingIntakeStep = null;
      updateMeetingIntake(r);
    } else if (d.meetingAction === 'cancel-intake-edit') {
      editingIntakeStep = null;
      renderMeetingWorkflow();
    } else if (d.meetingAction === 'start') {
      makeMessage(r.production.started || r.production.needsResume ? '请继续制作。' : '请开始制作会议材料。', 'user');
      runMeetingProduction();
    } else if (d.meetingAction === 'pause') {
      pauseMeetingRun();
      makeMessage('制作已暂停。您可以先补充修改意见，或确认继续。', 'assistant');
      renderMeetingWorkflow();
    } else if (d.meetingAction === 'cancel-edit') {
      editingMeetingMaterial = '';
      renderMeetingWorkflow();
    } else if (d.meetingAction === 'download') {
      downloadMeetingBundle(r, button);
    }
  });
}
