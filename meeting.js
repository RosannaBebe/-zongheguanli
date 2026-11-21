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
let viewedIntakeStep = null;
let editingIntakeStep = null;
let intakeDraft = null;
let savedIntakeStep = null;
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
    if (person.type !== 'visitor' || person.mock || !person.company || !person.name || !person.title) continue;
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
  entry.versions.push({content, mock: content.startsWith('【模拟数据】'), updatedAt: entry.updatedAt});
  if (existing >= 0) library.splice(existing, 1);
  library.unshift(entry);
  writeMeetingLibrary(MATERIAL_LIBRARY_KEY, library);
}

function meetingIntake(r) {
  const f = r.facts;
  const info = [['日期', f.date], ['时间', f.time], ['会议室', f.location], ['主题', f.topic]];
  const peopleMissing = [];
  if (!r.participants.some(p => p.type === 'sei')) peopleMissing.push('SEI 参会人姓名');
  if (f.no_external_attendees !== true && !r.participants.some(p => p.type === 'visitor')) {
    peopleMissing.push('外方参会人的公司、姓名和职务（如无外方，请告知）');
  }
  for (const person of r.participants) {
    const missing = [];
    if (!['sei', 'visitor'].includes(person.type)) missing.push('参会方');
    if (!person.name?.trim()) missing.push('姓名');
    if (person.type === 'visitor' && !person.company?.trim()) missing.push('公司');
    if (!person.title?.trim()) missing.push('职务');
    if (missing.length) peopleMissing.push(`${person.name || '未署名参会人'}：${missing.join('、')}`);
  }
  const count = String(f.attendee_count ?? '').trim();
  const countMismatch = /^\d+$/.test(count) && Number(count) !== r.participants.length;
  return [
    {
      title: '会议基本信息', requirement: '获得会议日期、时间、会议室和会议主题。',
      missing: info.filter(([, value]) => !value).map(([label]) => label),
    },
    {
      title: '参会人信息', requirement: 'SEI 按姓名查询职务，外方由您提供公司、姓名和职务。',
      missing: [
        ...peopleMissing,
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
  viewedIntakeStep = null;
  editingIntakeStep = null;
  intakeDraft = null;
  savedIntakeStep = null;
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

function mockMeetingMaterial(r, key, instructions = '') {
  const f = r.facts;
  const basics = `${f.topic}\n${f.date} ${f.time} · ${f.location}`;
  const rows = r.participants.map(person => [person.type === 'sei' ? 'SEI' : person.company, person.name, person.title].filter(Boolean).join(' · '));
  const examples = {
    handbook: `${basics}\n\n议程示例\n1. 介绍参会人员\n2. 交流讨论\n3. 汇总待办事项`,
    roster: rows.join('\n'),
    notice: `拟于 ${f.date} ${f.time} 在 ${f.location} 召开${f.topic}。请参会人员提前准备交流材料。`,
    seat_plan: '屏幕方向\n' + r.participants.map((person, index) => `席位 ${index + 1} · ${person.name}`).join('\n'),
    table_tents: r.participants.map(person => r.tentLanguage === 'zh-en'
      ? person.name + ' / ' + (person.english_name || '英文姓名待核对') : person.name).join('\n\n'),
    dining_plan: '用餐桌位示例\n' + r.participants.map((person, index) => `第 ${Math.floor(index / 8) + 1} 桌 · ${person.name}`).join('\n'),
  };
  const note = instructions ? '\n\n本次修改要求（待落实）\n' + instructions : '';
  return '【模拟数据】\n' + MATERIAL_TITLES[key] + '\n\n' + examples[key] + note;
}

function saveMeetingMaterial(r, key, content, mock = false) {
  if ((mock || r.mockSteps?.length) && !content.startsWith('【模拟数据】')) {
    content = '【模拟数据】\n' + content;
  }
  r.materials[key] = content;
  archiveMeetingMaterial(r, key, content);
  persistMeetingRecord(r);
  currentMaterialTab = key;
}

async function runMeetingProduction(options = {}) {
  const r = getMeetingRecord();
  if (!r || productionRun || busy || editingMeetingMaterial || intakeDraft || !meetingReady(r)) return;
  if (!meetingNextMaterial(r)) return;
  retireWorkspaceRecovery();
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
      const simulated = options.mockKey === key;
      const response = simulated ? {key, content: mockMeetingMaterial(r, key, r.production.notes[key])}
        : await request('/api/meeting/material', {
        key, profile: r, materials: r.materials, instructions: r.production.notes[key] || '',
        reference: r.production.references[key] || '',
      }, {signal: run.controller.signal, retry: options.retryKey === key});
      if (productionRun !== run || active !== run.session) return;
      if (response.key !== key || !response.content) {
        throw Object.assign(new Error('材料生成结果为空'), {code: 'invalid_model_reply'});
      }
      saveMeetingMaterial(r, key, response.content, simulated);
      if (simulated) {
        makeMessage(`已在右侧展示${MATERIAL_TITLES[key]}的模拟数据。我会继续处理下一项。`, 'assistant', true, {demo: true});
      }
      renderMeetingWorkflow();
    }
    makeMessage('本场会议所需材料已全部制作完成，并为您保存入库。您可在右侧逐份审阅和修改，也可以打包下载 PDF 或 Word。', 'assistant');
  } catch (error) {
    if (productionRun !== run || active !== run.session || error.name === 'AbortError') return;
    showWorkspaceFailure(error, `${MATERIAL_TITLES[run.key]}暂未生成：`, {kind: 'material', key: run.key});
  } finally {
    if (productionRun === run) {
      productionRun = null;
      renderMeetingWorkflow();
    }
  }
}

async function recoverSavedMeetingBasics(session) {
  const record = getMeetingRecord();
  if (record) recoverSeiTitles(session, record);
  if (!record || record.basicsRecovered || !meetingIntake(record)[0].missing.length) return;
  const messages = session.messages.filter(message => message.role === 'user' && !message.meetingRouting);
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

async function recoverSeiTitles(session, record) {
  const people = record.participants.filter(person =>
    person.type === 'sei' && person.name && (!person.title || ['mock', 'directory'].includes(person.title_source))
  );
  if (!people.length) return;
  try {
    const {participants} = await request('/api/meeting/resolve-sei-titles', {names: people.map(person => person.name)});
    if (active !== session) return;
    const before = JSON.stringify([record.facts, record.participants, record.meal]);
    for (const person of people) {
      if (!record.participants.includes(person)) continue;
      const match = participants.find(item => item.name === person.name);
      if (!match) continue;
      person.title = match.title;
      if (match.title_source) person.title_source = match.title_source;
      else delete person.title_source;
    }
    if (changedMeetingFacts(record, before)) {
      pauseMeetingRun();
      persistMeetingRecord(record);
      if (!busy && editingIntakeStep === null) renderMeetingWorkflow();
    }
  } catch (_) {
    // Any unmatched titles remain visible in the intake checklist.
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
    const identity = person => [person.type, person.company || '', person.name, person.title || '', person.english_name || '', person.title_source || ''];
    if (JSON.stringify(r.participants.map(identity)) !== JSON.stringify(patch.participants.map(identity))) changed = true;
    r.participants = patch.participants;
    if (r.participants.some(person => person.type === 'visitor') && r.facts.no_external_attendees === true) {
      r.facts.no_external_attendees = false;
      changed = true;
    }
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

async function reviseMeetingMaterial(r, revision, options = {}) {
  const key = revision.key;
  if (!MATERIAL_TITLES[key]) return false;
  const instructions = revision.instruction;
  if (!options.replay) {
    r.production.notes[key] = [r.production.notes[key], instructions].filter(Boolean).join('\n').slice(-2400);
    persistMeetingRecord(r);
  }
  if (!r.materials[key]) {
    makeMessage(`已记下对${MATERIAL_TITLES[key]}的修改要求，继续制作时会按这个要求处理。`, 'assistant');
    return true;
  }
  const session = active;
  const pending = makeMessage(`正在修改${MATERIAL_TITLES[key]}…`, 'pending', false);
  try {
    const out = options.mock ? {content: mockMeetingMaterial(r, key, instructions)} : await request('/api/meeting/material', {
      key, revision: true, profile: r, materials: r.materials, instructions,
    }, {retry: options.replay});
    if (active !== session) return false;
    if (!out.content) {
      throw Object.assign(new Error('材料修改结果为空'), {code: 'invalid_model_reply'});
    }
    saveMeetingMaterial(r, key, out.content, options.mock || r.materials[key].startsWith('【模拟数据】'));
    makeMessage(options.mock
      ? `已展示${MATERIAL_TITLES[key]}的模拟稿，正式修改要求已保留，请您审阅。`
      : `${MATERIAL_TITLES[key]}已修改并入库，请您审阅。`, 'assistant', true, {demo: Boolean(options.mock)});
    return true;
  } catch (error) {
    if (active === session) {
      showWorkspaceFailure(error, `${MATERIAL_TITLES[key]}暂未修改：`, {kind: 'revision', revision});
    }
    return false;
  } finally {
    pending.remove();
  }
}

function meetingIdentity(session) {
  const facts = {...session.meetingFacts, ...session.meetingRecord?.facts};
  return {...facts, topic: facts.topic || session.meetingName || ''};
}

function normalizeMeetingName(name) {
  return String(name || '').normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function meetingScheduleDiffers(a, b) {
  return ['date', 'time'].some(key => a[key] && b[key] && a[key] !== b[key]);
}

async function findMeetingCandidates(text, session) {
  const current = meetingIdentity(session);
  const normalized = normalizeMeetingName(text);
  const refersBack = /之前|上次|刚才|原来|先前|已有|原有|之前那场|同一场|同一个会/.test(text);
  const starting = /(?:要|想|准备|帮我|请).{0,8}(?:办|开|安排|筹备|组织|召开)|新建|再办|再开|另开|另一场/.test(text);
  const mentionsCurrent = current.topic && normalized.includes(normalizeMeetingName(current.topic));
  const time = meetingTimeMention(text);
  const differentSchedule = (current.date && /\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}/.test(text)
    && !meetingDateMention(text, current.date)) || (current.time && time && time !== current.time);
  const history = readHistory().filter(item => {
    if (item.assistant !== 'meeting' || item.meetingChoice && !meetingIdentity(item).topic) return false;
    if (item.id === session.id) return (starting || differentSchedule) && mentionsCurrent;
    return refersBack || !(session.distinctMeetingIds || []).includes(item.id);
  });
  const exact = history.filter(item => {
    const name = normalizeMeetingName(meetingIdentity(item).topic);
    return name.length > 1 && normalized.includes(name);
  });
  if (mentionsCurrent && !starting && !refersBack && !differentSchedule) {
    // In the existing meeting, an ordinary update can still refer to it by name.
    return exact.filter(item => normalizeMeetingName(meetingIdentity(item).topic) !== normalizeMeetingName(current.topic));
  }
  if (exact.length) return exact;

  const otherMeetings = history.filter(item => item.id !== session.id && meetingIdentity(item).topic);
  const firstMessage = !session.messages.some(message => message.role === 'user' && !message.meetingRouting);
  const namedRequest = /[\p{Script=Han}A-Za-z0-9]{2,}(?:会议|交流会|座谈会|评审会|研讨会)/u.test(text);
  if (!otherMeetings.length || (!refersBack && !(firstMessage && namedRequest))) return [];
  try {
    const meetings = otherMeetings.slice(0, 40).map(item => ({
      id: item.id, name: meetingIdentity(item).topic, facts: meetingIdentity(item),
    }));
    const result = await request('/api/meeting/match', {text, meetings});
    const match = otherMeetings.find(item => item.id === result.match_id);
    if (match) {
      const name = normalizeMeetingName(meetingIdentity(match).topic);
      return otherMeetings.filter(item => normalizeMeetingName(meetingIdentity(item).topic) === name);
    }
  } catch (_) {
    // Local names remain available when the matching service is unavailable.
  }
  return refersBack ? otherMeetings.slice(0, 5) : [];
}

function meetingDateMention(text, date) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!parts) return false;
  return text.includes(date) || [...text.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/g)].some(match =>
    (!match[1] || match[1] === parts[1]) && Number(match[2]) === Number(parts[2]) && Number(match[3]) === Number(parts[3])
  );
}

function meetingTimeMention(text) {
  const match = /(上午|下午|晚上|中午)?\s*(?<![\d零一二两三四五六七八九十])(\d{1,2}|[零一二两三四五六七八九十]{1,3})(?:[:：](\d{2})|点(?:([0-5]?\d)分|半)?)/.exec(text);
  if (!match) return '';
  let hour = Number(match[2]);
  if (!Number.isFinite(hour)) {
    const digits = {零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
    const [tens, ones] = match[2].split('十');
    hour = ones === undefined ? digits[tens] : (digits[tens] || 1) * 10 + (digits[ones] || 0);
  }
  if (!Number.isFinite(hour) || hour > 23 || Number(match[3] || match[4] || 0) > 59) return '';
  if (['下午', '晚上'].includes(match[1]) && hour < 12) hour += 12;
  if (match[1] === '中午' && hour < 3) hour += 12;
  return String(hour).padStart(2, '0') + ':' + (match[0].endsWith('半') ? '30' : String(match[3] || match[4] || 0).padStart(2, '0'));
}

function meetingChoiceLabel(session) {
  const f = meetingIdentity(session);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.date || '');
  const date = match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : f.date || '日期待确认';
  return `${date} ${f.time || '时间待确认'}的「${f.topic || '待命名会议'}」${f.location ? `（${f.location}）` : ''}`;
}

function meetingChoiceCandidates(session) {
  const history = readHistory();
  return session.meetingChoice.candidateIds.map(id => id === session.id ? session : history.find(item => item.id === id)).filter(Boolean);
}

function showMeetingChoiceActions(session) {
  if (!session.meetingChoice) return;
  const log = $('messages');
  log.querySelector('.meeting-choice-actions')?.remove();
  const candidates = meetingChoiceCandidates(session);
  const actions = document.createElement('div');
  actions.className = 'meeting-choice-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', '确认是否为同一场会议');
  const button = (label, decision, description) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'button';
    item.textContent = label;
    if (description) item.setAttribute('aria-label', description);
    item.onclick = () => finishMeetingChoice(session, decision);
    actions.append(item);
  };
  candidates.forEach((item, index) => button(
    candidates.length === 1 ? '同一场，合并' : `合并至第 ${index + 1} 场`,
    item.id, '确认合并到' + meetingChoiceLabel(item),
  ));
  button('新建会议', 'new');
  button('取消', 'cancel');
  log.append(actions);
  log.scrollTop = log.scrollHeight;
}

