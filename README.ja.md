[English](README.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · **日本語** · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

Garmin Connect から歩数、睡眠、心拍数、ストレス、アクティビティなどを自動的に Obsidian Daily Notes に同期します。Dataview で検索可能な frontmatter プロパティとして記録されます。

> **デスクトップ専用。** このプラグインは Garmin Connect の認証に Electron の BrowserWindow を使用するため、モバイルでは動作しません。

> **注意:** このプラグインは Electron のブラウザセッションを通じて Garmin Connect の内部Web APIを使用します。公式のサードパーティAPIはありません。

## 機能

- **起動時の自動同期** — 過去7日間をチェックし、欠落している健康データを補完
- **手動同期** — コマンドパレットから開いている Daily Note を同期
- **バックフィル** — 日付範囲の一括同期（例：過去3ヶ月分）
- **20以上の指標** — 歩数、睡眠スコア、HRV、ストレス、Body Battery、SpO2、体重など
- **アクティビティ追跡** — 各ワークアウトが読みやすいサマリーとして表示
- **ワークアウトの場所** — 最初の GPS アクティビティから逆ジオコーディングで取得した地名
- **スマート検出** — Periodic Notes または内蔵の Daily Notes プラグインから Daily Notes のパスとフォーマットを自動検出
- **サブディレクトリ対応** — ネストされたフォルダ内の既存 Daily Notes を検索（例：`Journal/2024-07/`）
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

- **Obsidian Desktop**（Windows、macOS、Linux）— モバイルでは動作しません
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

### 自動同期

Obsidian 起動時に、プラグインが過去7日間をチェックし、欠落している健康データを自動で補完します。操作は不要です。

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

- **Garmin Connect** — ブラウザウィンドウで Garmin Connect に認証します。プラグインはパスワードを保存しません。ローカルのプラグインデータには、再ログインなしでブラウザセッションを復元するために、セッションCookieを含む Garmin のセッションデータが保存される場合があります。このセッションデータはログイントークンと同じように扱ってください。有効期間は Garmin が制御し、Obsidian のプラグインデータを含むバックアップや同期ツールに含まれる可能性があります。**ログアウト**すると、このデバイスに保存された Garmin セッションデータが削除されます。
- **Nominatim (OpenStreetMap)** — **ワークアウト場所**機能が有効な場合、最初のアクティビティのGPS座標が逆ジオコーディングのために `nominatim.openstreetmap.org` に送信されます。設定の **ワークアウト場所** で無効にできます。

その他のサーバーにデータは送信されません。

## 開発

```bash
npm install
npm run dev    # ウォッチモード
npm run build  # プロダクションビルド
```
