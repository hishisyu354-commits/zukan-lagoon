/**
 * 図鑑ラグーン — GASバックエンド(案A: 端末トークン方式・LINE不要)
 *
 * 初回セットアップ:
 *   1. script.google.com で新規プロジェクトを作り、このファイルを貼る
 *      (appsscript.json は「プロジェクトの設定 → マニフェスト表示」で差し替え)
 *   2. エディタから setup() を1回実行(権限承認) →
 *      ログにシートURLと「オーナーコード」が出る。オーナーコードは誰にも見せない
 *   3. デプロイ > ウェブアプリ / 実行ユーザー=自分 / アクセス=全員 → /exec URLを控える
 *   4. 公開ページの #/setup を開き、オーナーコードと表示名を入れて自分をオーナー登録
 *
 * ユーザー識別(案A・承認ゲートなし版 2026-08-22菱沼判断):
 *   - 各端末が初回書き込み時にランダムな秘密トークンを生成し、書き込みに毎回添付する
 *   - membersシートで トークン→(表示名・状態) を管理。状態: owner/member/blocked
 *   - 未知のトークンは即memberとして自動登録され、そのまま投稿できる(承認不要)
 *   - 表示名は自己申告。同じトークンからの申告で変更可(フォームの名前欄=自分の名前)
 *   - blockedだけは投稿拒否(オーナーが管理タブ or シート直編集で設定する非常ブレーキ)
 *   - オーナーはセットアップコードで確定(先着レースなし・機種変時も同コードで復帰可)
 *
 * 読み(doGet)は誰でも。公開JSONにトークンは含めない(表示名のみ)。
 * 削除・修正はスプレッドシート直編集で行う(削除APIを持たない=攻撃面を減らす)。
 */

var PROPS = PropertiesService.getScriptProperties();

var VERSION = "v3"; // ping応答に含める。フロント/Claudeが反映確認に使う

var SHEET_DEFS = {
  fish:     ["id", "name", "rarity", "description", "knownPointIds", "seasons", "createdByName", "createdByToken", "createdAt"],
  records:  ["id", "fishId", "pointId", "date", "depth", "memo", "photoIds", "userName", "token", "createdAt"],
  comments: ["id", "targetType", "targetId", "text", "userName", "token", "createdAt"],
  points:   ["id", "area", "subarea", "name", "lat", "lng"],
  members:  ["token", "displayName", "status", "requestedAt", "updatedAt"]
};

// 初期ポイント(新規setup時のみ使用)。階層=エリア>サブエリア>ポイント。緯度経度はおおよそ。
// 【注】ポイントの正はフロント(index.htmlのPOINTS_MASTER)。稼働中のシートが旧5列形式でも
// フロント側が同idを新形式で上書き表示するため、既存シートの改修・再デプロイは不要。
// シートに「フロントに無い新しいid」の行を足せば追加ポイントとして合流する。
var SEED_POINTS = [
  ["izu-osezaki-wannai", "伊豆", "大瀬崎", "湾内", 35.0268, 138.7877],
  ["izu-osezaki-sentan", "伊豆", "大瀬崎", "先端", 35.0313, 138.786],
  ["izu-koganezaki",     "伊豆", "", "黄金崎", 34.7947, 138.7637],
  ["izu-futo",           "伊豆", "", "富戸", 34.9256, 139.133],
  ["izu-iop",            "伊豆", "", "伊豆海洋公園(IOP)", 34.9092, 139.142],
  ["okinawa-maeda",      "沖縄本島", "恩納村", "真栄田岬", 26.445, 127.7716],
  ["okinawa-zanpa",      "沖縄本島", "読谷村", "残波岬", 26.4409, 127.7119],
  ["kerama-zamami",      "慶良間", "", "座間味", 26.2283, 127.3038],
  ["hachijo-nazumado",   "八丈島", "", "ナズマド", 33.1216, 139.7614],
  ["hachijo-yaene",      "八丈島", "", "八重根", 33.1005, 139.7683],
  ["hachijo-sokodo",     "八丈島", "", "底土", 33.113, 139.801]
];

var LIMITS = {
  maxPhotosPerRecord: 4,
  maxPhotoBase64Bytes: 2 * 1024 * 1024, // 圧縮済み前提(クライアントで長辺1600px/0.82)
  maxTextLen: 1000,
  maxCommentLen: 300,
  maxNameLen: 60,
  minTokenLen: 16
};

/* ---------------- セットアップ ---------------- */

