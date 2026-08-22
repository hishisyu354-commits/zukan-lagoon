/**
 * サークル魚図鑑 — GASバックエンド
 *
 * 初回セットアップ:
 *   1. script.google.com で新規プロジェクトを作り、このファイルを貼る
 *   2. スクリプトプロパティに LINE_CHANNEL_ID を設定
 *      (LINE DevelopersのLINEログインチャネルの「チャネルID」。シークレットではない)
 *   3. エディタから setup() を1回実行 → シートとDriveフォルダが自動生成される
 *   4. デプロイ > ウェブアプリ / 実行ユーザー=自分 / アクセス=全員 → /exec URLを控える
 *
 * 権限モデル:
 *   - 読み(doGet)は誰でも。公開JSONにLINE userIdは含めない(表示名のみ)。
 *   - 書き(doPost)はLIFFのIDトークン必須。LINEの検証API(oauth2/v2.1/verify)で
 *     サーバー側からトークンを検証し、なりすましを防ぐ。
 *   - membersシートの status: owner / approved / pending / blocked。
 *     名簿が空のとき最初に認証した人がownerになる(デプロイ直後に自分が開くこと)。
 *   - 荒れた場合の削除はシート直編集で行う(MVPでは削除APIを持たない)。
 */

var PROPS = PropertiesService.getScriptProperties();

var SHEET_DEFS = {
  fish:     ["id", "name", "rarity", "description", "createdByName", "createdByUserId", "createdAt"],
  records:  ["id", "fishId", "pointId", "date", "depth", "memo", "photoIds", "userName", "userId", "createdAt"],
  comments: ["id", "targetType", "targetId", "text", "userName", "userId", "createdAt"],
  points:   ["id", "area", "name", "lat", "lng"],
  members:  ["userId", "displayName", "status", "requestedAt", "updatedAt"]
};

// 初期ポイント(あとでシートから自由に追加・修正)
var SEED_POINTS = [
  ["izu-osezaki-wannai", "伊豆", "大瀬崎 湾内", "", ""],
  ["izu-osezaki-sentan", "伊豆", "大瀬崎 先端", "", ""],
  ["izu-koganezaki",     "伊豆", "黄金崎", "", ""],
  ["izu-futo",           "伊豆", "富戸", "", ""],
  ["izu-iop",            "伊豆", "伊豆海洋公園(IOP)", "", ""],
  ["okinawa-maeda",      "沖縄本島", "真栄田岬", "", ""],
  ["okinawa-zanpa",      "沖縄本島", "残波岬", "", ""],
  ["kerama-zamami",      "慶良間", "座間味", "", ""],
  ["hachijo-nazumado",   "八丈島", "ナズマド", "", ""],
  ["hachijo-yaene",      "八丈島", "八重根", "", ""]
];

var LIMITS = {
  maxPhotosPerRecord: 4,
  maxPhotoBase64Bytes: 2 * 1024 * 1024, // 圧縮済み前提(クライアントで長辺1600px/0.82)
  maxTextLen: 1000,
  maxCommentLen: 300,
  maxNameLen: 60
};

/* ---------------- セットアップ ---------------- */

function setup() {
  var ssId = PROPS.getProperty("SS_ID");
  var ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.create("dive-zukan-db");
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
    var folder = DriveApp.createFolder("dive-zukan-photos");
    PROPS.setProperty("PHOTO_FOLDER_ID", folder.getId());
  }

  Logger.log("スプレッドシート: " + ss.getUrl());
  Logger.log("LINE_CHANNEL_ID 設定済み?: " + (PROPS.getProperty("LINE_CHANNEL_ID") ? "yes" : "NO — スクリプトプロパティに設定して"));
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

