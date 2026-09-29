# 九大法 学習OS API — Render版

Google Sheets を正本DBとして使う軽量APIサーバーです。

## Render 環境変数
- `SPREADSHEET_ID`: 対象のGoogle Sheets ID
- `API_KEY`: 十分長いランダム文字列
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Google CloudサービスアカウントJSON（文字列またはbase64）
- `WRITE_ENABLED`: `true` / `false`
- `LOG_ENABLED`: `true` / `false`
- `ALLOWED_ORIGINS`: Web UIのオリジンをカンマ区切り。空なら全許可

## Google側で必要なこと
1. Google Cloudでサービスアカウントを作成
2. Google Sheets APIを有効化
3. サービスアカウントJSONキーを発行
4. 学習OSスプレッドシートをサービスアカウントのメールアドレスに編集者として共有
5. JSONをRenderのSecret環境変数に登録（GitHubやシートには保存しない）

## エンドポイント
- `GET /health` — サーバー生存確認（認証不要）
- `GET /ready` — Google Sheets接続確認（認証不要）
- `GET /api/dashboard`
- `GET/POST /api/scores`
- `GET/POST /api/errors`
- `GET/POST/PATCH /api/scans`
- `GET/POST/PATCH /api/problems`
- `GET /api/patterns`
- `GET /api/subjects`
- `GET /api/weekly-plan`
- `GET/POST/PATCH /api/sources`

`/api/*` は `x-api-key` ヘッダー認証です。APIキーはURLクエリに載せません。