function setup() {
  var ssId = PROPS.getProperty("SS_ID");
  var ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.create("zukan-lagoon-db");
  if (!ssId) PROPS.setProperty("SS_ID", ss.getId());

  Object.keys(SHEET_DEFS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEET_DEFS[name]);
    }
  });
  var def = ss.getSheetByName("シート1") || ss.getSheetByName("Sheet1");
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  var pts = ss.getSheetByName("points");
  if (pts.getLastRow() <= 1) {
    SEED_POINTS.forEach(function (r) { pts.appendRow(r); });
  }

  var folderId = PROPS.getProperty("PHOTO_FOLDER_ID");
  if (!folderId) {
    var folder = DriveApp.createFolder("zukan-lagoon-photos");
    PROPS.setProperty("PHOTO_FOLDER_ID", folder.getId());
  }

  var code = PROPS.getProperty("OWNER_SETUP_CODE");
  if (!code) {
    code = Utilities.getUuid().replace(/-/g, "").slice(0, 12);
    PROPS.setProperty("OWNER_SETUP_CODE", code);
  }

  Logger.log("スプレッドシート: " + ss.getUrl());
  Logger.log("オーナーコード(誰にも見せない): " + code);
  Logger.log("次: ウェブアプリとしてデプロイ(実行=自分/アクセス=全員) → 公開ページの #/setup でこのコードを入力");
}

/* ---------------- シートユーティリティ ---------------- */

function ss_() {
  return SpreadsheetApp.openById(PROPS.getProperty("SS_ID"));
}

