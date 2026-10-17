let WORDS = {}; // words.json から読み込む（レベル1〜4）

/* --- かな → ローマ字の入力パターン（複数表記対応） --- */
const BASE = {};
("あ a い i う u え e お o か ka き ki く ku け ke こ ko さ sa し shi|si す su せ se そ so " +
  "た ta ち chi|ti つ tsu|tu て te と to な na に ni ぬ nu ね ne の no は ha ひ hi ふ fu|hu へ he ほ ho " +
  "ま ma み mi む mu め me も mo や ya ゆ yu よ yo ら ra り ri る ru れ re ろ ro わ wa を wo " +
  "が ga ぎ gi ぐ gu げ ge ご go ざ za じ ji|zi ず zu ぜ ze ぞ zo だ da ぢ di づ du で de ど do " +
  "ば ba び bi ぶ bu べ be ぼ bo ぱ pa ぴ pi ぷ pu ぺ pe ぽ po").split(" ")
  .forEach((v, i, a) => { if (i % 2 === 0) BASE[v] = a[i + 1].split("|"); });
const YSTEM = { "し": ["sh", "sy"], "ち": ["ch", "ty", "cy"], "じ": ["j", "jy", "zy"] };
const YV = { "ゃ": "a", "ゅ": "u", "ょ": "o" };

function toHira(str) {
  return [...str].map(c => { const n = c.charCodeAt(0); return n >= 0x30A1 && n <= 0x30F6 ? String.fromCharCode(n - 0x60) : c; }).join("");
}
function buildCandidates(kana) {
  // 全角の英数字・記号（ｗ、！、？など）は半角に直し、読点・句点はキーボードの , . に対応させる
  const h = [...toHira(kana.normalize("NFKC").replace(/、/g, ",").replace(/。/g, ".").toLowerCase())], toks = [];
  let small = false;
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (c === "っ") { small = true; continue; }
    let t;
    if (c === "ー") {
      t = { opts: ["-"] }; // 伸ばし棒は「ー」キー（-）で入力
    } else if (c === "ん") {
      t = { n: true };
    } else if (YV[h[i + 1]] && BASE[c]) {
      const stems = YSTEM[c] || [BASE[c][0].replace(/i$/, "") + "y"];
      t = { opts: stems.map(st => st + YV[h[i + 1]]) }; i++;
    } else {
      t = { opts: BASE[c] || [c] };
    }
    if (small && t.opts) {
      const o2 = [];
      t.opts.forEach(o => { if (/^[bcdfghjklmpqrstvwxyz]/.test(o)) o2.push(o[0] + o); });
      t.opts.forEach(o => { o2.push("xtu" + o, "ltu" + o, "xtsu" + o, "ltsu" + o); });
      t = { opts: o2 }; small = false;
    }
    toks.push(t);
  }
  let res = [""];
  toks.forEach((t, i) => {
    let opts = t.opts;
    if (t.n) {
      const nx = toks[i + 1];
      const plain = !nx || (nx.opts && nx.opts.every(o => !/^[aiueoy]/.test(o)));
      opts = plain ? ["n", "nn", "xn"] : ["nn", "xn"];
    }
    const next = [];
    res.forEach(r => opts.forEach(o => next.push(r + o)));
    res = next;
  });
  return [...new Set(res)];
}
let cands = [], typed = "";
/* 設定（setting.json で上書きできる。読み込めないときはこの初期値を使う） */
const DEFAULTS = {
  title: "ローマ字タイピング",
  desc: "60秒のあいだに、表示された言葉をローマ字で打とう。\nミスなしで打てた言葉が続くほど、長い言葉が出やすくなります。",
  resultTitle: "おつかれさま！",
  theme: "blue",      // blue / green / yellow / red
  background: "",     // 空欄なら通常の背景。画像ファイル名（例: "photo.png"）を入れるとその画像になる
  time: 60,
  font: "",           // 空欄なら標準。Google Fontsの名前（例: "Noto Serif JP"）を入れると、そのフォントになる
  hideRomaji: false,  // true にすると、ローマ字のガイドを隠す（打った文字だけ表示）
  timeBonus: 0,       // 1語打てるごとに足す秒数
  missScorePenalty: 0, // ミス1回で引く点数
  missTimePenalty: 0,  // ミス1回で減らす秒数
  maxMiss: 0,         // この回数ミスしたら終了（0なら無制限）
  easyWords: 4,
  recentExclude: 8,
  scorePerLevel: { "1": 10, "2": 10, "3": 10, "4": 20 },
  comboBonusEvery: 5,
  comboBonus: 5,
  shareUrl: "",
  shareText: "ローマ字タイピングで{score}点！（{done}語・正確さ{accuracy}%・最大{maxCombo}連続）"
};
const FONT_STACK = '"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
let S = DEFAULTS, TOTAL = DEFAULTS.time;
const $ = id => document.getElementById(id);
const screens = { start: $("start"), play: $("play"), end: $("end") };
let state = "start", word, last = [], score, combo, maxCombo, endTime, raf, keys, miss, done, missed, topLevel, curLevel;