function askMeetingChoice(session, text, candidates) {
  session.meetingChoice = {text, index: session.messages.length, candidateIds: candidates.map(item => item.id)};
  makeMessage(text, 'user', true, {meetingRouting: true});
  const prompt = candidates.length === 1
    ? `请您确认，您说的是${meetingChoiceLabel(candidates[0])}吗？如果是同一场，我会合并记录。如果是新会议，我会单独新建。`
    : '我找到了几场可能相关的会议，请您确认是哪一场：\n'
      + candidates.map((item, index) => `${index + 1}. ${meetingChoiceLabel(item)}`).join('\n')
      + '\n如果是另一场会议，可以选择「新建会议」。';
  makeMessage(prompt, 'assistant', true, {meetingRouting: true});
  showMeetingChoiceActions(session);
}

function resolveMeetingChoiceText(text, candidates) {
  const normalized = normalizeMeetingName(text);
  if (/^(取消|先不处理|不合并也不新建)$/.test(normalized)) return 'cancel';
  if (/(?:[？?]|吗)\s*$/.test(text) || /^(是不是|请问|如果|可能|应该是|我不确定|不确定|还没确定)/.test(normalized)) return '';
  if (/^(都不是|这几场都不是|新建|新会议|新建会议|新建一场|另开一场)$/.test(normalized)
    || /^(?:不是同一场|不是同一个会|不是|不合并)?(?:这是一场|这是|是|我要|请|帮我)?(?:一场|一个)?(?:新会议|新的会|新的一场|同名的新会议|另一场|另一个会|另开|新建|重新建)/.test(normalized)) return 'new';
  if (/^(不是|不对|不要|不合并|不确认|还没确定|不确定|我不确定)/.test(normalized)) return '';
  const selection = /^(?:是|选|选择|确认|合并至|合并到|确认合并到)?第(?:\s*)(\d+|[一二三四五六七八九十])[场个项]$/.exec(normalized);
  if (selection) {
    const index = Number(selection[1]) || '一二三四五六七八九十'.indexOf(selection[1]) + 1;
    return candidates[index - 1]?.id || '';
  }
  const dateSpecified = /\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}/.test(text);
  const time = meetingTimeMention(text);
  if (dateSpecified || time) {
    const selection = /^(是|对|选|确认|合并)|(?:那场|这场)(?:会|会议)?$/.test(normalized);
    const scheduleOnly = /^(?:\d{4}年)?[\d月日号:：\-上午下午晚上中午点半分零一二两三四五六七八九十\s]+$/.test(text.trim());
    if (!selection && !scheduleOnly) return '';
    const matches = candidates.filter(item => {
      const facts = meetingIdentity(item);
      return (!dateSpecified || meetingDateMention(text, facts.date)) && (!time || time === facts.time);
    });
    if (matches.length === 1) return matches[0].id;
    return '';
  }
  if (candidates.length === 1 && /^(是|是的|对|对的|没错|嗯|确认|同一个|同一个会|是同一个|是同一个会|同一场|是同一场|是这场|就是这场|就是那场|合并|确认合并|是的合并|同一场合并)$/.test(normalized)) {
    return candidates[0].id;
  }
  return '';
}

