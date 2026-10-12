# 邻舍.EXE Design System

邻舍.EXE 采用 **Cel Glow UI**：赛璐璐动漫游戏质感 × 柔光玻璃氛围——暖色明亮、暗夜克制、Q 弹、内容优先。

配色为「珊瑚暖纸 · 暗夜玻璃」的双主题体系，支持暖色 / 暗夜 / 按时间切换。Toast、GiftPanel、ImageGenBubble 是动效与反馈的内部范本，新功能应从它们与全局组件类延伸。

## 游戏化 UI（2026-09-09 起）

小镇世界内的玩法界面全面向游戏舞台靠拢，以 `TownDialogueStage.vue` 的 SVG 暖纸不规则对话框为锚点，不再使用 SaaS 后台卡片堆叠。

* 游戏浮层使用可见纸张/木板质感、暖纸底色、墨色文字和硬描边；允许不规则 SVG 外框、厚底按钮、立绘舞台、任务回合条、工作牌和结算收据。
* 保留 `LinsheButton / LinsheInput / LinsheSelect / LinsheSwitch` 的统一组件：按钮使用软糖立体，输入类使用平面轮廓；游戏化只改变容器、信息层级和视觉氛围，不绕过组件规则。
* 禁止玻璃拟态、渐变光斑、装饰性 Orb、卡片套卡片；弹窗遮罩仍用 `rgba(0,0,0,0.45)`，浮层内不用 backdrop-filter。
* 普通应用页面（聊天、设置、背包、信箱等）继续沿用 Soft Warm UI；镇内舞台、生活、工坊、咖啡馆等玩法界面优先迁移到游戏化视觉。
* 新玩法界面应能看出“玩家在世界里做事”：立绘在场、对话在暖纸框里、操作以回合/班次/收据呈现，而不是表单化管理。

## 样式体系（styles/）

| 文件 | 职责 |
|---|---|
| `styles/tokens.css` | 唯一变量源：2 套主题（`:root` 默认 warm + `[data-theme="dark"]`）、赛璐璐 token、`--fun-*` 功能色、圆角/阴影/字号/动效/层级尺度 |
| `styles/base.css` | reset、元素默认（button/input/滚动条）、`:focus-visible`、**全局 prefers-reduced-motion 兜底** |
| `styles/components.css` | 共享组件类（见下） |
| `styles/animations.css` | keyframes 去重库、page/modal-fade/drawer 过渡、通用动画类（cel-spin/cel-waterflow/cel-jelly） |

引入顺序（main.js）：fonts → tokens → base → components → animations。**禁止在组件内硬编码主题色值**，必须引用变量。

**迁移约定**：组件改用全局组件类时必须删除自己的 scoped 副本（scoped 属性选择器优先级更高，双写会以本地为准）。

## 核心 Token

- **色彩**：`--accent`（主色，含 `-hover/-light/-rgb`）、`--accent-2/3/4`（点睛与多彩轮换）、`--fun-*`（功能色组：purple/pink/orange/teal/blue/gold/violet/neutral，不随主题）
- **赛璐璐**：`--cel-outline`（深描边）、`--border-strong`（组件 2px 描边）、`--shadow-hard / -sm`（偏移硬阴影）、`--btn-lip`（贴纸按钮底部厚度）、`--grad-cel`（两段式明暗渐变）、`--grad-brand`（日落拼色）、`--grad-soft`（幻彩浅底）、`--dot-color`（波点纹理）
- **尺度**：`--radius-sm/md/lg/xl/full`、`--shadow-xs/sm/md/lg + --shadow-glow + --focus-ring`、`--fs-xs~2xl`、`--dur-fast/base/slow`、`--ease-standard/out/spring/emph`、`--z-nav/drawer/modal/popover/toast/float`

## 组件类（components.css）

