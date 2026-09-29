import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'node:crypto';
import { google } from 'googleapis';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));

const PORT = Number(process.env.PORT || 10000);
const SPREADSHEET_ID = String(process.env.SPREADSHEET_ID || '').trim();
const API_KEY = process.env.API_KEY || '';
const WRITE_ENABLED = String(process.env.WRITE_ENABLED || 'true').toLowerCase() === 'true';
const LOG_ENABLED = String(process.env.LOG_ENABLED || 'true').toLowerCase() === 'true';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  }
}));

const TABLES = {
  scores: { sheet: 'ScoreLog', headersRow: 3, startRow: 4, keys: ['date','source','subject','score','maxScore','rate','memo','evidence','status','nextCheck'], writable: ['date','source','subject','score','maxScore','memo','evidence','status','nextCheck'], idKey: null },
  errors: { sheet: 'ErrorLog', headersRow: 3, startRow: 4, keys: ['date','subject','source','question','unit','score','maxScore','cause','causeMemo','understood','day1','day7','minutes','priority','status','nextAction'], writable: ['date','subject','source','question','unit','score','maxScore','cause','causeMemo','understood','day1','day7','minutes','priority','status','nextAction'], idKey: null },
  scans: { sheet: 'ScanInbox', headersRow: 3, startRow: 4, keys: ['scanId','receivedAt','sourceId','year','examType','subject','fileName','fileId','pages','contentType','rights','quality','extractStatus','splitStatus','answerStatus','priority','reviewStatus','notes'], writable: ['receivedAt','sourceId','year','examType','subject','fileName','fileId','pages','contentType','rights','quality','extractStatus','splitStatus','answerStatus','priority','reviewStatus','notes'], idKey: 'scanId', prefix: 'SCAN' },
  problems: { sheet: 'ProblemBank', headersRow: 3, startRow: 4, keys: ['problemId','sourceId','scanId','year','examType','subject','bigQuestion','subQuestion','page','category','unitGenre','microSkill','questionType','answerFormat','points','standardMinutes','difficulty','kyudaiLikeness','tags','summary','coreProcess','trap','intentNotes','userScore','maxScore','rate','lastAttempt','cause','day1','day7','mastery','nextReview','sourceRef','review','notes'], writable: ['sourceId','scanId','year','examType','subject','bigQuestion','subQuestion','page','category','unitGenre','microSkill','questionType','answerFormat','points','standardMinutes','difficulty','kyudaiLikeness','tags','summary','coreProcess','trap','intentNotes','userScore','maxScore','lastAttempt','cause','day1','day7','mastery','nextReview','sourceRef','review','notes'], idKey: 'problemId', prefix: 'PB' },
  patterns: { sheet: 'KyudaiPattern', headersRow: 3, startRow: 4, keys: ['subject','tag','count','recent5Count','avgDifficulty','avgKyudaiLikeness','userAvgRate','unmasteredCount','priorityIndex','judgment'], writable: [], idKey: null },
  subjects: { sheet: 'SubjectMap', headersRow: 3, startRow: 4, keys: ['subject','current','target','priority','mainMaterial','subMaterial','weeklyFrequency','rule','milestone'], writable: [], idKey: 'subject' },
  weekly: { sheet: 'WeeklyPlan', headersRow: 3, startRow: 4, keys: ['day','context','mainTask','subTask','minimum','standard','extra','doneCondition','actual'], writable: [], idKey: 'day' },
  sources: { sheet: 'SourceRegistry', headersRow: 3, startRow: 4, keys: ['sourceId','name','type','years','subject','acquisition','rights','referenceMethod','reference','status','quality','notes'], writable: ['name','type','years','subject','acquisition','rights','referenceMethod','reference','status','quality','notes'], idKey: 'sourceId', prefix: 'SRC' },
};

function requireSpreadsheetId() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID is not configured');
  return SPREADSHEET_ID;
}

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
  const value = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(value);
}

