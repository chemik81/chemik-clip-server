/**
 * 🎞️ Serwer skrótów meczów (Chemik Leagues)
 * Worker ligi zleca: POST /job  →  serwer pobiera nagranie VOD (yt-dlp), szuka kandydatów
 * (kliknięcia „🎬 Clip!” kibiców + skoki głośności), Gemini ocenia i opisuje akcje,
 * ffmpeg skleja skrót 16:9 i wersję 9:16, pliki wracają do Workera (R2) do akceptacji admina.
 *
 * Zmienne środowiskowe (Railway → Variables):
 *   WORKER_SECRET   — ta sama wartość co DISCORD_WEBHOOK_SECRET w Workerach (i WORKER_SECRET bota)
 *   GEMINI_FREE_KEY — darmowy klucz Gemini (używany najpierw, jak w bocie)
 *   GEMINI_API_KEY  — płatny klucz Gemini (zapasowy)
 *   GEMINI_MODEL    — opcjonalnie, domyślnie gemini-2.5-flash
 */
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), { spawn } = require('child_process');
const PORT = process.env.PORT || 8080, SECRET = process.env.WORKER_SECRET || '';
const GKEYS = [process.env.GEMINI_FREE_KEY, ...(process.env.GEMINI_API_KEY || '').split(',')].map(s => String(s || '').trim()).filter(Boolean); // jak w bocie: najpierw darmowy, potem płatny
let MODEL = process.env.GEMINI_MODEL || null, _modelAt = 0; // bez GEMINI_MODEL: najnowszy „flash” z listy modeli Google (stare modele znikają)
async function pickModel(force) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (MODEL && !force && Date.now() - _modelAt < 12 * 3600e3) return MODEL;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GKEYS[0]}`, { signal: AbortSignal.timeout(15e3) });
    const list = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const flash = list.filter(n => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|live|audio|native|thinking/.test(n)).sort((a, b) => ver(b) - ver(a) || (/preview|exp/.test(a) ? 1 : 0) - (/preview|exp/.test(b) ? 1 : 0));
    if (flash[0]) { MODEL = flash[0]; _modelAt = Date.now(); log('gemini model:', MODEL); return MODEL; }
  } catch (e) { log('models:', e.message); }
  return MODEL || 'gemini-flash-latest';
}
const FONT = process.env.FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── narzędzia ───────────────────────────────────────────────────
function run(cmd, args, { timeout = 30 * 60e3, onStdout } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    p.stdout.on('data', d => onStdout && onStdout(d)); p.stderr.on('data', d => { err += d; if (err.length > 400000) err = err.slice(-200000); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', e => { clearTimeout(t); rej(e); });
    p.on('close', c => { clearTimeout(t); c === 0 ? res(err) : rej(new Error(`${cmd} exit ${c}: ${err.slice(-500)}`)); });
  });
}
const hms = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const isLocal = u => /^\/|^file:/.test(u);
const localPath = u => u.replace(/^file:\/\//, '');

// fragment nagrania [from, to] (sekundy od początku VOD) → mp4 720p
async function getSegment(url, from, to, out) {
  if (isLocal(url)) return run('ffmpeg', ['-y', '-ss', String(from), '-to', String(to), '-i', localPath(url), '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-ar', '44100', '-ac', '2', out]);
  const tmp = out.replace(/\.mp4$/, '.dl');
  await run('yt-dlp', ['-q', '--no-warnings', '-f', 'bv*[height<=720]+ba/b[height<=720]/best', '--merge-output-format', 'mp4', '--download-sections', `*${hms(from)}-${hms(to)}`, '--concurrent-fragments', '4', '-o', tmp + '.%(ext)s', url], { timeout: 6 * 60e3 });
  const f = (await fsp.readdir(path.dirname(out))).find(x => x.startsWith(path.basename(tmp) + '.'));
  if (!f) throw new Error('segment not downloaded');
  await run('ffmpeg', ['-y', '-i', path.join(path.dirname(out), f), '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-ar', '44100', '-ac', '2', out]);
  await fsp.unlink(path.join(path.dirname(out), f)).catch(() => {});
}
// dźwięk okna meczu → głośność co 0,5 s (dB)
async function loudness(url, from, to, dir) {
  let src = url, ss = ['-ss', String(from), '-to', String(to)];
  if (!isLocal(url)) {
    const tmp = path.join(dir, 'audio');
    await run('yt-dlp', ['-q', '--no-warnings', '-f', 'Audio_Only/audio_only/bestaudio/worst', '--download-sections', `*${hms(from)}-${hms(to)}`, '--concurrent-fragments', '4', '-o', tmp + '.%(ext)s', url], { timeout: 20 * 60e3 });
    const f = (await fsp.readdir(dir)).find(x => x.startsWith('audio.')); if (!f) throw new Error('audio not downloaded');
    src = path.join(dir, f); ss = [];
  } else src = localPath(url);
  const SR = 8000, WIN = SR / 2, out = []; let acc = 0, n = 0, carry = null;
  await run('ffmpeg', ['-v', 'error', ...ss, '-i', src, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { timeout: 20 * 60e3, onStdout: d => {
    let buf = carry ? Buffer.concat([carry, d]) : d; const even = buf.length - (buf.length % 2); carry = even < buf.length ? buf.subarray(even) : null;
    for (let i = 0; i < even; i += 2) { const v = buf.readInt16LE(i) / 32768; acc += v * v; if (++n === WIN) { out.push(10 * Math.log10(acc / n + 1e-10)); acc = 0; n = 0; } }
  } });
  return out; // indeks i → sekunda from + i/2
}
// skoki głośności (krzyk na voice, reakcja publiczności) względem tła z ostatniej minuty
function audioPeaks(db, from, max = 14) {
  const sm = db.map((_, i) => (db[i - 1] ?? db[i]) * .25 + db[i] * .5 + (db[i + 1] ?? db[i]) * .25), W = 120, base = [];
  for (let i = 0; i < sm.length; i++) { const w = sm.slice(Math.max(0, i - W), Math.min(sm.length, i + W)).slice().sort((a, b) => a - b); base.push(w[Math.floor(w.length / 2)]); }
  const ex = sm.map((v, i) => v - base[i]), peaks = [];
  for (let i = 0; i < ex.length; i++) { if (ex[i] < 6) continue; let isMax = true; for (let j = Math.max(0, i - 20); j < Math.min(ex.length, i + 20); j++) if (ex[j] > ex[i]) { isMax = false; break; } if (isMax) peaks.push({ t: from + i / 2, w: ex[i] / 3 }); }
  return peaks.sort((a, b) => b.w - a.w).slice(0, max);
}
// Gemini: ocena fragmentu (0–10), podpis, nick, najlepsze sekundy
async function judge(file, ctx) {
  if (!GKEYS.length) return null;
  const data = (await fsp.readFile(file)).toString('base64');
  const prompt = `This is a ~24 second clip from a stream of an NBA 2K Pro-Am game (${ctx.team1} vs ${ctx.team2}). The camera follows one player. Voices on the stream are the players' team voice chat and may be in ANY language (Polish, Finnish, Turkish, Romanian, English…) — loud excited voices are a hint that something big happened, but judge mainly by what you SEE.
