# 🐟 鯖工房 (SabaKobo)

Minecraft Java版サーバーの作成・起動・管理を1画面で行うWindowsデスクトップアプリ。

## 主な機能（v0.3）

- **サーバー作成ウィザード**: Paper / Fabric / Forge / Vanilla の4種。バージョン選択→ダウンロード→EULA同意→初期設定まで
- **起動・停止・コンソール**: アプリがjavaを直接起動して標準入出力を握る方式（RCON不使用）。優雅な停止（stop→30秒待ち→強制終了）
- **Java自動選択**: インストール済みJDKを検出し、MCバージョン/ローダーに合うJavaを自動で選ぶ（Forge 1.18〜1.20.4のJava 17限定などの罠に対応）
- **プレイヤー監視**: ログから入退室を検知して一覧表示。クリックでOP付与/キック/BAN/ゲームモード変更
- **サーバー設定エディタ**: server.propertiesの主要項目を日本語ラベルで編集（コメント・順序・改行コードはバイト単位で保全）
- **プラグイン/Mod管理**: jarの一覧・有効/無効切替・ドラッグ&ドロップ追加・要再起動バッジ
- **自動更新**: GitHub Releasesから新版を自動取得

## 動作環境

- Windows 10/11
- サーバー実行にはJDKが必要（アプリが検出・案内します）

## 開発

```
npm install
npm start          # 起動
npm run test       # CDP自動テスト（要: npx electron . --remote-debugging-port=9223）
npm run dist       # インストーラのビルド
```