- **按钮**：`.btn-primary`（贴纸：实底+底厚+顶部高光，按下沉底）/ `.btn-ghost` / `.btn-tonal` / `.btn-danger` / `.btn-sm`；全局 `button:active` 按压下沉（`.no-press` 可豁免）
- **表面**：`.card`（毛玻璃+2px 描边+微硬阴影）/ `.card-solid` / `.card-interactive`（hover 上浮）
- **弹窗**：新弹窗一律用 `LinsheModal`，配合 `modal-fade` 获得统一 pop 入场；暖色沿用 v3.2 人物详情卡口径（暖纸外壳 + 白色内衬，`--modal-*` token），暗夜保持 Cel Glow 深色玻璃；底层仍是 `.modal-overlay / -panel(±.modal-wide/.modal-full) / -header / -title / -close / -body / -footer` 家族类。
- **弹窗（手机端 <768px）**：不换皮肤，只收留白 —— 遮罩内边距 20px → `8px + env(safe-area-inset-*)`（面板靠它避开刘海 / 挖孔 / 手势条），面板宽度铺满可用宽度、三档尺寸统一，`full` 撑满可用高度；**圆角、描边、白色内衬全部保留**，内衬留白走 `--modal-lining-margin-mobile`。移动端几何只写在 `LinsheModal.vue` 的移动端段落里，不要再用 `100vw/100dvh + border-radius:0` 做「全屏面板」（会被遮罩内边距推向一侧、贴边裁切并丢圆角，与 PC 观感不一致）。
- **其他**：`.chip(.active/.chip-x)`、`.avatar(-fallback)`、`.empty`（波点+悬浮图标）、`.skeleton`、`.icon-tile(.t-purple/pink/orange/teal/blue/gold/violet)`、`.sheen`（hover 斜光扫过）、`.sparkle(.s-low)`、`.stagger`（列表错峰入场，fill=backwards 不阻塞 hover/FLIP）

## 主题体系

* 2 套预设：`warm 暖色`（默认，沿用 v3.2 珊瑚暖纸原色）、`dark 暗夜`；入口为设置页「功能开关」→「界面主题」，支持暖色 / 暗夜 / 按时间自动切换。
* 切换：`theme.js` + `stores/settings.js` → `<html data-theme>`，localStorage 持久化（设备级偏好）；「按时间」在 18:00-06:00 使用暗夜、其余时间使用暖色。
* 例外：信箱 / Toast / 世界观编辑器保留「暖纸」底色与深棕文字（质感岛），强调色仍用主题变量；金色礼物色、语义状态色不随主题。

## 动效规范

1. 默认只动 `transform` / `opacity`；平面输入控件的悬停、聚焦与失焦允许仅对 `border-color` 做 `--dur-interaction`（0.3 秒）/ `--ease-standard` 过渡，底色与尺寸不变。时长用 `--dur-*`，缓动用 `--ease-*`（弹性一律 `--ease-spring`）
2. 入场：列表容器加 `.stagger`；弹窗用 `modal-fade`；页面切换走全局 `.page`
3. 反馈：按钮全局按压下沉；点赞用 `.like-burst`（heart-pop + ring-out）；徽标出现用 `.cel-jelly`
4. 氛围：光斑缓慢漂移（index.html，52-64s）、`.sparkle` 微闪——密度克制，不叠加多层环境动画
5. 加载：优先 `.skeleton` 骨架屏，其次 `.cel-spin` loader、pending 按钮用 `.cel-waterflow`
6. `prefers-reduced-motion` 由 base.css 全局兜底，组件无需单独处理

## 主题切换 / 角色聊天背景（既有能力）

* 设置页「功能开关」卡片中的「界面主题」切换主题；私聊 `ChatBgPanel.vue` 用 `LinsheTabs` 切换「聊天背景 / Galgame 背景」，分别保存到角色的 `chat_bg_path / galgame_bg_path`。两者支持本地上传 / 恢复默认，并共用 `BackgroundCropper.vue`（LinsheModal）确认取景：拖动、滚轮 / 双指缩放，提供当前窗口 / 横屏 / 竖屏 / 原图比例，确认后导出所选区域；取消不改变背景，已有背景可再次调整取景。Galgame 背景还支持按场景要求生成无人环境，生成结果先进入取景窗口，确认后才应用；未设置时沿用聊天背景。图片存 `data/images/chatbg/`（相册分类「聊天背景」）。

## Linshe 表单控件层（v3.2 合入）