function mergeMeetingProfiles(target, source) {
  const donor = source.meetingRecord;
  if (!donor) return;
  const record = target.meetingRecord ??= {
    facts: {...target.meetingFacts}, participants: [], meal: {required: null, special_diet: ''},
    materials: {}, production: {started: false, asked: false, tentAsked: false, notes: {}, references: {}},
  };
  const before = JSON.stringify([record.facts, record.participants, record.meal]);
  for (const [key, value] of Object.entries(donor.facts)) {
    if (record.facts[key] == null || record.facts[key] === '') record.facts[key] = value;
  }
  for (const person of donor.participants) {
    const existing = record.participants.find(item => item.type === person.type
      && normalizeMeetingName(item.name) === normalizeMeetingName(person.name)
      && (item.company === person.company || !item.company || !person.company));
    if (!existing) record.participants.push(person);
    else for (const key of ['company', 'title', 'title_source', 'english_name']) {
      if (!existing[key] && person[key]) existing[key] = person[key];
    }
  }
  if (record.facts.no_external_attendees === true && record.participants.some(person => person.type === 'visitor')) {
    record.facts.no_external_attendees = false;
  }
  if (record.meal.required === null) record.meal = {...donor.meal};
  else if (record.meal.required === true && donor.meal.required === true && !record.meal.special_diet) {
    record.meal.special_diet = donor.meal.special_diet;
  }
  record.mockSteps = [...new Set([...(record.mockSteps || []), ...(donor.mockSteps || [])])];
  if (record.production && record.materials) changedMeetingFacts(record, before);
  target.meetingFacts = {...record.facts};
  target.meetingName = record.facts.topic || target.meetingName;
}