function sheetsClient() {
  requireSpreadsheetId();
  const creds = serviceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

function requireAuth(req, res, next) {
  if (!API_KEY) return res.status(503).json({ ok:false, error:'API_KEY is not configured' });
  const candidate = req.get('x-api-key') || '';
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(API_KEY));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}

function requireWrite(req, res, next) {
  if (!WRITE_ENABLED) return res.status(403).json({ ok:false, error:'write disabled' });
  next();
}

function colToA1(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function normalize(v) {
  if (v === undefined || v === null) return '';
  return v;
}

async function readTable(key, query = {}) {
  const def = TABLES[key];
  if (!def) throw new Error(`unknown table ${key}`);
  const sheets = sheetsClient();
  const endCol = colToA1(def.keys.length);
  const range = `'${def.sheet}'!A${def.startRow}:${endCol}`;
  const out = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range, valueRenderOption: 'UNFORMATTED_VALUE' });
  const rows = out.data.values || [];
  let items = rows.map((row, idx) => {
    const obj = { _row: def.startRow + idx };
    def.keys.forEach((k, i) => obj[k] = row[i] ?? '');
    return obj;
  }).filter(o => Object.values(o).some(v => v !== '' && v !== o._row));

  const reserved = new Set(['limit','offset','sort']);
  for (const [k,v] of Object.entries(query)) {
    if (reserved.has(k) || v === undefined || v === '') continue;
    items = items.filter(x => String(x[k] ?? '') === String(v));
  }
  if (query.sort) {
    const desc = String(query.sort).startsWith('-');
    const keyName = desc ? String(query.sort).slice(1) : String(query.sort);
    items.sort((a,b) => {
      const av = a[keyName], bv = b[keyName];
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (desc ? -1 : 1);
    });
  }
  const offset = Math.max(0, Number(query.offset || 0));
  const limit = Math.min(500, Math.max(1, Number(query.limit || 100)));
  return items.slice(offset, offset + limit);
}

