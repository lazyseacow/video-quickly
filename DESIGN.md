---
version: alpha
name: Mobbin Analysis
description: An analysis of Mobbin's design language — a gallery-white, monochrome interface system built to disappear behind the content it curates. Near-black ink on white canvas, a ladder of barely-there neutral tints instead of shadows, stadium-pill controls, 24px card geometry, iOS-style 30% squircle icon tiles, and the Saans typeface at unusual variable weights (652 display, 456 text, 300 light). One electric blue accent is reserved for commercial signals; every other color on screen belongs to the product screenshots being showcased.

colors:
  primary: "#141414"
  on-primary: "#ffffff"
  ink: "#141414"
  ink-soft: "#262626"
  text-muted: "#707070"
  text-faint: "#adadad"
  canvas: "#ffffff"
  canvas-soft: "#f3f3f3"
  field: "#f0f0f0"
  hairline-soft: "#f0f0f0"
  hairline: "#e0e0e0"
  accent: "#0066ff"

typography:
  display:
    fontFamily: Saans
    fontSize: 80px
    fontWeight: 652
    lineHeight: 1
    letterSpacing: 0
  heading-1:
    fontFamily: Saans
    fontSize: 56px
    fontWeight: 652
    lineHeight: 1
    letterSpacing: 0
  heading-2:
    fontFamily: Saans
    fontSize: 44px
    fontWeight: 652
    lineHeight: 1.13
    letterSpacing: 0
  heading-3:
    fontFamily: Saans
    fontSize: 32px
    fontWeight: 652
    lineHeight: 1.13
    letterSpacing: 0
  heading-4:
    fontFamily: Saans
    fontSize: 24px
    fontWeight: 652
    lineHeight: 1.25
    letterSpacing: 0
  title:
    fontFamily: Saans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  body-lg:
    fontFamily: Saans
    fontSize: 20px
    fontWeight: 300
    lineHeight: 1.38
    letterSpacing: 0
  body:
    fontFamily: Saans
    fontSize: 16px
    fontWeight: 456
    lineHeight: 1.38
    letterSpacing: 0
  body-sm:
    fontFamily: Saans
    fontSize: 14px
    fontWeight: 456
    lineHeight: 1.43
    letterSpacing: 0
  link:
    fontFamily: Saans
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: 0
  label:
    fontFamily: Saans
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0
  caption:
    fontFamily: Saans
    fontSize: 12px
    fontWeight: 456
    lineHeight: 1.33
    letterSpacing: 0

rounded:
  none: 0px
  sm: 16px
  md: 24px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px
  section-lg: 120px

components:
  nav-pill:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    padding: "0px {spacing.md}"

  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.full}"

  button-pill-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  text-input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  text-input-focused:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  badge-popular:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-primary}"

  badge-overlay:
    backgroundColor: "rgba(115, 115, 115, 0.56)"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"

  pricing-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.md}"

  pricing-card-featured:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"

  segmented-control:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.full}"

  segmented-control-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  testimonial-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.sm}"

  faq-row:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"

  app-icon-squircle:
    cornerRadius: "30%"

  brand-chip:
    textColor: "{colors.ink}"
    typography: "{typography.heading-3}"

  portrait-tile:
    rounded: "{rounded.md}"
    textColor: "{colors.on-primary}"

  award-lockup:
    textColor: "{colors.ink}"
    typography: "{typography.heading-3}"

  compare-table:
    rowBorder: "{colors.canvas-soft}"
    highlightBackground: "{colors.canvas-soft}"
    textColor: "{colors.ink}"

  footer:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"

  # ─── Examples (illustrative) — kit-mirror surfaces referencing brand primitives ───
  ex-pricing-tier:
    description: "Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface."
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-pricing-tier-featured:
    description: "Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode)."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-product-selector:
    description: "What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery)."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-cart-drawer:
    description: "Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart)."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    item-divider: "{colors.hairline}"
  ex-app-shell-row:
    description: "Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator."
    backgroundColor: "{colors.canvas}"
    activeIndicator: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs} {spacing.md}"
  ex-data-table-cell:
    description: "Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm."
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.caption}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.sm} {spacing.md}"
    rowBorder: "{colors.hairline}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-modal-card:
    description: "Modal dialog surface — same chrome as feature-card with elevated shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-empty-state-card:
    description: "Empty-state illustration frame."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.xxl}"
    captionTypography: "{typography.body}"
  ex-toast:
    description: "Toast notification surface — feature-card shape + medium shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    typography: "{typography.body-sm}"