表单与操作控件统一使用上游 3.2 引入的 7 个 Linshe 组件（`web-ui/src/components/ui/`）。它们是 Cel Glow 体系的**结构层**：交互与布局归组件，皮肤色值必须引用 Cel Glow token、随暖色 / 暗夜两套主题联动，**禁止保留上游的珊瑚色硬编码**（上游文档中的「珊瑚糖」在本体系下即 `var(--accent)` 主题糖）：

- **`LinsheButton`**：表单与弹窗按钮不留裸 `<button>`。变体 `primary`（主操作实心，每屏至多一个）/ `secondary`（次要，默认）/ `danger` / `ghost`（描边幽灵）/ `icon`（圆形小图标钮，中性糖面 + 悬停转主题色，尺寸档位为正方形）/ `chip`（胶囊选择、页签）/ `link`（文字链接）。「软糖立体」＝亮面填充 + 深色厚底硬投影 + 按下下沉压扁，与 `.btn-primary` 贴纸按钮语言同源；实底色走 `--accent` / `--fun-*`，底厚与投影走 `--btn-lip` / `--shadow-hard` 系 token。
- **`LinsheInput`**：文本输入框 / 文本域统一使用平面轮廓：保留原有 `--bg-secondary` 主题底色（悬停、聚焦均不变色），1.5px `--border` 细描边、`--radius-md` 圆角（sm 用 `--radius-sm`），不使用凹陷阴影、高光或发光光晕。悬停描边加深至 `--border-strong`；聚焦只将同一圈边框变为 `--accent`，不叠加外圈，尺寸不变；错误态边框始终使用 `--danger`，禁用底色保持 `--bg-tertiary`。聊天输入框、信纸、透明嵌入输入等特殊输入界面保留独立设计，但皮肤色值应对齐 token。
- **`LinsheAutoTextarea`**：需要自动增高、或收起时单行省略的长文本域使用（`collapsible` / `min-height`），皮肤与 `LinsheInput` 同源，不要自己写 auto-resize。
- **`LinsheSelect`**：下拉选择统一使用。触发器与 LinsheInput 同皮肤；选项面板 Teleport 到 body 的轻量浮层，选中态用 `--accent`，空间不足自动向上翻转。
- **`LinsheSwitch`**：拨动开关统一使用，不写裸 checkbox 开关样式。关/开两态等高不跳变（关＝中性糖、开＝主题糖）；`aria-label`、`title` 等透传到内部 input。
- **`LinsheTabs`**：分段选择/页签统一使用，不写裸 div 或 button 分段控件；`options` 为 `{ label, value }`；轨道用 `--bg-sunken` 暖纸凹陷，`md` 页签式（选中项 `--accent` 浅底 + 底部指示条）、`sm` 小分段（选中项主题表面胶囊 + `--shadow-xs`），文案统一 `--accent`。
- **`LinsheModal`**：弹窗基础窗体统一使用，不写裸遮罩/面板。`v-model` 控制显隐，`title` 为标题，`wide` / `full` 控制面板宽度（`full` 宽度走 `--modal-full-width`，个别面板可用 `panel-class` 覆盖该 token，不改组件皮肤），`#header-extra` / `#footer` 为附加插槽；`anchor` 传宿主选择器（如 `anchor=".page-host"`）时遮罩 Teleport 进宿主并铺满它、面板改为相对宿主居中，用于「这个窗口属于某张页面而不是整个视口」的场景（如小镇的居民动态窗），留空＝默认相对视口居中；暖色为暖纸外壳 + 白色内衬（对齐 LoRA 设置窗：标题栏与底部操作区留在外壳上，白色内衬只包正文，`--modal-*` token），暗夜为 Cel Glow 深色玻璃。


**通用约定**（随上游一并合入）：

- 特殊交互元素（长按发送键、礼物卡片、视觉小说选项、下拉菜单项、整卡入口等已有独立设计的）用 `<div role="button">` + 自包含样式实现，不套通用组件，也不使用 `<button>` 标签。
- 弹窗遮罩层级靠透明度表达——页面遮罩 `rgba(0,0,0,.45)`、面板内加载/生成遮罩用 `--glass-bg`（暖色仍呈半透明白），不用模糊；毛玻璃（backdrop-filter）仅用于 `.card` 表面氛围，不用于遮罩层（滚动时逐帧重合成是卡顿来源）。
- 镇内生活类面板统一使用共用暖纸外壳 `TownPaperPanel.vue`（标题条 + 暖纸卷轴内容区 + 收据式脚注），钱袋（`TownWalletPanel.vue`）与公告站（`TownBoardPanel.vue`）都由它包裹，不再各自重画浮层；进店玩法面板（`TownVenueServicePanel.vue`）沿用同一外壳与结算收据语言。新增建筑 / NPC 玩法面板应复用该外壳，只替换标题、角色与内容，不另起视觉体系。