function makeId(prefix) {
  const t = new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
  const r = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${t}-${r}`;
}

function todayJst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}

function defaults(key, obj) {
  if (key === 'scores' && !obj.date) obj.date = todayJst();
  if (key === 'errors' && !obj.date) obj.date = todayJst();
  if (key === 'scans') {
    if (!obj.receivedAt) obj.receivedAt = todayJst();
    if (!obj.extractStatus) obj.extractStatus = '未処理';
    if (!obj.splitStatus) obj.splitStatus = '未処理';
    if (!obj.reviewStatus) obj.reviewStatus = '未確認';
  }
  if (key === 'problems') {
    if (!obj.mastery) obj.mastery = '未着手';
    if (!obj.review) obj.review = '未確認';
  }
}

function validateCreate(key, obj) {
  const required = {
    scores:['source','subject','score','maxScore'],
    errors:['subject','source','unit','cause','status'],
    scans:['sourceId','year','examType','subject','fileName','contentType','rights'],
    problems:['sourceId','year','examType','subject','bigQuestion','unitGenre','summary'],
    sources:['name','type']
  }[key] || [];
  const missing = required.filter(k => obj[k] === undefined || obj[k] === null || obj[k] === '');
  if (missing.length) throw new Error(`missing fields: ${missing.join(', ')}`);
}

async function createRecord(key, data) {
  const def = TABLES[key];
  if (!def || def.writable.length === 0) throw new Error('read-only table');
  const obj = { ...data };
  validateCreate(key, obj);
  defaults(key, obj);
  if (def.idKey && !obj[def.idKey]) obj[def.idKey] = makeId(def.prefix || key.toUpperCase());

  const row = def.keys.map(k => normalize(obj[k]));
  if (key === 'scores') row[5] = `=IFERROR(D${def.startRow}/E${def.startRow},"")`;
  if (key === 'problems') row[25] = `=IFERROR(X${def.startRow}/Y${def.startRow},"")`;

  const sheets = sheetsClient();
  const endCol = colToA1(def.keys.length);
  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${def.sheet}'!A${def.startRow}:${endCol}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values:[row] }
  });
  const updatedRange = resp.data.updates?.updatedRange || '';
  const match = updatedRange.match(/!(?:[A-Z]+)(\d+):/);
  const actualRow = match ? Number(match[1]) : null;
  if (actualRow) {
    if (key === 'scores') await sheets.spreadsheets.values.update({ spreadsheetId:SPREADSHEET_ID, range:`'${def.sheet}'!F${actualRow}`, valueInputOption:'USER_ENTERED', requestBody:{values:[[`=IFERROR(D${actualRow}/E${actualRow},"")`]]} });
    if (key === 'problems') await sheets.spreadsheets.values.update({ spreadsheetId:SPREADSHEET_ID, range:`'${def.sheet}'!Z${actualRow}`, valueInputOption:'USER_ENTERED', requestBody:{values:[[`=IFERROR(X${actualRow}/Y${actualRow},"")`]]} });
  }
  return { ...obj, _row: actualRow };
}

async function updateRecord(key, id, patch) {
  const def = TABLES[key];
  if (!def?.idKey) throw new Error('stable id is not available for this table');
  const items = await readTable(key, { limit:500 });
  const found = items.find(x => String(x[def.idKey]) === String(id));
  if (!found) throw new Error('record not found');
  const merged = { ...found, ...patch, [def.idKey]: found[def.idKey] };
  const row = def.keys.map(k => normalize(merged[k]));
  const sheets = sheetsClient();
  const endCol = colToA1(def.keys.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${def.sheet}'!A${found._row}:${endCol}${found._row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values:[row] }
  });
  if (key === 'problems') await sheets.spreadsheets.values.update({ spreadsheetId:SPREADSHEET_ID, range:`'${def.sheet}'!Z${found._row}`, valueInputOption:'USER_ENTERED', requestBody:{values:[[`=IFERROR(X${found._row}/Y${found._row},"")`]]} });
  return { ...merged, _row: found._row };
}

async function appendLog({ requestId, method, path, status, rows=0, subject='', durationMs=0, message='', actor='api' }) {
  if (!LOG_ENABLED) return;
  try {
    const sheets = sheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'API_Log'!A4:J",
      valueInputOption:'USER_ENTERED',
      insertDataOption:'INSERT_ROWS',
      requestBody:{ values:[[new Date().toISOString(),requestId,method,path,status,rows,subject,durationMs,message,actor]] }
    });
  } catch (e) {
    console.error('API_Log write failed:', e.message);
  }
}

app.use((req,res,next) => {
  req.requestId = crypto.randomUUID();
  req.startedAt = Date.now();
  res.on('finish', () => appendLog({
    requestId:req.requestId, method:req.method, path:req.path, status:res.statusCode,
    durationMs:Date.now()-req.startedAt, message:res.locals.logMessage || '', actor:'api'
  }));
  next();
});

app.get('/', async (req,res) => {
  let sheetsState = 'unknown';
  try { const s = sheetsClient(); await s.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID, fields:'spreadsheetId,properties.title' }); sheetsState='connected'; } catch { sheetsState='not-connected'; }
  res.type('html').send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>九大法 学習OS API</title><style>body{font-family:system-ui,sans-serif;margin:40px;line-height:1.6;background:#f6f8fb;color:#183040}.card{max-width:850px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 24px #0001}code{background:#eef3f7;padding:.15rem .35rem;border-radius:5px}</style><div class="card"><h1>九大法 学習OS API</h1><p>Server: <b>online</b></p><p>Google Sheets: <b>${sheetsState}</b></p><p>Spreadsheet config: <b>${SPREADSHEET_ID ? 'configured' : 'missing'}</b></p><p>Endpoints: <code>/health</code>, <code>/api/dashboard</code>, <code>/api/scores</code>, <code>/api/errors</code>, <code>/api/scans</code>, <code>/api/problems</code>, <code>/api/patterns</code>, <code>/api/subjects</code>, <code>/api/weekly-plan</code>, <code>/api/sources</code></p></div></html>`);
});

