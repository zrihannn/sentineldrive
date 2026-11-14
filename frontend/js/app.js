import { apiGet, apiWrite, readCache, writeCache, readPreferences, writePreferences, flushOutbox, queueSize, downloadBlob } from './api.js?v=3.0.8';
import { VisionEngine } from './vision.js?v=3.0.8';
import { AlarmEngine } from './alarm.js?v=3.0.8';

const $ = id => document.getElementById(id);
const THEME_KEY = 'sentineldrive.theme';
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const average = values => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : 0;
const median = values => { if(!values.length)return 0; const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const robust = values => { const m=median(values); const deviations=values.map(v=>Math.abs(v-m)); const mad=median(deviations); const filtered=values.filter(v=>Math.abs(v-m)<=Math.max(mad*3.5,Math.abs(m)*.04,.0005));return average(filtered.length?filtered:values); };
const uid = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-','').slice(0,14)}`;
const isoNow = () => new Date().toISOString();
const fmtNum = (value,digits=1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = value => value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : '—';
const fmtTime = value => value ? new Date(value).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}) : '—';
const fmtDuration = seconds => { const s=Math.max(0,Math.floor(Number(seconds)||0));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; };
const fmtBytes = bytes => bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(2)} MB`;

const DEFAULT_POLICIES = {
  earThreshold:.21, marThreshold:.42, poseTolerance:18, gazeTolerance:.28,
  drowsyDelay:1.5, yawnDelay:1.1, postureDelay:2.5, distractionDelay:2,
  faceLostDelay:2, alarmEnabled:true, alarmTone:'siren', alarmVolume:90,
  autoStartMonitoring:false, telemetryInterval:1000, retentionDays:365
};

const cache = readCache() || {};
const state = {
  drivers: cache.drivers || [], vehicles: cache.vehicles || [], sessions: cache.sessions || [],
  incidents: cache.incidents || [], activity: cache.activity || [],
  policies: readPreferences({ ...DEFAULT_POLICIES, ...(cache.policies || {}) }),
  health: null, storage: null, analytics: null, activeView:'command',
  currentMetrics:null, currentSession:null, sessionStartedAt:0, sessionStats:null,
  telemetryBuffer:[], lastTelemetryAt:0, lastTelemetryFlush:0,
  liveEvents:[], selectedDriverId:localStorage.getItem('sd.os3.driver') || '',
  selectedVehicleId:localStorage.getItem('sd.os3.vehicle') || '',
  eventTimers:{ eyeStart:0, eyeTriggered:false, eyeOpenSince:0, yawnStart:0, yawnTriggered:false, poseStart:0, poseTriggered:false, distractionStart:0, distractionTriggered:false, faceLostStart:0, faceLostTriggered:false },
  calibration:null, bootstrapped:false, online:false, currentRisk:0
};

const vision = new VisionEngine({
  video:$('cameraVideo'), canvas:$('overlayCanvas'),
  onMetrics: metrics => handleMetrics(metrics),
  onLost: () => handleFaceLost(),
  onStatus: status => updateEngineStatus(status)
});
const alarm = new AlarmEngine({ onState: status => renderAlarmState(status) });

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const toggle = $('themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
    toggle.title = `Switch to ${dark ? 'light' : 'dark'} theme`;
    toggle.querySelector('.theme-toggle-icon').textContent = dark ? '☀' : '☾';
    toggle.querySelector('.theme-toggle-label').textContent = dark ? 'Light' : 'Dark';
  }
  $('themeColorMeta')?.setAttribute('content', dark ? '#111a17' : '#f4f6f2');
}

function toast(message, kind='info') {
  const node=document.createElement('div'); node.className=`toast ${kind==='error'?'error':kind==='success'?'success':''}`; node.textContent=message;
  $('toastStack').append(node); window.setTimeout(()=>node.remove(),4300);
}
function setDbStatus(online) {
  state.online=online;
  $('sidebarDbStatus').textContent=online?'SQLite connected':'Offline cache mode';
  $('dbMiniText').textContent=online?'SQLITE ONLINE':'OFFLINE CACHE';
  $('footerDbStatus').textContent=online?'SQLITE DATABASE ONLINE':'OFFLINE CACHE MODE';
  $('apiStatusText').textContent=online?'API CONNECTED':'API OFFLINE';
  $('apiStatusDot').classList.toggle('online',online);
  $('syncStatusText').textContent=online?`${queueSize()} queued operations waiting to sync.`:'Local cache is active. New writes will queue until the API returns.';
}
function updateEngineStatus(label) {
  const active=Boolean(vision.streamActive);
  $('engineMiniText').textContent=label.replace('FACE LANDMARKER ','').replace('ENGINE ','');
  $('engineMiniDot').classList.toggle('online',active && label.includes('READY'));
  $('trackingPill').innerHTML=`<i></i> ${esc(label)}`;
  $('trackingPill').classList.toggle('active',active && label.includes('READY'));
}
function saveCache() {
  writeCache({ drivers:state.drivers,vehicles:state.vehicles,sessions:state.sessions,incidents:state.incidents,activity:state.activity,policies:state.policies, cachedAt:isoNow() });
}
function setBootMessage(message, progress) {
  const label = $('bootMessage');
  if (label) label.textContent = message;
  const fill = $('bootProgressFill');
  if (fill && Number.isFinite(progress)) fill.style.width = `${clamp(progress, 0, 100)}%`;
}

async function refreshBootstrap(silent=false) {
  try {
    setBootMessage('CONNECTING TO LOCAL DATABASE', 35);
    const data = await apiGet('/api/bootstrap', { timeoutMs: 8000 });
    state.drivers = data.drivers || [];
    state.vehicles = data.vehicles || [];
    state.sessions = data.sessions || [];
    state.incidents = data.incidents || [];
    state.activity = data.activity || [];
    state.policies = { ...DEFAULT_POLICIES, ...(data.policies || {}) };
    writePreferences(state.policies);
    saveCache();
    setDbStatus(true);
    if (!state.selectedDriverId || !state.drivers.some(d => d.id === state.selectedDriverId)) {
      state.selectedDriverId = state.drivers.find(d => d.status === 'active')?.id || state.drivers[0]?.id || '';
    }
    if (!state.selectedVehicleId || !state.vehicles.some(v => v.id === state.selectedVehicleId)) {
      state.selectedVehicleId = state.vehicles.find(v => v.status === 'active')?.id || '';
    }
    state.bootstrapped = true;
    setBootMessage('LOCAL DATABASE CONNECTED', 70);
    return true;
  } catch (error) {
    console.warn('SentinelDrive bootstrap API unavailable:', error);
    setDbStatus(false);
    if (!state.drivers.length && cache.drivers) {
      state.drivers = cache.drivers;
      state.vehicles = cache.vehicles || [];
      state.sessions = cache.sessions || [];
      state.incidents = cache.incidents || [];
      state.activity = cache.activity || [];
    }
    if (!silent) toast('Database connection unavailable. The local cache is loaded; new records will queue for sync.', 'error');
    setBootMessage('STARTING FROM LOCAL CACHE', 70);
    return false;
  }
}

async function hydrateWorkspaceData() {
  const jobs = [
    ['sessions', '/api/sessions?limit=1000'],
    ['incidents', '/api/incidents?limit=5000'],
    ['activity', '/api/activity?limit=1000']
  ];
  const results = await Promise.allSettled(jobs.map(([, path]) => apiGet(path, { timeoutMs: 7000 })));
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') state[jobs[index][0]] = result.value;
    else console.warn(`SentinelDrive optional startup request failed (${jobs[index][0]}):`, result.reason);
  });
  saveCache();
  await refreshHealth();
  renderAll();
}

async function refreshHealth() {
  const [health, storage] = await Promise.allSettled([
    apiGet('/api/health', { timeoutMs: 5000 }),
    apiGet('/api/storage', { timeoutMs: 5000 })
  ]);
  if (health.status === 'fulfilled') state.health = health.value;
  if (storage.status === 'fulfilled') state.storage = storage.value;
  const connected = health.status === 'fulfilled';
  setDbStatus(connected);
  if (connected) renderJournalStatus();
  return connected;
}
async function refreshSessionsAndIncidents() {
  try {
    const [sessions,incidents,activity]=await Promise.all([apiGet('/api/sessions?limit=500'),apiGet('/api/incidents?limit=1000'),apiGet('/api/activity?limit=100')]);
    state.sessions=sessions;state.incidents=incidents;state.activity=activity;saveCache();
  } catch { /* Keep cache and queue state. */ }
  renderAll();
}

function navigate(view) {
  state.activeView=view;
  document.querySelectorAll('.view').forEach(node=>node.classList.toggle('active',node.id===`view-${view}`));
  document.querySelectorAll('.nav-link').forEach(node=>node.classList.toggle('active',node.dataset.view===view));
  const labels={command:'Command center',monitor:'Live monitor',drivers:'Driver registry',vehicles:'Vehicle registry',sessions:'Session archive',events:'Event timeline',analytics:'Analytics & insights',policies:'Safety policies',journal:'System journal'};
  $('pageCrumb').textContent=labels[view]||view;
  if(view==='analytics') void loadAnalytics(Number($('analyticsRange').value||30));
  if(view==='journal') void refreshHealth().then(renderJournal);
  window.scrollTo({top:0,behavior:'smooth'});
  closePalette();
}

function renderAll() {
  populateAssignments();
  renderCommand();renderDrivers();renderVehicles();renderSessions();renderEvents();renderPolicyForm();renderJournal();
  renderNavCounts();
}
function renderNavCounts() {
  $('driverNavCount').textContent=state.drivers.length;
  $('vehicleNavCount').textContent=state.vehicles.length;
  $('eventNavCount').textContent=state.incidents.filter(item=>!item.acknowledged).length;
  $('activeSessionCount').textContent=state.sessions.filter(item=>item.status==='active').length + (state.currentSession?1:0);
  $('unackedCount').textContent=state.incidents.filter(item=>!item.acknowledged).length;
  $('liveNavDot').classList.toggle('active',Boolean(state.currentSession));
  $('journalUnread').style.display=state.incidents.some(item=>!item.acknowledged&&item.severity==='critical')?'block':'none';
}
function nameForDriver(id) { return state.drivers.find(item=>item.id===id)?.name || (id?'Archived driver':'Unassigned'); }
function nameForVehicle(id) { const v=state.vehicles.find(item=>item.id===id);return v?`${v.label} · ${v.registration}`:(id?'Archived vehicle':'Unassigned'); }
function summaryCard(label,value) { return `<div class="summary-card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
function renderCommand() {
  const inc=state.incidents;
  $('todayLabel').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',day:'2-digit',month:'short',year:'numeric'}).toUpperCase();
  $('kpiSessions').textContent=state.sessions.filter(s=>new Date(s.started_at)>Date.now()-30*86400000).length;
  $('kpiSamples').textContent=Number(state.storage?.counts?.telemetry||state.health?.counts?.telemetry||0).toLocaleString();
  $('kpiAttention').innerHTML=state.analytics?.average_attention==null?'—<small>/100</small>':`${Math.round(state.analytics.average_attention)}<small>/100</small>`;
  $('kpiEvents').textContent=inc.filter(i=>new Date(i.occurred_at)>Date.now()-30*86400000).length;
  $('systemStatusText').textContent=state.online?'SYSTEM NOMINAL':'LOCAL CACHE MODE';
  $('systemStatusText').style.color=state.online?'#4e7f5e':'#b17d4d';
  $('activeSessionCount').textContent=state.sessions.filter(s=>s.status==='active').length+(state.currentSession?1:0);
  $('unackedCount').textContent=inc.filter(i=>!i.acknowledged).length;
  renderFeed();
  if(state.analytics) drawTrend($('attentionChart'),state.analytics.daily||[]);
  $('trendEmpty').classList.toggle('visible',!state.analytics?.daily?.length);
  $('attentionChart').style.display=state.analytics?.daily?.length?'block':'none';
}
function renderFeed() {
  const priority=state.incidents.slice().sort((a,b)=>new Date(b.occurred_at)-new Date(a.occurred_at)).slice(0,5);
  $('priorityFeed').innerHTML=priority.length?priority.map(item=>`<div class="event-row"><span class="event-severity ${esc(item.severity)}">${item.severity==='critical'?'!':'⌁'}</span><div class="event-row-main"><b>${esc(item.title)}</b><p>${esc(item.detail||item.event_type)} · ${esc(nameForDriver(item.driver_id))}</p></div><time>${fmtTime(item.occurred_at)}</time></div>`).join(''):'<div class="empty-row">No safety events have been recorded.</div>';
  $('activityFeed').innerHTML=state.activity.slice(0,5).map(item=>`<div class="activity-row"><i class="activity-pin ${item.level==='critical'||item.level==='high'?'danger':item.level==='warning'?'warning':''}"></i><div class="activity-row-main"><b>${esc(item.title)}</b><p>${esc(item.detail)}</p></div><time>${fmtTime(item.created_at)}</time></div>`).join('')||'<div class="empty-row">Activity will appear as you use the platform.</div>';
}