---


## Video Quickly 项目适配

本项目以此文件为前端视觉规范，适用于创作工作台、项目与素材库、角色、模板、模型、Skill、制作与费用记录，以及所有弹窗。下方 Mobbin 分析提供视觉来源；实际产品的统一实现以 `apps/desktop/src/design-tokens.css`、`styles.css` 和 `components/Primitives.tsx` 为准。

### 主题、排版与层次

- 新用户默认浅色：白色画布 `#ffffff`、近黑正文 `#141414`、灰色表面 `#f3f3f3`、字段 `#f0f0f0`、分隔线 `#e0e0e0`。保留用户已保存的明暗主题选择；深色主题使用中性灰阶。
- 操作与选中态使用黑白灰。成功、警告、失败保留独立语义色；视频、图片、字幕及用户内容保留其真实颜色。时间轴轨道通过名称、图标、边框与灰阶区分。
- 字体使用 Segoe UI Variable、Segoe UI、Microsoft YaHei UI、系统无衬线回退。页面标题 28px，项目标题 24px，弹窗标题 20px，正文 14px，控件 13–14px，说明 12px，密集编辑器元信息 11px。标题字重 650，正文 400，不另加字距。
- 使用 4px 基础间距和 8 / 12 / 16 / 24 / 32 / 48px 尺度。用留白、灰阶和细边框建立层次，表面保持实色。

### 按钮、图标与弹窗

| 元素 | 统一规范 |
| --- | --- |
| 主按钮 | 黑底白字，深色主题反转；桌面默认 32px 最小视觉高度（`--button-height`），至少 40px 点击区；触屏至少 44px 高。16px 水平内边距、8px 图文间距、胶囊圆角。 |
| 次按钮 / 轻按钮 | 灰色填充与细边框 / 透明填充；沿用主按钮的排版、圆角及交互状态。危险操作使用语义色。 |
| 图标按钮 | 40 × 40px 最小点击区，16 × 16px 图标，胶囊外形；必须提供可访问名称。移动端高频导航至少 44px。 |
| 图标 | 统一使用 Lucide、`currentColor`。常规描边 1.75px，强调操作与选中导航 2px；按钮 16px、导航 18px、图标容器 20px。 |
| 弹窗 | 24px 外圆角、实色表面、细边框；标题区左侧 24px、右侧 16px，内容区 24px，操作区 16px / 24px、按钮间距 8px。 |
| 弹窗交互 | 标题和操作栏固定、长内容独立滚动；自动聚焦首个字段，支持 Tab、Escape 和关闭后的焦点恢复；窄窗口按钮可换行。 |
| 分区设置 | 复杂编辑表单使用左侧分类、中央当前分区、右侧常驻预览；切换分类保留输入，只让当前分区独立滚动。窄窗口改为顶部分类，预览按需展开；必填校验自动定位所属分区。 |
| 项目设置侧栏 | 使用“创作 / 画面 / 声音 / 资料”顶部分类，当前分类独立滚动，保存操作固定在底部；次级功能使用带图标与箭头的紧凑操作行。 |
| 批量导出 | 使用“导出规格 / 输出设置 / 导出记录”分区，配置与记录分别展示；规格摘要卡片自适应并排，展开配置占满内容区宽度，字段按可用空间换行；开始导出后切换到记录。 |
| 视频帧率 | 项目设置与导出共用 30 / 60 fps 选项；已有其他帧率只显示当前值，主动选择后才修改。 |
| 表单与媒体 | 字段 16px 圆角，44px 最小高度；内容卡片 24px，媒体 16px，密集时间轴片段 8px。 |
| 下拉框 | 16px 箭头、16px 右侧留白，文字右侧预留 48px；展开列表与控件间距 8px、16px 圆角，选项至少 40px 高，选中项使用灰阶填充与勾选标记。复用原生选择与键盘语义。 |
| 导航与切换 | 选中前后保持相同字体、字号和字重，用灰阶背景与文字颜色标识状态；编辑器内的下划线选项卡保留清晰的选中标记。 |
| 素材卡片 | 图片自动预览并按需加载；保留有意义的来源说明，文件名、大小和使用状态按统一层级展示。 |
| 模型连接 | 平台标识使用本地 24px 品牌 SVG；基本连接在桌面使用两列表单，窄窗口改为单列。模型列表占满内容区，填写地址与密钥后自动读取型号，允许手动填写；语音资源预设与远端账号列表明确区分。能力由连接类型与协议确定。图片尺寸复用统一下拉框，自定义时再展示输入框。 |
| 模型协议 | 所有模型连接统一按文本、图片、视频、音频分别添加与筛选，旧连接自动归入对应类型，每类表单仅显示对应协议和参数。文本展示 Chat Completions、Responses API 与 Anthropic Messages，本地 Ollama 标明原生接口；图片、视频、音频使用专用接口。音频由配音或识别协议确定用途。 |
| 模型与音色选择 | 模型输入框右侧的下载图标用于重新获取列表，加载时显示进度图标并防止重复触发。音色显示名称，按模型或资源版本筛选，长列表支持搜索；公共预设与账号读取结果明确标注，保留自定义和已有值。 |
| 用量展示 | 四项 Token 指标并列，数字使用等宽数字；明确的 0、未返回的 — 和部分返回的 * 分别表示。 |
| 页面切换 | 已访问页面保留内容与本地状态，数据在后台更新；页面切换使用直接反馈，首次懒加载就绪前保留当前内容。 |
| 提示 | 顶部居中显示；连续提示由下向上滚动替换，快速连发时保留最新内容。每次新提示重新计时 2 秒，支持关闭和减少动态效果。 |
| 步骤操作 | 弹窗底部依次为“取消”“保存”“执行”，主要操作置于右侧，沿用统一按钮尺寸与间距。 |
| 界面文案 | 上下文明确时，按钮使用“保存 / 刷新 / 应用 / 重试 / 加载更多”等短动词；可访问名称保留操作对象。说明使用短句，保留覆盖、删除、范围和权限等必要信息；同屏不同导出格式与操作后果仍需明确区分。 |