function updateMember_(userId, patch) {
  var sh = ss_().getSheetByName("members");
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(userId)) {
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

/* ---------------- 公開読み取りAPI ---------------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "all";
  if (action === "ping") return json_({ ok: true, ts: new Date().toISOString() });

  // 公開ペイロード: userId系の列は落とす(§プライバシー)
  var fish = readAll_("fish").map(function (f) {
    return { id: f.id, name: f.name, rarity: Number(f.rarity) || 0, description: f.description, by: f.createdByName, createdAt: f.createdAt };
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

  var auth = verifyLineToken_(req.idToken);
  if (!auth) return json_({ ok: false, code: "auth", message: "LINEログインの有効期限切れ。再ログインしてください。" });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var me = ensureMember_(auth);

    if (req.action === "whoami") {
      return json_({ ok: true, status: me.status, name: auth.name });
    }
    if (me.status === "blocked") return json_({ ok: false, code: "blocked" });

    // オーナー専用
    if (req.action === "pending" || req.action === "approve" || req.action === "block" || req.action === "members") {
      if (me.status !== "owner") return json_({ ok: false, code: "forbidden" });
      if (req.action === "pending" || req.action === "members") {
        var want = req.action === "pending" ? ["pending"] : ["owner", "approved", "pending", "blocked"];
        var list = readAll_("members").filter(function (m) { return want.indexOf(m.status) >= 0; })
          .map(function (m) { return { userId: m.userId, name: m.displayName, status: m.status, requestedAt: m.requestedAt }; });
        return json_({ ok: true, members: list });
      }
      var target = String(req.userId || "");
      var next = req.action === "approve" ? "approved" : "blocked";
      if (!updateMember_(target, { status: next, updatedAt: now_() })) return json_({ ok: false, code: "notfound" });
      return json_({ ok: true });
    }

    // 投稿系はowner/approvedのみ
    if (me.status === "pending") {
      return json_({ ok: false, code: "pending", message: "オーナーの承認待ちです。承認されると投稿できます。" });
    }

    if (req.action === "addFish")    return addFish_(req, auth);
    if (req.action === "addRecord")  return addRecord_(req, auth);
    if (req.action === "addComment") return addComment_(req, auth);
    return json_({ ok: false, code: "unknown_action" });
  } finally {
    lock.releaseLock();
  }
}

function ensureMember_(auth) {
  var members = readAll_("members");
  var hit = members.filter(function (m) { return String(m.userId) === String(auth.userId); })[0];
  if (hit) {
    return hit;
  }
  // 名簿が空なら最初の認証者がオーナー(デプロイ直後に自分が開く前提)
  var status = members.length === 0 ? "owner" : "pending";
  appendRow_("members", { userId: auth.userId, displayName: auth.name, status: status, requestedAt: now_(), updatedAt: now_() });
  return { userId: auth.userId, displayName: auth.name, status: status };
}

function addFish_(req, auth) {
  var name = clip_(req.name, LIMITS.maxNameLen);
  var rarity = Math.max(1, Math.min(5, Number(req.rarity) || 1));
  if (!name) return json_({ ok: false, code: "validation", message: "名前は必須" });
  var id = Utilities.getUuid();
  appendRow_("fish", {
    id: id, name: name, rarity: rarity,
    description: clip_(req.description, LIMITS.maxTextLen),
    createdByName: auth.name, createdByUserId: auth.userId, createdAt: now_()
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

  var photos = (req.photos || []).slice(0, LIMITS.maxPhotosPerRecord);
  var photoIds = [];
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    if (!p || !p.b64) continue;
    if (p.b64.length > LIMITS.maxPhotoBase64Bytes * 1.4) return json_({ ok: false, code: "photo_too_large" });
    var blob = Utilities.newBlob(Utilities.base64Decode(p.b64), p.mime || "image/jpeg",
      "zukan-" + Utilities.getUuid() + ".jpg");
    var file = DriveApp.getFolderById(PROPS.getProperty("PHOTO_FOLDER_ID")).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    photoIds.push(file.getId());
  }

  var id = Utilities.getUuid();
  appendRow_("records", {
    id: id, fishId: fishId, pointId: String(req.pointId),
    date: clip_(req.date, 10), depth: clip_(req.depth, 10),
    memo: clip_(req.memo, LIMITS.maxTextLen),
    photoIds: photoIds.join(","),
    userName: auth.name, userId: auth.userId, createdAt: now_()
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
    userName: auth.name, userId: auth.userId, createdAt: now_()
  });
  return json_({ ok: true, id: id });
}

/* ---------------- LINE IDトークン検証 ---------------- */

function verifyLineToken_(idToken) {
  if (!idToken) return null;
  var channelId = PROPS.getProperty("LINE_CHANNEL_ID");
  if (!channelId) return null;
  var res = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  var c = JSON.parse(res.getContentText());
  if (!c.sub) return null;
  return { userId: c.sub, name: c.name || "名無し", picture: c.picture || "" };
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