function populateAssignments() {
  const driver=$('monitorDriver'),vehicle=$('monitorVehicle');
  if(!driver||!vehicle)return;
  const prevD=driver.value||state.selectedDriverId,prevV=vehicle.value||state.selectedVehicleId;
  driver.innerHTML=state.drivers.filter(d=>d.status==='active').map(d=>`<option value="${esc(d.id)}">${esc(d.name)}${d.employee_code?` · ${esc(d.employee_code)}`:''}</option>`).join('')||'<option value="">No active driver profiles</option>';
  vehicle.innerHTML='<option value="">No vehicle assigned</option>'+state.vehicles.filter(v=>v.status==='active').map(v=>`<option value="${esc(v.id)}">${esc(v.label)} · ${esc(v.registration)}</option>`).join('');
  driver.value=state.drivers.some(d=>d.id===prevD&&d.status==='active')?prevD:(driver.options[0]?.value||'');
  vehicle.value=state.vehicles.some(v=>v.id===prevV&&v.status==='active')?prevV:'';
  state.selectedDriverId=driver.value;state.selectedVehicleId=vehicle.value;
  localStorage.setItem('sd.os3.driver',state.selectedDriverId||'');localStorage.setItem('sd.os3.vehicle',state.selectedVehicleId||'');
  const selected=state.drivers.find(d=>d.id===state.selectedDriverId);
  if(selected?.baseline) vision.setBaseline(selected.baseline);
  $('policyCalibrateBtn').disabled=!vision.streamActive||!selected;
  renderBaselineStatus();
}