## 设计原则

新功能设计时先明确内容、主要操作和信息层级，再决定组件和布局；优先复用全局组件类与既有交互模式。

**目标：让新功能看起来像“邻舍的一部分”，而不是后来添加的独立页面。**

## 私聊沉浸对话（Galgame）

* 模式切换使用 `ChatModeSwitch.vue` 右上角浮出入口：鼠标靠近右上角时，在聊天标题栏下方显示柔和圆角胶囊入口，使用主题底色、细边框与轻阴影，文字为「Galgame」；离开后 0.3 秒淡出，绝对定位，不新增工具栏或内容占位。首次进入私聊延迟 0.6 秒浮现入口和一句轻提示，约 4.2 秒后收起，按设备用 localStorage 记住，不因换角色、刷新或切换模式重复提示。通过宿主 pointermove 判断靠近，不用透明热区遮挡设置等操作；键盘聚焦同样显示，触屏保留常显入口。这是独立游戏控件，支持点击和 Enter / Space，不做分段页签。PC「同步立绘展示」保留在原有标题栏，手机端仍从设置进入。`?mode=galgame` 在同一私聊页切换显示，导航宿主保持挂载，退出不取消回复或丢失草稿。
* 舞台优先使用角色独立的沉浸背景，未设置时复用聊天背景；中央表情立绘轻微呼吸。**立绘延伸到舞台底部，下半身由更高层级的宽幅对话框遮挡**，不得通过缩小人物或预留底部空间避开对话框。
* 对话框参考游戏截图：切角长框、双层细描边、名字分隔线、右下角推进标记；颜色集中使用 `--dialogue-*` token，支持暖色 / 暗夜。整体统一为暖白纸面、灰褐描边、浅米灰内线及中性投影；舞台对话框的姓名与正文使用深珊瑚橙，辅助文字使用柔和棕橙，分别走 `--dialogue-speech-ink / -muted`。暗夜对话框与菜单统一使用暖炭灰底，正文使用提高明度的珊瑚橙，辅助文字用浅棕灰；历史回顾沿用同组深色纸面与浅灰文字。所有回复（包括一屏内的短回复）都从第一个字开始逐字显示，标点稍作停顿；超出一屏时分页。点击补全当前页，再点击翻页，读完后显示回应选项。重新测量或缩放窗口保留已显示字数，不跳到全文；系统开启减少动态效果时直接展示当前页。后续新回复使用「点击查看新回复」提示，与当前正文的「点击继续」翻页区分。
* 对话框上方右侧使用 `TownVnChoice variant="dialogue"` 排列最多两条预测回复，只复用当前聊天流程已返回且属于最新回复的候选；没有候选时不主动补生成，进入模式、切换角色或刷新消息也不触发额外生成。下方直接显示原生单行输入框与发送控件，不显示 placeholder，高度跟随当前最高的候选选项（无选项时 46px）。选项和输入区共用顶部菜单的 `GalgameMenuFrame.vue` 暖白底斜向标签、低饱和珊瑚角标和米灰错位投影，选项与输入区的外边框和左侧粗边使用 `--dialogue-control-outline` 暖深灰色，文字与图标保持灰褐墨色，文字保持直立；长选项使用较缓斜角并留出投影空间。输入框采用与选项一致的独立样式，不使用 `LinsheInput`，支持回车发送并避开输入法组词；输入时保留角色台词。
* 当前回复的图片显示在舞台左侧空白处，手机端与右侧选项分栏；历史回顾显示缩略图。舞台与回顾图片统一使用直角白色照片纸边框和轻微柔和投影，暗夜使用降低亮度的暖白相纸与较深柔和投影，颜色集中在 `--dialogue-photo-*`。舞台照片加载完成后播放日程「瞄一眼」式局部轻闪与上下快门展开动效（约 0.4 秒），白色相纸边框保持稳定；减少动态效果时直接展示照片。图片点击统一使用 Teleport 到 body 的 `ImageLightbox`，支持纯图片回复及文字之后才到达的配图，隐藏对话时一并隐藏图片。等待状态只展示真实生图任务的准备与重试提示，完成或失败后退出等图提示；等待文字、消息排队和本轮收尾过程不显示等待文案，发送按钮保持原文案并通过禁用状态反馈。
* 历史在左上，PC 的「同步立绘」与隐藏 / 恢复对话在右上；「返回聊天」恢复为右上角常显的 SVG 箭头 + 文字操作，不使用悬停浮出入口。舞台操作使用 SVG 图标 + 简短文字的 `div[role=button]`，不套 `LinsheButton`，支持键盘 Enter / Space 与可见焦点；暖色主题按钮保持白色基调，采用 `GalgameMenuFrame.vue` 的漫画式斜向标签：暖白底、深灰文字、图标、描边与左侧粗短边、低饱和珊瑚角标及米灰错位硬投影，图标和文字保持直立、加粗，悬停时短线展开；顶部操作、回复选项、叫醒与发送控件默认深灰，悬停或键盘聚焦时文字、图标和对应边框以 0.3 秒过渡至深珊瑚橙（`--dialogue-menu-hover`），禁用或调用中的控件不触发变色；颜色集中在 `--dialogue-menu-*`，暖色保持白色基调；暗夜的顶部操作、回复选项、输入区和叫醒控件统一为暖炭灰底、浅灰文字、灰褐边框和深色错位投影，悬停 / 聚焦时使用亮珊瑚橙以保证对比度，近不透明衬底隔离场景背景，不加模糊光晕。立绘管理窗口继续使用 Linshe 组件。隐藏时同时收起对话框和选项，暂停逐字显示；模式、表情、输入和窗口切换保持 0.3 秒过渡。
* 历史回顾按用户指定作为独立的 Galgame 界面：使用 `GalgameHistory.vue`，不使用 Linshe 组件。回顾层覆盖舞台，沿用 `--dialogue-*` 的切角纸面、双层墨色描边，按人物名与台词排版；操作用 SVG + 文字，保留图片灯箱、更早记录加载、回到最新、Esc 返回与键盘焦点循环。进入定位到最新记录，加载更早记录保持阅读位置；开合各 0.3 秒，退出动画完成后卸载并恢复舞台焦点。
* 角色正在睡觉且未被临时叫醒时，在对话框姓名栏右侧显示月亮图标与「睡着了 · 叫醒」标签，沿用暖白底、暖深灰边框与深灰文字和图标的菜单样式；独立于回复选项显示，消息排队时仍可操作。复用普通私聊的电话 / 上门 / 摇醒逻辑，调用中显示「正在呼唤…」并防止重复触发，醒来后用 0.3 秒淡出收起。
* 舞台和历史共同读取完整消息展示接口，过滤 prompt 与表情标记，保留段落和动作描写；渲染状态不回写原始对话。进入舞台、切换角色及返回页面时同时检查默认立绘和当前角色已启用配置单中的表情包（至少一张已完成且有图片地址），两项都可用才播放台词并开放回应；只读检查不触发生图。缺项以原有游戏选项样式逐项给出当前角色的立绘管理 / 表情包管理入口，加载失败单独提示并支持重新检查；关闭管理窗口及后台刷新后重新检查，异步结果按角色隔离。

## 传媒漫画界面

传媒导航与帖子详情使用用户指定的夸张漫画游戏风：珊瑚撞墨色、粗描边、硬阴影、大标题与对话气泡，正文表面继续跟随暖色 / 暗夜主题。此范围的操作按钮使用 `MediaGameButton`，是通用 `LinsheButton` 约定的明确例外；频道与弹窗分别复用 `LinsheTabs variant="comic"`、`LinsheModal variant="comic"`，默认变体不变。配色由 `--media-*` 与现有主题 token 提供，开关窗口和内容切换保持 0.3 秒过渡。社交帖子卡片保留原有瀑布流与信息布局，以纸面底色、轻量漫画描边、硬阴影和贴纸角标呼应导航，媒体设置继续使用通用 Linshe 控件。
