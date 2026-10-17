[English](README.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · **日本語** · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

Garmin Connect から歩数、睡眠、心拍数、ストレス、アクティビティなどを自動的に Obsidian Daily Notes に同期します。Dataview で検索可能な frontmatter プロパティとして記録されます。

> **デスクトップとモバイルで動作します**（Windows、macOS、Linux、iOS、Android）。このプラグインは Garmin Connect の内部APIを使用します。公式のサードパーティAPIはありません。Garmin のメールアドレスとパスワード（2段階認証を使っている場合は確認コードも）でサインインします。Garmin がその試行をブロックした場合は、ブラウザでのサインインを代替手段として利用できます。

## 機能

- **起動時の自動同期** — 過去7日間をチェックし、欠落している健康データを補完
- **手動同期** — コマンドパレットから開いている Daily Note を同期
- **バックフィル** — 日付範囲の一括同期（例：過去3ヶ月分）
- **20以上の指標** — 歩数、睡眠スコア、HRV、ストレス、Body Battery、SpO2、体重など
- **アクティビティ追跡** — 各ワークアウトが読みやすいサマリーとして表示
- **ワークアウトの場所** — 最初の GPS アクティビティから逆ジオコーディングで取得した地名
- **スマート検出** — Periodic Notes または内蔵の Daily Notes プラグインから Daily Notes のパスとフォーマットを自動検出
- **サブディレクトリ対応** — ネストされたフォルダ内の既存 Daily Notes を検索（例：`Journal/2024-07/`）。ファイル名形式に `/` を含めると日付ごとのサブフォルダを作成（例：`YYYY/YYYY-MM-DD` → `Journal/2026/2026-08-04.md`）
- **言語自動検出** — UI 言語は Obsidian の言語設定に基づいて自動設定（EN、DE、ZH、JA、ES、FR）
- **オプションの構造化データ** — 高度な Dataview クエリ用の機械可読 `trainings` フィールド

## Frontmatter 出力

### 指標

```yaml
---
steps: 15185
resting_hr: 69
sleep_score: 81
sleep_duration: 7h 43min
hrv: 39
stress: 30
vo2_max: 48
workout_location: Bad Honnef, Deutschland
---
```

**ボディバッテリー:** `body_battery` は Garmin の *charged* 値で、その日のボディバッテリー増加分の合計（主に睡眠中の回復）であり、現在のレベルではありません。その日の最低値と最高値（Garmin アプリの履歴に表示される値）が必要な場合は `body_battery_min` と `body_battery_max` を有効にしてください。

### アクティビティ

各ワークアウトはサマリー文字列を持つ frontmatter キーとして記録されます：

```yaml
---
hiking: 8.2 km · 157min · Ø105 bpm · 696 kcal
e_bike: 22.1 km · 65min · Ø112 bpm · 420 kcal
---
```

実際にワークアウトがあった日のみアクティビティキーが追加されます。プラグインはノートの既存コンテンツを上書きしません。

### トレーニング（オプション、機械可読）

設定で「機械可読トレーニング」を有効にすると、Dataview クエリ用の構造化 `trainings` フィールドが追加されます：

```yaml
---
trainings:
  - type: hiking
    category: outdoor
    distance_km: 8.2
    duration_min: 157
    avg_hr: 105
    calories: 696
  - type: e_bike
    category: cycling
    distance_km: 22.1
    duration_min: 65
    avg_hr: 112
    calories: 420
---
```

## 要件

- **Obsidian**（Windows、macOS、Linux、iOS、Android）
- Garmin Connect にアクセスできる **Garmin アカウント**
- **Daily Notes** または **Periodic Notes** プラグインが有効（または設定でパスを手動指定）

## インストール

### Community Plugins から（推奨）

1. Obsidian 設定 → Community Plugins → ブラウズ を開く
2. "Garmin Health Sync" を検索
3. プラグインをインストールして有効化
4. プラグイン設定で Garmin Connect にログイン

### 手動インストール

1. [最新リリース](https://github.com/fcandi/garmin-health-sync/releases)から `main.js` と `manifest.json` をダウンロード
2. Vault 内に `.obsidian/plugins/garmin-health-sync/` フォルダを作成
3. 両方のファイルをそのフォルダにコピー
4. 設定 → Community Plugins でプラグインを有効化

## 使い方

### サインイン

プラグインの設定を開き、**Garmin Connect** を選んで、Garmin のメールアドレスとパスワード（2段階認証を使っている場合は確認コードも）を入力します。デスクトップでもモバイルでも同じ方法でサインインできます。

Garmin は同じデバイスからの繰り返しのサインイン試行を制限することがあります。その場合、プラグインは次に試せるまでのカウントダウンを表示します。サインインがブロックされたときは、代わりに**ブラウザでサインイン**を使ってください。ブラウザで Garmin のページにサインインし、`ST-…` を含むページのテキストをコピーして、プラグインのクリップボードボタンをタップします（入力欄に貼り付けることもできます）。一度サインインすれば、プラグインが自動で接続を更新するため、再サインインが必要になることはほとんどありません。

### ノートの保存場所

**デイリーノートのパス**がフォルダ、**デイリーノートの形式**が [moment.js](https://momentjs.com/docs/#/displaying/format/) 構文によるファイル名で、標準の Daily Notes プラグインと同じ規則です。形式自体に `/` を含めると日付ごとのサブフォルダに配置でき、角かっこ内の文字列はそのまま使われます:

| パス | 形式 | 結果 |
| --- | --- | --- |
| `Journal` | `YYYY-MM-DD` | `Journal/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM-DD` | `Journal/2026/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM/YYYY-MM-DD` | `Journal/2026/2026-08/2026-08-04.md` |
| `Journal` | `YYYY-MM-DD [Workout]` | `Journal/2026-08-04 Workout.md` |

存在しないサブフォルダは自動的に作成されます。

### 自動同期

Obsidian 起動時に、プラグインが過去7日間をチェックし、欠落している健康データを自動で補完します。操作は不要です。既定では、デイリーノートが無い場合は自動的に作成します。

他のツールがデイリーノートを管理している場合（Templater、Calendar プラグイン、外部同期など）は、設定で **デイリーノートを必要に応じて作成** をオフにしてください。自動同期は実体のある（空でない）デイリーノートが存在するまで待機し、現れた時点で同期します。0 バイトの空のプレースホルダーは無視されます。手動同期とバックフィルは、この設定に関わらず常に不足しているノートを作成します。

### 手動同期

Daily Note を開き、コマンドパレット（Cmd/Ctrl+P）から **Garmin Health Sync: Sync current note** を実行します。

### 過去データのバックフィル

長年の Garmin データがありますか？任意の日付範囲を一括同期できます：

1. コマンドパレット（Cmd/Ctrl+P）を開く
2. **「ヘルスデータをバックフィル」** を検索
3. 開始日と終了日を選択
4. プラグインが API スロットリングを避けながら、その範囲のすべてのデータを取得します

## アクティビティキーの正規化

Garmin の `typeKey` 値はより簡潔な正規キーに変換されます：

| プロバイダーキー | 正規キー | カテゴリ |
|---|---|---|
| `e_bike_fitness` | `e_bike` | cycling |
| `e_bike_mountain` | `e_mtb` | cycling |
| `resort_skiing_snowboarding` | `skiing` | winter |
| `backcountry_skiing_snowboarding` | `backcountry_skiing` | winter |
| `stand_up_paddleboarding` | `sup` | water |
| `fitness_equipment` | `gym_equipment` | gym |

その他の Garmin キーはそのまま使用されます（例：`hiking`、`running`、`cycling`、`swimming`、`strength_training`、`yoga` など）。

### アクティビティカテゴリ

各アクティビティにはカテゴリが割り当てられます：

| カテゴリ | 例 |
|---|---|
| `cycling` | cycling, e_bike, e_mtb, mountain_biking, indoor_cycling, road_biking |
| `running` | running, trail_running, treadmill, ultra_run |
| `walking` | walking, indoor_walking |
| `outdoor` | hiking, mountaineering, rock_climbing, bouldering |
| `swimming` | swimming, pool_swimming, open_water_swimming |
| `winter` | skiing, backcountry_skiing, cross_country_skiing, snowboarding |
| `water` | sup, rowing, kayaking, surfing, sailing |
| `gym` | strength_training, gym_equipment, elliptical, yoga, pilates, hiit |
| `racket` | tennis, badminton, squash, table_tennis, pickleball |
| `team` | soccer, basketball, volleyball, rugby |
| `other` | golf, meditation, multi_sport |

## データとプライバシー

このプラグインは、2つの外部サービスへネットワークリクエストを行います。

- **Garmin Connect** — プラグインにメールアドレスとパスワード（必要な場合は確認コードも）を入力します。これらは Garmin のサインインサーバー（`sso.garmin.com`、中国向けは `sso.garmin.cn`）にのみ送信され、プラグインが保存したりログに記録したりすることはありません。サインイン後、プラグインは Garmin のサインイントークンを Obsidian のシークレットストレージに保存します。これはデバイス内に留まるため、他のデバイスへの同期や、Vault のバックアップ・Git への混入は起こりません。シークレットストレージが利用できない場合や書き込みが拒否された場合に限り、`data.json` に保存します。これらのトークンはログイン情報と同様に扱ってください。有効期間は Garmin が管理します。各デバイスで個別にサインインします。Garmin がサインインをブロックまたは制限した場合は、ブラウザでのサインインが提示されます（ブラウザで Garmin のページにサインインし、1回限りのチケットを貼り付けます）。サインインに必要な公開 OAuth クライアントキーは `thegarth.s3.amazonaws.com` から取得します（このホストに接続できない場合は同梱のフォールバックキーを使用）。**ログアウト**でこのデバイスに保存されたトークンを削除します。
- **Nominatim (OpenStreetMap)** — **ワークアウト場所**機能が有効な場合、最初のアクティビティのGPS座標が逆ジオコーディングのために `nominatim.openstreetmap.org` に送信されます。設定の **ワークアウト場所** で無効にできます。

その他のサーバーにデータは送信されません。

## 開発

```bash
npm install
npm run dev    # ウォッチモード
npm run build  # プロダクションビルド
```