async function finishMeetingChoice(source, decision) {
  if (active !== source || !source.meetingChoice || busy || intakeDraft || editingMeetingMaterial) return;
  const choice = source.meetingChoice;
  const selected = meetingChoiceCandidates(source).find(item => item.id === decision);
  if (decision !== 'new' && decision !== 'cancel' && !selected) {
    makeMessage('这场会议已不在列表中。您可以选择其他候选会议，或新建一场。', 'assistant', true, {meetingRouting: true});
    showMeetingChoiceActions(source);
    return;
  }
  const log = $('messages');
  if (decision === 'cancel') {
    delete source.meetingChoice;
    log.querySelector('.meeting-choice-actions')?.remove();
    makeMessage('已取消本次匹配，您可以继续当前会话。', 'assistant', true, {meetingRouting: true});
    return;
  }
  const history = readHistory();
  const previous = {...source, messages: source.messages.filter((item, index) => index < choice.index || !item.meetingRouting)};
  delete previous.meetingChoice;
  const sourceFacts = meetingIdentity(previous);
  const sourceIsDraft = !sourceFacts.topic;
  const sameRecord = selected?.id === source.id;
  const matchesRecord = selected && (sourceIsDraft
    || normalizeMeetingName(sourceFacts.topic) === normalizeMeetingName(meetingIdentity(selected).topic))
    && !meetingScheduleDiffers(sourceFacts, meetingIdentity(selected));
  const reusedDraft = decision === 'new' && sourceIsDraft;
  let target = sameRecord || reusedDraft ? previous : selected || null;
  if (selected && !sameRecord) {
    target = structuredClone(selected);
    if (matchesRecord) {
      target.messages = [...target.messages, ...previous.messages.filter(item => !item.meetingRouting && !item.failed)]
        .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      mergeMeetingProfiles(target, previous);
    }
  }
  if (target && decision === 'new') target.distinctMeetingIds = choice.candidateIds;
  const keepSource = !sameRecord && !reusedDraft && !matchesRecord;
  const updated = history.filter(item => item.id !== source.id && item.id !== target?.id);
  if (keepSource) updated.unshift(previous);
  if (target) updated.unshift(target);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated.slice(0, 200)));
  } catch (_) {
    makeMessage('暂未保存会议记录，请您稍后重试。', 'assistant', true, {meetingRouting: true});
    showMeetingChoiceActions(source);
    return;
  }
  startSession('meeting', '', target, {
    silent: true,
    homeHandoff: matchesRecord || sameRecord || sourceIsDraft ? source.homeHandoff : '',
  });
  if (decision === 'new') active.distinctMeetingIds = choice.candidateIds;
  const message = decision === 'new' ? '已新建会议，我会接着整理您刚才提供的信息。'
    : `已确认是同一场会议，已将本次沟通接续到${meetingChoiceLabel(selected)}。`;
  makeMessage(message, 'assistant', true, {meetingRouting: true});
  if (selected) persistMeetingRecord(getMeetingRecord());
  await sendMeetingMessage(choice.text, {skipMatch: true});
}

async function sendMeetingMessage(text, options = {}) {
  if (busy || editingMeetingMaterial || intakeDraft) return;
  const session = active;
  const r = getMeetingRecord();
  if (session.meetingChoice && !options.skipMatch) {
    const decision = resolveMeetingChoiceText(text, meetingChoiceCandidates(session));
    if (decision) return finishMeetingChoice(session, decision);
    makeMessage(text, 'user', true, {meetingRouting: true});
    makeMessage('请确认要合并到哪场会议，或选择「新建会议」。', 'assistant', true, {meetingRouting: true});
    showMeetingChoiceActions(session);
    return;
  }
  retireWorkspaceRecovery();
  busy = true;
  $('chatSend').disabled = true;
  let resume = false;
  let runningKey = '';
  let wasRunning = false;
  try {
    if (!options.skipMatch) {
      const candidates = await findMeetingCandidates(options.meetingMatchText || text, session);
      if (active !== session) return;
      if (candidates.length) {
        askMeetingChoice(session, text, candidates);
        return;
      }
    }
    runningKey = productionRun?.key || options.runningKey || '';
    wasRunning = pauseMeetingRun() || Boolean(options.runningKey);
    const priorPhase = meetingPhase(r);
    if (!options.replay) {
      makeMessage(text, 'user');
      if (wasRunning) makeMessage('已暂停制作，我先处理您刚补充的意见。', 'assistant');
    }
    renderMeetingWorkflow();
    const pending = makeMessage('正在为您整理…', 'pending', false);
    let out;
    try {
      out = await request('/api/ai/chat', {
        assistant: 'meeting', messages: workspaceModelMessages(session), shared_memory: readSharedMemory(),
        home_handoff: session.homeHandoff || '',
        meeting_memory: {
          profile: r, phase: priorPhase, current_material: runningKey || meetingNextMaterial(r),
          materials: r.materials, today: new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'}),
        },
      }, {retry: options.replay});
    } finally {
      pending.remove();
    }
    if (active !== session) return;
    mergeSharedMemory(out.shared_memory_patch);
    const before = JSON.stringify([r.facts, r.participants, r.meal]);
    const previousIntake = meetingIntake(r);
    const hadMaterials = Object.keys(r.materials).length > 0;
    const changed = applyMeetingPatch(r, out.meeting);
    const revision = out.meeting?.revision;
    if (changed) {
      changedMeetingFacts(r, before);
      persistMeetingRecord(r);
    }
    const intake = meetingIntake(r);
    const currentStep = intake.findIndex(step => step.missing.length);
    let reply = out.reply;
    if (!revision && currentStep === 1) {
      reply = '为便于核对名单，请您补充以下信息：\n' + intake[1].missing.map(item => '· ' + item).join('\n');
    } else if (!revision && previousIntake[1].missing.length && !intake[1].missing.length) {
      reply = '双方参会名单及职务已核齐，您可以在右侧查看。';
      if (r.participants.some(person => person.title_source === 'mock')) {
        reply += ' SEI 名单中的模拟职务已单独标明。';
      }
    }
    makeMessage(reply, 'assistant');
    if (revision && !await reviseMeetingMaterial(r, revision)) return;
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
      const step = meetingIntake(r).findIndex(item => item.missing.length);
      showWorkspaceFailure(error, '这次暂未处理完成：', {kind: 'chat', text, runningKey, step});
    }
  } finally {
    busy = false;
    $('chatSend').disabled = false;
    if (active === session) renderMeetingWorkflow();
  }
  if (resume && active === session) runMeetingProduction();
}

