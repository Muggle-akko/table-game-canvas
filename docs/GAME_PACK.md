# JSON 游戏包

Parlor 的“插件”是纯 JSON 资源包：它描述桌名、牌背、牌面、公共 Token、骰子和共享计数器，不执行第三方代码。牌面、牌背与 Token 都可选用游戏包目录里的本地图片。完整格式见 [`game-packs/pack.schema.json`](../game-packs/pack.schema.json)。

仓库内有四个可直接使用的资源包：

- `standard-54.json`：完整 54 张标准扑克，也是默认包。
- `uno.json`：经典结构的 108 张 UNO 资源，只包含文字与颜色，不包含规则脚本。
- `parlor-eight.json`：固定 8 张牌的最小隐私验收样本。
- `moon-outpost.json`：展示牌、Token、D12 和资源计数如何组合成另一种主题。

## 复制并开一个自己的桌

1. 复制 `game-packs/parlor-eight.json`，例如保存为 `game-packs/my-game.json`。
2. 修改 `id`、`name`、`tableTitle`、`cards` 和 `tokens`。
3. 在开房前先校验：

```bash
npm run validate:pack -- ./game-packs/my-game.json
```

4. 使用该包开房：

```bash
npm run room -- --name "房主" --pack ./game-packs/my-game.json
```

本地开发同样支持：

```bash
npm run dev -- --pack ./game-packs/my-game.json
```

也可以通过环境变量指定：

```bash
GAME_PACK=./game-packs/my-game.json npm run room -- --name "房主"
```

## 在已有桌面添加牌盒

资源库可以重复取用牌盒，每次都会生成独立的牌盒、卡牌和 Token。已有手牌和其他牌盒保持各自状态；收回散牌时，卡牌回到自己的来源牌盒。

房主也可以在浏览器中导入不超过 500 KB、没有图片引用的 JSON。每次导入在本机生成独立记录，即使 `id` 与内置资源或另一份导入相同，也会分别显示。资源预览左上角的移除按钮只删除该本机记录，桌上实例继续保留。旧版按 `pack.id` 保存的本机记录仍能读取。

桌名、公共骰子和共享计数器由开房时的包初始化；往已有桌面添加牌盒时只添加牌和 Token。其他骰子、便签、计分器、袋子和桌垫可从资源库逐个取用。

## 字段

- `id` / `name` / `version`：资源包身份信息。
- `tableTitle`：用该包开房时，房间顶栏显示的桌名。
- `cardBack`：来自该牌盒、无权查看正面的牌使用的背面标识。`label` 会显示在牌背，`color` 使用 `#RRGGBB` 格式控制底色，`theme` 预留给图案样式；可选 `image` 指向自定义牌背图。
- `cards`：牌面资源。每项需要稳定的 `key`，但运行时会由房主生成随机实例 ID；可选 `image` 指向这张牌的正面图。
- `cards[].color` / `cards[].textColor`：可选的 `#RRGGBB` 卡面底色与文字色，适合 UNO 一类无需图片的彩色资源。
- `tokens`：初始位于公共区的共享标记。所有玩家可以提出移动，房主进程确认并广播最终坐标；可选 `image` 指向圆形 Token 图。
- `die`：公共骰子，支持 D2–D20；结果由房主进程生成。
- `counter`：一个通用共享整数，可用作回合、分数或资源。`initial`、`min`、`max` 决定初始值与边界；每次只允许加一或减一，结果进入房主撤销链。

## 本地图片

图片路径以 JSON 文件所在目录为根，推荐把资源包和图片放在同一个文件夹：

```text
my-game/
├── game.json
└── art/
    ├── back.webp
    ├── red-dragon.jpg
    └── first-player.png
```

对应字段示例：

```json
{
  "cardBack": {
    "label": "DRAGON",
    "color": "#8f2f2a",
    "image": "art/back.webp"
  },
  "tokens": [
    {
      "key": "first-player",
      "label": "起始玩家",
      "symbol": "Ⅰ",
      "color": "#e9b94d",
      "x": 420,
      "y": 560,
      "image": "art/first-player.png"
    }
  ],
  "cards": [
    {
      "key": "red-dragon",
      "label": "赤龙",
      "rank": "01",
      "suit": "dragon",
      "symbol": "龙",
      "tone": "red",
      "image": "art/red-dragon.jpg"
    }
  ]
}
```

- 支持 PNG、JPEG、WebP、AVIF；单张最多 8 MB。
- 只接受相对路径，不接受远程 URL、绝对路径、反斜杠、查询参数、`..` 或符号链接跳出资源包目录。
- `label`、`symbol`、`color` 等文字字段仍然必填。图片不存在或浏览器加载失败时，桌面会自动保留原有文字/符号画面，不显示破图。
- 开房与 `validate:pack` 都会检查图片是否存在、格式是否受支持、大小是否越界；失败时不会留下半开的房间服务。
- 房主进程不会把本机文件路径发给浏览器。客户端只收到 `hasImage`；牌面图片和文字牌面使用同一套可见性规则。
- 牌背与公共 Token 图片可公开缓存；卡面图片每次都由当前会话和牌的即时状态鉴权，并禁用缓存。别人的私有手牌、盖住的公共牌与牌叠中被覆盖的牌都不能读取正面图片；牌堆最上面朝上的一张可见。

## 资源而不是规则

JSON 包只负责“桌上有什么”，不负责“应该怎么玩”。牌可以自由移动、翻面、旋转、转交或叠成牌堆；骰子、计数器和行动玩家也只是独立工具。UNO 包不会自动判断颜色是否合法，扑克包不会自动比较牌型，这些都由同桌玩家自行约定。

牌或整叠牌可拖到公共牌或另一叠牌的顶部。正反面与原顺序保持，混合牌堆中的每张牌仍保留自己的牌背与图片来源。牌堆最上面朝上的牌公开可见，内部牌面不可读取；横向、纵向或网格展开后，朝上的牌才会依次公开。洗牌只打乱顺序，保留每张牌的正反面，并更换实例 ID，避免用旧 ID 跟踪牌序。

德州同样只提供 52 张扑克、桌垫、普通筹码、庄家钮及可编辑规则指引；发牌、下注、分池与结算由玩家自己进行。Token 的 `symbol` 支持 1–8 个字符，可声明多位数筹码面值。

## 当前边界

资源包不包含 JavaScript、自动规则、脚本钩子或远程 URL。它只声明资源；权限过滤、图片读取、拖拽、原子随机和同步都由可信的房主核心负责。这让自建者可以安全导入朋友制作的包，而不用直接执行对方代码。开房时也会执行与 `validate:pack` 相同的运行时预检，字段错误、重复资源 key、越界数量、非法颜色或图片问题都会在监听端口前明确报错。
