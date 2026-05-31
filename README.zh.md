[English](README.md) · [Deutsch](README.de.md) · **中文** · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

自动将步数、睡眠、心率、压力、运动等健康数据从 Garmin Connect 同步到 Obsidian Daily Notes —— 作为 frontmatter 属性，可通过 Dataview 查询。

> **仅限桌面端。** 本插件使用 Electron 的 BrowserWindow 进行 Garmin Connect 身份验证，不支持移动设备。

> **注意：** 本插件通过 Electron 浏览器会话使用 Garmin Connect 的内部 Web API；Garmin 没有提供官方第三方 API。

## 功能特性

- **启动时自动同步** —— 检查最近 7 天并补充缺失的健康数据
- **手动同步** —— 通过命令面板同步任意已打开的 Daily Note
- **回填** —— 批量同步一段日期范围（例如最近 3 个月）
- **20+ 项指标** —— 步数、睡眠评分、HRV、压力、身体电量、SpO2、体重等
- **运动追踪** —— 每次锻炼以易读的摘要形式呈现
- **运动地点** —— 通过逆地理编码获取首个 GPS 活动的地名
- **智能检测** —— 自动识别你的 Daily Notes 路径和格式（来自 Periodic Notes 或内置 Daily Notes 插件）
- **子目录支持** —— 在嵌套文件夹中查找已有的 Daily Notes（例如 `Journal/2024-07/`）
- **语言自动检测** —— UI 语言根据你的 Obsidian 语言设置自动适配（EN、DE、ZH、JA、ES、FR）
- **可选的结构化数据** —— 机器可读的 `trainings` 字段，用于高级 Dataview 查询

## Frontmatter 输出

### 指标

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

### 活动

每次锻炼以 frontmatter 键加摘要字符串的形式写入：

```yaml
---
hiking: 8.2 km · 157min · Ø105 bpm · 696 kcal
e_bike: 22.1 km · 65min · Ø112 bpm · 420 kcal
---
```

只有实际有锻炼的日期才会生成活动键 —— 插件绝不会覆盖你笔记中的已有内容。

### 训练记录（可选，机器可读）

在设置中启用"机器可读训练记录"，即可添加结构化的 `trainings` 字段用于 Dataview 查询：

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

## 要求

- **Obsidian Desktop**（Windows、macOS、Linux）——本插件不支持移动端
- 可访问 Garmin Connect 的 **Garmin 账号**
- 已启用 **Daily Notes** 或 **Periodic Notes** 插件（或在设置中手动配置路径）

## 安装

### 从 Community Plugins 安装（推荐）

1. 打开 Obsidian 设置 → Community Plugins → 浏览
2. 搜索 "Garmin Health Sync"
3. 安装并启用插件
4. 在插件设置中登录 Garmin Connect

### 手动安装

1. 从[最新发布](https://github.com/fcandi/garmin-health-sync/releases)下载 `main.js` 和 `manifest.json`
2. 在你的 vault 中创建文件夹 `.obsidian/plugins/garmin-health-sync/`
3. 将两个文件复制到该文件夹
4. 在设置 → Community Plugins 中启用插件

## 使用方法

### 自动同步

每次启动 Obsidian 时，插件会自动检查最近 7 天并补充缺失的健康数据，无需手动操作。

### 手动同步

打开一篇 Daily Note，然后通过命令面板（Cmd/Ctrl+P）运行 **Garmin Health Sync: Sync current note**。

### 回填历史数据

有多年的 Garmin 数据？你可以批量同步任意日期范围：

1. 打开命令面板（Cmd/Ctrl+P）
2. 搜索 **"回填健康数据"**（Backfill health data）
3. 选择开始和结束日期
4. 插件会自动获取该范围内的所有数据，并通过速率限制避免 API 节流

## 活动键名标准化

Garmin 的 `typeKey` 值会被标准化为更简洁的规范键名：

| 服务商键名 | 标准键名 | 分类 |
|---|---|---|
| `e_bike_fitness` | `e_bike` | cycling |
| `e_bike_mountain` | `e_mtb` | cycling |
| `resort_skiing_snowboarding` | `skiing` | winter |
| `backcountry_skiing_snowboarding` | `backcountry_skiing` | winter |
| `stand_up_paddleboarding` | `sup` | water |
| `fitness_equipment` | `gym_equipment` | gym |

所有其他 Garmin 键名保持不变（例如 `hiking`、`running`、`cycling`、`swimming`、`strength_training`、`yoga` 等）。

### 活动分类

每项活动会被分配一个分类：

| 分类 | 示例 |
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

## 数据与隐私

本插件会向两个外部服务发起网络请求：

- **Garmin Connect** — 浏览器窗口会使用你的凭据登录 Garmin Connect。插件不会保存你的密码。本地插件数据可能会保存 Garmin 会话数据，包括会话 Cookie，以便插件无需再次要求登录即可恢复浏览器会话。请像对待登录令牌一样对待这些会话数据：其有效期由 Garmin 控制；如果备份或同步工具包含 Obsidian 插件数据，这些数据也可能被包含在其中。**退出登录**会清除此设备上保存的 Garmin 会话数据。
- **Nominatim (OpenStreetMap)** — 如果启用了 **训练地点** 功能，你第一项活动的 GPS 坐标会发送到 `nominatim.openstreetmap.org` 进行反向地理编码。你可以在设置中的 **训练地点** 关闭此功能。

不会向其他服务器发送数据。

## 开发

```bash
npm install
npm run dev    # 监听模式
npm run build  # 生产构建
```
