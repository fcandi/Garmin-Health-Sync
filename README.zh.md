[English](README.md) · [Deutsch](README.de.md) · **中文** · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

自动将步数、睡眠、心率、压力、运动等健康数据从 Garmin Connect 同步到 Obsidian Daily Notes —— 作为 frontmatter 属性，可通过 Dataview 查询。

> **支持桌面端和移动端**（Windows、macOS、Linux、iOS、Android）。本插件使用 Garmin Connect 的内部 API；Garmin 没有提供官方第三方 API。你使用 Garmin 邮箱和密码登录（如启用两步验证，还需输入验证码）。如果 Garmin 阻止此次尝试，可使用备用的浏览器登录方式。

## 功能特性

- **启动时自动同步** —— 检查最近 7 天并补充缺失的健康数据
- **手动同步** —— 通过命令面板同步任意已打开的 Daily Note
- **回填** —— 批量同步一段日期范围（例如最近 3 个月）
- **20+ 项指标** —— 步数、睡眠评分、HRV、压力、身体电量、SpO2、体重等
- **运动追踪** —— 每次锻炼以易读的摘要形式呈现
- **运动地点** —— 通过逆地理编码获取首个 GPS 活动的地名
- **智能检测** —— 自动识别你的 Daily Notes 路径和格式（来自 Periodic Notes 或内置 Daily Notes 插件）
- **子目录支持** —— 在嵌套文件夹中查找已有的 Daily Notes（例如 `Journal/2024-07/`）；文件名格式包含 `/` 时会按日期创建子文件夹（例如 `YYYY/YYYY-MM-DD` → `Journal/2026/2026-08-04.md`）
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

**身体电量：** `body_battery` 是 Garmin 的 *charged* 值，即当天身体电量所有增量的总和（主要是夜间恢复），而不是当前电量。如需当天的最低值和最高值（即 Garmin 应用历史记录中显示的数值），请启用 `body_battery_min` 和 `body_battery_max`。

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

- **Obsidian**（Windows、macOS、Linux、iOS 或 Android）
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

### 登录

打开插件设置并选择 **Garmin Connect**，然后输入你的 Garmin 邮箱和密码（如启用两步验证，还需输入验证码）。桌面端和移动端的登录方式相同。

Garmin 可能会限制同一设备的重复登录尝试，此时插件会显示倒计时，等待结束后才能再次尝试。如果登录被阻止，请改用**使用浏览器登录**：在浏览器中打开 Garmin 的页面登录，复制包含 `ST-…` 的页面文字，然后点击插件中的剪贴板按钮（也可以粘贴到输入框）。登录成功后，插件会自动续期连接，因此你很少需要重新登录。

### 笔记的存放位置

**每日笔记路径**是文件夹，**每日笔记格式**是采用 [moment.js](https://momentjs.com/docs/#/displaying/format/) 语法的文件名，与内置 Daily Notes 插件的约定一致。格式本身可以包含 `/`，从而把笔记放入按日期划分的子文件夹；方括号内的文本保持原样：

| 路径 | 格式 | 结果 |
| --- | --- | --- |
| `Journal` | `YYYY-MM-DD` | `Journal/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM-DD` | `Journal/2026/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM/YYYY-MM-DD` | `Journal/2026/2026-08/2026-08-04.md` |
| `Journal` | `YYYY-MM-DD [Workout]` | `Journal/2026-08-04 Workout.md` |

缺失的子文件夹会自动创建。

### 自动同步

每次启动 Obsidian 时，插件会自动检查最近 7 天并补充缺失的健康数据，无需手动操作。默认情况下，缺少每日笔记时会自动创建。

如果其他工具负责管理你的每日笔记（Templater、Calendar 插件、外部同步），请在设置中关闭 **缺失时创建每日笔记**。自动同步随后会等待真正的（非空）每日笔记出现，并在其出现时立即同步；0 字节的空占位笔记会被忽略。手动同步和回填始终会创建缺失的笔记，与该设置无关。

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

- **Garmin Connect** —— 你在插件中输入邮箱和密码（如需要还有验证码）。它们只会发送到 Garmin 的登录服务器（`sso.garmin.com`，中国区为 `sso.garmin.cn`），插件不会保存或记录它们。登录后，插件会把 Garmin 登录令牌保存在 Obsidian 的密钥存储中，该存储只保留在本设备上，因此令牌不会同步到其他设备，也不会进入库备份或 Git。只有在密钥存储不可用或拒绝写入时，插件才会退而将其保存在 `data.json` 中。请像对待登录凭据一样对待这些令牌：其有效期由 Garmin 控制。每台设备需要单独登录。如果 Garmin 阻止或限制登录，会提供浏览器登录方式（在浏览器中打开 Garmin 的页面登录并粘贴一次性票据）。登录所需的公开 OAuth 客户端密钥从 `thegarth.s3.amazonaws.com` 获取（如果该主机无法访问，则使用内置的备用密钥）。**退出登录**会清除本设备上保存的令牌。
- **Nominatim (OpenStreetMap)** — 如果启用了 **训练地点** 功能，你第一项活动的 GPS 坐标会发送到 `nominatim.openstreetmap.org` 进行反向地理编码。你可以在设置中的 **训练地点** 关闭此功能。

不会向其他服务器发送数据。

## 开发

```bash
npm install
npm run dev    # 监听模式
npm run build  # 生产构建
```
