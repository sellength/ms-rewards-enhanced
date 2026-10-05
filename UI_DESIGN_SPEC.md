# 微软积分控制中心 UI 设计系统与组件开发规范 (UI Design Spec)

> 任务交互标记、完成真值与执行门控统一见 [接口注册表第 5、8 节](docs/API_INTERFACE_REGISTRY.md)。本规范只定义展示与协作边界；不以 UI 文档改写执行策略。

> 📌 **项目唯一设计准绳**：本项目后续所有新功能、新分支、新页面模块与交互组件，必须**100% 严格遵循本文档所定义的视觉风格、色彩规范、排版层级、组件骨架与微动效标准**，严禁使用任何突兀、风格不一致的第三方通用模板。

---

## 1. 核心设计哲学 (Design Philosophy)

* **设计语言**：**Microsoft Fluent Design System 2 + Apple HIG 玻璃拟态 (Glassmorphism)**。
* **视觉特征**：
  * 半透明磨砂背景（`backdrop-filter: blur(16px)`）；
  * 多层立体深度（3D 浮雕图标 + 柔和彩色投影 `drop-shadow`）；
  * 大圆角设计（卡片 `14px ~ 18px`，徽章胶囊 `12px ~ 20px`）；
  * 高对比度信息层次（主数据加粗大字号，辅助文字低饱和度）；
  * 物理弹性微动效（基于 `cubic-bezier(0.16, 1, 0.3, 1)` 的流畅过渡）。

---

## 2. 色彩系统与设计令牌 (Design Tokens)

### 2.1 主题背景与卡片色 (CSS Variables)

```css
:root {
    /* 默认浅色主题 (Light Mode) */
    --bg-app: #f4f6fb;
    --bg-sidebar: #ffffff;
    --bg-card: rgba(255, 255, 255, 0.92);
    --border-color: rgba(226, 232, 240, 0.8);
    --border-card: rgba(0, 0, 0, 0.06);
    --text-primary: #0f172a;
    --text-secondary: #64748b;
    --text-muted: #94a3b8;
    --shadow-card: 0 4px 20px -2px rgba(0, 0, 0, 0.05);
    --shadow-hover: 0 12px 28px -4px rgba(0, 0, 0, 0.1);
}

[data-theme="dark"] {
    /* 深色主题 (Dark Mode) */
    --bg-app: #0b0f19;
    --bg-sidebar: rgba(13, 18, 31, 0.95);
    --bg-card: rgba(17, 24, 39, 0.85);
    --border-color: rgba(255, 255, 255, 0.08);
    --border-card: rgba(255, 255, 255, 0.07);
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --shadow-card: 0 4px 20px -2px rgba(0, 0, 0, 0.35);
    --shadow-hover: 0 12px 32px -4px rgba(0, 0, 0, 0.5);
}
```

### 2.2 品牌功能色 (Semantic Colors)

| 功能语义 | 色值 (十六进制) | 适用场景 | 对应渐变 / 浅色底 |
| :--- | :--- | :--- | :--- |
| **Microsoft 经典蓝** | `#0078d4` / `#0284c7` | 主操作按钮、标题高亮、聚焦光标 | `linear-gradient(135deg, #0078d4, #0284c7)` |
| **完成/安全绿** | `#107c41` / `#10b981` | 打勾已完成 (`✔ 10`)、成功提示、连胜 | `rgba(16, 185, 129, 0.12)` |
| **积分/金币黄** | `#d97706` / `#fbbf24` | 3D 金币堆、积分大字、连击火苗 (`🔥`) | `rgba(245, 158, 11, 0.12)` |
| **天空蓝 (搜索)** | `#0ea5e9` / `#38bdf8` | 移动端搜索卡片、日志信息流 | `rgba(14, 165, 233, 0.12)` |
| **紫罗兰 (特权)** | `#8b5cf6` / `#a855f7` | 专属特权、大额宝箱加成 | `rgba(139, 92, 246, 0.12)` |
| **警告/错误红** | `#ef4444` / `#f87171` | 报错日志、阻断报警 | `rgba(239, 68, 68, 0.15)` |

### 2.3 官方卡片淡彩马卡龙底色 (Pastel Themes for Task Icons)
用于任务卡片左侧图标的背景色：
* **蜜桃粉 (`#fff1f2`)**：每日一言、问答等；
* **浅薰衣草紫 (`#f5f3ff`)**：航班出行、机票搜索等；
* **薄荷淡绿 (`#f0fdf4`)**：樱花、植物、自然风光等；
* **暖杏淡黄 (`#fefce8`)**：艺术、插花、摄影等；
* **柔雾淡蓝 (`#f0f9ff`)**：天气、百科、知识测验等。