function canRecoverMeetingModel(operation) {
  const r = getMeetingRecord();
  if (!r || productionRun || editingMeetingMaterial || intakeDraft) return false;
  if (operation.kind === 'material') return meetingReady(r) && meetingNextMaterial(r) === operation.key;
  if (operation.kind === 'revision') return meetingReady(r) && Boolean(r.materials[operation.revision.key]);
  return operation.kind === 'chat';
}

async function recoverMeetingModel(operation, mock) {
  const r = getMeetingRecord();
  if (operation.kind === 'material') {
    return runMeetingProduction(mock ? {mockKey: operation.key} : {retryKey: operation.key});
  }
  if (operation.kind === 'revision') {
    const session = active;
    busy = true;
    $('chatSend').disabled = true;
    try {
      if (await reviseMeetingMaterial(r, operation.revision, {replay: true, mock}) && active === session
        && r.production.started && meetingNextMaterial(r)) {
        r.production.needsResume = true;
        persistMeetingRecord(r);
        makeMessage('请问是否继续制作其余材料？', 'assistant');
      }
    } finally {
      busy = false;
      $('chatSend').disabled = false;
      if (active === session) renderMeetingWorkflow();
    }
    return;
  }
  if (!mock) {
    return sendMeetingMessage(operation.text, {replay: true, skipMatch: true, runningKey: operation.runningKey});
  }
  return showMeetingIntakeMock(r, operation);
}

function mockMeetingAttendees(r) {
  const sample = {sei: 0, visitor: 0};
  const names = new Set(r.participants.map(person => person.name));
  function demoName(type) {
    let name;
    do {
      name = `${type === 'sei' ? 'SEI 示例人员' : '外方示例人员'} ${++sample[type]}`;
    } while (names.has(name));
    names.add(name);
    return name;
  }
  const fill = (person, type) => {
    const name = person.name || demoName(type);
    const company = person.company || (type === 'visitor' ? '示例单位' : '');
    const title = person.title || (type === 'sei' ? '会务协调代表' : '项目联络代表');
    const mock = person.mock || type !== person.type || name !== person.name || title !== person.title
      || (type === 'visitor' && company !== person.company);
    return mock ? {...person, type, name, company, title, mock: true} : person;
  };
  const people = r.participants.map(person => fill(person, ['sei', 'visitor'].includes(person.type)
    ? person.type : r.facts.no_external_attendees ? 'sei' : 'visitor'));
  if (!people.some(person => person.type === 'sei')) people.push(fill({}, 'sei'));
  if (r.facts.no_external_attendees !== true && !people.some(person => person.type === 'visitor')) {
    people.push(fill({}, 'visitor'));
  }
  const count = Number(r.facts.attendee_count);
  if (Number.isInteger(count) && count > people.length && count <= 100) {
    while (people.length < count) people.push(fill({}, 'sei'));
  } else if (r.facts.attendee_count && count !== people.length) {
    r.facts.attendee_count = String(people.length);
  }
  r.participants = people;
}

function showMeetingIntakeMock(r, operation) {
  const steps = meetingIntake(r);
  const index = operation.step ?? steps.findIndex(step => step.missing.length);
  const before = JSON.stringify([r.facts, r.participants, r.meal]);
  if (index < 0) {
    const key = meetingNextMaterial(r);
    makeMessage('【模拟数据】会议信息已齐，您可以继续查看会议工作台。', 'assistant', true, {demo: true});
    if (key === 'table_tents' && r.production.tentAsked && !r.tentLanguage) {
      const text = operation.text || '';
      r.tentLanguage = !/不要英文|不需要英文|只要中文/.test(text) && /英文|双语/.test(text) ? 'zh-en' : 'zh';
      makeMessage(`【模拟数据】本次演示使用${r.tentLanguage === 'zh-en' ? '中英文' : '中文'}桌签。`, 'assistant', true, {demo: true});
      return runMeetingProduction({mockKey: key});
    }
    const text = operation.text || '';
    if (key && !operation.runningKey && /^(?:好[的呀]?|可以|同意|确认|(?:请)?(?:开始|继续)(?:制作(?:会议材料|材料)?|做)?)[。！!\s]*$/.test(text.trim())) {
      return runMeetingProduction({mockKey: key});
    }
    return;
  }
  if (index === 0) {
    const examples = {
      topic: '项目工作协调会（示例）',
      date: new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'}),
      time: '09:00',
      location: '示例会议室',
    };
    for (const [field, value] of Object.entries(examples)) {
      if (!r.facts[field]) r.facts[field] = value;
    }
  } else if (index === 1) {
    mockMeetingAttendees(r);
  } else {
    if (typeof r.meal.required !== 'boolean') r.meal.required = !/不(?:需(?:要)?|用|安排)?(?:就餐|用餐|吃饭)|无用餐|不吃/.test(operation.text || '');
    if (r.meal.required && !r.meal.special_diet) r.meal.special_diet = '无';
  }
  r.mockSteps = [...new Set([...(r.mockSteps || []), index])];
  editingIntakeStep = null;
  changedMeetingFacts(r, before);
  persistMeetingRecord(r);
  makeMessage(`【模拟数据】已补齐「${steps[index].title}」的示例信息，您可以在右侧查看或修改。`, 'assistant', true, {demo: true});
  askMeetingStart(r);
  renderMeetingWorkflow();
}

