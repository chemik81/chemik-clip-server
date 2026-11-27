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
let _models = null, _modelsAt = 0; // ranking modeli „flash” z listy Google (stare modele znikają, nowe bywają przeciążone)
async function modelList(force) {
  if (_models && !force && Date.now() - _modelsAt < 6 * 36e5) return _models;
  let list = [];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GKEYS[0]}`, { signal: AbortSignal.timeout(15e3) });
    list = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  } catch (e) { log('models:', e.message); }
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const flash = list.filter(n => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|live|audio|native|thinking/.test(n)).sort((a, b) => ver(b) - ver(a) || (/preview|exp/.test(a) ? 1 : 0) - (/preview|exp/.test(b) ? 1 : 0));
  _models = [...new Set([process.env.GEMINI_MODEL, ...flash, 'gemini-flash-latest'].filter(Boolean))]; _modelsAt = Date.now(); log('gemini models:', _models.slice(0, 4).join(', '));
  return _models;
}
// jedno zapytanie do Gemini: przeciążony model (503/timeout) → na 20 min schodzi na koniec kolejki; klucz bez limitu (429) → pomijany przez godzinę
const _cool = {}; const cool = (k, ms) => { _cool[k] = Date.now() + ms; }, hot = k => (_cool[k] || 0) > Date.now();
async function gemGenerate(parts, { keys = GKEYS, timeout = 60e3, budget = 180e3, cfg = {} } = {}) {
  const t0 = Date.now(); let models = await modelList();
  const order = () => [...models.slice(0, 4).filter(m => !hot('m:' + m)), ...models.slice(0, 4).filter(m => hot('m:' + m))];
  const ks = () => { const ok = keys.filter(k => !hot('k:' + k)); return ok.length ? ok : keys; };
  for (const model of order()) {
    for (const key of ks()) {
      if (Date.now() - t0 > budget) return null;
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', ...cfg } }), signal: AbortSignal.timeout(timeout) });
        if (r.ok) { const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); if (t) return t; continue; }
        const body = (await r.text()).slice(0, 120).replace(/\s+/g, ' '); log('gemini', r.status, model, key === process.env.GEMINI_FREE_KEY ? '(free)' : '(paid)', body);
        if (r.status === 404) { models = await modelList(true); break; }
        if (r.status === 429) { cool('k:' + key, 60 * 60e3); continue; }        // limit klucza → następny klucz
        if (r.status === 503 || r.status === 500) { cool('m:' + model, 20 * 60e3); break; } // przeciążony model → następny model
      } catch (e) { log('gemini err', model, e.message); cool('m:' + model, 20 * 60e3); break; }
    }
  }
  return null;
}
// 🏷️ nick z obrazu → najbliższy nick z prawdziwego składu (statystyki meczu + składy drużyn)
const _nn = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function _lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
function matchName(raw, roster) {
  const r = _nn(raw); if (!r || !(roster || []).length) return roster?.length ? null : (raw || null);
  let best = null, bs = 0;
  for (const n of roster) { const k = _nn(n); if (!k) continue; let sc = k === r ? 1 : (k.includes(r) || r.includes(k)) && Math.min(k.length, r.length) >= 3 ? 0.85 : 1 - _lev(k, r) / Math.max(k.length, r.length); if (sc > bs) { bs = sc; best = n; } }
  return bs >= 0.6 ? best : null;
}
const cleanCaption = (cap, raw, name) => { let c = String(cap || ''); for (const x of [raw, name].filter(Boolean)) c = c.replace(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim(); c = c.replace(/^[\s,:;—–-]+|[\s,:;—–-]+$/g, '').replace(/\s{2,}/g, ' '); return c ? c[0].toUpperCase() + c.slice(1) : c; };
const rosterLine = job => (job.roster || []).length ? `\nPlayers in this game (if you name a player, use the EXACT spelling from this list, otherwise null): ${job.roster.join(', ')}.` : '';
const parseJson = t => { try { return JSON.parse(String(t).replace(/^\s*```(json)?|```\s*$/g, '').trim()); } catch { return null; } };
const tSec = v => { if (typeof v === 'number') return v; const m = String(v || '').trim().split(':').map(Number); return m.some(isNaN) ? NaN : m.reduce((a, x) => a * 60 + x, 0); };
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
  const small = file.replace(/\.mp4$/, '.ai.mp4'); // mniejsza kopia dla AI (szybsza odpowiedź, ten sam obraz akcji)
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', 'scale=-2:480,fps=15', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-ac', '1', '-b:a', '64k', small]).catch(() => {});
  const data = (await fsp.readFile(fs.existsSync(small) ? small : file)).toString('base64');
  const prompt = `This is a ~24 second clip from a stream of an NBA 2K Pro-Am game (${ctx.team1} vs ${ctx.team2}). The camera follows one player. Voices on the stream are the players' team voice chat and may be in ANY language (Polish, Finnish, Turkish, Romanian, English…) — loud excited voices are a hint that something big happened, but judge mainly by what you SEE.