---

## 3. 字体与排版层级 (Typography Hierarchy)

* **主字体族 (UI Font Stack)**：
  ```css
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  ```
* **等宽字体族 (Monospace Stack - 专用于数字/代码/时间戳)**：
  ```css
  font-family: 'SF Mono', 'Segoe UI Mono', Menlo, Consolas, Monaco, monospace;
  ```

| 层级 | 字号 (rem / px) | 字重 (Font Weight) | 示例组件 |
| :--- | :--- | :--- | :--- |
| **大号数值 (Metric Display)** | `2.25rem` (36px) | `800` (Extra Bold) | 可用总积分 `14,899`、今日赚取 `120` |
| **模块大标题 (H1 / Page Title)**| `1.4rem` (22.4px) | `800` (Extra Bold) | 页面顶部 `控制中心`、`Mobile 控制中心` |
| **卡片标题 (H2 / Card Title)** | `1.05rem` (16.8px) | `700` (Bold) | `每日活动总览`、`每日核心任务` |
| **任务卡片主标题** | `0.9rem` (14.4px) | `700` (Bold) | `Upcoming events near me` |
| **副标题 / 描述正文** | `0.82rem` (13.1px) | `500` (Medium) | 任务说明、用户等级进度条文字 |
| **徽章 / 胶囊小标签 (Pill)** | `0.75rem` (12px) | `700` (Bold) | `✔ 10`、`🔥 5 天连击`、`Completed ↗` |

---

## 4. 核心标准组件规范 (Component Library Spec)

### 4.1 核心数据总览卡 (Hero Metrics Card)
* **结构规范**：采用 3 列横向响应式布局（`grid-template-columns: 1.2fr 1fr 1.2fr`）：
  1. **左列**：用户头像徽标（蓝色圆形 + 大写首字母）+ 用户邮箱 + 会员等级徽章（`Silver Member`）；
  2. **中列**：可用积分余额（大字号数字 + 点击唤起 `Points breakdown` 抽屉链接）；
  3. **右列**：今日总赚取（3D 4层立体金币堆 + 今日得分 `120 / 98` + 连击天数徽章）。
* **交互规范**：鼠标悬停有轻微向上浮起（`translateY(-2px)`）和外发光。

---

### 4.2 4 宫格官方活动看板 (`Your activity` Grid)
* **结构规范**：严格 4 列等宽网格（`grid-template-columns: repeat(4, 1fr)`），间距 `14px`。
* **卡片解构**：
  ```
  ┌─────────────────────────────┐
  │  卡片名称 (如 Bing Search)  │
  │                             │
  │     [ 3D 浮雕质感图标 ]     │
  │                             │
  │ 状态 (1/1)       连击 (🔥 4)│
  └─────────────────────────────┘
  ```
* **图标规范**：采用白色浮雕圆角方块作为底托，内置带彩色阴影的 Fluent 3D 风格矢量/Emoji 图标。

---

### 4.3 任务清单与推广卡片设计规范 (`.ms-cards-grid` & `.ms-card`)

任务清单是控制中心最高频的交互单元。**所有控制中心（包括 Desktop、Mobile、Xbox 等）的任务列表必须 100% 统一采用 `.ms-cards-grid` 和 `.ms-card` 结构与样式**，严禁使用任何未经规范的非标准 DOM 或自创类名。

#### 1. 结构与网格规范
* **容器网格 (`.ms-cards-grid`)**：严格采用 3 列等宽网格（`grid-template-columns: repeat(3, 1fr)`），网格间距 `gap: 1rem (16px)`。在移动/窄屏适配下自动阶梯退化为 2 列或 1 列。
* **卡片解构 (`.ms-card`)**：
  ```
  ┌──────────────────────────────────────────────────────────────┐
  │ [ 50x50 ]  卡片单行主标题 (加粗, 溢出省略号 ...)              │
  │ [ 淡彩  ]  卡片副标题/任务描述说明 (浅灰双行省略)             │
  │ [ 缩略图]  [ ✔ 10 ] (绿色胶囊)           Completed ↗ (右下状态)│
  └──────────────────────────────────────────────────────────────┘
  ```
