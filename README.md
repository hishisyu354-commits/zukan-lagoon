# 図鑑ラグーン (dive-zukan)

ダイビングサークルの共有魚図鑑。**閲覧は誰でも・投稿はLINEログイン＋オーナー承認制**。

- 公開URL: https://hishisyu354-commits.github.io/zukan-lagoon/
- リポジトリ: https://github.com/hishisyu354-commits/zukan-lagoon (公開)

決定事項(2026-08-22 菱沼):
- 名前=図鑑ラグーン / 土台は案B = GitHub Pages + GAS + スプレッドシート + Drive + LIFF
- 先に公開し、UIは明るい海(ラグーン)トーン
- 閲覧に合言葉なし(完全公開)。荒らし防止は「書き込みのみ承認制」
- 費用: ¥0 / クレカ不要(Google無料枠 + LINE Developers無料 + GitHub Pages無料)

## 構成

```
閲覧者(誰でも) ──GET──> GASウェブアプリ ──> スプレッドシート(fish/records/comments/points/members)
投稿者(承認済み) ─POST─> 　同上(LIFFのIDトークンを毎回LINEのverify APIでサーバー検証)
写真 ──────────────────> Driveフォルダ(リンクを知っている人は閲覧可)
フロント: index.html 1枚(GitHub Pages)。CONFIGのGAS_URLが空の間はモックモード(localStorage)で動く
```

権限: membersシートの status = `owner` / `approved` / `pending` / `blocked`。
**名簿が空の状態で最初にログインした人がownerになる**(GAS稼働直後に必ず菱沼が開くこと)。
新規の人は自動で `pending` 登録され、投稿しようとすると「承認待ち」表示。
ownerは画面下の「メンバー管理」から承認/ブロック。削除・修正はスプレッドシート直編集で行う(MVPは削除APIを持たない=攻撃面を減らす)。

公開JSONにLINEのuserIdは含めない(表示名のみ)。トークン検証は client_id(チャネルID)のみで行うため、
**リポジトリにもフロントにも秘密情報は無い**(LIFF ID / GAS URL / チャネルIDは公開されても権限奪取に直結しない)。

## 残りのセットアップ(菱沼の手作業)

### 1. GASバックエンド
1. script.google.com → 新規プロジェクト → `gas/Code.gs` を貼る(appsscript.jsonは「プロジェクトの設定→マニフェスト表示」で差し替え)
2. エディタで `setup()` を1回実行(権限承認) → ログにシートURLが出る
3. デプロイ → 新しいデプロイ → ウェブアプリ / **実行ユーザー=自分 / アクセス=全員** → `/exec` URLを控える

### 2. LINE Developers(無料・会社チャネルとは完全分離で個人新規)
1. developers.line.biz → 個人プロバイダー作成
2. **LINEログインチャネル**を作成 → 「チャネルID」を控え、GASのスクリプトプロパティ `LINE_CHANNEL_ID` に設定
3. チャネル内に **LIFFアプリ**を追加:
   - サイズ: Full / エンドポイントURL: `https://hishisyu354-commits.github.io/zukan-lagoon/`
   - Scope: **openid と profile に必ずチェック**(IDトークンに必要)
   - LIFF IDを控える
4. (任意・共有カードを使うなら) shareTargetPicker を有効化

### 3. フロント設定と反映
`index.html` の `CONFIG` に `GAS_URL` と `LIFF_ID` を記入 → commit → push(Pagesに自動反映)。

### 4. オーナー確定(重要)
反映後の公開URLを**最初に自分が開いてLINEログイン** → membersシートに自分がownerで入る。

## 動作確認のチェックリスト
- [x] モック: 一覧/詳細/投稿フォームがChromeで描画される(2026-08-22ヘッドレス検証)
- [ ] モック実操作: 写真つき登録→検索/絞り込み→コメント
- [ ] 本番: LINEログイン→自分がowner→魚を1匹登録(写真がDriveに入り表示される)
- [ ] 別端末(ログインなし)で閲覧だけできる
- [ ] サブ垢で開く→pending→メンバー管理で承認→投稿できる
- [ ] 共有ボタン(LINE内ならトークへカード、外ならOS共有シート)

## 未検証(実装済みだが実機で通していない)
- Drive写真の `thumbnail?id=` 配信(Drive側仕様変更の前歴あり。表示されなければ配信方式を差し替える)
- GAS×LIFFの通し(IDトークン検証、トークン期限切れ→再ログイン動線)
- shareTargetPickerのFlexカード(LINE内/外部ブラウザの挙動差)
- 古い端末でのEXIF回転(canvas圧縮時)

## マップ(Phase 2・実装済 2026-08-22)
- 一覧/マップの切替タブ。Leaflet+OpenStreetMap(無料・キー不要)で世界→日本→ポイントへズーム。
- ピン=ポイントごとの種数バッジ、色=そのポイントの最高レア度。レア度チップ・検索がマップにも効く。
- ピンをタップ→ポップアップ→「このポイントの魚を見る」で一覧に絞り込みジャンプ。
- 初期ポイント10ヶ所の緯度経度は**おおよそ**(pointsシートのlat/lngで修正可)。座標が空のポイントはピン非表示。
- タイルはOSM公式(帰属表記は自動表示)。Leafletは初回タブ切替時にunpkg CDNから遅延読込。

## 次の拡張候補(未着手)
- Phase 3: ポイント内手描きマップ+発見位置ピン(レア度色)。マップ画像は自作のみ(ショップ地図の流用は著作権NG)。recordsにx/y列を足しLeafletのImageOverlayで実装予定
- 記録単位のコメント(データ構造は対応済み・UIのみ)
- 計測: 公開2週間の投稿件数/投稿人数(台帳の測定列)