function renderAttendeeList(r, editable = false) {
  const people = r.participants.map((person, index) => {
    const role = {visitor: '外方', sei: 'SEI'}[person.type] || '待确认参会方';
    const title = person.title ? person.title + (person.title_source === 'mock' ? '（模拟）' : '') : '职务待补充';
    const info = [role, person.company, person.name || '姓名待补充', title, person.mock && '模拟数据'].filter(Boolean).map(meetingEscape).join(' · ');
    return `<div class="attendee-item"><span>${info}</span>${editable ? `
      <button type="button" class="workflow-btn" data-edit-attendee="${index}">编辑</button>
      <button type="button" class="workflow-btn" data-remove-attendee="${index}">移除</button>` : ''}</div>`;
  }).join('');
  return `<div class="attendee-list">${people || '<span class="workflow-hint">尚未添加参会人。</span>'}</div>`;
}

function renderMeetingAttendees(r) {
  const visitors = meetingArray(VISITOR_KEY);
  return `<div class="attendee-row">
    <label class="workflow-field">身份<select id="attendeeType"><option value="sei">主办方（SEI）</option><option value="visitor">外部参会方</option></select></label>
    <label class="workflow-field" id="companyField" hidden>公司<input id="attendeeCompany" maxlength="160"></label>
    <label class="workflow-field">姓名<input id="attendeeName" maxlength="160"></label>
    <label class="workflow-field" id="titleField" hidden>职务<input id="attendeeTitle" maxlength="160"></label>
    <button type="button" class="workflow-btn" id="saveMeetingAttendee" data-meeting-action="add-attendee">添加</button>
    <button type="button" class="workflow-btn" id="cancelMeetingAttendee" data-meeting-action="cancel-attendee" hidden>取消</button>
  </div>
  ${renderAttendeeList(r, true)}
  ${r.participants.some(person => person.type === 'visitor') ? '' : `
    <label class="workflow-hint"><input type="checkbox" id="noExternalAttendees" ${r.facts.no_external_attendees ? 'checked' : ''}> 本场无外方参会人</label>`}
  <details class="visitor-directory">
    <summary>查询访客人员库 · ${visitors.length} 人</summary>
    <label class="workflow-field">公司或姓名<input id="visitorLookup" autocomplete="off"></label>
    <p class="workflow-hint">选中后带入公司和姓名，请补充本次参会职务。</p>
    <div class="visitor-matches" id="visitorMatches">${visitorMatches('')}</div>
  </details>`;
}

function visitorMatches(query) {
  const results = meetingArray(VISITOR_KEY).filter(v =>
    [v.company, v.name].join(' ').toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20);
  return results.map(v => `<button class="visitor-match" data-use-visitor="${meetingEscape(v.key)}" type="button">${meetingEscape(v.company)} · ${meetingEscape(v.name)}</button>`).join('')
    || '<span class="workflow-hint">暂无匹配访客。</span>';
}