* **标准 HTML 代码骨架 (Standard DOM Template)**：
  ```html
  <div class="ms-cards-grid" id="containerId">
      <div class="ms-card" onclick="openTaskUrl('任务标题或链接')" title="点击直达任务">
          <!-- 1. 左侧缩略图: 50x50px 淡彩马卡龙底托 + 矢量/主题 Emoji -->
          <div class="card-thumb thumb-green">📰</div>
          
          <!-- 2. 中间与右侧信息区 -->
          <div class="card-details">
              <div>
                  <div class="card-title">必应新闻阅读 (Read to Earn)</div>
                  <div class="card-desc">手机端阅读 10 篇新闻文章，每天可获得 30 积分</div>
              </div>
              <div class="card-foot">
                  <!-- 已完成: ms-pill-green / 未完成: ms-pill-pending -->
                  <span class="ms-pill-green">✔ 30</span>
                  <span class="card-status-label">Completed ↗</span>
              </div>
          </div>
      </div>
  </div>
  ```

#### 2. 精确尺寸与 CSS 属性要求
* **卡片高度与边距**：
  * 固定高度：`height: 96px; min-height: 96px; max-height: 96px;`
  * 内边距：`padding: 0.9rem 1.15rem;`
  * 间距：`gap: 14px;`
  * 圆角：`border-radius: 14px;`
  * 阴影与过渡：`box-shadow: var(--shadow-card); transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);`
  * 悬停态：`transform: translateY(-2px); border-color: #3b82f6; box-shadow: var(--shadow-hover);`
* **缩略图底色类名字典 (Thumbnail Palette Dictionary)**：
  * `.thumb-green`: 翠绿淡渐变（新闻、植物、自然、生态）
  * `.thumb-cyan`: 浅青淡渐变（移动端、搜索、网络）
  * `.thumb-yellow`: 暖杏淡渐变（签到、日历、问答、艺术）
  * `.thumb-peach`: 蜜桃粉渐变（花卉、每日一言、推荐）
  * `.thumb-purple`: 薰衣草紫渐变（专属特权、机票、娱乐）
  * `.thumb-desert`: 暖褐淡渐变（旅行、探索、探险）
  * `.thumb-star`: 金星淡渐变（高额奖励、限时任务）
* **状态胶囊规范 (Status Pill Tokens)**：
  * **已完成 (Completed)**：`<span class="ms-pill-green">✔ 30</span>`（绿色半透明底 + 深绿加粗文字）+ `<span class="card-status-label">Completed ↗</span>`
  * **待完成 (Pending)**：`<span class="ms-pill-pending">+10</span>`（半透明点数胶囊）+ `<span class="card-status-label">⏳ 待完成</span>`
  * 正常执行结束后，官方仍为待完成或任务明确要求在 Bing App 内手动操作时，必须继续显示“⏳ 待完成”；不得仅因本轮没有完成而显示“❌ 异常”。“异常”只用于明确错误或运行失败。
  * **无分直达推广 (Promo Link)**：`<span class="card-status-label" style="margin-left:auto; font-size:1.1rem;">↗</span>`

#### 3. 分区规划要求 (Two-Tier Section Hierarchy)
控制中心任务清单必须按层次划分为清晰的 2 个板块：
1. **第一板块：核心每日打卡 (`Daily Set` / `Mobile Core Tasks`)**
   * 包含 3 张每日必做高优卡片，右侧带有当前阶段打卡进度小徽章（如 `3/3 完成 (30/30分) 🟢`）；
2. **第二板块：拓展与探索活动 (`Keep earning` / `Mobile Keep earning & Explore`)**
   * 包含 6+ 张探索、推广、限时或加成任务卡片（3 列 × N 行），右侧带有总完成度徽章（如 `50/50 完成 🟢 ▲`）。
   * PC Keep earning 与移动 More activities 中需用户操作且官方尚未完成的卡，在标题右侧统一显示蓝色 `人工任务` 胶囊，详情抽屉显示“需要用户手动操作”；官方确认完成后只显示 `已完成`，不再保留人工标签。PC 仍过滤移动 App 专属卡，Rewards goal 类 PC 卡保留并标记；普通 Quiz/URL Reward 不显示。该二态规则严禁用于 Daily Set。