function readAll_(name) {
  var sh = ss_().getSheetByName(name);
  var vals = sh.getDataRange().getValues();
  var head = vals.shift();
  return vals.filter(function (r) { return String(r[0]) !== ""; }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function appendRow_(name, obj) {
  var sh = ss_().getSheetByName(name);
  sh.appendRow(SHEET_DEFS[name].map(function (h) {
    return obj[h] === undefined || obj[h] === null ? "" : obj[h];
  }));
}

function updateMember_(token, patch) {
  var sh = ss_().getSheetByName("members");
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(token)) {
      var head = vals[0];
      Object.keys(patch).forEach(function (k) {
        var col = head.indexOf(k);
        if (col >= 0) sh.getRange(i + 1, col + 1).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}

function findMember_(token) {
  return readAll_("members").filter(function (m) { return String(m.token) === String(token); })[0] || null;
}

function getRowById_(name, id) {
  return readAll_(name).filter(function (r) { return String(r.id) === String(id); })[0] || null;
}

function updateRowById_(name, id, patch) {
  var sh = ss_().getSheetByName(name);
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) {
      Object.keys(patch).forEach(function (k) {
        var col = head.indexOf(k);
        if (col >= 0) sh.getRange(i + 1, col + 1).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}

// 稼働中のシートに足りない列(後から追加した定義)をヘッダー行へ自動追記する
function ensureColumns_(name) {
  var sh = ss_().getSheetByName(name);
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  SHEET_DEFS[name].forEach(function (h) {
    if (head.indexOf(h) < 0) {
      sh.getRange(1, head.length + 1).setValue(h);
      head.push(h);
    }
  });
}

// 見られる季節を正規化(春夏秋冬のみ・重複除去)。記録日付の分布とは別の「宣言」情報
function normalizeSeasons_(v) {
  var ok = ["春", "夏", "秋", "冬"];
  var seen = {};
  return (v || []).map(String).filter(function (x) {
    return ok.indexOf(x) >= 0 && !seen[x] && (seen[x] = true);
  }).join(",");
}

// ポイントid配列を正規化(文字列化・空除去・重複除去・上限30)
function normalizePointIds_(v) {
  var seen = {};
  return (v || []).map(function (x) { return String(x || "").trim(); })
    .filter(function (x) { return x && !seen[x] && (seen[x] = true); })
    .slice(0, 30).join(",");
}

// base64写真をDriveに保存してid配列を返す。maxCountで上限を切る
function savePhotoList_(photos, maxCount) {
  var ids = [];
  var list = (photos || []).slice(0, Math.max(0, maxCount));
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || !p.b64) continue;
    if (p.b64.length > LIMITS.maxPhotoBase64Bytes * 1.4) return { error: "photo_too_large" };
    var blob = Utilities.newBlob(Utilities.base64Decode(p.b64), p.mime || "image/jpeg",
      "zukan-" + Utilities.getUuid() + ".jpg");
    var file = DriveApp.getFolderById(PROPS.getProperty("PHOTO_FOLDER_ID")).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    ids.push(file.getId());
  }
  return { ids: ids };
}

/* ---------------- 公開読み取りAPI ---------------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "all";
  if (action === "ping") return json_({ ok: true, ts: new Date().toISOString(), ver: VERSION });

  // 公開ペイロード: トークン列は落とす(§プライバシー/なりすまし防止)
  var fish = readAll_("fish").map(function (f) {
    return { id: f.id, name: f.name, rarity: Number(f.rarity) || 0, description: f.description,
             knownPointIds: String(f.knownPointIds || "").split(",").filter(String),
             seasons: String(f.seasons || "").split(",").filter(String),
             by: f.createdByName, createdAt: f.createdAt };
  });
  var records = readAll_("records").map(function (r) {
    return { id: r.id, fishId: r.fishId, pointId: r.pointId, date: fmtDate_(r.date), depth: r.depth, memo: r.memo,
             photoIds: String(r.photoIds || "").split(",").filter(String), by: r.userName, createdAt: r.createdAt };
  });
  var comments = readAll_("comments").map(function (c) {
    return { id: c.id, targetType: c.targetType, targetId: c.targetId, text: c.text, by: c.userName, createdAt: c.createdAt };
  });
  var points = readAll_("points");
  return json_({ ok: true, fish: fish, records: records, comments: comments, points: points });
}

function fmtDate_(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "");
}

/* ---------------- 書き込みAPI ---------------- */

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: "badreq" });
  }

  var token = String(req.deviceToken || "").trim();
  if (token.length < LIMITS.minTokenLen) return json_({ ok: false, code: "badreq" });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // オーナー登録(セットアップコード方式)。機種変時も同コードで復帰できる
    if (req.action === "claimOwner") {
      var code = PROPS.getProperty("OWNER_SETUP_CODE");
      if (!code || String(req.setupCode || "").trim() !== code) {
        return json_({ ok: false, code: "badcode", message: "オーナーコードが違います" });
      }
      var name = clip_(req.name, LIMITS.maxNameLen) || "オーナー";
      if (findMember_(token)) {
        updateMember_(token, { displayName: name, status: "owner", updatedAt: now_() });
      } else {
        appendRow_("members", { token: token, displayName: name, status: "owner", requestedAt: now_(), updatedAt: now_() });
      }
      return json_({ ok: true, status: "owner", name: name });
    }

    // whoami は照会のみ(未登録なら status="")
    if (req.action === "whoami") {
      var m0 = findMember_(token);
      return json_({ ok: true, status: m0 ? m0.status : "", name: m0 ? m0.displayName : "" });
    }

    var me = findMember_(token);

    // オーナー専用(名簿の閲覧・ブロック)
    if (req.action === "members" || req.action === "block") {
      if (!me || me.status !== "owner") return json_({ ok: false, code: "forbidden" });
      if (req.action === "members") {
        var list = readAll_("members").map(function (m) {
          return { token: m.token, name: m.displayName, status: m.status, requestedAt: m.requestedAt };
        });
        return json_({ ok: true, members: list });
      }
      var target = findMember_(String(req.token || ""));
      if (!target) return json_({ ok: false, code: "notfound" });
      if (target.status === "owner") return json_({ ok: false, code: "forbidden" });
      updateMember_(target.token, { status: "blocked", updatedAt: now_() });
      return json_({ ok: true });
    }

    // 書き込み系: 承認ゲートなし。未知トークンは即member登録して受け付ける
    if (!me) {
      var newbie = clip_(req.name, LIMITS.maxNameLen) || "名無し";
      appendRow_("members", { token: token, displayName: newbie, status: "member", requestedAt: now_(), updatedAt: now_() });
      me = { token: token, displayName: newbie, status: "member" };
    }
    if (me.status === "blocked") return json_({ ok: false, code: "blocked" });
    // 名前変更はセルフサービス(同じトークン=同じ人。フォームの名前欄がそのまま自分の名前)
    var newName = clip_(req.name, LIMITS.maxNameLen);
    if (newName && newName !== String(me.displayName)) {
      updateMember_(token, { displayName: newName, updatedAt: now_() });
      me.displayName = newName;
    }

    var auth = { token: token, name: me.displayName };
    if (req.action === "addFish")    return addFish_(req, auth);
    if (req.action === "addRecord")  return addRecord_(req, auth);
    if (req.action === "addComment") return addComment_(req, auth);
    if (req.action === "editFish")   return editFish_(req, auth);
    if (req.action === "editRecord") return editRecord_(req, auth, me.status === "owner");
    return json_({ ok: false, code: "unknown_action" });
  } finally {
    lock.releaseLock();
  }
}

function addFish_(req, auth) {
  var name = clip_(req.name, LIMITS.maxNameLen);
  var rarity = Math.max(1, Math.min(5, Number(req.rarity) || 1));
  if (!name) return json_({ ok: false, code: "validation", message: "名前は必須" });
  ensureColumns_("fish");
  var id = Utilities.getUuid();
  appendRow_("fish", {
    id: id, name: name, rarity: rarity,
    description: clip_(req.description, LIMITS.maxTextLen),
    knownPointIds: normalizePointIds_(req.knownPointIds),
    seasons: normalizeSeasons_(req.seasons),
    createdByName: auth.name, createdByToken: auth.token, createdAt: now_()
  });
  return json_({ ok: true, id: id });
}