按钮、图标和弹窗的悬停、按下、禁用、加载及键盘焦点应通过共享样式维护。只对颜色、透明度和必要的变换设置短过渡，并尊重减少动态效果偏好。新增页面复用现有布局与生产组件；先扩展语义令牌，再增加组件变体。

下拉控件统一使用 `Primitives.tsx` 中的 `Select`，由原生 `select` 管理选择状态，独立的值显示区负责长文本省略；样式集中在 `select.css`，并适配减少动态效果和高对比度偏好。

属性面板内连续的整宽操作按钮之间使用 8px 间距，与后续表单字段之间使用 16px 间距。时间轴工具条高 56px，紧凑控件高 40px；批量编辑按钮左右各留 8px，工具条内上下保持约 8px 留白。

## Overview

Mobbin is a reference library of real product interfaces, and its own interface is engineered to get out of the way. The system is strictly monochrome: near-black ink (`{colors.ink}` — #141414) on a pure white canvas (`{colors.canvas}`), with structure carried by a ladder of barely-perceptible neutral tints rather than by shadows or color. The thousands of app screenshots, icon tiles, and brand logos the site exists to show are the only saturated elements on any page — the chrome frames them the way a gallery wall frames paintings.

The geometry does the brand work that color refuses to do. Every interactive element is a stadium pill (`{rounded.full}`): the floating navigation bar, every button, the segmented billing toggle, the overlay badges. Containers sit at a calm `{rounded.md}` (24px), media tiles at `{rounded.sm}` (16px), and app icons render as iOS-style squircles at 30% corner radius. Type is set in Saans at deliberately non-standard variable weights — a chunky 652 for every heading, a bookish 456 for text, an airy 300 for hero subtitles — which gives the monochrome pages a strong typographic voice without a single decorative flourish.

One color is allowed to interrupt: an electric blue accent (`{colors.accent}` — #0066ff), used exclusively for commercial signals — the "Popular" plan badge and the yearly-savings callout on pricing. Its scarcity is the point; when blue appears, it is asking for a decision.

**Key Characteristics:**
- Gallery-white monochrome palette — `{colors.ink}` on `{colors.canvas}`, zero brand chroma outside the single `{colors.accent}` blue
- Stadium-pill interaction language: nav bar, buttons, toggles, and badges all at `{rounded.full}`
- Shadow-free elevation — hierarchy built from a neutral tint ladder (`{colors.canvas-soft}`, `{colors.field}`, `{colors.hairline}`) and 1px hairlines
- Saans at signature variable weights: 652 headings with tight 1.0–1.13 line-height, 456 body, 300 light subtitles
- iOS-style squircle icon tiles (30% radius) as a recurring visual motif across library counters and brand marquees
- Content supplies the color: app screenshots, brand icons, and grayscale curator portraits carry all visual richness
- Full-bleed near-black `{colors.ink}` footer with rounded top corners closes every page in polarity inversion

## Colors

Source pages: home, pricing, awards, signup.

### Brand & Accent
- **Ink Black** (`{colors.primary}` — #141414): The brand color. Fills every primary CTA pill, the footer band, and all display typography. Mobbin's identity is this near-black, softened just off pure black to sit comfortably next to photography.
- **Electric Blue** (`{colors.accent}` — #0066ff): The only chromatic accent in the system. Reserved for commercial emphasis — the "Popular" pricing badge and savings callouts. Never used decoratively, never used for CTAs.

### Surface
- **Canvas** (`{colors.canvas}` — #ffffff): Default page and card background across all pages.
- **Soft Canvas** (`{colors.canvas-soft}` — #f3f3f3): The workhorse tint — a 6% ink wash over white. Fills the floating nav pill, the featured pricing card, FAQ accordion rows, soft utility pills, segmented-control tracks, and the highlighted comparison-table column.
- **Field** (`{colors.field}` — #f0f0f0): An 8% ink wash used as the fill for form inputs, giving fields presence without borders.
- **Soft Hairline** (`{colors.hairline-soft}` — #f0f0f0): 1px card outlines — the faintest possible edge, used on white-on-white cards (pricing, testimonials).
- **Hairline** (`{colors.hairline}` — #e0e0e0): The stronger 16% control border, used on outlined pill buttons and interactive chrome.

### Text
- **Ink** (`{colors.ink}` — #141414): Headings, body copy, and nav links.
- **Soft Ink** (`{colors.ink-soft}` — #262626): Slightly lifted dark used for secondary lockups and the awards wordmark.
- **Muted** (`{colors.text-muted}` — #707070): Secondary copy — supporting paragraphs, plan descriptions, vote counts, underlined inline links.
- **Faint** (`{colors.text-faint}` — #adadad): Tertiary text — placeholders, de-emphasized footer links, fine print.

### Semantic
- The system ships no dedicated success/warning/error palette on its marketing surfaces; state communication stays within the monochrome ladder, with `{colors.accent}` as the sole positive-emphasis signal.

## Typography

### Font Family

**Saans** — a contemporary neo-grotesque used exclusively, across every page and every role. It is loaded as a variable font, and the brand's voice comes from where it sits on the weight axis: headings render at an unusual 652 (heavier than semibold, lighter than bold), running text at 456 (a hair over regular), and hero subtitles at a genuinely light 300. Fallback stack: system sans (`-apple-system, "Helvetica Neue", Arial, sans-serif`).

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display}` | 80px | 652 | 1.0 | 0 | Homepage hero statements and library counters |
| `{typography.heading-1}` | 56px | 652 | 1.0 | 0 | Page heroes ("Design like a Pro.", "The votes are in.") |
| `{typography.heading-2}` | 44px | 652 | 1.13 | 0 | Section headings on content pages |
| `{typography.heading-3}` | 32px | 652 | 1.13 | 0 | Card-level headlines, award winner names, auth headings |
| `{typography.heading-4}` | 24px | 652 | 1.25 | 0 | Sub-section headings, plan names |
| `{typography.title}` | 20px | 600 | 1.3 | 0 | Feature titles, emphasized rows |
| `{typography.body-lg}` | 20px | 300 | 1.38 | 0 | Hero subtitles and lead paragraphs — the light counterpoint to 652 headings |
| `{typography.body}` | 16px | 456 | 1.38 | 0 | Default body copy, testimonial quotes |
| `{typography.body-sm}` | 14px | 456 | 1.43 | 0 | Supporting copy, plan feature lists, legal text |
| `{typography.link}` | 16px | 600 | 1.38 | 0 | Nav links and button labels |
| `{typography.label}` | 12px | 600 | 1.33 | 0 | Badge and pill labels |
| `{typography.caption}` | 12px | 456 | 1.33 | 0 | Captions, metadata, form fine print |

### Principles

- **Weight contrast is the drama.** Pairing 652 headings against 300 light subtitles at the same scale step (e.g. 80px display over 20px light lead) creates hierarchy without color or ornament.
- **Tight leading up top.** Display and heading-1 sit at line-height 1.0; headings never breathe more than 1.25. Body text opens up to 1.38–1.43.
- **Zero letter-spacing everywhere.** The grotesque is trusted at its natural fit; no tracking adjustments at any size.
- **Sentence case with terminal periods.** Headlines read as declarative sentences: "Discover real-world design inspiration." — the period is part of the voice.

### Note on Font Substitutes

Saans is a commercial typeface. The closest widely-available substitutes are **Inter** (variable, supports the 300/450/650 weight positions via its variable axis) or **Hanken Grotesk**. When substituting, map weight 652 → 650 (or 700 at static weights), 456 → 450 (or 500), and keep line-heights as specified — Saans has a compact x-height, so substitutes may need line-height reduced by ~0.05.

## Layout

### Spacing System
- **Base unit**: 8px, with 4px half-steps for fine rhythm
- **Tokens**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 80px · `{spacing.section-lg}` 120px
- Buttons are fixed-height pills padded horizontally at `{spacing.md}`; inputs pad `{spacing.sm} {spacing.md}`
- Universal rhythm constants: 28px and 80px vertical steps recur on every page; 120px separates major homepage acts

### Grid & Container
- Content rides a centered column: single-column centered lockups for heroes and award winners, a 2-up card grid for pricing plans, 3-up for portrait tiles, and a 4-column masonry for testimonials.
- The floating nav pill is detached from the viewport edge and horizontally centered, rather than a full-width bar — the page canvas visibly wraps around it.
- Marquee strips (brand logos, app screenshots) run full-bleed beyond the content column.

### Whitespace Philosophy

Whitespace is the primary grouping device. Sections are separated by `{spacing.section}` to `{spacing.section-lg}` of empty canvas with no divider rules; within cards, generous `{spacing.lg}` padding keeps content off the hairline edges. The homepage alternates dense collage moments (icon clouds, screenshot grids) with near-empty typographic interludes — compression and release.

### Responsive Strategy

#### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| 2xl | 1536px | Max content width engaged; marquees widen |
| xl | 1280px | Default desktop grid |
| lg | 1024px | Comparison table condenses; testimonial masonry drops to 3 columns |
| md | 840px / 768px | Pricing cards stack to 1-up; portrait grid drops to 2-up; nav links collapse |
| sm | 719px / 640px | Single-column layouts; display type scales down from 80px |
| xs | 600px | Minimum layout; auth split-panel drops its screenshot marquee |

#### Touch Targets
- Pill buttons and nav CTAs are fixed-height stadium shapes comfortably above the 44px minimum; form inputs pad to a similar height via `{spacing.sm} {spacing.md}`.
- The segmented billing toggle presents each option as a full pill target, not a small radio dot.

#### Collapsing Strategy
- The floating `nav-pill` persists on scroll and across breakpoints, tightening to logomark + CTA on narrow screens.
- Multi-column grids (pricing 2-up, portraits 3-up, testimonials 4-up) collapse column-by-column rather than reflowing horizontally.
- The signup page's two-panel split (form left, angled screenshot marquee right) drops the marquee panel entirely on narrow viewports, keeping the centered form column.

#### Image Behavior
- App screenshots and device mockups keep fixed aspect ratios and `{rounded.md}` corners at all sizes.
- Marquee strips overflow the viewport intentionally and animate horizontally; they crop rather than scale.
- Curator portraits stay square-ish tiles, lazily loaded, always grayscale.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | Flat on `{colors.canvas}` | Default — most of every page |
| 1 | `{colors.canvas-soft}` fill, no border | Nav pill, featured pricing card, FAQ rows, soft pills |
| 2 | 1px `{colors.hairline-soft}` outline on white | Pricing and testimonial cards |
| 3 | 1px inset ring | Comparison-table highlight column edge |
| Inverse | `{colors.ink}` fill, `{colors.on-primary}` text | Footer band, primary CTAs |

The system is essentially shadow-free: no drop shadows appear on any card, button, or nav element. Elevation is communicated by *fill difference* (white vs. 6–8% ink tints) and by hairlines, which keeps every surface print-flat and lets the screenshot content supply all depth cues. The one soft-shadow exception is the active segment of the segmented control, which lifts off its `{colors.canvas-soft}` track as a white pill.

### Decorative Depth
- **Glass monoliths** — the awards hero renders tall trophy pillars in a white-to-gray vertical gradient, reading as frosted glass against the `{colors.canvas-soft}` band; the page's only atmospheric gradient.
- **Photography as depth** — floating app-icon squircles, angled screenshot collages (signup's rotated marquee panel), and device mockups create parallax-like layering on a flat canvas.
- **Polarity inversion** — the `{colors.ink}` footer with `{rounded.md}` top corners acts as a heavy baseboard, giving each page a physical end-stop.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed media strips and marquee images |
| `{rounded.sm}` | 16px | Inputs, video tiles, testimonial cards, FAQ rows |
| `{rounded.md}` | 24px | Content cards, device mockups, portrait tiles, footer top corners |
| `{rounded.full}` | 9999px | Every pill: nav, buttons, badges, toggles |

### Photography Geometry
- App screenshots render inside device-shaped frames at `{rounded.md}`.
- App icons use the signature 30% squircle radius (`app-icon-squircle`) — the iOS icon silhouette — at every size from 32px chips to 96px hero tiles.
- Curator portraits are near-square tiles at `{rounded.md}`, always black-and-white, with name captions overlaid in `{colors.on-primary}` on a `badge-overlay` scrim near the lower edge.
- Avatars in testimonial cards are small circles (`{rounded.full}`) with a tiny company logo badge overlapping the bottom-right corner.

## Components

### Buttons

**`button-primary`** — "Join for free", "Get started", "Continue", "View winners"
- Fill `{colors.primary}`, label `{colors.on-primary}` in `{typography.link}`, shape `{rounded.full}`, padding `0px {spacing.md}` on a fixed-height pill
- The single CTA style everywhere: nav, pricing cards, auth form, awards hero

**`button-outline`** — "Continue with Google", secondary "Get started"
- Fill `{colors.canvas}`, label `{colors.ink}`, 1px `{colors.hairline}` border, shape `{rounded.full}`
- The de-emphasized twin of the primary pill; used when two actions sit side by side or for third-party auth

**`button-pill-soft`** — "Explore ↗", "Mobbin ↗", "Read more"
- Fill `{colors.canvas-soft}`, label `{colors.ink}`, shape `{rounded.full}`
- Tertiary utility pill for outbound and in-page links; no border, relies on its tint fill

### Cards & Containers

**`pricing-card`** — default plan tier (Team)
- `{colors.canvas}` fill, 1px `{colors.hairline-soft}` outline, `{rounded.md}` corners
- Plan name in `{typography.heading-4}`, price figure large with stacked `{typography.caption}` qualifiers, feature list rows in `{typography.body-sm}` with `{colors.text-muted}` icons

**`pricing-card-featured`** — highlighted plan tier (Pro)
- `{colors.canvas-soft}` fill, borderless, `{rounded.md}` corners — emphasis by tint, not by outline or polarity flip
- Carries the `badge-popular` chip beside the plan name and a full-width `button-primary` CTA, while the default tier gets `button-outline`

**`testimonial-card`** — user quote tile
- `{colors.canvas}` fill, 1px `{colors.hairline-soft}` outline, `{rounded.sm}` corners
- Circular avatar with overlapping company mini-badge, name in `{typography.link}`, company in `{colors.text-muted}` `{typography.body-sm}`, quote in `{typography.body}`
- Laid out as a 4-column masonry of varying heights

**`faq-row`** — accordion item
- Full-width `{colors.canvas-soft}` bar, `{rounded.sm}` corners, question in `{typography.body}` with a trailing chevron; rows stack with `{spacing.sm}` gaps

**`portrait-tile`** — curator/juror grid cell
- Grayscale photograph at `{rounded.md}`, name + role caption overlaid at bottom center in `{colors.on-primary}`
- The strict black-and-white treatment keeps the people grid inside the monochrome system

### Inputs & Forms

**`text-input`**
- `{colors.field}` fill, no border, `{colors.ink}` text with `{colors.text-faint}` placeholder, `{rounded.sm}` corners, padding `{spacing.sm} {spacing.md}`

**`text-input-focused`**
- Same chrome plus a 2px `{colors.ink}` ring — focus is signaled in ink, consistent with the monochrome system

### Navigation

**`nav-pill`** — Top Nav (Desktop)
- A floating, horizontally-centered stadium bar in `{colors.canvas-soft}`: logomark + wordmark left, text links ("Pricing", "Awards", "Log in") in `{typography.link}` right, capped by a `button-primary` CTA
- Detaches from the page edge with visible canvas above it; persists as a sticky element on scroll

**Top Nav (Mobile)**
- The pill tightens to logomark + CTA; links collapse behind the pill

**Sub-nav (Awards)**
- Minimal corner marks instead of a bar: logomark + section name top-left, a `button-pill-soft` "Mobbin ↗" return link top-right

### Signature Components

**`app-icon-squircle`** — the recurring 30%-radius icon tile; floats in loose clouds around library counters, lines up in "Other nominees" rows, and anchors `brand-chip` entries

**`brand-chip`** — marquee lockup of squircle icon + brand name in `{typography.heading-3}` ink; scrolls horizontally in full-bleed strips of recognizable products

**`badge-popular`** — compact `{colors.accent}` chip with `{colors.on-primary}` label marking the featured pricing tier; the only blue element on the page

**`badge-overlay`** — translucent gray pill (rgba(115, 115, 115, 0.56)) with `{colors.on-primary}` `{typography.label}` text, laid over photography and screenshots (category tags, portrait captions)

**`segmented-control`** + **`segmented-control-active`** — billing-period toggle: a `{colors.canvas-soft}` stadium track holding two pill options; the active option is a `{colors.canvas}` white pill, the inactive label sits in `{colors.text-muted}`

**`award-lockup`** — centered winner presentation: laurel-flanked category eyebrow in `{colors.text-muted}`, winner name in `{typography.heading-3}`, description in `{colors.text-muted}` `{typography.body}`, vote share in `{typography.body-sm}`, closed by a `button-pill-soft` "Explore ↗"

**`compare-table`** — the pricing comparison grid: feature rows divided by 1px `{colors.canvas-soft}` rules, the recommended plan's column washed in `{colors.canvas-soft}` with an inset ring edge

**`footer`** — full-width `{colors.ink}` band with `{rounded.md}` top corners: white wordmark at display scale, tagline in `{colors.text-faint}`, two columns of `{colors.text-faint}` links that read in `{colors.on-primary}` for emphasis rows

### Examples (illustrative)

> Kit-mirror demonstration surfaces. Each `ex-*` entry references brand-native primitives via token syntax so downstream consumers re-skin the same 10 surfaces consistently; none carries invented literal values.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).
- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.
- Properties: `backgroundColor`, `rounded`, `padding`, `typography`


## Do's and Don'ts

### Do
- Keep the canvas `{colors.canvas}` white and let imported content (screenshots, icons, logos) supply all saturation.
- Use `{rounded.full}` for every interactive element — a rectangular button does not exist in this system.
- Build emphasis with the tint ladder: `{colors.canvas-soft}` fill for featured surfaces, `{colors.hairline-soft}` outlines for resting cards.
- Reserve `{colors.accent}` for commercial signals (featured badges, savings callouts) — one or two blue elements per page at most.
- Set every heading in Saans 652 with line-height 1.0–1.13 and end headline sentences with a period.
- Pair heavy 652 headings with 300-weight `{typography.body-lg}` subtitles for hierarchy without color.
- Render app icons as 30% squircles and portraits in grayscale to keep third-party imagery inside the system.
- Close pages with the inverse `{colors.ink}` footer, rounded at the top.

### Don't
- Don't add drop shadows — elevation is fills and hairlines only.
- Don't use `{colors.accent}` for CTAs; primary actions are always `{colors.primary}` ink pills.
- Don't introduce additional accent hues, gradients on UI chrome, or colored section bands.
- Don't outline the featured pricing tier — feature it with the `{colors.canvas-soft}` fill and `badge-popular` instead.
- Don't apply letter-spacing or all-caps styling; the type system runs at natural tracking in sentence case.
- Don't put borders on form fields at rest — inputs are `{colors.field}` tint fills; the border appears only as the 2px ink focus ring.
- Don't let full-color photography of people into the curator/juror grids; portraits are strictly black-and-white.
- Don't square off pill geometry at small sizes — badges, chips, and toggles stay stadium-shaped.