3. **弹性发现板块 (`Additional official tasks`)**
   * 已知分区内的卡片数量必须跟随官方响应动态增减；发现符合资格但不属于现有契约的新任务类型/集合时，自动生成独立分区，禁止错误塞入 Daily Set、Keep earning 或 More activities；
   * 未验证完成协议的新分区必须标记「只读发现」，只展示状态和分值，不自动执行、不计入今日主卡或既有任务小计；
   * PC/移动任务页为固定底部运行日志栏预留至少 `96px` 安全区；日志展开时安全区增至 `340px`，保证最后一个动态分区可完整滚动查看。

---

### 4.4 积分账本侧边滑出抽屉 (Slide Breakdown Drawer)
* **规范**：
  * 从右侧滑入（`width: 440px`, `right: 0`, `transition: transform 0.35s ease`）；
  * 背后带有暗色磨砂遮罩（`rgba(0, 0, 0, 0.45)`, `backdrop-filter: blur(4px)`）；
  * 抽屉按 `platform + scope` 渲染，打开新卡片时必须完整覆盖标题、主值、分项、来源和操作按钮，禁止沿用上一终端或上一卡片的数据；
  * 「可用积分余额」展示账号余额及可用的月度/年度/Lifetime 信息，不得显示今日积分；
  * PC「今日总赚取」展示 Rewards Web 官方今日累计、PC 任务小计、Search、Daily Set、Keep earning 与未归类差额；
  * 移动「今日赚取」只展示 SAAndroid Daily Set、App Search、Read to earn，签到与 streak 明确排除；
  * 移动 More activities 标题汇总必须直接使用后端已按官方口径规范化的 `moreActivitiesEarned/moreActivitiesMax`，不得由前端按完成卡片重新求和；当前 `_exploreonbing_activation_` 卡展示且计入上限，但不计入主汇总分子；
  * Search、Read、签到以及 Daily Set/Keep earning 的单张任务卡展示该卡自身的进度、积分、状态和数据来源；任务存在安全的官方 URL 时显示「打开官方任务」；
  * 尚未完成且带 `人工任务` 标记的 Keep earning/More activities 详情增加“执行方式：需要用户手动操作”，避免把外部网页跳转或通用请求误认为可自动完成；官方完成后隐藏该行，只保留完成状态；
  * 任务组进入“执行中/异常”时，仅未完成、正分且可自动执行的子卡继承该运行状态；0 分信息/导航卡不显示运行徽章，未完成人工卡继续只显示“人工任务”，已完成卡继续只显示“已完成”；
  * PC/移动共用任务详情抽屉底部采用横向双按钮：存在安全官方 URL 时，左侧「打开官方任务」主按钮与右侧「关闭」次按钮按约 `2:1` 分配宽度，保持同高和 `12px` 间距；无安全 URL 时隐藏主按钮并让「关闭」占满底栏。右上角 `×` 和点击遮罩仍可关闭；
  * Edge Browsing 继续使用按分钟设计的专属抽屉，不复用积分抽屉；
  * 服务端返回的任务标题和说明必须通过 `textContent`/文本节点渲染，不得以未转义 HTML 写入抽屉。

---

### 4.5 Pop 悬浮折叠控制台 (Floating Pop Console)
* **规范**：
  * 悬浮于页面底部（`bottom: 12px`, `border-radius: 14px`，避开侧边栏）；
  * 右侧带有旋转 chevron 指示箭头（展开/收拢时 **180° 同步旋转**）；
  * 展开动效：`max-height` 从 `0` 平滑过渡至 `260px`，使用 `cubic-bezier(0.16, 1, 0.3, 1)`；
  * 日志行采用终端等宽字体，支持 `green`（成功）、`blue`（高亮）、`red`（报错）多级染色。

---

### 4.6 同步按钮频率反馈

* PC 与移动同步按钮分别维护 15 秒防重复窗口，不得因点击一个终端而锁定另一个终端；
* 首次点击立即显示旋转状态并发起同步；请求进行中按钮禁用；
* 冷却窗口内再次触发不得产生第二次云请求，当前终端日志显示“请在 N 秒后再次手动同步”；
* 服务端返回 `retryAfterSeconds` 时，页面使用该剩余秒数替代内部错误码；
* 后台 5 分钟同步和失败退避不得在运行日志中制造周期噪声，任务执行日志仍通过 SSE 即时显示。

---

### 4.8 任务刷新信息 (Task Refresh Info)