function renderDrivers() {
  const active=state.drivers.filter(d=>d.status==='active').length;
  $('driverSummary').innerHTML=summaryCard('TOTAL PROFILES',state.drivers.length)+summaryCard('ACTIVE DRIVERS',active)+summaryCard('CALIBRATED PROFILES',state.drivers.filter(d=>d.baseline).length)+summaryCard('RESTRICTED',state.drivers.filter(d=>d.status==='restricted').length);
  const query=($('driverSearch').value||'').toLowerCase(),status=$('driverStatusFilter').value;
  const rows=state.drivers.filter(d=>(status==='all'||d.status===status)&&`${d.name} ${d.employee_code} ${d.license_ref}`.toLowerCase().includes(query));
  $('driversTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>DRIVER</th><th>IDENTIFIER</th><th>CALIBRATION</th><th>STATUS</th><th>PROFILE UPDATED</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(d=>`<tr><td><span class="table-primary">${esc(d.name)}</span><span class="sub-cell">${esc(d.email||'No email on file')}</span></td><td>${esc(d.employee_code||'—')}<span class="sub-cell">${esc(d.license_ref||'No licence ref')}</span></td><td>${d.baseline?`<span class="status-chip active">CALIBRATED</span><span class="sub-cell">${d.baseline.samples||0} stable frames · ${esc(d.baseline.quality||'usable')} quality</span>`:'<span class="status-chip inactive">NOT CALIBRATED</span>'}</td><td><span class="status-chip ${esc(d.status)}">${esc(d.status.toUpperCase())}</span></td><td>${fmtDate(d.updated_at)}</td><td><div class="row-actions"><button class="row-action" data-driver-edit="${esc(d.id)}">Edit</button><button class="row-action danger" data-driver-delete="${esc(d.id)}">Archive</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="table-empty"><b>No driver profiles found</b>Create a profile to assign monitoring sessions and store a personal baseline.</div>';
}
function renderVehicles() {
  const active=state.vehicles.filter(v=>v.status==='active').length;
  $('vehicleSummary').innerHTML=summaryCard('REGISTERED ASSETS',state.vehicles.length)+summaryCard('AVAILABLE',active)+summaryCard('IN MAINTENANCE',state.vehicles.filter(v=>v.status==='maintenance').length)+summaryCard('INACTIVE',state.vehicles.filter(v=>v.status==='inactive').length);
  const query=($('vehicleSearch').value||'').toLowerCase(),status=$('vehicleStatusFilter').value;
  const rows=state.vehicles.filter(v=>(status==='all'||v.status===status)&&`${v.label} ${v.registration} ${v.make_model}`.toLowerCase().includes(query));
  $('vehiclesTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>VEHICLE</th><th>REGISTRATION</th><th>TYPE / MODEL</th><th>STATUS</th><th>UPDATED</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(v=>`<tr><td><span class="table-primary">${esc(v.label)}</span><span class="sub-cell">Asset ID · ${esc(v.id.slice(-8).toUpperCase())}</span></td><td>${esc(v.registration)}</td><td>${esc(v.vehicle_type)}<span class="sub-cell">${esc(v.make_model||'Model not specified')}</span></td><td><span class="status-chip ${esc(v.status)}">${esc(v.status.toUpperCase())}</span></td><td>${fmtDate(v.updated_at)}</td><td><div class="row-actions"><button class="row-action" data-vehicle-edit="${esc(v.id)}">Edit</button><button class="row-action danger" data-vehicle-delete="${esc(v.id)}">Archive</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="table-empty"><b>No vehicles registered</b>Add a fleet asset to bind monitoring sessions to a real vehicle record.</div>';
}
function renderSessions() {
  $('sessionSummary').innerHTML=summaryCard('TOTAL RECORDS',state.sessions.length)+summaryCard('COMPLETED',state.sessions.filter(s=>s.status==='completed').length)+summaryCard('ACTIVE',state.sessions.filter(s=>s.status==='active').length)+summaryCard('TELEMETRY SAMPLES',state.sessions.reduce((sum,s)=>sum+Number(s.telemetry_count||0),0).toLocaleString());
  const q=($('sessionSearch').value||'').toLowerCase(),status=$('sessionStatusFilter').value;
  const rows=state.sessions.filter(s=>(status==='all'||s.status===status)&&`${s.id} ${nameForDriver(s.driver_id)} ${nameForVehicle(s.vehicle_id)}`.toLowerCase().includes(q));
  $('sessionsTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>SESSION</th><th>DRIVER / VEHICLE</th><th>STARTED</th><th>DURATION</th><th>TELEMETRY</th><th>EVENTS</th><th>ATTENTION</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(s=>`<tr><td><span class="table-primary">${esc(s.id.slice(-10).toUpperCase())}</span><span class="sub-cell">${esc(s.id)}</span></td><td><span class="table-primary">${esc(nameForDriver(s.driver_id))}</span><span class="sub-cell">${esc(nameForVehicle(s.vehicle_id))}</span></td><td>${fmtDate(s.started_at)}</td><td>${fmtDuration(s.duration_seconds||((s.ended_at?new Date(s.ended_at):new Date())-new Date(s.started_at))/1000)}</td><td>${Number(s.telemetry_count||0).toLocaleString()}</td><td>${s.incident_count||0}</td><td>${s.average_attention==null?'—':`${Math.round(s.average_attention)} / 100`}</td><td><span class="status-chip ${s.status==='active'?'restricted':'active'}">${esc(s.status.toUpperCase())}</span></td><td><div class="row-actions"><button class="row-action" data-session-detail="${esc(s.id)}">Inspect</button>${s.status==='active'?`<button class="row-action danger" data-session-finish="${esc(s.id)}">End</button>`:''}</div></td></tr>`).join('')}</tbody></table>`:'<div class="table-empty"><b>No monitoring sessions found</b>Start a monitored session to create a permanent record with linked telemetry.</div>';
}
function severityClass(value){return ['critical','high','medium','low'].includes(value)?value:'medium';}
function renderEvents() {
  const unacked=state.incidents.filter(i=>!i.acknowledged).length;
  $('eventSummary').innerHTML=summaryCard('TOTAL EVENTS',state.incidents.length)+summaryCard('UNACKNOWLEDGED',unacked)+summaryCard('CRITICAL',state.incidents.filter(i=>i.severity==='critical').length)+summaryCard('ACKNOWLEDGED',state.incidents.filter(i=>i.acknowledged).length);
  const q=($('eventSearch').value||'').toLowerCase(),type=$('eventTypeFilter').value,sev=$('eventSeverityFilter').value,ack=$('eventAckFilter').value;
  const rows=state.incidents.filter(i=>(type==='all'||i.event_type===type)&&(sev==='all'||i.severity===sev)&&(ack==='all'||String(Boolean(i.acknowledged))===ack)&&`${i.title} ${i.detail} ${i.event_type} ${nameForDriver(i.driver_id)}`.toLowerCase().includes(q));
  $('eventsTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>EVENT</th><th>EVENT TYPE</th><th>DRIVER / SESSION</th><th>SEVERITY</th><th>OCCURRED</th><th>ACKNOWLEDGEMENT</th><th>ACTION</th></tr></thead><tbody>${rows.map(i=>`<tr><td><span class="table-primary">${esc(i.title)}</span><span class="sub-cell">${esc(i.detail)}</span></td><td>${esc(i.event_type.replaceAll('_',' ').toUpperCase())}</td><td>${esc(nameForDriver(i.driver_id))}<span class="sub-cell">${esc(i.session_id?i.session_id.slice(-9).toUpperCase():'No session')}</span></td><td><span class="severity-chip ${severityClass(i.severity)}">${esc(i.severity.toUpperCase())}</span></td><td>${fmtDate(i.occurred_at)}</td><td><span class="ack-chip ${i.acknowledged?'':'pending'}">${i.acknowledged?'ACKNOWLEDGED':'PENDING REVIEW'}</span></td><td>${i.acknowledged?'—':`<button class="row-action" data-event-ack="${esc(i.id)}">Acknowledge</button>`}</td></tr>`).join('')}</tbody></table>`:'<div class="table-empty"><b>No matching event records</b>Adjust the filters or wait for the live engine to record safety events.</div>';
}

function renderPolicyForm() {
  const p=state.policies;
  const bindings={polEar:['earThreshold',v=>Number(v).toFixed(3)],polMar:['marThreshold',v=>Number(v).toFixed(2)],polDrowsy:['drowsyDelay',v=>`${Number(v).toFixed(1)} s`],polYawn:['yawnDelay',v=>`${Number(v).toFixed(1)} s`],polPose:['poseTolerance',v=>`${v}°`],polGaze:['gazeTolerance',v=>Number(v).toFixed(2)],polDistraction:['distractionDelay',v=>`${Number(v).toFixed(1)} s`],polFaceLost:['faceLostDelay',v=>`${Number(v).toFixed(1)} s`],polVolume:['alarmVolume',v=>`${v}%`]};
  Object.entries(bindings).forEach(([id,[key,format]])=>{if($(id)){$(id).value=p[key];$(`${id}Value`).textContent=format(p[key]);}});
  $('polAlarmTone').value=p.alarmTone;$('polAlarmEnabled').checked=p.alarmEnabled;$('polAutoStart').checked=p.autoStartMonitoring;$('polInterval').value=String(p.telemetryInterval);$('polRetention').value=String(p.retentionDays);
  $('policySavedLabel').textContent='SYNCED TO LOCAL POLICY';
  $('policyCalibrateBtn').disabled=!vision.streamActive||!state.selectedDriverId;
  renderBaselineStatus();
}
function renderBaselineStatus() {
  const d=state.drivers.find(item=>item.id===state.selectedDriverId),baseline=d?.baseline;
  $('baselineStatus').classList.toggle('active',Boolean(baseline));
  $('baselineStatus').innerHTML=`<i></i><span>${baseline?`Baseline calibrated · ${baseline.quality||'usable'} quality`:'No calibration loaded for selected driver'}</span>`;
  $('baselineDetail').textContent=baseline?`${baseline.samples||0} valid frames · Captured ${fmtDate(baseline.calibratedAt)} · EAR ${fmtNum(baseline.ear,3)} · Gaze ${fmtNum(baseline.gazeX,3)}`:'Connect a camera and select a driver profile to establish a personalised baseline.';
}

function renderJournal() {
  const filter=$('journalCategory')?.value||'all';
  const records=state.activity.filter(a=>filter==='all'||a.category===filter).slice(0,100);
  $('journalTable').innerHTML=records.map(a=>`<div class="journal-entry"><time>${fmtDate(a.created_at)}</time><div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p></div><span class="journal-category">${esc(a.category)}</span></div>`).join('')||'<div class="empty-row">No activity records are available.</div>';
  renderJournalStatus();
}
function renderJournalStatus() {
  const health=state.health||{},counts=state.storage?.counts||health.counts||{};
  $('systemStatusGrid').innerHTML=[['VISION ENGINE',vision.streamActive?'RUNNING':'STANDBY',vision.streamActive?'Camera pipeline connected':'Waiting for camera'],['DATABASE',state.online?'OPERATIONAL':'OFFLINE CACHE',state.online?'SQLite · WAL mode':'Browser cache only'],['PERSISTED RECORDS',Object.values(counts).reduce((sum,v)=>sum+Number(v||0),0).toLocaleString(),'Across all platform tables'],['PENDING SYNC',queueSize(),queueSize()?'Waiting for API connection':'Outbox is empty']].map(([a,b,c])=>`<div class="system-status-card"><span>${a}</span><b>${b}</b><small>${c}</small></div>`).join('');
  $('storageFigure').textContent=state.storage?fmtBytes(state.storage.database_size_bytes):'—';
  $('storageBreakdown').innerHTML=Object.entries(counts).map(([key,value])=>`<div><span>${esc(key.replaceAll('_',' '))}</span><b>${Number(value||0).toLocaleString()}</b></div>`).join('')||'<div><span>Waiting for database metadata</span><b>—</b></div>';
  $('syncStatusText').textContent=state.online?`${queueSize()} queued operations waiting to sync.`:'Local cache is active. Writes are queued until the API returns.';
}

function setMetric(id,value) { $(id).textContent=value; }
function handleMetrics(raw) {
  restoreFaceState();
  const p=state.policies,baseline=vision.baseline;
  const postureRisk=clamp((raw.poseDeviation-p.poseTolerance+6)/22*100,0,100);
  const gazeRisk=clamp((raw.gazeDeviation-p.gazeTolerance+.10)/.40*100,0,100);
  const eyeRisk=raw.ear<p.earThreshold?clamp((p.earThreshold-raw.ear)/Math.max(.02,p.earThreshold)*100,0,100):clamp((p.earThreshold+.04-raw.ear)/.04*45,0,45);
  const mouthRisk=raw.mar>p.marThreshold?30:0;
  const postureScore=Math.round(100-clamp((raw.poseDeviation-p.poseTolerance)*3.4,0,100));
  const attentionScore=Math.round(clamp(100-gazeRisk*.67-postureRisk*.33,0,100));
  const riskScore=Math.round(clamp(eyeRisk*.48+gazeRisk*.22+postureRisk*.20+mouthRisk*.10,0,100));
  const metrics={...raw,postureScore,attentionScore,riskScore,eyesClosed:raw.ear<p.earThreshold,yawning:raw.mar>p.marThreshold,trackingConfidence:raw.trackingConfidence};
  state.currentMetrics=metrics;state.currentRisk=riskScore;
  $('sessionBtn').disabled=!state.currentSession&&!state.currentMetrics;$('calibrateBtn').disabled=false;$('policyCalibrateBtn').disabled=!state.selectedDriverId;
  updateMetricCards(metrics);updateDriverState(metrics);evaluateRules(metrics,performance.now());
  if(state.currentSession) collectTelemetry(metrics);
  if(state.calibration) collectCalibration(metrics);
}
function updateMetricCards(m) {
  setMetric('earValue',fmtNum(m.ear,3));setMetric('marValue',fmtNum(m.mar,3));
  $('postureValue').innerHTML=`${m.postureScore}<small>/100</small>`;$('attentionValue').innerHTML=`${m.attentionScore}<small>/100</small>`;
  $('earBar').style.width=`${clamp(m.ear/.45*100,0,100)}%`;$('marBar').style.width=`${clamp(m.mar/1.1*100,0,100)}%`;$('postureBar').style.width=`${m.postureScore}%`;$('attentionBar').style.width=`${m.attentionScore}%`;
  setMetric('earState',m.eyesClosed?'Eyes closing / closed':'Eyes open');setMetric('marState',m.yawning?'Mouth open':'Neutral range');setMetric('postureState',m.poseDeviation>state.policies.poseTolerance?'Head deviation':'Aligned');setMetric('attentionState',m.attentionScore<65?'Attention diverted':'Forward attention');
  setMetric('earThresholdLabel',Number(state.policies.earThreshold).toFixed(3));setMetric('marThresholdLabel',Number(state.policies.marThreshold).toFixed(2));setMetric('poseDeviationLabel',`${m.poseDeviation.toFixed(1)}°`);setMetric('gazeDeltaLabel',m.gazeDelta.toFixed(3));
  setMetric('resolutionLabel',`${$('cameraVideo').videoWidth} × ${$('cameraVideo').videoHeight}`);setMetric('fpsLabel',`${m.fps.toFixed(0)} FPS`);setMetric('inferenceLabel',`${m.inferenceMs.toFixed(1)} ms`);setMetric('landmarkCount',String(m.landmarkCount));setMetric('faceLockLabel',`LOCKED · ${m.trackingConfidence}%`);
  $('cameraLost').classList.remove('visible');
}
function updateDriverState(m) {
  setMetric('riskScore',String(m.riskScore));
  const color=m.riskScore>=70?'#bd6659':m.riskScore>=40?'#c69a61':'#69a77d';
  $('riskMeter').style.background=`conic-gradient(${color} ${m.riskScore*3.6}deg,var(--risk-track,#e9eee8) 0deg)`;
  $('riskLabel').textContent=m.riskScore>=70?'Elevated driver risk':m.riskScore>=40?'Attention needs review':'Stable driver state';
  $('riskDetail').textContent=m.eyesClosed?'Sustained eye closure is being monitored.':m.attentionScore<65?'Gaze or head pose is outside the calibrated forward range.':'No high-risk signal currently detected.';
  $('driverStateTag').textContent=m.riskScore>=70?'ELEVATED':m.riskScore>=40?'WATCH':'ATTENTIVE';$('driverStateTag').classList.toggle('active',m.riskScore<40);
  setMetric('stateEye',m.eyesClosed?'Closed':'Open');setMetric('statePose',m.poseDeviation>state.policies.poseTolerance?'Off-centre':'Aligned');setMetric('stateGaze',m.gazeDeviation>state.policies.gazeTolerance?'Diverted':'Forward');setMetric('stateConfidence',`${m.trackingConfidence}%`);
  if(state.currentSession){
    setMetric('sessionSamples',state.currentSession.telemetry_count.toLocaleString());
    setMetric('sessionEvents',state.currentSession.incident_count.toLocaleString());
    setMetric('sessionAttention',state.sessionStats.samples?`${Math.round(state.sessionStats.attentionTotal/state.sessionStats.samples)}/100`:'—');
  }
}

function resetRuleTimers() {
  state.eventTimers={eyeStart:0,eyeTriggered:false,eyeOpenSince:0,yawnStart:0,yawnTriggered:false,poseStart:0,poseTriggered:false,distractionStart:0,distractionTriggered:false,faceLostStart:0,faceLostTriggered:false};
  alarm.clearCondition();
}
function evaluateRules(m,now) {
  const t=state.eventTimers,p=state.policies,seconds=now/1000;
  if(m.eyesClosed){
    t.eyeOpenSince=0;if(!t.eyeStart)t.eyeStart=seconds;
    if(!t.eyeTriggered && seconds-t.eyeStart>=p.drowsyDelay){
      t.eyeTriggered=true;
      addIncident('drowsiness','Sustained eye closure',`Eye aspect ratio ${m.ear.toFixed(3)} remained below the ${p.earThreshold.toFixed(3)} threshold for ${(seconds-t.eyeStart).toFixed(1)} seconds.`, 'critical',m,Math.round((seconds-t.eyeStart)*1000));
      if(p.alarmEnabled) void alarm.start();
    }
  }else{
    if(t.eyeTriggered){if(!t.eyeOpenSince)t.eyeOpenSince=seconds;if(seconds-t.eyeOpenSince>=.45){alarm.clearCondition();t.eyeStart=0;t.eyeTriggered=false;t.eyeOpenSince=0;}}
    else {t.eyeStart=0;t.eyeOpenSince=0;}
  }
  if(m.yawning){if(!t.yawnStart)t.yawnStart=seconds;if(!t.yawnTriggered&&seconds-t.yawnStart>=p.yawnDelay){t.yawnTriggered=true;addIncident('yawning','Sustained yawning detected',`Mouth aspect ratio ${m.mar.toFixed(3)} exceeded the configured threshold.`, 'medium',m,Math.round((seconds-t.yawnStart)*1000));}}
  else {t.yawnStart=0;t.yawnTriggered=false;}
  const postureOff=m.poseDeviation>p.poseTolerance;
  if(postureOff){if(!t.poseStart)t.poseStart=seconds;if(!t.poseTriggered&&seconds-t.poseStart>=p.postureDelay){t.poseTriggered=true;addIncident('posture','Head posture deviation',`Head pose deviated ${m.poseDeviation.toFixed(1)}° from the calibrated baseline.`, 'medium',m,Math.round((seconds-t.poseStart)*1000));}}
  else {t.poseStart=0;t.poseTriggered=false;}
  const distracted=m.gazeDeviation>p.gazeTolerance || postureOff;
  if(distracted){if(!t.distractionStart)t.distractionStart=seconds;if(!t.distractionTriggered&&seconds-t.distractionStart>=p.distractionDelay){t.distractionTriggered=true;addIncident('distraction','Forward attention deviation','Head pose or iris position remained outside the configured forward-attention tolerance.','high',m,Math.round((seconds-t.distractionStart)*1000));}}
  else {t.distractionStart=0;t.distractionTriggered=false;}
}
function handleFaceLost() {
  state.currentMetrics=null;
  $('sessionBtn').disabled=!state.currentSession;$('calibrateBtn').disabled=true;$('policyCalibrateBtn').disabled=true;
  $('cameraLost').classList.add('visible');$('trackingPill').classList.remove('active');$('trackingPill').innerHTML='<i></i> FACE SEARCHING';$('faceLockLabel').textContent='SEARCHING';
  ['earValue','marValue','postureValue','attentionValue'].forEach(id=>$(id).textContent='—');
  ['earState','marState','postureState','attentionState'].forEach(id=>$(id).textContent='Face not visible');
  if(state.currentSession){
    const t=state.eventTimers,now=performance.now()/1000;
    if(!t.faceLostStart)t.faceLostStart=now;
    if(!t.faceLostTriggered&&now-t.faceLostStart>=state.policies.faceLostDelay){t.faceLostTriggered=true;addIncident('face_lost','Face tracking interrupted','The face landmark engine could not maintain a face lock. Check camera alignment and lighting.','high',null,Math.round((now-t.faceLostStart)*1000));}
  }
  setMetric('stateEye','Unknown');setMetric('statePose','Unknown');setMetric('stateGaze','Unknown');setMetric('stateConfidence','—');
  if(state.currentMetrics===null){/* telemetry intentionally pauses without a face */}
}
function restoreFaceState() { state.eventTimers.faceLostStart=0;state.eventTimers.faceLostTriggered=false; }

function addIncident(type,title,detail,severity,metrics,durationMs=0) {
  const id=uid('evt'),incident={id,session_id:state.currentSession?.id||null,driver_id:state.selectedDriverId||null,vehicle_id:state.selectedVehicleId||null,event_type:type,title,detail,severity,occurred_at:isoNow(),duration_ms:durationMs,acknowledged:false,metrics:metrics?{ear:metrics.ear,mar:metrics.mar,posture_score:metrics.postureScore,attention_score:metrics.attentionScore,risk_score:metrics.riskScore,pitch_delta:metrics.pitchDelta,yaw_delta:metrics.yawDelta,roll_delta:metrics.rollDelta,gaze_delta:metrics.gazeDelta,tracking_confidence:metrics.trackingConfidence}: {},source:'mediapipe-face-landmarker'};
  state.incidents.unshift(incident);state.incidents=state.incidents.slice(0,5000);
  if(state.currentSession){state.currentSession.incident_count+=1;state.sessionStats.incidents+=1;}
  state.liveEvents.unshift(incident);state.liveEvents=state.liveEvents.slice(0,8);
  void apiWrite('POST','/api/incidents',{...incident,metrics:incident.metrics});
  saveCache();renderNavCounts();renderEvents();renderCommand();renderLiveEvents();
  toast(`${title} · ${severity.toUpperCase()}`,severity==='critical'?'error':'info');
}
function renderLiveEvents(){
  $('liveEventCount').textContent=`${state.liveEvents.length} events`;
  $('liveEventFeed').innerHTML=state.liveEvents.map(i=>`<div class="live-event-item ${i.severity==='critical'?'critical':''}"><i></i><span>${esc(i.title)}</span><time>${fmtTime(i.occurred_at)}</time></div>`).join('')||'<div class="empty-row">Monitoring events will stream here.</div>';
}

async function connectCamera() {
  $('enableCameraBtn').disabled=true;$('enableCameraBtn').textContent='Initialising vision engine…';
  await alarm.unlock();
  try {
    const info=await vision.start();
    $('cameraStage').classList.add('has-feed');$('cameraDot').classList.add('online');$('cameraSourceLabel').textContent=info.label;$('resolutionLabel').textContent=`${info.width} × ${info.height}`;
    $('enableCameraBtn').textContent='Camera connected';$('stopCameraBtn').disabled=false;$('switchCameraBtn').disabled=info.cameras.length<2;$('calibrateBtn').disabled=false;
    $('policyCalibrateBtn').disabled=!state.selectedDriverId;
    $('liveNavDot').classList.add('active');updateEngineStatus('FACE LANDMARKER READY');
    const driver=state.drivers.find(d=>d.id===state.selectedDriverId);vision.setBaseline(driver?.baseline||null);
    toast('Camera connected. Face lock and live safety rules are active.','success');
    if(state.policies.autoStartMonitoring) setTimeout(()=>{if(!state.currentSession&&state.currentMetrics)startSession();},900);
  } catch(error) {
    console.error(error);$('enableCameraBtn').disabled=false;$('enableCameraBtn').textContent='Enable camera ↗';toast(error.message||'Unable to initialise camera.','error');
  }
}
async function disconnectCamera() {
  let sessionError = null;
  if(state.currentSession) {
    try { await stopSession(); } catch(error) { sessionError = error; }
  }
  if(state.calibration) cancelCalibration();
  alarm.stop();
  state.currentMetrics = null;
  state.currentSession = null;
  state.sessionStats = null;
  state.sessionStartedAt = 0;
  state.telemetryBuffer = [];
  resetRuleTimers();
  vision.stop(true);
  $('cameraStage').classList.remove('has-feed','expanded');
  document.body.classList.remove('camera-expanded-open');
  $('cameraDot').classList.remove('online');$('liveNavDot').classList.remove('active');$('cameraSourceLabel').textContent='No camera connected';
  $('resolutionLabel').textContent='—';$('faceLockLabel').textContent='SEARCHING';$('fpsLabel').textContent='0';$('inferenceLabel').textContent='— ms';$('landmarkCount').textContent='—';$('cameraLost').classList.remove('visible');
  ['earValue','marValue','postureValue','attentionValue'].forEach(id=>$(id).textContent='—');
  ['earState','marState','postureState','attentionState'].forEach(id=>$(id).textContent='Waiting for face signal');
  ['earBar','marBar','postureBar','attentionBar'].forEach(id=>$(id).style.width='0%');
  $('stateEye').textContent='Unknown';$('statePose').textContent='Unknown';$('stateGaze').textContent='Unknown';$('stateConfidence').textContent='—';
  $('riskScore').textContent='—';$('riskLabel').textContent='Awaiting signal';$('riskDetail').textContent='Connect the camera and establish a stable face lock.';$('riskMeter').style.background='conic-gradient(#65a77c 0deg,var(--risk-track,#e9eee8) 0deg)';
  $('sessionBtn').classList.remove('recording');$('sessionBtnText').textContent='Start session';$('sessionBtn').disabled=true;
  $('sessionSamples').textContent='0';$('sessionEvents').textContent='0';$('sessionAttention').textContent='—';$('sessionDuration').textContent='00:00:00';$('sessionReference').value='';
  $('recordingState').textContent='NOT RECORDING';$('recordingState').classList.remove('active');$('sessionHelper').textContent='Live alerts are evaluated once the camera is connected. Start a session to persist continuous telemetry.';
  $('enableCameraBtn').disabled=false;$('enableCameraBtn').textContent='Enable camera ↗';$('stopCameraBtn').disabled=true;$('switchCameraBtn').disabled=true;$('calibrateBtn').disabled=true;$('policyCalibrateBtn').disabled=true;
  $('trackingPill').classList.remove('active');$('trackingPill').innerHTML='<i></i> ENGINE STANDBY';
  updateEngineStatus('ENGINE STANDBY');renderAll();
  toast(sessionError ? `Camera disconnected. Session could not be archived: ${sessionError.message||sessionError}` : 'Camera disconnected.');
}
async function switchCamera() { try {const info=await vision.switchCamera();$('cameraSourceLabel').textContent=info.label;$('resolutionLabel').textContent=`${info.width} × ${info.height}`;toast('Camera source switched.');}catch(error){toast(error.message,'error');} }

async function startSession() {
  if(!vision.streamActive){toast('Connect the camera before starting a session.','error');return;}
  if(!state.currentMetrics){toast('A stable face lock is required before starting a session.','error');return;}
  const id=uid('ses'),started=isoNow();
  const record={id,driver_id:state.selectedDriverId||null,vehicle_id:state.selectedVehicleId||null,started_at:started,notes:'',meta:{vision_engine:'MediaPipe Face Landmarker',landmarks:478,telemetry_interval_ms:state.policies.telemetryInterval}};
  state.currentSession={...record,status:'active',telemetry_count:0,incident_count:0};state.sessionStartedAt=Date.now();state.sessionStats={samples:0,attentionTotal:0,postureTotal:0,riskTotal:0,peakRisk:0,incidents:0};state.lastTelemetryAt=0;state.lastTelemetryFlush=Date.now();state.telemetryBuffer=[];
  $('sessionReference').value=id;$('sessionBtn').disabled=false;$('sessionBtn').classList.add('recording');$('sessionBtnText').textContent='End session';$('recordingState').textContent='RECORDING LIVE';$('recordingState').classList.add('active');$('sessionHelper').textContent='Session telemetry is being captured and written to the local database. Incident detection remains active.';
  await apiWrite('POST','/api/sessions',record);saveCache();renderNavCounts();toast('Monitoring session started. Telemetry persistence is active.','success');
}
async function finishTelemetryBatch() {
  if(!state.currentSession||!state.telemetryBuffer.length)return;
  const id=state.currentSession.id,buffer=state.telemetryBuffer.splice(0,state.telemetryBuffer.length);
  await apiWrite('POST',`/api/sessions/${encodeURIComponent(id)}/telemetry`,{samples:buffer});
}
async function stopSession() {
  if(!state.currentSession)return;
  await finishTelemetryBatch();
  const session=state.currentSession,stats=state.sessionStats,duration=(Date.now()-state.sessionStartedAt)/1000;
  const payload={ended_at:isoNow(),duration_seconds:duration,average_attention:stats.samples?stats.attentionTotal/stats.samples:null,average_posture:stats.samples?stats.postureTotal/stats.samples:null,average_risk:stats.samples?stats.riskTotal/stats.samples:null,peak_risk:stats.samples?stats.peakRisk:null,telemetry_count:stats.samples,incident_count:stats.incidents};
  await apiWrite('POST',`/api/sessions/${encodeURIComponent(session.id)}/end`,payload);
  state.sessions.unshift({...session,...payload,status:'completed'});state.sessions=state.sessions.slice(0,1000);state.currentSession=null;state.sessionStats=null;
  $('sessionBtn').classList.remove('recording');$('sessionBtnText').textContent='Start session';$('sessionBtn').disabled=!state.currentMetrics;$('recordingState').textContent='NOT RECORDING';$('recordingState').classList.remove('active');$('sessionDuration').textContent='00:00:00';$('sessionReference').value='';$('sessionHelper').textContent='Live alerts remain active while the camera is connected. Start another session to persist telemetry.';
  saveCache();renderAll();void refreshHealth();void loadAnalytics(30);toast(`Session archived · ${payload.telemetry_count.toLocaleString()} telemetry samples saved.`,'success');
}
async function finishArchivedSession(sessionId) {
  const session=state.sessions.find(item=>item.id===sessionId);
  if(!session||session.status!=='active')return;
  if(state.currentSession?.id===sessionId){await stopSession();return;}
  if(!window.confirm('End this active session and archive it?'))return;

  const endedAt=isoNow();
  const startedAt=Date.parse(session.started_at);
  const duration=Number.isFinite(startedAt)?Math.max(0,(Date.now()-startedAt)/1000):0;
  const payload={
    ended_at:endedAt,
    duration_seconds:duration,
    average_attention:null,
    average_posture:null,
    average_risk:null,
    peak_risk:null,
    telemetry_count:Number(session.telemetry_count||0),
    incident_count:Number(session.incident_count||0)
  };

  try{
    const result=await apiWrite('POST',`/api/sessions/${encodeURIComponent(sessionId)}/end`,payload);
    session.status='completed';
    session.ended_at=endedAt;
    session.duration_seconds=duration;
    saveCache();
    renderAll();
    if(result?.queued){
      toast('Session end queued. It will sync when the backend is reachable.','info');
      return;
    }
    await refreshSessionsAndIncidents();
    toast('Previously active session archived.','success');
  }catch(error){
    toast(`Could not end session: ${error.message||error}`,'error');
  }
}

function updateSessionClock() {
  if(!state.currentSession)return;
  $('sessionDuration').textContent=fmtDuration((Date.now()-state.sessionStartedAt)/1000);
}
function collectTelemetry(m) {
  const now=Date.now(),interval=Number(state.policies.telemetryInterval)||1000;
  if(now-state.lastTelemetryAt<interval)return;
  state.lastTelemetryAt=now;
  const sample={id:uid('tel'),recorded_at:isoNow(),elapsed_ms:now-state.sessionStartedAt,ear:m.ear,mar:m.mar,left_ear:m.leftEAR,right_ear:m.rightEAR,posture_score:m.postureScore,attention_score:m.attentionScore,risk_score:m.riskScore,pitch_delta:m.pitchDelta,yaw_delta:m.yawDelta,roll_delta:m.rollDelta,gaze_delta:m.gazeDelta,tracking_confidence:m.trackingConfidence,fps:m.fps,inference_ms:m.inferenceMs,face_count:1,state:m.riskScore>=70?'elevated':m.riskScore>=40?'watch':'attentive'};
  state.telemetryBuffer.push(sample);const stats=state.sessionStats;stats.samples+=1;stats.attentionTotal+=m.attentionScore;stats.postureTotal+=m.postureScore;stats.riskTotal+=m.riskScore;stats.peakRisk=Math.max(stats.peakRisk,m.riskScore);
  state.currentSession.telemetry_count+=1;
  $('sessionSamples').textContent=state.currentSession.telemetry_count.toLocaleString();$('sessionEvents').textContent=state.currentSession.incident_count.toLocaleString();$('sessionAttention').textContent=Math.round(stats.attentionTotal/stats.samples);
  if(state.telemetryBuffer.length>=5||now-state.lastTelemetryFlush>=5000){state.lastTelemetryFlush=now;void finishTelemetryBatch();}
}

function startCalibration() {
  if(!vision.streamActive||!state.currentMetrics){toast('Connect the camera and acquire a face lock before calibration.','error');return;}
  const driver=state.drivers.find(d=>d.id===state.selectedDriverId);
  if(!driver){toast('Select an active driver profile before calibrating.','error');return;}
  if(state.calibration)return;
  state.calibration={started:performance.now(),duration:8000,samples:[],lastFeedback:0,stableReference:null};
  $('calibrationDialog').showModal();$('calibrationTitle').textContent=`Calibrating ${driver.name}`;$('calibrationMessage').textContent='Sit naturally, face the camera and look forward. Keep both eyes open with a relaxed expression.';$('calibrationSamples').textContent='0';$('calibrationTime').textContent='8.0';$('calibrationProgress').style.width='0%';$('calibrationFeedback').textContent='Collecting stable facial landmarks…';
  state.calibration.raf=requestAnimationFrame(calibrationProgressLoop);
}
function calibrationProgressLoop(now) {
  if(!state.calibration)return;
  const p=state.calibration,progress=clamp((now-p.started)/p.duration,0,1);
  $('calibrationTime').textContent=(Math.max(0,p.duration-(now-p.started))/1000).toFixed(1);$('calibrationProgress').style.width=`${progress*100}%`;
  if(progress>=1){completeCalibration();return;}
  p.raf=requestAnimationFrame(calibrationProgressLoop);
}
function collectCalibration(m) {
  const p=state.calibration;if(!p)return;
  if(m.ear<.12){$('calibrationFeedback').textContent='Keep both eyes comfortably open.';return;}
  if(m.mar>state.policies.marThreshold+.15){$('calibrationFeedback').textContent='Relax your mouth and hold a neutral expression.';return;}
  if(m.trackingConfidence<60){$('calibrationFeedback').textContent='Move into the frame and improve your lighting.';return;}
  const sample={ear:m.ear,gazeX:m.gazeX,pitch:m.pitch,yaw:m.yaw,roll:m.roll};
  const recent=p.samples.slice(-28);
  if(recent.length>=12){
    const limits={ear:.09,gazeX:.22,pitch:8,yaw:8,roll:8};
    const stable=Object.keys(limits).every(key=>Math.abs(sample[key]-median(recent.map(x=>x[key])))<=limits[key]);
    if(!stable){$('calibrationFeedback').textContent='Hold your head steady and keep your gaze forward.';return;}
  }
  p.samples.push(sample);if(p.samples.length>400)p.samples.shift();$('calibrationSamples').textContent=p.samples.length;
  if(performance.now()-p.lastFeedback>600){$('calibrationFeedback').textContent=p.samples.length>=50?'Signal quality looks good. Keep holding this natural position…':'Good face lock. Gathering enough valid samples…';p.lastFeedback=performance.now();}
}
async function completeCalibration() {
  const p=state.calibration;if(!p)return;
  cancelAnimationFrame(p.raf);state.calibration=null;$('calibrationDialog').close();
  if(p.samples.length<50){toast(`Calibration rejected: only ${p.samples.length} stable samples were collected. Improve lighting and retry.`,'error');return;}
  const stats={pitch:Math.sqrt(average(p.samples.map(s=>(s.pitch-median(p.samples.map(x=>x.pitch)))**2))),yaw:Math.sqrt(average(p.samples.map(s=>(s.yaw-median(p.samples.map(x=>x.yaw)))**2))),gaze:Math.sqrt(average(p.samples.map(s=>(s.gazeX-median(p.samples.map(x=>x.gazeX)))**2)))};
  const baseline={version:3,ear:robust(p.samples.map(s=>s.ear)),gazeX:robust(p.samples.map(s=>s.gazeX)),pitch:robust(p.samples.map(s=>s.pitch)),yaw:robust(p.samples.map(s=>s.yaw)),roll:robust(p.samples.map(s=>s.roll)),calibratedAt:isoNow(),samples:p.samples.length,stability:{pitch:Number(stats.pitch.toFixed(2)),yaw:Number(stats.yaw.toFixed(2)),gaze:Number(stats.gaze.toFixed(3))},quality:p.samples.length>=120&&stats.pitch<4.5&&stats.yaw<4.5&&stats.gaze<.15?'high':'usable'};
  const driver=state.drivers.find(d=>d.id===state.selectedDriverId);if(!driver)return;
  driver.baseline=baseline;driver.updated_at=isoNow();vision.setBaseline(baseline);
  if(!localStorage.getItem('sd.os3.ear-manual'))state.policies.earThreshold=clamp(baseline.ear*.70,.15,.27);
  await persistDriver(driver);await savePolicies(false);
  renderDrivers();renderPolicyForm();$('earThresholdLabel').textContent=state.policies.earThreshold.toFixed(3);
  toast(`Personal baseline saved for ${driver.name} · ${p.samples.length} stable samples · ${baseline.quality} quality.`,'success');
}
function cancelCalibration(){if(!state.calibration)return;cancelAnimationFrame(state.calibration.raf);state.calibration=null;$('calibrationDialog').close();toast('Calibration cancelled. Previous baseline retained.');}

async function savePolicies(showToast=true) {
  const payload={policies:{...state.policies}};writePreferences(state.policies);$('policySavedLabel').textContent='SAVING…';
  try{const result=await apiWrite('PUT','/api/policies',payload);$('policySavedLabel').textContent=result.queued?'QUEUED OFFLINE':'SYNCED TO SQLITE';$('policyUpdatedAt').textContent=fmtDate(result.updated_at||isoNow());if(showToast)toast(result.queued?'Policy saved locally and queued for sync.':'Safety policy set saved to SQLite.','success');}
  catch(error){$('policySavedLabel').textContent='SAVE FAILED';toast(error.message,'error');}
}
function bindPolicyRange(id,key,format) {
  $(id).addEventListener('input',event=>{state.policies[key]=Number(event.target.value);$(`${id}Value`).textContent=format(state.policies[key]);writePreferences(state.policies);$('policySavedLabel').textContent='UNSAVED CHANGES';if(key==='earThreshold')localStorage.setItem('sd.os3.ear-manual','1');});
}

async function createOrUpdateDriver(payload,id='') {
  const recordId=id||uid('drv');
  const method=id?'PUT':'POST',path=id?`/api/drivers/${encodeURIComponent(id)}`:'/api/drivers';
  const result=await apiWrite(method,path,{...payload,id:recordId});
  const record={...payload,id:recordId,created_at:result.created_at||isoNow(),updated_at:isoNow(),baseline:payload.baseline||null};
  const idx=state.drivers.findIndex(d=>d.id===record.id);if(idx>=0)state.drivers[idx]={...state.drivers[idx],...record};else state.drivers.push(record);
  saveCache();renderAll();return record;
}
async function persistDriver(driver) {
  const payload={name:driver.name,employee_code:driver.employee_code||'',license_ref:driver.license_ref||'',phone:driver.phone||'',email:driver.email||'',status:driver.status||'active',notes:driver.notes||'',baseline:driver.baseline||null};
  await apiWrite('PUT',`/api/drivers/${encodeURIComponent(driver.id)}`,payload);saveCache();
}
function openDriverDialog(driver=null) {
  $('driverForm').reset();$('driverId').value=driver?.id||'';$('driverDialogTitle').textContent=driver?'Edit driver profile':'New driver profile';
  $('driverName').value=driver?.name||'';$('driverCode').value=driver?.employee_code||'';$('driverLicense').value=driver?.license_ref||'';$('driverPhone').value=driver?.phone||'';$('driverEmail').value=driver?.email||'';$('driverStatus').value=driver?.status||'active';$('driverNotes').value=driver?.notes||'';$('driverDialog').showModal();
}
async function saveDriverFromForm(event) {
  event.preventDefault();const id=$('driverId').value,old=state.drivers.find(d=>d.id===id);
  const payload={name:$('driverName').value.trim(),employee_code:$('driverCode').value.trim(),license_ref:$('driverLicense').value.trim(),phone:$('driverPhone').value.trim(),email:$('driverEmail').value.trim(),status:$('driverStatus').value,notes:$('driverNotes').value.trim(),baseline:old?.baseline||null};
  try{await createOrUpdateDriver(payload,id);$('driverDialog').close();toast(id?'Driver profile updated.':'Driver profile created.','success');populateAssignments();}
  catch(error){toast(error.message,'error');}
}
async function deleteDriver(id) {
  const driver=state.drivers.find(d=>d.id===id);if(!driver)return;
  if(!confirm(`Archive ${driver.name}? Saved sessions will remain linked to this profile.`))return;
  try{const result=await apiWrite('DELETE',`/api/drivers/${encodeURIComponent(id)}`);if(result.status==='deleted')state.drivers=state.drivers.filter(item=>item.id!==id);else{driver.status='inactive';driver.updated_at=isoNow();}saveCache();renderAll();toast(result.status==='archived'||result.queued?'Driver archived or queued for archive. Existing records are retained.':'Driver profile deleted.','success');}
  catch(error){toast(error.message,'error');}
}
function openVehicleDialog(vehicle=null) {
  $('vehicleForm').reset();$('vehicleId').value=vehicle?.id||'';$('vehicleDialogTitle').textContent=vehicle?'Edit vehicle':'Register vehicle';
  $('vehicleLabel').value=vehicle?.label||'';$('vehicleRegistration').value=vehicle?.registration||'';$('vehicleMake').value=vehicle?.make_model||'';$('vehicleType').value=vehicle?.vehicle_type||'Car';$('vehicleStatus').value=vehicle?.status||'active';$('vehicleNotes').value=vehicle?.notes||'';$('vehicleDialog').showModal();
}
async function saveVehicleFromForm(event) {
  event.preventDefault();const id=$('vehicleId').value,payload={label:$('vehicleLabel').value.trim(),registration:$('vehicleRegistration').value.trim().toUpperCase(),make_model:$('vehicleMake').value.trim(),vehicle_type:$('vehicleType').value,status:$('vehicleStatus').value,notes:$('vehicleNotes').value.trim()};
  try{const recordId=id||uid('veh');const result=await apiWrite(id?'PUT':'POST',id?`/api/vehicles/${encodeURIComponent(id)}`:'/api/vehicles',{...payload,id:recordId});const record={...payload,id:recordId,updated_at:isoNow(),created_at:result.created_at||isoNow()};const idx=state.vehicles.findIndex(v=>v.id===record.id);if(idx>=0)state.vehicles[idx]={...state.vehicles[idx],...record};else state.vehicles.push(record);saveCache();$('vehicleDialog').close();renderAll();toast(id?'Vehicle updated.':'Vehicle registered.','success');}
  catch(error){toast(error.message,'error');}
}
async function deleteVehicle(id) {
  const vehicle=state.vehicles.find(v=>v.id===id);if(!vehicle)return;if(!confirm(`Archive ${vehicle.label} (${vehicle.registration})?`))return;
  try{const result=await apiWrite('DELETE',`/api/vehicles/${encodeURIComponent(id)}`);if(result.status==='deleted')state.vehicles=state.vehicles.filter(item=>item.id!==id);else vehicle.status='inactive';saveCache();renderAll();toast(result.status==='archived'||result.queued?'Vehicle archived or queued for archive. Saved sessions are retained.':'Vehicle deleted.','success');}
  catch(error){toast(error.message,'error');}
}

async function showSessionDetail(id) {
  const s=state.sessions.find(item=>item.id===id);if(!s)return;
  $('detailTitle').textContent=`Session ${id.slice(-10).toUpperCase()}`;
  $('detailBody').innerHTML=`<div class="detail-row"><span>Driver</span><b>${esc(nameForDriver(s.driver_id))}</b></div><div class="detail-row"><span>Vehicle</span><b>${esc(nameForVehicle(s.vehicle_id))}</b></div><div class="detail-row"><span>Started</span><b>${fmtDate(s.started_at)}</b></div><div class="detail-row"><span>Ended</span><b>${fmtDate(s.ended_at)}</b></div><div class="detail-row"><span>Duration</span><b>${fmtDuration(s.duration_seconds)}</b></div><div class="detail-row"><span>Telemetry samples</span><b>${Number(s.telemetry_count||0).toLocaleString()}</b></div><div class="detail-row"><span>Recorded events</span><b>${s.incident_count||0}</b></div><div class="detail-row"><span>Average attention</span><b>${s.average_attention==null?'—':`${Math.round(s.average_attention)} / 100`}</b></div><div class="detail-row"><span>Average risk</span><b>${s.average_risk==null?'—':`${Math.round(s.average_risk)} / 100`}</b></div><div id="sessionDetailTelemetry"><div class="empty-row">Loading telemetry trace…</div></div>`;
  $('detailDialog').showModal();
  try{const rows=await apiGet(`/api/sessions/${encodeURIComponent(id)}/telemetry?limit=5000`);const canvas=document.createElement('canvas');canvas.className='detail-chart';canvas.height=160;$('sessionDetailTelemetry').innerHTML='<div class="section-label" style="margin-top:15px">SESSION TELEMETRY TRACE</div>';if(rows.length){$('sessionDetailTelemetry').append(canvas);drawTrend(canvas,rows.map(r=>({day:new Date(r.recorded_at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}),attention:r.attention_score,posture:r.posture_score})));}else $('sessionDetailTelemetry').innerHTML+='<div class="empty-row">No telemetry samples were stored for this session.</div>';}
  catch{ $('sessionDetailTelemetry').innerHTML='<div class="empty-row">Telemetry is unavailable while the database is offline.</div>'; }
}
async function acknowledgeIncident(id) {
  const item=state.incidents.find(i=>i.id===id);if(!item)return;
  try{await apiWrite('PATCH',`/api/incidents/${encodeURIComponent(id)}/acknowledge`);item.acknowledged=true;item.acknowledged_at=isoNow();state.activity.unshift({id:uid('act'),category:'safety',title:'Incident acknowledged',detail:item.title,level:'info',created_at:isoNow()});saveCache();renderAll();toast('Event acknowledged and written to the audit trail.','success');}
  catch(error){toast(error.message,'error');}
}

async function loadAnalytics(days=30) {
  try{state.analytics=await apiGet(`/api/analytics?days=${days}`);renderAnalytics();renderCommand();}
  catch{state.analytics=null;renderAnalytics();}
}
function renderAnalytics() {
  const a=state.analytics;if(!a){$('analyticsKpis').innerHTML='';return;}
  $('analyticsKpis').innerHTML=[['SESSIONS',a.sessions],['MONITORING TIME',fmtDuration(a.total_duration_seconds)],['TELEMETRY SAMPLES',Number(a.samples).toLocaleString()],['AVG ATTENTION',a.average_attention==null?'—':`${Math.round(a.average_attention)}/100`],['SAFETY EVENTS',a.incidents]].map(([label,value])=>`<div class="analytics-kpi"><span>${label}</span><b>${esc(value)}</b></div>`).join('');
  drawTrend($('analyticsTrend'),a.daily||[]);$('analyticsTrendEmpty').classList.toggle('visible',!a.daily?.length);$('analyticsTrend').style.display=a.daily?.length?'block':'none';
  const total=(a.incidents_by_type||[]).reduce((sum,x)=>sum+x.count,0);
  const labels={drowsiness:'Drowsiness',yawning:'Yawning',posture:'Head posture',distraction:'Attention deviation',face_lost:'Face tracking lost'};
  $('eventBreakdown').innerHTML=a.incidents_by_type?.length?a.incidents_by_type.map(item=>`<div class="breakdown-item"><div class="breakdown-item-top"><span>${esc(labels[item.event_type]||item.event_type)}</span><b>${item.count} · ${total?Math.round(item.count/total*100):0}%</b></div><div class="breakdown-track"><i style="width:${total?item.count/total*100:0}%"></i></div></div>`).join(''):'<div class="empty-row">No event data available.</div>';
  const order=['critical','high','medium','low'],severityMap=Object.fromEntries((a.incidents_by_severity||[]).map(x=>[x.severity,x.count]));
  $('severityBreakdown').innerHTML=order.map(key=>`<div class="severity-row ${key}"><span>${key.toUpperCase()}</span><div class="severity-track"><i style="width:${a.incidents?100*(severityMap[key]||0)/a.incidents:0}%"></i></div><b>${severityMap[key]||0}</b></div>`).join('');
  $('coverageStats').innerHTML=[['Persisted metric snapshots',Number(a.samples).toLocaleString()],['Average attention',a.average_attention==null?'—':`${Math.round(a.average_attention)} / 100`],['Average posture',a.average_posture==null?'—':`${Math.round(a.average_posture)} / 100`],['Average estimated risk',a.average_risk==null?'—':`${Math.round(a.average_risk)} / 100`],['Peak estimated risk',a.peak_risk==null?'—':`${Math.round(a.peak_risk)} / 100`],['Unacknowledged events',a.unacknowledged_incidents]].map(([x,y])=>`<div class="coverage-row"><span>${x}</span><b>${y}</b></div>`).join('');
}
function drawTrend(canvas,data) {
  if(!canvas||!data?.length)return;
  const ctx=canvas.getContext('2d'),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1,w=Math.max(300,rect.width||canvas.clientWidth||600),h=canvas.clientHeight||220;
  canvas.width=w*dpr;canvas.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
  const pad={l:28,r:13,t:15,b:25},cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;
  ctx.font='9px DM Mono, monospace';ctx.fillStyle='#a3aea5';ctx.strokeStyle='#edf1ed';ctx.lineWidth=1;
  [0,25,50,75,100].forEach(v=>{const y=pad.t+ch*(1-v/100);ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText(String(v),3,y+3);});
  const series=[{key:'attention',color:'#619c76'},{key:'posture',color:'#89a6c3'}];
  series.forEach(s=>{const points=data.map((item,index)=>({x:pad.l+(data.length===1?cw/2:index/(data.length-1)*cw),y:pad.t+ch*(1-clamp(Number(item[s.key]||0),0,100)/100)})).filter((point,index)=>Number.isFinite(Number(data[index][s.key])));
    if(points.length<1)return;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
    points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,2.4,0,Math.PI*2);ctx.fillStyle=s.color;ctx.fill();});
  });
  const ticks=[0,Math.floor((data.length-1)/2),data.length-1].filter((v,i,a)=>a.indexOf(v)===i);
  ticks.forEach(i=>{const x=pad.l+(data.length===1?cw/2:i/(data.length-1)*cw);ctx.fillStyle='#a2ada4';ctx.fillText(String(data[i].day||'').slice(5),x-15,h-6);});
}