function meetingLibraryMatches(query, type) {
  const results = meetingArray(MATERIAL_LIBRARY_KEY).filter(item => item.type === type
    && (item.meetingId === active.id || !item.versions?.at(-1)?.mock)
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

function renderIntakeDetails(step, r) {
  if (step === 1) {
    const count = r.facts.attendee_count;
    return `<p class="intake-review-count">${r.participants.length} 位参会人${count ? ` · 预计 ${meetingEscape(count)} 人` : ''}</p>
      ${renderAttendeeList(r)}`;
  }
  const f = r.facts;
  const fields = step === 0
    ? [['会议主题', f.topic], ['会议室', f.location], ['会议日期', f.date], ['会议时间', f.time]]
    : [['是否用餐', r.meal.required ? '用餐' : '不用餐'],
      ...(r.meal.required ? [['特殊餐饮需求', r.meal.special_diet === '无' ? '无特殊要求' : r.meal.special_diet]] : [])];
  return `<dl class="intake-review-fields">${fields.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${meetingEscape(value)}</dd></div>`
  ).join('')}</dl>`;
}

function renderMeetingIntake(r, steps, startAction, productionVisible) {
  const stepIndex = steps.findIndex(step => step.missing.length > 0);
  const step = steps[stepIndex];
  const previousForm = $('meetingIntakeFields');
  const keepOpen = previousForm?.dataset.step === String(stepIndex) && previousForm.open;
  const f = r.facts;
  const seiCount = r.participants.filter(person => person.type === 'sei').length;
  const visitorCount = r.participants.filter(person => person.type === 'visitor').length;
  const summaries = [
    [f.topic, f.date, f.time, f.location].filter(Boolean).join(' · '),
    `SEI ${seiCount} 人 · 外方 ${visitorCount} 人 · 姓名与职务齐全`,
    r.meal.required ? ('用餐 · ' + (r.meal.special_diet === '无' ? '无特殊要求' : r.meal.special_diet)) : '不用餐',
  ];
  const prompts = [
    '您可以把会议主题、时间和地点直接告诉赛博小潘。',
    '请提供 SEI 参会人姓名，我会按姓名查询职务。外方请提供公司、姓名和职务。',
    '请告诉我是否安排用餐。有特殊要求的话，也可以一起说明。',
  ];
  const confirmed = steps.map((item, index) => {
    if (item.missing.length || (index === 2 && steps[1].missing.length)) return '';
    const expanded = viewedIntakeStep === index;
    const editing = editingIntakeStep === index;
    const panelId = `intakeReview-${index}`;
    return `<li class="intake-confirmed">
      <span class="meeting-step-number intake-check" aria-label="已确认">✓</span>
      <div><strong id="intakeTitle-${index}">${index + 1} · ${item.title}${r.mockSteps?.includes(index) ? ' · 模拟数据' : ''}</strong>
        <p>${meetingEscape(summaries[index])}</p>
      </div>
      <div class="intake-confirmed-actions">
        ${index === 0 && f.location ? `<button type="button" class="workflow-btn room-preview-button" data-room-preview="true" aria-label="查看${meetingEscape(f.location)}的俯视示意图">查看会议室</button>` : ''}
        <button type="button" class="workflow-btn intake-view" data-intake-view="${index}" data-step-title="${item.title}" aria-expanded="${expanded}"
          aria-controls="${panelId}" aria-label="${expanded ? '收起' : '查看'}${item.title}" ${intakeDraft ? 'disabled' : ''}>${expanded ? '收起' : '查看'}</button>
        <button type="button" class="workflow-btn intake-view" data-intake-step="${index}" data-intake-shortcut="${index}"
          aria-label="修改${item.title}" ${expanded ? 'hidden' : ''} ${busy || intakeDraft || editingMeetingMaterial ? 'disabled' : ''}>修改</button>
      </div>
      <section class="intake-review" id="${panelId}" aria-labelledby="intakeTitle-${index}" ${expanded ? '' : 'hidden'}>
        ${editing ? `
          <div id="meetingIntakeEditor">
            ${renderIntakeFields(index, intakeDraft)}
            <p class="intake-review-error" id="intakeEditError" role="alert" hidden></p>
            <div class="workflow-actions">
              <button type="button" class="workflow-btn primary" data-meeting-action="save-intake-edit">保存</button>
              <button type="button" class="workflow-btn" data-meeting-action="cancel-intake-edit">取消</button>
            </div>
          </div>` : `
          ${renderIntakeDetails(index, r)}
          <div class="intake-review-actions">
            <button type="button" class="workflow-btn" data-intake-step="${index}" aria-label="编辑${item.title}" ${busy || editingMeetingMaterial ? 'disabled' : ''}>编辑</button>
            ${savedIntakeStep === index ? '<span role="status" class="intake-save-status">已保存</span>' : ''}
          </div>`}
      </section>
    </li>`;
  }).join('');
  return `<section class="workflow-card">
    <div class="meeting-section-head"><h3>会议信息收集</h3>
      <span class="meeting-section-meta">${!step ? '资料齐全' : '第 ' + (stepIndex + 1) + ' 步'}</span>
    </div>
    ${confirmed ? `<ol class="meeting-step-list intake-confirmed-list" aria-label="已确认的信息">${confirmed}</ol>` : ''}
    ${step ? `<div class="intake-current">
      <div class="intake-current-heading"><span class="meeting-step-number">${stepIndex + 1}</span>
        <strong>${step.title}</strong></div>
      <p>${prompts[stepIndex]}</p>
        ${stepIndex === 0 && summaries[0] ? `<p class="intake-captured">已填：${meetingEscape(summaries[0])}</p>` : ''}
        ${stepIndex === 1 ? `<p class="intake-captured">待补充：${step.missing.map(meetingEscape).join('；')}</p>
          ${r.participants.length ? `<div class="attendee-preview">${renderAttendeeList(r)}</div>` : ''}` : ''}
      ${intakeDraft ? '' : `<details class="meeting-intake-fields" id="meetingIntakeFields" data-step="${stepIndex}" ${keepOpen ? 'open' : ''}>
        <summary>手动补充</summary>
        <div class="meeting-intake-body">
          ${renderIntakeFields(stepIndex, r)}
          <div class="workflow-actions">
            <button type="button" class="workflow-btn primary" data-meeting-action="save-intake">保存${step.title.replace('信息','')}</button>
          </div>
        </div>
      </details>`}
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
  const disabled = busy || editing || intakeDraft ? 'disabled' : '';
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
        const status = skipped ? '无需制作' : r.materials[key] ? (r.materials[key].startsWith('【模拟数据】') ? '模拟数据' : '已完成')
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
        `<button type="button" class="material-tab ${selected === key ? 'active' : ''}" role="tab" aria-selected="${selected === key}" aria-controls="meetingMaterialPanel" data-material-tab="${key}" ${intakeDraft || (editing && selected !== key) ? 'disabled' : ''}>${label}</button>`
      ).join('')}</div>
      <div id="meetingMaterialPanel" role="tabpanel" aria-label="${MATERIAL_TITLES[selected]}">
        ${selected === 'seat_plan' ? '<p class="workflow-hint">模拟座位图，供您预览和编辑。</p>' : ''}
        ${editing ? `<textarea id="meetingMaterialEditor" class="material-editor" rows="12" maxlength="18000" aria-label="编辑${MATERIAL_TITLES[selected]}">${meetingEscape(oldDraft ?? r.materials[selected])}</textarea>`
          : `<pre class="material-content">${meetingEscape(r.materials[selected])}</pre>`}
      </div>
      <div class="workflow-actions">
        <button type="button" class="workflow-btn" data-edit-material="${selected}" ${busy || intakeDraft ? 'disabled' : ''}>${editing ? '保存' : '编辑'}</button>
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
  if ($('noExternalAttendees')) r.facts.no_external_attendees = $('noExternalAttendees').checked;
  if (!$('mealRequired')) return;
  const meal = $('mealRequired').value;
  r.meal.required = meal ? meal === 'yes' : null;
  r.meal.special_diet = meal === 'yes' ? $('mealDiet').value.trim() : '';
}

function updateMeetingIntake(r, applyChanges = readMeetingIntake) {
  if (busy) return;
  const wasRunning = pauseMeetingRun();
  const before = JSON.stringify([r.facts, r.participants, r.meal]);
  applyChanges(r);
  const changed = changedMeetingFacts(r, before);
  if (changed || wasRunning) retireWorkspaceRecovery();
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

function openIntakeEditor(r, step) {
  if (busy || editingMeetingMaterial || intakeDraft || meetingIntake(r)[step].missing.length) return;
  if (pauseMeetingRun()) {
    r.production.needsResume = true;
    persistMeetingRecord(r);
    makeMessage('已暂停制作。保存会议资料后可继续。', 'assistant');
  }
  viewedIntakeStep = editingIntakeStep = step;
  savedIntakeStep = null;
  intakeDraft = structuredClone({facts: r.facts, participants: r.participants, meal: r.meal});
  renderMeetingWorkflow();
  $('meetingIntakeEditor').querySelector('input, select')?.focus({preventScroll: true});
}

function focusIntakeReviewEdit(step) {
  $('intakeReview-' + step)?.querySelector('[data-intake-step]')?.focus({preventScroll: true});
}

function toggleIntakeReview(root, step) {
  const previous = viewedIntakeStep;
  viewedIntakeStep = previous === step ? null : step;
  for (const index of new Set([previous, step])) {
    if (index === null) continue;
    const toggle = root.querySelector(`[data-intake-view="${index}"]`);
    const panel = $('intakeReview-' + index);
    if (!toggle || !panel) continue;
    const expanded = viewedIntakeStep === index;
    const label = expanded ? '收起' : '查看';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', label + toggle.dataset.stepTitle);
    toggle.textContent = label;
    panel.hidden = !expanded;
    root.querySelector(`[data-intake-shortcut="${index}"]`).hidden = expanded;
  }
}

function closeIntakeEditor() {
  intakeDraft = null;
  editingIntakeStep = null;
}

function saveIntakeEditor(r) {
  if (busy || !intakeDraft) return;
  const step = editingIntakeStep;
  const draft = intakeDraft;
  readMeetingIntake(draft);
  const missing = meetingIntake(draft)[step].missing;
  if (missing.length) {
    const message = $('intakeEditError');
    message.textContent = '请补齐后保存：' + missing.join('；');
    message.hidden = false;
    return;
  }
  closeIntakeEditor();
  savedIntakeStep = step;
  updateMeetingIntake(r, record => {
    if (step === 0) {
      for (const key of ['topic', 'location', 'date', 'time']) record.facts[key] = draft.facts[key];
    } else if (step === 1) {
      record.participants = draft.participants;
      for (const key of ['attendee_count', 'no_external_attendees']) {
        if (Object.hasOwn(draft.facts, key)) record.facts[key] = draft.facts[key];
        else delete record.facts[key];
      }
    } else {
      record.meal = draft.meal;
    }
  });
  focusIntakeReviewEdit(step);
}

function changeMeetingAttendees(r, applyChanges, finishIntake = false) {
  if (intakeDraft) {
    readMeetingIntake(intakeDraft);
    applyChanges(intakeDraft);
    renderMeetingWorkflow();
    if (finishIntake) saveIntakeEditor(r);
    return;
  }
  updateMeetingIntake(r, record => {
    readMeetingIntake(record);
    applyChanges(record);
    if (!meetingIntake(record)[1].missing.length) viewedIntakeStep = 1;
  });
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
  $('titleField').hidden = !visitor && $('saveMeetingAttendee').dataset.editIndex === undefined;
}

function editMeetingAttendee(person, index) {
  const save = $('saveMeetingAttendee');
  const editing = index !== undefined;
  if (editing) save.dataset.editIndex = index;
  else delete save.dataset.editIndex;
  save.textContent = editing ? '保存人员' : '添加';
  $('cancelMeetingAttendee').hidden = !editing;
  $('attendeeType').value = person?.type === 'visitor' ? 'visitor' : 'sei';
  $('attendeeName').value = person?.name || '';
  $('attendeeCompany').value = person?.company || '';
  $('attendeeTitle').value = person?.title_source ? '' : person?.title || '';
  setAttendeeType();
  $('attendeeName').focus();
}

async function saveMeetingAttendee(r, button, finishIntake = false) {
  if (busy || button.disabled) return;
  const session = active;
  const formRecord = intakeDraft || r;
  const index = button.dataset.editIndex;
  const previous = formRecord.participants[index];
  const type = $('attendeeType').value;
  const name = $('attendeeName').value.trim();
  const company = type === 'visitor' ? $('attendeeCompany').value.trim() : '';
  const title = $('titleField').hidden ? '' : $('attendeeTitle').value.trim();
  if (!name) return $('attendeeName').focus();
  const existing = previous || formRecord.participants.find(person =>
    person.type === type && person.name.replace(/\s/gu, '') === name.replace(/\s/gu, '')
    && (person.company === company || !person.company || !company)
  );
  const entry = {type, company, name, title, english_name: existing?.name === name ? existing.english_name || '' : ''};
  if (existing?.mock && existing.name === name && existing.company === company && existing.title === title) entry.mock = true;
  if (!previous && !title && existing?.title) {
    entry.title = existing.title;
    if (existing.title_source) entry.title_source = existing.title_source;
  }
  if (type === 'sei' && !entry.title) {
    button.disabled = true;
    try {
      const {participants} = await request('/api/meeting/resolve-sei-titles', {names: [name]});
      if (participants[0]?.title) Object.assign(entry, participants[0]);
    } catch (_) {
      // Save the name so the title can still be supplied manually.
    } finally {
      button.disabled = false;
    }
  }
  if (active !== session || busy || !button.isConnected) return;
  changeMeetingAttendees(r, record => {
    if (type === 'visitor') record.facts.no_external_attendees = false;
    const position = record.participants.indexOf(existing);
    if (position < 0) record.participants.push(entry);
    else record.participants[position] = entry;
  }, finishIntake);
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
    } else if (d.intakeView !== undefined) {
      if (intakeDraft) return;
      toggleIntakeReview(root, Number(d.intakeView));
    } else if (d.intakeStep !== undefined) {
      openIntakeEditor(r, Number(d.intakeStep));
    } else if (d.materialTab) {
      if (intakeDraft) return;
      currentMaterialTab = d.materialTab;
      renderMeetingWorkflow();
    } else if (d.editMaterial) {
      if (intakeDraft) return;
      if (editingMeetingMaterial) {
        const content = $('meetingMaterialEditor').value.trim();
        if (!content) return $('meetingMaterialEditor').focus();
        editingMeetingMaterial = '';
        saveMeetingMaterial(r, d.editMaterial, content, r.materials[d.editMaterial].startsWith('【模拟数据】'));
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
    } else if (d.editAttendee !== undefined) {
      editMeetingAttendee((intakeDraft || r).participants[Number(d.editAttendee)], d.editAttendee);
    } else if (d.removeAttendee !== undefined) {
      if (busy) return;
      changeMeetingAttendees(r, record => record.participants.splice(Number(d.removeAttendee), 1));
    } else if (d.useVisitor) {
      const visitor = meetingArray(VISITOR_KEY).find(entry => entry.key === d.useVisitor);
      if (!visitor) return;
      editMeetingAttendee({type: 'visitor', company: visitor.company, name: visitor.name});
      $('attendeeTitle').focus();
    } else if (d.libraryReference) {
      if (intakeDraft) return;
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
      saveMeetingAttendee(r, button);
    } else if (d.meetingAction === 'cancel-attendee') {
      editMeetingAttendee();
    } else if (d.meetingAction === 'save-intake') {
      if (busy) return;
      updateMeetingIntake(r);
    } else if (d.meetingAction === 'save-intake-edit') {
      const personButton = $('saveMeetingAttendee');
      if (personButton && (personButton.dataset.editIndex !== undefined || $('attendeeName').value.trim())) {
        saveMeetingAttendee(r, personButton, true);
      } else {
        saveIntakeEditor(r);
      }
    } else if (d.meetingAction === 'cancel-intake-edit') {
      const step = editingIntakeStep;
      closeIntakeEditor();
      renderMeetingWorkflow();
      focusIntakeReviewEdit(step);
    } else if (d.meetingAction === 'start') {
      if (intakeDraft) return;
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