- 位于 PC/移动 Hero 卡片左侧账户信息下方，与头像、账号和等级组成同一信息列，不新增顶层大卡。
- 使用淡蓝时钟底托、`--bg-subtle` 背景、`--border-color` 边框和辅助小字；固定标题为“任务更新时间（系统获取）”。
- 只显示一行“下一次刷新：MM/DD 00:00”，其值必须是浏览器/OS 当前时间之后的下一个本地零点；不得使用可能滞后的终端官方周期日期推算这个展示值。
- 不展示官方周期、最近同步或 IANA 时区等技术字段；页面直接使用浏览器/OS 系统时区，不提供手动时区设置。

## 5. 微动效与交互准则 (Animations & Micro-interactions)

```css
/* 1. 悬停浮起动画 */
.card-hover-effect {
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease;
}
.card-hover-effect:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-hover);
}

/* 2. 按钮点击按压反馈 */
.btn-action:active {
    transform: scale(0.98);
}

/* 3. 同步图标同心匀速旋转 */
.spinning {
    animation: spin 0.8s linear infinite;
    transform-origin: 50% 50%;
}
@keyframes spin {
    100% { transform: rotate(360deg); }
}

/* 4. Pop 折叠与展开缓动 */
.bar-expandable {
    transition: max-height 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
}
```

---

## 6. 后续添加新功能的 4 大铁律 (Implementation Checklist)

无论未来添加任何新模块（例如 Xbox 控制中心、自动兑换卡、多账号管理）：
1. ✅ **必须统一色彩体系**：严格复用 `--bg-card`、`--text-primary` 与语义功能色；
2. ✅ **必须统一图标语言**：图标必须带有淡彩底托或 3D 浮雕光影，禁止直接裸放干瘪的线框图标；
3. ✅ **必须统一卡片骨架**：顶部标题 + 中间数值/内容 + 底部胶囊标签与状态文本；
4. ✅ **必须统一动效缓动**：所有弹窗、抽屉、折叠面板统一采用 `cubic-bezier(0.16, 1, 0.3, 1)` 弹性过渡。

---

## 7. Gemini / OpenDesign 协作边界

Gemini、OpenDesign 或其他生成式 UI 工具只负责视觉与交互展示层，不拥有业务数据的解释权。本节是 UI 专用权限的唯一现行正文。按本次组件读取设计规范；涉及业务字段时查接口注册表对应条目，无需阅读旧交接表。

### 7.1 可以处理

- 对现有页面进行视觉审计、局部线框稿和组件方案设计；
- 调整目标组件的布局、间距、字号、颜色 token、对齐、响应式、动效和无障碍表现；
- 修复按钮重叠、文本溢出、日志栏遮挡、抽屉布局和状态视觉层级；
- 在用户确认方案后，对 `public/` 中目标组件、UI 专属资源与必要的 UI 测试做最小补丁；已有明确方案或实施授权时不重复确认。

### 7.2 不可越界

- 不得整体重写页面、替换 UI 框架或将设计工具生成代码整页覆盖到项目；
- 不得修改 `web.mjs`、`src/`、外部/本地接口、SSE 数据结构、Session、同步或任务执行逻辑；
- 不得改变 PC/移动端任务归属、积分公式、完成条件、状态来源或受保护字段名称；
- 不得根据标题、颜色、旧缓存或前端猜测生成“已完成”，页面只展示后端官方来源状态；
- 保留现有 DOM ID、`data-*` 属性、事件绑定与测试选择器；确需改名时，用源码搜索或 CodeGraph 查清消费者，并在同一局部补丁中更新相关回归；
- 不得向在线设计工具提交真实账号数据、接口响应、Cookie、Token、RUID 或设备信息。

### 7.3 推荐执行顺序

1. 截取当前目标区域并列出具体 UI 问题，不改代码；
2. 使用 OpenDesign 或可用 UI/UX Skill 产出局部方案，继续沿用本规范的设计 token 和组件语言；
3. 尚未确认且涉及设计选择的方案交由用户确认；已确认方案直接实施；
4. 用最小 diff 实施，不触碰范围外代码；
5. 对同一数据快照比较修改前后界面，并检查桌面、窄窗口、浅色、深色和键盘焦点；
6. 完成与改动匹配的验证后登记结果；布局小改可用同快照视觉检查，交互行为变化运行相关回归，CodeGraph 按需使用。

如果一个视觉方案必须依赖新字段或业务行为，先停止 UI 实施，将其拆成新的 `REQ-*` 功能需求；未经确认不能由 UI 工具自行设计后端语义；用户已明确授权同一业务范围时沿用该授权。纯 UI 改动不得新增 Microsoft 请求，状态、积分、任务数量和按钮可用性须与同一后端快照保持一致。