async function exportBackup() {
  try{const payload=await apiGet('/api/export/json');downloadBlob(`sentineldrive-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2),'application/json');toast('Full platform backup downloaded.','success');}
  catch{const payload={application:'SentinelDrive 3.0.8',exported_at:isoNow(),...readCache()};downloadBlob(`sentineldrive-local-backup-${Date.now()}.json`,JSON.stringify(payload,null,2),'application/json');toast('Downloaded the available local cache. Connect the database for a complete telemetry backup.','error');}
}
async function restoreBackup(file) {
  try{const payload=JSON.parse(await file.text());const result=await apiWrite('POST','/api/import/json',payload);if(result.queued)toast('Restore queued. It will merge when the database reconnects.');else toast(`Backup merged: ${result.total} records imported. Existing records were preserved.`,'success');await refreshBootstrap(true);renderAll();}
  catch(error){toast(`Backup restore failed: ${error.message}`,'error');}
}
function csvExport(path){window.location.href=path;}

function renderAlarmState(status) {
  $('alarmLed').classList.toggle('active',status.active&&!status.previewing);
  $('alarmModeLabel').textContent=status.active?(status.previewing?'PREVIEW':'ALARM ACTIVE'):(status.silenced?'SILENCED':'ARMED');
  $('alarmConsoleStatus').textContent=status.message|| (status.active?(status.previewing?`Previewing ${status.label}`:`Continuous ${status.label} alarm`):status.silenced?'Alarm silenced until eyes reopen and a new event occurs.':'No active alert');
  $('alarmConsoleStatus').classList.toggle('active',status.active&&!status.previewing);
  $('settingAlarm').checked=status.enabled;
}

function renderJournalStatusFallback(){renderJournalStatus();}
function updateClock(){ $('systemClock').textContent=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }

function openPalette(){const palette=$('commandPalette');palette.classList.add('open');palette.setAttribute('aria-hidden','false');$('paletteSearch').value='';renderPalette('');$('paletteSearch').focus();}
function closePalette(){ $('commandPalette').classList.remove('open');$('commandPalette').setAttribute('aria-hidden','true'); }
function renderPalette(query){
  const views=[['command','Command center','◫'],['monitor','Live monitor','◎'],['drivers','Driver registry','♙'],['vehicles','Vehicle registry','▰'],['sessions','Session archive','◷'],['events','Event timeline','⌁'],['analytics','Analytics & insights','▥'],['policies','Safety policies','⚙'],['journal','System journal','≡']];
  let results=views.filter(x=>`${x[1]} ${x[0]}`.toLowerCase().includes(query.toLowerCase())).map(x=>({view:x[0],label:x[1],icon:x[2],meta:'WORKSPACE'}));
  if(query.trim()){
    const q=query.toLowerCase();
    state.drivers.filter(d=>d.name.toLowerCase().includes(q)).slice(0,3).forEach(d=>results.push({view:'drivers',label:d.name,icon:'♙',meta:'DRIVER PROFILE'}));
    state.incidents.filter(i=>`${i.title} ${i.detail}`.toLowerCase().includes(q)).slice(0,3).forEach(i=>results.push({view:'events',label:i.title,icon:'⌁',meta:'SAFETY EVENT'}));
  }
  $('paletteResults').innerHTML=results.slice(0,12).map(r=>`<button class="palette-result" data-palette-view="${esc(r.view)}"><i>${esc(r.icon)}</i><span>${esc(r.label)}</span><small>${esc(r.meta)}</small></button>`).join('')||'<div class="empty-row">No matching workspace or record.</div>';
}
function globalSearch(query){if(!query.trim())return;navigate('events');$('eventSearch').value=query;renderEvents();}

function bindEvents() {
  applyTheme(document.documentElement.dataset.theme || 'light');
  $('themeToggle').addEventListener('click',()=>{
    const next=document.documentElement.dataset.theme==='dark'?'light':'dark';
    localStorage.setItem(THEME_KEY,next);
    applyTheme(next);
  });
  document.querySelectorAll('.nav-link,[data-goto]').forEach(node=>node.addEventListener('click',()=>navigate(node.dataset.view||node.dataset.goto)));
  $('enableCameraBtn').addEventListener('click',connectCamera);$('stopCameraBtn').addEventListener('click',()=>void disconnectCamera());$('switchCameraBtn').addEventListener('click',switchCamera);
  $('sessionBtn').addEventListener('click',()=>state.currentSession?void stopSession().catch(error=>toast(`Could not end session: ${error.message||error}`,'error')):void startSession().catch(error=>toast(`Could not start session: ${error.message||error}`,'error')));$('calibrateBtn').addEventListener('click',startCalibration);$('policyCalibrateBtn').addEventListener('click',startCalibration);$('cancelCalibrationBtn').addEventListener('click',cancelCalibration);
  const setCameraExpanded = expanded => {
    const stage = $('cameraStage');
    const button = $('fullscreenBtn');
    const exitButton = $('exitExpandedBtn');
    stage.classList.toggle('expanded', expanded);
    document.body.classList.toggle('camera-expanded-open', expanded);
    button.textContent = expanded ? '×' : '⛶';
    button.title = expanded ? 'Exit expanded camera view' : 'Expand camera';
    button.setAttribute('aria-pressed', String(expanded));
    exitButton.hidden = !expanded;
  };
  $('fullscreenBtn').addEventListener('click', () => setCameraExpanded(!$('cameraStage').classList.contains('expanded')));
  $('exitExpandedBtn').addEventListener('click', () => setCameraExpanded(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('cameraStage').classList.contains('expanded') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      setCameraExpanded(false);
    }
  });
  $('monitorDriver').addEventListener('change',event=>{state.selectedDriverId=event.target.value;localStorage.setItem('sd.os3.driver',state.selectedDriverId);const driver=state.drivers.find(d=>d.id===state.selectedDriverId);vision.setBaseline(driver?.baseline||null);renderBaselineStatus();$('policyCalibrateBtn').disabled=!vision.streamActive||!driver;});
  $('monitorVehicle').addEventListener('change',event=>{state.selectedVehicleId=event.target.value;localStorage.setItem('sd.os3.vehicle',state.selectedVehicleId);});
  $('addDriverBtn').addEventListener('click',()=>openDriverDialog());$('driverForm').addEventListener('submit',saveDriverFromForm);$('cancelDriverBtn').addEventListener('click',()=>$('driverDialog').close('cancel'));$('cancelDriverCloseBtn').addEventListener('click',()=>$('driverDialog').close('cancel'));
  $('driversTable').addEventListener('click',event=>{const edit=event.target.closest('[data-driver-edit]'),del=event.target.closest('[data-driver-delete]');if(edit)openDriverDialog(state.drivers.find(d=>d.id===edit.dataset.driverEdit));if(del)void deleteDriver(del.dataset.driverDelete);});
  $('driverSearch').addEventListener('input',renderDrivers);$('driverStatusFilter').addEventListener('change',renderDrivers);
  $('addVehicleBtn').addEventListener('click',()=>openVehicleDialog());$('vehicleForm').addEventListener('submit',saveVehicleFromForm);$('cancelVehicleBtn').addEventListener('click',()=>$('vehicleDialog').close('cancel'));$('cancelVehicleCloseBtn').addEventListener('click',()=>$('vehicleDialog').close('cancel'));
  $('vehiclesTable').addEventListener('click',event=>{const edit=event.target.closest('[data-vehicle-edit]'),del=event.target.closest('[data-vehicle-delete]');if(edit)openVehicleDialog(state.vehicles.find(v=>v.id===edit.dataset.vehicleEdit));if(del)void deleteVehicle(del.dataset.vehicleDelete);});
  $('vehicleSearch').addEventListener('input',renderVehicles);$('vehicleStatusFilter').addEventListener('change',renderVehicles);
  $('sessionsTable').addEventListener('click',event=>{const detail=event.target.closest('[data-session-detail]'),finish=event.target.closest('[data-session-finish]');if(detail)void showSessionDetail(detail.dataset.sessionDetail);if(finish)void finishArchivedSession(finish.dataset.sessionFinish);});$('sessionSearch').addEventListener('input',renderSessions);$('sessionStatusFilter').addEventListener('change',renderSessions);$('closeDetailBtn').addEventListener('click',()=>$('detailDialog').close());
  ['eventSearch','eventTypeFilter','eventSeverityFilter','eventAckFilter'].forEach(id=>$(id).addEventListener(id==='eventSearch'?'input':'change',renderEvents));
  $('eventsTable').addEventListener('click',event=>{const ack=event.target.closest('[data-event-ack]');if(ack)void acknowledgeIncident(ack.dataset.eventAck);});
  bindPolicyRange('polEar','earThreshold',v=>v.toFixed(3));bindPolicyRange('polMar','marThreshold',v=>v.toFixed(2));bindPolicyRange('polDrowsy','drowsyDelay',v=>`${v.toFixed(1)} s`);bindPolicyRange('polYawn','yawnDelay',v=>`${v.toFixed(1)} s`);bindPolicyRange('polPose','poseTolerance',v=>`${v}°`);bindPolicyRange('polGaze','gazeTolerance',v=>v.toFixed(2));bindPolicyRange('polDistraction','distractionDelay',v=>`${v.toFixed(1)} s`);bindPolicyRange('polFaceLost','faceLostDelay',v=>`${v.toFixed(1)} s`);bindPolicyRange('polVolume','alarmVolume',v=>`${v}%`);
  $('polAlarmTone').addEventListener('change',e=>{state.policies.alarmTone=e.target.value;alarm.configure({tone:e.target.value});$('policySavedLabel').textContent='UNSAVED CHANGES';writePreferences(state.policies);});
  $('polAlarmEnabled').addEventListener('change',e=>{state.policies.alarmEnabled=e.target.checked;alarm.configure({enabled:e.target.checked});$('policySavedLabel').textContent='UNSAVED CHANGES';writePreferences(state.policies);});
  $('polAutoStart').addEventListener('change',e=>{state.policies.autoStartMonitoring=e.target.checked;$('policySavedLabel').textContent='UNSAVED CHANGES';writePreferences(state.policies);});
  $('polInterval').addEventListener('change',e=>{state.policies.telemetryInterval=Number(e.target.value);$('policySavedLabel').textContent='UNSAVED CHANGES';writePreferences(state.policies);});
  $('polRetention').addEventListener('change',e=>{state.policies.retentionDays=Number(e.target.value);$('policySavedLabel').textContent='UNSAVED CHANGES';writePreferences(state.policies);});
  $('savePoliciesBtn').addEventListener('click',()=>void savePolicies());
  $('settingAlarm').addEventListener('change',e=>{state.policies.alarmEnabled=e.target.checked;$('polAlarmEnabled').checked=e.target.checked;alarm.configure({enabled:e.target.checked});writePreferences(state.policies);void savePolicies(false);});
  $('testAlarmBtn').addEventListener('click',()=>void alarm.preview());$('silenceAlarmBtn').addEventListener('click',()=>alarm.silence());
  $('analyticsRange').addEventListener('change',e=>void loadAnalytics(Number(e.target.value)));$('trendRange').addEventListener('change',e=>void loadAnalytics(Number(e.target.value)));
  $('exportIncidentCsvBtn').addEventListener('click',()=>csvExport('/api/export/incidents.csv'));$('exportTelemetryBtn').addEventListener('click',()=>csvExport('/api/export/telemetry.csv'));
  $('exportBackupBtn').addEventListener('click',exportBackup);$('backupBtn').addEventListener('click',exportBackup);$('restoreFile').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)void restoreBackup(file);e.target.value='';});
  $('exportAnalyticsBtn').addEventListener('click',()=>{if(!state.analytics)return;downloadBlob(`sentineldrive-analytics-${state.analytics.days}d.json`,JSON.stringify(state.analytics,null,2),'application/json');});
  $('refreshSystemBtn').addEventListener('click',async()=>{await refreshBootstrap();await refreshHealth();renderAll();toast('System metadata refreshed.','success');});$('syncNowBtn').addEventListener('click',async()=>{const result=await flushOutbox();await refreshBootstrap(true);toast(`${result.sent} queued operations synced · ${result.remaining} remaining.`,result.remaining?'error':'success');});$('journalCategory').addEventListener('change',renderJournal);
  $('openJournalBtn').addEventListener('click',()=>navigate('journal'));
  $('globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')globalSearch(e.target.value);});
  $('commandPalette').addEventListener('click',e=>{if(e.target.classList.contains('palette-backdrop'))closePalette();const button=e.target.closest('[data-palette-view]');if(button)navigate(button.dataset.paletteView);});$('paletteSearch').addEventListener('input',e=>renderPalette(e.target.value));
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();}if(e.key==='Escape')closePalette();});
  window.addEventListener('online',async()=>{setDbStatus(true);const r=await flushOutbox();await refreshBootstrap(true);toast(`Connection restored · ${r.sent} operations synced.`,'success');});
  window.addEventListener('sentinel:queued',e=>{setDbStatus(false);renderJournalStatus();});
  window.addEventListener('sentinel:queue-flushed',e=>{renderJournalStatus();});
  window.addEventListener('beforeunload',()=>{if(state.currentSession){void finishTelemetryBatch();}vision.stop();alarm.destroy();});
  $('exportBackupBtn').title='Download all drivers, vehicles, sessions, incidents, telemetry, policies and audit activity.';
}

async function bootstrap() {
  setBootMessage('LOADING WORKSPACE MODULES', 15);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js?v=3.0.8', { updateViaCache: 'none' }).catch(error => console.warn('Offline shell registration skipped:', error));
  }
  bindEvents();
  const online = await refreshBootstrap(true);
  setBootMessage('PREPARING COMMAND CENTER', 82);
  alarm.configure({ enabled: state.policies.alarmEnabled, tone: state.policies.alarmTone, volume: state.policies.alarmVolume });
  populateAssignments();
  renderAll();
  $('bootScreen').hidden = true;
  $('appShell').hidden = false;
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updateSessionClock, 500);
  setInterval(() => { if (state.activeView === 'journal') void refreshHealth(); }, 15000);
  if (online) toast('SentinelDrive is operational. Local database connected.', 'success');
  else toast('SentinelDrive opened in local cache mode. Backend connection is unavailable.', 'error');

  // Load larger tables and analytics after the shell is visible. They must never hold the splash screen.
  void hydrateWorkspaceData();
  void loadAnalytics(30).catch(error => console.warn('Analytics startup skipped:', error));
  if (queueSize()) {
    flushOutbox().then(async result => {
      if (result.sent) await refreshBootstrap(true);
      const q = queueSize();
      if ($('syncStatusText')) $('syncStatusText').textContent = `${q} operations queued for database sync.`;
    }).catch(error => console.warn('Offline queue sync deferred:', error));
  }
}
bootstrap().catch(error=>{console.error('SentinelDrive startup failed:',error);const boot=$('bootScreen');const shell=$('appShell');if(boot)boot.hidden=true;if(shell)shell.hidden=false;toast(`Startup error: ${error.message||error}`,'error');});