function addRecord_(req, auth) {
  var fishId = String(req.fishId || "");
  if (req.newFish) {
    var created = JSON.parse(addFish_(req.newFish, auth).getContent());
    if (!created.ok) return json_(created);
    fishId = created.id;
  }
  if (!fishId) return json_({ ok: false, code: "validation", message: "魚が未指定" });
  if (!req.pointId) return json_({ ok: false, code: "validation", message: "ポイントが未指定" });

  var saved = savePhotoList_(req.photos, LIMITS.maxPhotosPerRecord);
  if (saved.error) return json_({ ok: false, code: saved.error });
  var photoIds = saved.ids;

  var id = Utilities.getUuid();
  appendRow_("records", {
    id: id, fishId: fishId, pointId: String(req.pointId),
    date: clip_(req.date, 10), depth: clip_(req.depth, 10),
    memo: clip_(req.memo, LIMITS.maxTextLen),
    photoIds: photoIds.join(","),
    userName: auth.name, token: auth.token, createdAt: now_()
  });
  return json_({ ok: true, id: id, fishId: fishId, photoIds: photoIds });
}

function addComment_(req, auth) {
  var text = clip_(req.text, LIMITS.maxCommentLen);
  if (!text) return json_({ ok: false, code: "validation", message: "本文が空" });
  var tt = req.targetType === "record" ? "record" : "fish";
  if (!req.targetId) return json_({ ok: false, code: "validation", message: "対象が未指定" });
  var id = Utilities.getUuid();
  appendRow_("comments", {
    id: id, targetType: tt, targetId: String(req.targetId), text: text,
    userName: auth.name, token: auth.token, createdAt: now_()
  });
  return json_({ ok: true, id: id });
}

/* ---------------- 編集API ---------------- */

// 魚の情報はメンバー全員で共同編集できる(名前の表記ゆれ・レア度の合議を想定)
function editFish_(req, auth) {
  var f = getRowById_("fish", String(req.fishId || ""));
  if (!f) return json_({ ok: false, code: "notfound" });
  var name = clip_(req.name, LIMITS.maxNameLen);
  if (!name) return json_({ ok: false, code: "validation", message: "名前は必須" });
  ensureColumns_("fish");
  updateRowById_("fish", f.id, {
    name: name,
    rarity: Math.max(1, Math.min(5, Number(req.rarity) || 1)),
    description: clip_(req.description, LIMITS.maxTextLen),
    knownPointIds: normalizePointIds_(req.knownPointIds),
    seasons: normalizeSeasons_(req.seasons)
  });
  return json_({ ok: true });
}

// 発見記録は投稿した本人(同じトークン)かオーナーだけが編集できる
function editRecord_(req, auth, isOwner) {
  var r = getRowById_("records", String(req.recordId || ""));
  if (!r) return json_({ ok: false, code: "notfound" });
  if (String(r.token) !== auth.token && !isOwner) {
    return json_({ ok: false, code: "forbidden", message: "自分の投稿だけ編集できます" });
  }
  if (!req.pointId) return json_({ ok: false, code: "validation", message: "ポイントが未指定" });
  if (!req.date) return json_({ ok: false, code: "validation", message: "日付が未指定" });

  var keep = String(r.photoIds || "").split(",").filter(String);
  var removeIds = req.removePhotoIds || [];
  if (removeIds.length) {
    keep = keep.filter(function (pid) { return removeIds.indexOf(pid) < 0; });
    removeIds.forEach(function (pid) {
      try { DriveApp.getFileById(pid).setTrashed(true); } catch (e) { /* 既に無い等は無視 */ }
    });
  }
  var saved = savePhotoList_(req.addPhotos, LIMITS.maxPhotosPerRecord - keep.length);
  if (saved.error) return json_({ ok: false, code: saved.error });
  keep = keep.concat(saved.ids);

  updateRowById_("records", r.id, {
    pointId: String(req.pointId),
    date: clip_(req.date, 10),
    depth: clip_(req.depth, 10),
    memo: clip_(req.memo, LIMITS.maxTextLen),
    photoIds: keep.join(",")
  });
  return json_({ ok: true, photoIds: keep });
}

/* ---------------- 小物 ---------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return new Date().toISOString();
}

function clip_(v, n) {
  return String(v === undefined || v === null ? "" : v).slice(0, n);
}
