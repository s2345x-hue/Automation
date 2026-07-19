# Morning Scan 完全自動化セットアップ

毎朝、ボタンを押さなくても自動でスキャンが実行され、ページを開いた瞬間に結果が反映される仕組みです。
GitHub Actionsがサーバー側でスキャンを実行し、結果を`data/scan.json`としてコミット、
GitHub Pagesで公開されたページがそれを読みに行きます。

サーバー側実行なので、ブラウザのCORS制限を受けません（今まで不安定だったCOTデータの取得も安定します）。

## セットアップ手順

### 1. GitHubリポジトリを作る
新しいリポジトリを作成し（Public/Privateどちらでも可。Privateの場合もGitHub Pagesは無料で使えます）、
このフォルダの中身（`index.html`, `scan.mjs`, `.github/workflows/scan.yml`, `data/.gitkeep`）を
そのままアップロードします。

GitHub上で直接ドラッグ&ドロップでアップロードするか、`git`コマンドが使える場合は：

```bash
cd (このフォルダ)
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

### 2. APIキーをSecretsに登録
Twelve DataのAPIキー（今までブラウザに保存していたもの）を、コード上に書かず安全に使うため
GitHub Secretsに登録します。

1. リポジトリの `Settings` → `Secrets and variables` → `Actions` を開く
2. `New repository secret` をクリック
3. Name: `TD_API_KEY`
4. Secret: Twelve DataのAPIキーを貼り付け
5. `Add secret`

### 3. GitHub Pagesを有効化
1. リポジトリの `Settings` → `Pages` を開く
2. `Source` を `Deploy from a branch` に設定
3. `Branch` を `main` / `/ (root)` に設定して `Save`
4. 数分待つと `https://<あなたのユーザー名>.github.io/<リポジトリ名>/` でアクセスできるようになります

### 4. 動作確認
1. リポジトリの `Actions` タブを開く
2. `Morning Scan` ワークフローを選択
3. `Run workflow` ボタンで手動実行してみる（`workflow_dispatch`で手動トリガーできる設定にしてあります）
4. 数分後、`data/scan.json` がリポジトリにコミットされていれば成功
5. GitHub PagesのURLをブラウザで開き、「朝の準備」タブに「🌐 サーバー自動更新: ...」と表示されれば完了

これ以降は毎朝自動で実行されます（デフォルトはJST 6:30。`.github/workflows/scan.yml`の`cron`部分で変更可能）。

## 注意点

- **file://で直接開いた場合はこの機能は働きません**。GitHub Pages（またはその他のWebサーバー）経由で開く必要があります。file://で開いた場合は今まで通り手動ボタンでの取得にフォールバックします。
- ブラウザに保存していたAPIキーはもう不要ですが、消さなくても動作に影響はありません。
- ワークフローの実行時間はGitHub Actionsの無料枠（Publicリポジトリなら無制限、Privateなら月2000分）の範囲内で収まります（1回あたり数分程度）。
- cron scheduleはGitHub側の負荷状況により数分〜十数分遅延することがあります（GitHub公式の既知の制約です）。