Rate how highlight-worthy the best play in the clip is, 0–10: 9–10 = poster dunk, game winner, buzzer beater, ankle breaker + score, chase-down block; 7–8 = clean dunk, deep/contested three, alley-oop, great block or steal + fast break, and-one; 4–6 = ordinary made basket or nice pass; 0–3 = nothing, menus, replays, loading screens, free throws, dead ball, timeouts.
Reply with JSON only: {"score": number, "type": "dunk|three|block|steal|alleyoop|layup|assist|other|none", "caption": "${ctx.lang === 'pl' ? 'krótki podpis akcji po polsku, max 55 znaków, bez emoji' : 'short caption of the play in English, max 55 chars, no emoji'}", "player": "gamertag of the player who made the play if readable on screen, else null", "start": seconds, "end": seconds} — start/end = the best 6–13 s within the clip: include the build-up and the finish, end right after the ball goes in or the play ends.`;
  let model = await pickModel();
  for (let ki = 0; ki < GKEYS.length; ki++) { const key = GKEYS[ki];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'video/mp4', data } }, { text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }), signal: AbortSignal.timeout(90e3) });
      if (!r.ok) { const t = await r.text(); log('gemini', r.status, model, t.slice(0, 160).replace(/\s+/g, ' '));
        if (r.status === 404) { const sug = (t.match(/use models\/([\w.-]+)/) || [])[1]; const nm = process.env.GEMINI_MODEL ? null : (sug || await pickModel(true)); if (nm && nm !== model) { model = MODEL = nm; _modelAt = Date.now(); ki--; } } // model wycofany → nowy i ten sam klucz jeszcze raz
        continue; }
      const j = await r.json(), txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const o = JSON.parse(txt.replace(/^```json|```$/g, '').trim()); return { score: +o.score || 0, type: o.type || 'other', caption: String(o.caption || '').slice(0, 60), player: o.player && o.player !== 'null' ? String(o.player).slice(0, 30) : null, start: +o.start || 0, end: +o.end || 0 };
    } catch (e) { log('gemini err', e.message); }
  }
  return null;
}
async function probeDur(f) { return new Promise(res => { const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]); let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => res(parseFloat(o) || 0)); }); }

// ── montaż ──────────────────────────────────────────────────────
const V = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k'];
async function txt(dir, name, s) { const f = path.join(dir, name + '.txt'); await fsp.writeFile(f, String(s)); return f; }
const dt = (file, size, x, y, extra = '') => `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=white:x=${x}:y=${y}${extra}`;
async function card(dir, name, lines, secs) { // plansza: lista [tekst, rozmiar, kolor]
  const files = []; for (const [i, l] of lines.entries()) files.push(await txt(dir, `${name}${i}`, l[0]));
  let y = 360 - lines.reduce((a, l) => a + l[1] * 1.35, 0) / 2, vf = [];
  lines.forEach((l, i) => { vf.push(dt(files[i], l[1], '(w-text_w)/2', Math.round(y), `:fontcolor=${l[2] || 'white'}`)); y += l[1] * 1.35; });
  const out = path.join(dir, name + '.mp4');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x0b1020:s=1280x720:d=${secs}:r=30`, '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`, '-t', String(secs), '-vf', vf.join(',') + `,fade=t=in:st=0:d=0.4,fade=t=out:st=${secs - 0.4}:d=0.4`, ...V, '-shortest', out]);
  return out;
}
async function part(dir, i, seg, a, b, caption, top) {
  const cf = await txt(dir, `cap${i}`, caption), tf = await txt(dir, `top${i}`, top), out = path.join(dir, `part${i}.mp4`), d = b - a;
  const vf = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,`
    + `drawbox=x=0:y=ih-92:w=iw:h=92:color=black@0.55:t=fill,${dt(cf, 34, 40, 'h-70')},${dt(tf, 22, 40, 26, ':box=1:boxcolor=black@0.45:boxborderw=10')},fade=t=in:st=0:d=0.25,fade=t=out:st=${(d - 0.25).toFixed(2)}:d=0.25`;
  await run('ffmpeg', ['-y', '-ss', a.toFixed(2), '-to', b.toFixed(2), '-i', seg, '-vf', vf, '-af', `afade=t=in:st=0:d=0.25,afade=t=out:st=${(d - 0.3).toFixed(2)}:d=0.3`, ...V, out]);
  return out;
}
async function concat(dir, files, out) { const lst = path.join(dir, path.basename(out) + '.txt'); await fsp.writeFile(lst, files.map(f => `file '${f}'`).join('\n')); await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', out]); return out; }
async function vertical(wide, out) {
  await run('ffmpeg', ['-y', '-i', wide, '-filter_complex', '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:4[bg];[0:v]scale=720:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out]);
  return out;
}

// ── zlecenie ────────────────────────────────────────────────────
async function processJob(job, opts = {}) {
  const t0 = Date.now(), dir = await fsp.mkdtemp(path.join(os.tmpdir(), `hl-${job.scheduleId}-`)), pl = job.lang === 'pl';
  const brand = job.league === 'eu' ? 'EU CHEMIK LEAGUE' : '2K PRO-AM EKSTRAKLASA', site = job.league === 'eu' ? 'eu.chemikleagues.com' : 'chemikleagues.com';
  const stats = { candidates: 0, judged: 0, streams: 0 };
  try {
    const gameLen = Math.max(1, job.bestOf || 1) * 75 * 60 + 20 * 60, plays = [];
    for (const [si, s] of (job.streams || []).entries()) {
      const off = ms => (ms - s.created) / 1000, vodLen = (s.dur || 4 * 36e5) / 1000;
      const from = Math.max(0, off(job.start) - 300), to = Math.min(vodLen, from + gameLen);
      if (to - from < 120) continue; stats.streams++;
      progress(job, `${pl ? '🔊 Pobieram dźwięk i szukam głośnych momentów' : '🔊 Downloading audio, looking for loud moments'} (${hms(from)}–${hms(to)})`);
      // kandydaci: kliknięcia kibiców (akcja chwilę PRZED kliknięciem), klipy, skoki głośności
      const C = [];
      (job.presses || []).forEach(t => C.push({ t: off(t) - 7, w: 3 }));
      (job.fanClips || []).filter(c => !c.login || c.login === s.login).forEach(c => C.push({ t: off(c.t) - 9, w: 3 + (c.votes || 1) }));
      try { const db = await loudness(s.url, from, to, dir); audioPeaks(db, from).forEach(p => C.push({ t: p.t - 2, w: p.w })); } catch (e) { log('audio:', e.message); }
      const M = []; C.filter(c => c.t > from && c.t < to).sort((a, b) => a.t - b.t).forEach(c => { const l = M[M.length - 1]; if (l && c.t - l.t < 15) { l.w += c.w; if (c.w > l.top) { l.t = c.t; l.top = c.w; } } else M.push({ ...c, top: c.w }); });
      const pick = M.sort((a, b) => b.w - a.w).slice(0, opts.maxCand || (job.streams.length > 1 ? 10 : 14)); stats.candidates += pick.length;
      for (const [ci, c] of pick.entries()) {
        progress(job, `${pl ? '🎬 Fragment' : '🎬 Clip'} ${ci + 1}/${pick.length}: ${pl ? 'pobieram i oceniam (Gemini)' : 'downloading and rating (Gemini)'}`);
        const seg = path.join(dir, `seg${si}_${ci}.mp4`), a = Math.max(0, c.t - 16), b = Math.min(vodLen, c.t + 8);
        try { await getSegment(s.url, a, b, seg); } catch (e) { log('segment:', e.message); continue; }
        const seglen = await probeDur(seg); let j = await judge(seg, job); if (j) stats.judged++;
        if (!j) j = { score: Math.min(9, 4 + c.w), type: 'other', caption: pl ? 'Akcja meczu' : 'Big play', player: null, start: Math.max(0, seglen - 14), end: seglen - 3 };
        let st = Math.max(0, Math.min(j.start, seglen - 4)), en = Math.min(seglen, Math.max(j.end, st + 5)); if (en - st > 14) st = en - 14;
        plays.push({ seg, a: st, b: en, abs: s.created + (a + st) * 1000, score: j.score + Math.min(1.5, c.w / 6), type: j.type, caption: j.caption, player: j.player, team: s.team, login: s.login });
      }
    }
    // to samo z dwóch transmisji (±12 s) → zostaje lepiej oceniona
    const uniq = []; plays.sort((x, y) => y.score - x.score).forEach(p => { if (!uniq.some(u => Math.abs(u.abs - p.abs) < 12e3)) uniq.push(p); });
    let best = uniq.filter(p => p.score >= 6); if (best.length < 4) best = uniq.filter(p => p.score >= 4);
    best = best.slice(0, opts.maxPlays || 8).sort((x, y) => x.abs - y.abs);
    if (best.length < 3) throw new Error(pl ? `za mało dobrych akcji (${best.length})` : `not enough good plays (${best.length})`);
    progress(job, `${pl ? '✂️ Montaż skrótu' : '✂️ Editing the reel'} (${best.length} ${pl ? 'akcji' : 'plays'})`);
    const score = (job.games || []).map(g => `${g.s1} : ${g.s2}`).join('   ·   ');
    const top = `${job.team1} vs ${job.team2}${job.week ? `  ·  WEEK ${job.week}` : ''}`;
    const parts = [await card(dir, 'intro', [[brand, 30, '0xf5c518'], [`${job.team1}  vs  ${job.team2}`, 54], ...(score ? [[score, 44]] : []), [`${job.week ? `WEEK ${job.week}  ·  ` : ''}HIGHLIGHTS`, 26, '0x9aa4bf']], 3)];
    for (const [i, p] of best.entries()) parts.push(await part(dir, i, p.seg, p.a, p.b, `${p.caption}${p.player ? '  —  ' + p.player : ''}`, top));
    parts.push(await card(dir, 'outro', [[brand, 34, '0xf5c518'], [site, 28]], 2.5));
    const wide = await concat(dir, parts, path.join(dir, 'wide.mp4')), vert = await vertical(wide, path.join(dir, 'vertical.mp4'));
    const result = { ok: true, scheduleId: job.scheduleId, plays: best.map(p => ({ caption: p.caption, player: p.player, type: p.type, score: Math.round(p.score * 10) / 10, team: p.team, at: new Date(p.abs).toISOString() })), stats: { ...stats, seconds: Math.round((Date.now() - t0) / 1000), length: Math.round(await probeDur(wide)) } };
    if (opts.keep) return { ...result, files: { wide, vertical: vert }, dir };
    progress(job, pl ? '📤 Wysyłam pliki' : '📤 Uploading files');
    for (const [kind, f] of [['wide', wide], ['vertical', vert]]) {
      const r = await fetch(`${job.callback}/highlights/upload?sid=${encodeURIComponent(job.scheduleId)}&kind=${kind}`, { method: 'POST', headers: { 'X-Webhook-Secret': SECRET, 'Content-Type': 'video/mp4' }, body: await fsp.readFile(f) });
      if (!r.ok) throw new Error(`upload ${kind}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await report(job, result); return result;
  } catch (e) {
    log(`[${job.scheduleId}] ❌`, e.message);
    if (!opts.keep) await report(job, { ok: false, scheduleId: job.scheduleId, error: e.message, stats }); else throw e;
  } finally { if (!opts.keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
function progress(job, text) { if (!job.callback || /^http:\/\/x$/.test(job.callback)) return; fetch(`${job.callback}/highlights/progress`, { method: 'POST', headers: { 'X-Webhook-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleId: job.scheduleId, text }) }).catch(() => {}); log(`[${job.scheduleId}] ${text}`); }
async function report(job, body) { await fetch(`${job.callback}/highlights/done`, { method: 'POST', headers: { 'X-Webhook-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(e => log('report:', e.message)); }

// ── kolejka i HTTP ──────────────────────────────────────────────
const queue = []; let current = null;
async function pump() { if (current || !queue.length) return; current = queue.shift(); progress(current, current.lang === 'pl' ? '▶ Start' : '▶ Started');
  try { await processJob(current); } catch (e) { log('job:', e.message); } current = null; setImmediate(pump); }
if (require.main === module) {
  http.createServer((req, res) => {
    const J = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/health') return J(200, { ok: true, queue: queue.length, current: current ? current.scheduleId : null, gemini: GKEYS.length > 0 });
    if (req.method === 'POST' && req.url === '/job') {
      if (!SECRET || req.headers['x-webhook-secret'] !== SECRET) return J(401, { error: 'Unauthorized' });
      let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); });
      req.on('end', () => { let j; try { j = JSON.parse(b); } catch { return J(400, { error: 'bad json' }); }
        if (!j.scheduleId || !j.callback || !(j.streams || []).length) return J(400, { error: 'scheduleId, callback, streams required' });
        if (queue.some(q => String(q.scheduleId) === String(j.scheduleId) && q.callback === j.callback)) return J(200, { ok: true, duplicate: true });
        queue.push(j); J(202, { ok: true, position: queue.length }); pump(); });
      return;
    }
    J(404, { error: 'not found' });
  }).listen(PORT, () => log(`🎞️ clip server :${PORT} · gemini ${GKEYS.length ? 'on' : 'OFF'}`));
}
module.exports = { processJob, audioPeaks, loudness, judge };