Rate how highlight-worthy the best play in the clip is, 0–10. Be strict and use the whole scale: 9–10 = poster dunk, game winner, buzzer beater, ankle breaker + score, chase-down block; 7–8 = clean dunk, deep/contested three, alley-oop, great block, steal + fast-break finish, and-one; 5–6 = nice layup, open three, good pass; 2–4 = ordinary possession, missed shot; 0–1 = nothing happening, menus, replays, loading screens, free throws, timeouts.
Reply with JSON only: {"score": number, "type": "dunk|three|block|steal|alleyoop|layup|assist|other|none", "caption": "${ctx.lang === 'pl' ? 'krótki opis samej akcji po polsku, max 50 znaków, bez emoji i BEZ nicku gracza' : 'short description of the play itself in English, max 50 chars, no emoji and WITHOUT the player name'}", "player": "gamertag of the player who made the play if readable on screen, else null", "start": seconds, "end": seconds}${rosterLine(ctx)} — start/end = the best 8–14 s within the clip: include the build-up and the finish, end 1–2 s after the ball goes in or the play ends.`;
  const t = await gemGenerate([{ inline_data: { mime_type: 'video/mp4', data } }, { text: prompt }]); await fsp.unlink(small).catch(() => {});
  const o = t && parseJson(t); if (!o) return null;
  return { score: +o.score || 0, type: o.type || 'other', caption: String(o.caption || '').slice(0, 60), player: o.player && o.player !== 'null' ? String(o.player).slice(0, 30) : null, start: +o.start || 0, end: +o.end || 0 };
}
// 🧠 Gemini ogląda CAŁY mecz w niskiej rozdzielczości i wskazuje najlepsze akcje (główne źródło kandydatów)
async function gemUpload(file, key) {
  const size = (await fsp.stat(file)).size;
  const r1 = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`, { method: 'POST', headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': 'video/mp4', 'Content-Type': 'application/json' }, body: JSON.stringify({ file: { display_name: path.basename(file) } }) });
  const up = r1.headers.get('x-goog-upload-url'); if (!up) throw new Error('upload start ' + r1.status);
  const r2 = await fetch(up, { method: 'POST', headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: await fsp.readFile(file) });
  let f = (await r2.json()).file; if (!f?.name) throw new Error('upload ' + r2.status);
  for (let i = 0; i < 60 && f.state === 'PROCESSING'; i++) { await new Promise(x => setTimeout(x, 5000)); f = await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${key}`).then(r => r.json()); }
  if (f.state !== 'ACTIVE') throw new Error('file state ' + f.state);
  return f;
}
async function scanGame(url, from, to, dir, ctx, tag) {
  if (!GKEYS.length) return [];
  const low = path.join(dir, `scan_${tag}.mp4`), enc = ['-vf', 'scale=-2:360,fps=10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-ac', '1', '-b:a', '48k', low];
  if (isLocal(url)) await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(from), '-to', String(to), '-i', localPath(url), ...enc]);
  else { const tmp = path.join(dir, `scanraw_${tag}`);
    await run('yt-dlp', ['-q', '--no-warnings', '-f', 'b[height<=360]/bv*[height<=360]+ba/worst', '--merge-output-format', 'mp4', '--download-sections', `*${hms(from)}-${hms(to)}`, '--concurrent-fragments', '4', '-o', tmp + '.%(ext)s', url], { timeout: 25 * 60e3 });
    const f = (await fsp.readdir(dir)).find(x => x.startsWith(`scanraw_${tag}.`)); if (!f) throw new Error('scan video not downloaded');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, f), ...enc]); await fsp.unlink(path.join(dir, f)).catch(() => {}); }
  const mins = Math.round((to - from) / 60);
  const prompt = `This video is a full ${mins}-minute recording of an NBA 2K Pro-Am game stream (${ctx.team1} vs ${ctx.team2}); the camera follows one player. Voice chat may be in any language — use it only as a hint.
Find the 15 BEST highlight plays of the whole game (dunks, deep or clutch threes, alley-oops, blocks, steals that lead to a score, ankle breakers, and-ones, game-winners). Skip lobby, menus, loading screens, replays, free throws and dead balls. Spread them across the game, do not list the same play twice.
Also find the moment when the FINAL box score / end-of-game stats screen is shown (after the final buzzer).
Reply with JSON only: {"plays": [ {"time": "MM:SS" (the moment the ball goes in / the play ends, measured from the START OF THIS VIDEO), "score": 0-10, "type": "dunk|three|block|steal|alleyoop|layup|assist|other", "caption": "${ctx.lang === 'pl' ? 'krótki opis akcji po polsku, max 50 znaków, bez nicku' : 'short description of the play in English, max 50 chars, without the player name'}", "player": "gamertag if readable, else null"} ], "boxscore": "MM:SS" or null} — plays best first.${rosterLine(ctx)}`;
  for (const key of GKEYS) { let f = null;
    try {
      f = await gemUpload(low, key);
      const t = await gemGenerate([{ file_data: { mime_type: 'video/mp4', file_uri: f.uri } }, { text: prompt }], { keys: [key], timeout: 240e3, budget: 600e3, cfg: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } });
      const o = t && parseJson(t), arr = Array.isArray(o) ? o : o?.plays;
      if (o && !Array.isArray(o) && o.boxscore && isFinite(tSec(o.boxscore))) scanGame.box = { [tag]: from + tSec(o.boxscore) };
      if (Array.isArray(arr)) return arr.map(x => ({ t: from + tSec(x.time ?? x.t), score: +x.score || 0, type: x.type || 'other', caption: String(x.caption || '').slice(0, 60), player: x.player && x.player !== 'null' ? String(x.player).slice(0, 30) : null })).filter(x => isFinite(x.t) && x.t >= from && x.t <= to);
    } catch (e) { log('scan:', e.message); }
    finally { if (f?.name) fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${key}`, { method: 'DELETE' }).catch(() => {}); }
  }
  return [];
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
    + (caption ? `drawbox=x=0:y=ih-92:w=iw:h=92:color=black@0.55:t=fill,${dt(cf, 34, 40, 'h-70')},${dt(tf, 22, 40, 26, ':box=1:boxcolor=black@0.45:boxborderw=10')},` : '')
    + `fade=t=in:st=0:d=0.25,fade=t=out:st=${(d - 0.25).toFixed(2)}:d=0.25`;
  await run('ffmpeg', ['-y', '-ss', a.toFixed(2), '-to', b.toFixed(2), '-i', seg, '-vf', vf, '-af', `afade=t=in:st=0:d=0.25,afade=t=out:st=${(d - 0.3).toFixed(2)}:d=0.3`, ...V, out]);
  return out;
}
async function boxCard(dir, box, job, secs) { // 📊 tabela statystyk z danych ligi (gdy na nagraniu nie ma ekranu statystyk)
  const files = [], vf = [], add = async (s, size, x, y, col = 'white') => { const f = await txt(dir, 'bx' + files.length, s); files.push(f); vf.push(dt(f, size, x, y, `:fontcolor=${col}`)); };
  await add(job.lang === 'pl' ? 'STATYSTYKI MECZU' : 'FINAL BOX SCORE', 26, '(w-text_w)/2', 40, '0xf5c518');
  for (const [ci, t] of [box.t1, box.t2].entries()) { const x0 = ci ? 680 : 60;
    await add(`${t.name}  ${t.score}`, 30, x0, 100);
    await add('PTS  REB  AST', 18, x0 + 330, 150, '0x9aa4bf');
    for (const [i, p] of (t.players || []).entries()) { const y = 185 + i * 48; await add(p.n, 24, x0, y); await add(`${String(p.pts).padStart(3)}  ${String(p.reb).padStart(3)}  ${String(p.ast).padStart(3)}`, 24, x0 + 330, y); } }
  const out = path.join(dir, 'boxcard.mp4');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x0b1020:s=1280x720:d=${secs}:r=30`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(secs), '-vf', `drawbox=x=640:y=95:w=2:h=520:color=0x334155:t=fill,${vf.join(',')},fade=t=in:st=0:d=0.4,fade=t=out:st=${secs - 0.4}:d=0.4`, ...V, '-shortest', out]);
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
    const gameLen = Math.max(1, job.bestOf || 1) * 75 * 60 + 20 * 60, plays = []; let boxAt = null;
    for (const [si, s] of (job.streams || []).entries()) {
      const off = ms => (ms - s.created) / 1000, vodLen = (s.dur || 4 * 36e5) / 1000;
      const from = Math.max(0, off(job.start) - 300), to = Math.min(vodLen, from + gameLen);
      if (to - from < 120) continue; stats.streams++;
      progress(job, `${pl ? '🔊 Pobieram dźwięk i szukam głośnych momentów' : '🔊 Downloading audio, looking for loud moments'} (${hms(from)}–${hms(to)})`);
      // kandydaci: kliknięcia kibiców (akcja chwilę PRZED kliknięciem), klipy, skoki głośności
      const C = [];
      (job.presses || []).forEach(t => C.push({ t: off(t) - 7, w: 3 }));
      (job.fanClips || []).filter(c => !c.login || c.login === s.login).forEach(c => C.push({ t: off(c.t) - 9, w: 3 + (c.votes || 1) }));
      C.forEach(c => { c.fan = c.w; });
      try { const db = await loudness(s.url, from, to, dir); audioPeaks(db, from, 10).forEach(p => C.push({ t: p.t - 2, w: Math.min(3, p.w) })); } catch (e) { log('audio:', e.message); }
      progress(job, pl ? '🧠 Gemini ogląda cały mecz i wybiera najlepsze akcje' : '🧠 Gemini is watching the whole game and picking the best plays');
      try { scanGame.box = null; const sc = await scanGame(s.url, from, to, dir, job, si); stats.scanned = (stats.scanned || 0) + sc.length; sc.forEach(x => C.push({ t: x.t, w: 2 + x.score, scan: x }));
        if (scanGame.box?.[si] && !boxAt) boxAt = { url: s.url, t: scanGame.box[si], vodLen }; } catch (e) { log('scan:', e.message); }
      const M = []; C.filter(c => c.t > from && c.t < to).sort((a, b) => a.t - b.t).forEach(c => { const l = M[M.length - 1]; if (l && c.t - l.t < 15) { l.w += c.w; l.fan = (l.fan || 0) + (c.fan || 0); if (c.scan && (!l.scan || c.scan.score > l.scan.score)) l.scan = c.scan; if (c.w > l.top) { l.t = c.t; l.top = c.w; } } else M.push({ ...c, top: c.w }); });
      const pick = M.sort((a, b) => b.w - a.w).slice(0, opts.maxCand || (job.streams.length > 1 ? 12 : 18)); stats.candidates += pick.length;
      for (const [ci, c] of pick.entries()) {
        progress(job, `${pl ? '🎬 Fragment' : '🎬 Clip'} ${ci + 1}/${pick.length}: ${pl ? 'pobieram i oceniam (Gemini)' : 'downloading and rating (Gemini)'}`);
        const seg = path.join(dir, `seg${si}_${ci}.mp4`), a = Math.max(0, c.t - 16), b = Math.min(vodLen, c.t + 8);
        try { await getSegment(s.url, a, b, seg); } catch (e) { log('segment:', e.message); continue; }
        const seglen = await probeDur(seg), mid = c.t - a; let j = await judge(seg, job); if (j) stats.judged++;
        if (!j && c.scan) j = { ...c.scan, start: mid - 10, end: mid + 2 }; // ocena z przeglądu całego meczu
        if (!j) j = { score: Math.min(6, 2 + c.w / 2), type: 'other', caption: pl ? 'Akcja meczu' : 'Big play', player: null, start: mid - 10, end: mid + 2, weak: true };
        let st = Math.max(0, Math.min(j.start, seglen - 6)), en = Math.min(seglen, Math.max(j.end, st + 8)); if (en - st > 15) st = en - 15;
        plays.push({ seg, seglen, a: st, b: en, abs: s.created + (a + st) * 1000, score: j.score + Math.min(1.5, (c.fan || 0) / 4) + (c.scan && !j.weak ? 0.5 : 0), type: j.type, ...(() => { const raw = j.player || c.scan?.player || null, nm = matchName(raw, job.roster); return { player: nm, caption: cleanCaption(j.caption || c.scan?.caption, raw, nm) || (pl ? 'Akcja meczu' : 'Big play') }; })(), team: s.team, login: s.login });
      }
    }
    // to samo z dwóch transmisji (±12 s) → zostaje lepiej oceniona
    const uniq = []; plays.sort((x, y) => y.score - x.score).forEach(p => { if (!uniq.some(u => Math.abs(u.abs - p.abs) < 12e3)) uniq.push(p); });
    // najlepsze akcje: wszystkie mocne (≥7), potem kolejne najlepsze, aż skrót ma min. 60 s (maks. 12 akcji / ~130 s)
    const MIN = opts.minSec || 60, MAXN = opts.maxPlays || 12, len = p => p.b - p.a; let best = [], total = 0;
    for (const p of uniq) { if (best.length >= MAXN || total > 130) break; if (p.score >= 7 || total < MIN) { best.push(p); total += len(p); } }
    if (best.length < 3) throw new Error(pl ? `za mało akcji (${best.length})` : `not enough plays (${best.length})`);
    if (total < MIN) { const ext = Math.min(5, (MIN - total) / best.length); best.forEach(p => { const add = Math.min(ext, p.a); p.a -= add; p.abs -= add * 1000; total += add; }); } // za krótko → dłuższy rozbieg akcji
    best.sort((x, y) => x.abs - y.abs); stats.reelSec = Math.round(total);
    progress(job, `${pl ? '✂️ Montaż skrótu' : '✂️ Editing the reel'} (${best.length} ${pl ? 'akcji' : 'plays'})`);
    const score = (job.games || []).map(g => `${g.s1} : ${g.s2}`).join('   ·   ');
    const top = `${job.team1} vs ${job.team2}${job.week ? `  ·  WEEK ${job.week}` : ''}`;
    const parts = [await card(dir, 'intro', [[brand, 30, '0xf5c518'], [`${job.team1}  vs  ${job.team2}`, 54], ...(score ? [[score, 44]] : []), [`${job.week ? `WEEK ${job.week}  ·  ` : ''}HIGHLIGHTS`, 26, '0x9aa4bf']], 3)];
    for (const [i, p] of best.entries()) parts.push(await part(dir, i, p.seg, p.a, p.b, `${p.caption}${p.player && !p.caption.toLowerCase().includes(p.player.toLowerCase()) ? '  —  ' + p.player : ''}`, top));
    progress(job, pl ? '📊 Tabela statystyk na koniec' : '📊 Box score at the end');
    let boxPart = null;
    if (boxAt) try { const seg = path.join(dir, 'boxseg.mp4'), a = Math.max(0, boxAt.t - 0.5); await getSegment(boxAt.url, a, Math.min(boxAt.vodLen, a + 5), seg);
      const d = await probeDur(seg); if (d >= 3) boxPart = await part(dir, 'box', seg, 0, Math.min(4.5, d), '', top); /* ekran statystyk z gry — bez paska z podpisem */ } catch (e) { log('box:', e.message); }
    if (!boxPart && (job.box || []).length) boxPart = await boxCard(dir, job.box[job.box.length - 1], job, 5).catch(e => { log('boxcard:', e.message); return null; });
    if (boxPart) parts.push(boxPart);
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