app.get('/health', (req,res) => {
  res.json({ ok:true, service:'Kyudai Law Study OS API', time:new Date().toISOString() });
});

app.get('/status', (req,res) => {
  res.json({
    ok:true,
    config:{
      spreadsheetIdConfigured:Boolean(SPREADSHEET_ID),
      serviceAccountConfigured:Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      apiKeyConfigured:Boolean(API_KEY),
      writeEnabled:WRITE_ENABLED,
      logEnabled:LOG_ENABLED
    }
  });
});

app.get('/ready', async (req,res) => {
  try {
    const s = sheetsClient();
    const meta = await s.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID, fields:'spreadsheetId,properties.title' });
    res.json({ ok:true, sheets:{ connected:true, title:meta.data.properties?.title || '' } });
  } catch (e) {
    res.status(503).json({ ok:false, sheets:{ connected:false }, error:e.message });
  }
});

app.use('/api', requireAuth);

app.get('/api/dashboard', async (req,res,next) => {
  try {
    const [scores,errors,patterns,subjects,weekly] = await Promise.all([
      readTable('scores',{limit:500,sort:'-date'}), readTable('errors',{limit:500}), readTable('patterns',{limit:100,sort:'-priorityIndex'}), readTable('subjects',{limit:100}), readTable('weekly',{limit:20})
    ]);
    const latestScores = {};
    for (const s of scores) if (s.subject && (!latestScores[s.subject] || String(s.date)>String(latestScores[s.subject].date))) latestScores[s.subject]=s;
    const openErrors = errors.filter(e => e.status !== '習得');
    res.json({ ok:true, data:{ latestScores, openErrorCount:openErrors.length, highPriorityErrors:openErrors.filter(e=>e.priority==='高').slice(0,10), topKyudaiPatterns:patterns.filter(p=>Number(p.count||0)>0).slice(0,10), subjects, weeklyPlan:weekly } });
  } catch(e){ next(e); }
});

const routes = {
  scores:'scores', errors:'errors', scans:'scans', problems:'problems', patterns:'patterns', subjects:'subjects', 'weekly-plan':'weekly', sources:'sources'
};
for (const [path,key] of Object.entries(routes)) {
  app.get(`/api/${path}`, async (req,res,next) => {
    try { const items = await readTable(key, req.query); res.json({ ok:true, data:{ items, count:items.length } }); } catch(e){ next(e); }
  });
  if (TABLES[key].writable.length) {
    app.post(`/api/${path}`, requireWrite, async (req,res,next) => {
      try { const item = await createRecord(key, req.body || {}); res.status(201).json({ ok:true, data:{ item } }); } catch(e){ next(e); }
    });
    if (TABLES[key].idKey) {
      app.patch(`/api/${path}/:id`, requireWrite, async (req,res,next) => {
        try { const item = await updateRecord(key, req.params.id, req.body || {}); res.json({ ok:true, data:{ item } }); } catch(e){ next(e); }
      });
    }
  }
}

app.use((err,req,res,next) => {
  console.error(err);
  res.locals.logMessage = err.message;
  res.status(400).json({ ok:false, requestId:req.requestId, error:err.message });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Kyudai Law Study OS API listening on ${PORT}`);
  console.log('Config status', {
    spreadsheetIdConfigured:Boolean(SPREADSHEET_ID),
    serviceAccountConfigured:Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    apiKeyConfigured:Boolean(API_KEY),
    writeEnabled:WRITE_ENABLED,
    logEnabled:LOG_ENABLED
  });
  try {
    const s = sheetsClient();
    const meta = await s.spreadsheets.get({
      spreadsheetId:SPREADSHEET_ID,
      fields:'spreadsheetId,properties.title'
    });
    console.log('Google Sheets connection OK:', meta.data.properties?.title || SPREADSHEET_ID);
  } catch (e) {
    console.error('Google Sheets connection FAILED:', e.message);
  }
});