function show(name) { state = name; for (const k in screens) screens[k].classList.toggle("hidden", k !== name); }
function getBest() { try { return +localStorage.getItem("typing-best") || 0; } catch (e) { return 0; } }
function setBest(v) { try { localStorage.setItem("typing-best", v); } catch (e) { } }
$("best").textContent = getBest();

/* 連続（ミスなしで打てた言葉の数）が増えるほど、長い言葉のレベルが出やすくなる */
function pickLevel() {
  const target = 1 + Math.min(3, combo / 4);
  const w = [1, 2, 3, 4].map(L => Math.max(0.08, 1 - Math.abs(L - target) * 0.5));
  if (done < S.easyWords) w[2] = w[3] = 0; // 最初の数語は必ずレベル1〜2
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 4; i++) { r -= w[i]; if (r <= 0) return i + 1; }
  return 4;
}
function nextWord() {
  const lv = pickLevel(); curLevel = lv; topLevel = Math.max(topLevel, lv);
  // 直近8語は出さない（候補が尽きたときだけ、直前の1語だけを除く）
  let list = WORDS[lv].filter(w => !last.includes(w.text));
  if (!list.length) list = WORDS[lv].filter(w => w.text !== last[last.length - 1]);
  if (!list.length) list = WORDS[lv]; // 1語しかないレベルでもエラーにならないように
  const pick = list[Math.floor(Math.random() * list.length)];
  word = pick.text;
  last.push(word); if (last.length > S.recentExclude) last.shift();                       // 画面に表示する文字（漢字OK）
  typed = ""; missed = false; cands = buildCandidates(pick.kana); // 入力は読み仮名から作る
  $("kana").textContent = word; fit($("kana"));
  const longest = cands.reduce((a, b) => b.length > a.length ? b : a);
  $("romaji").textContent = longest; fit($("romaji"));
  render();
}
/* はみ出しそうなときは文字を小さくする */
function fit(el) {
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > 10) { size -= 1; el.style.fontSize = size + "px"; }
}
function render() {
  const r = cands[0];
  if (S.hideRomaji) { $("romaji").innerHTML = `<span class="d">${typed}</span>`; return; }
  $("romaji").innerHTML = `<span class="d">${typed}</span><span class="c">${r[typed.length]}</span><span class="n">${r.slice(typed.length + 1)}</span>`;
}
function start() {
  if (!WORDS[1]) return;
  score = combo = maxCombo = keys = miss = done = 0; topLevel = 1; last = [];
  $("score").textContent = 0; $("combo").textContent = 0; $("time").textContent = TOTAL; $("msg").textContent = "";
  $("missBox").classList.toggle("hidden", !(S.maxMiss > 0)); $("missCount").textContent = "0/" + S.maxMiss;
  $("bar").style.transform = "scaleX(1)"; $("bar").classList.remove("low");
  show("play"); nextWord();
  endTime = performance.now() + TOTAL * 1000;
  cancelAnimationFrame(raf);
  const tick = now => {
    if (state !== "play") return;
    const left = Math.max(0, endTime - now);
    $("bar").style.transform = `scaleX(${Math.min(1, left / (TOTAL * 1000))})`;
    $("time").textContent = Math.ceil(left / 1000);
    $("bar").classList.toggle("low", left <= 10000);
    if (left <= 0) return finish();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function finish() {
  cancelAnimationFrame(raf);
  const hits = keys - miss, acc = keys ? Math.round(hits / keys * 100) : 0;
  $("rScore").textContent = score; $("rKpm").textContent = Math.round(hits * 60 / TOTAL);
  $("rAcc").textContent = acc + "%"; $("rWords").textContent = done;
  const best = getBest();
  if (score > best) { setBest(score); $("rBest").textContent = "ベストスコアを更新しました！"; }
  else $("rBest").textContent = "ベストスコア：" + best;
  $("best").textContent = Math.max(best, score);
  const text = S.shareText.replace("{score}", score).replace("{done}", done)
    .replace("{accuracy}", acc).replace("{maxCombo}", maxCombo);
  $("share").href = "https://x.com/intent/post?text=" + encodeURIComponent(text) + (S.shareUrl ? "&url=" + encodeURIComponent(S.shareUrl) : "");
  show("end");
}
function press(ch) {
  keys++;
  const t2 = typed + ch, f = cands.filter(c => c.startsWith(t2));
  if (f.length) {
    typed = t2; cands = f;
    if (cands.includes(typed)) {
      done++;
      if (!missed) { combo++; maxCombo = Math.max(maxCombo, combo); }
      // 基本点（レベルごと）＋ 連続ボーナス
      const bonus = S.comboBonusEvery > 0 ? Math.floor(combo / S.comboBonusEvery) * S.comboBonus : 0;
      score += (S.scorePerLevel[curLevel] ?? 10) + bonus;
      endTime += S.timeBonus * 1000; // 残り時間を足す
      $("msg").textContent = combo >= 5 ? combo + " 連続！" : "";
      nextWord();
    } else render();
  } else {
    miss++; missed = true; combo = 0; $("msg").textContent = "";
    score = Math.max(0, score - S.missScorePenalty); // 点数ペナルティ
    endTime -= S.missTimePenalty * 1000;             // 時間ペナルティ
    $("missCount").textContent = miss + "/" + S.maxMiss;
    const k = $("kana"); k.classList.remove("shake"); void k.offsetWidth; k.classList.add("shake");
  }
  $("score").textContent = score; $("combo").textContent = combo;
  if (S.maxMiss > 0 && miss >= S.maxMiss) finish(); // ミスの回数で終了
}
document.addEventListener("keydown", e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" && state !== "start") { e.preventDefault(); start(); return; } // Escでリスタート
  if (state !== "play") {
    if (e.key === "Enter") { e.preventDefault(); start(); }
    return;
  }
  if (e.key.length === 1) { e.preventDefault(); press(e.key.toLowerCase()); }
});
$("go").onclick = start; $("again").onclick = start;

/* setting.json と words.json を読み込む（ローカルで開く場合はサーバー経由で開いてください） */
function applySettings() {
  TOTAL = S.time;
  document.title = S.title;
  $("title").textContent = S.title;
  $("desc").textContent = S.desc;
  $("resultTitle").textContent = S.resultTitle;
  if (S.font) {
    const name = String(S.font).replace(/["\\]/g, "");
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(name).replace(/%20/g, "+") + "&display=swap";
    document.head.appendChild(l);
    document.documentElement.style.setProperty("--font", `"${name}", ` + FONT_STACK);
  }
  document.documentElement.dataset.theme = ["blue", "green", "yellow", "red"].includes(S.theme) ? S.theme : "blue";
  if (S.background) {
    document.body.style.background = `url("${encodeURI(S.background)}") center/cover no-repeat`;
  }
}
$("go").disabled = true;
Promise.all([
  fetch("setting.json").then(r => r.json()).catch(() => ({})),   // 無くてもOK（初期値で動く）
  fetch("words.json").then(r => r.json())
]).then(([st, d]) => {
  S = Object.assign({}, DEFAULTS, st);
  S.scorePerLevel = Object.assign({}, DEFAULTS.scorePerLevel, st.scorePerLevel);
  applySettings();
  // "猫 ねこ" → {text, kana}　（読みが同じ言葉は "ゲーム" のように1つだけでOK）
  for (const k in d.levels) WORDS[k] = d.levels[k].map(s => { const [text, kana = text] = s.split(" "); return { text, kana }; });
  $("go").disabled = false;
}).catch(() => { $("go").textContent = "words.json を読み込めません"; });