# 影视体育话题雷达（国内来源版）

这是一个可部署在 GitHub Pages 上的自动更新榜单工具，面向内容运营选题参考。

页面只分两个 Tab：

- **影视**：电影、剧集、综艺、演员主创、票房档期、口碑评分、预告物料、奖项电影节等。
- **体育**：NBA、CBA、中超、国足、欧洲足球、网球、奥运综合项目、电竞等。

程序会自动抓取国内平台热榜和中文社区内容，并从标题/摘要中识别：

- 热门话题
- 相关词
- 所属方向
- 来源平台
- 样本链接
- 相对热度分

不需要你每次手动搜索。后续只需要改配置文件，就可以扩展新的来源或关键词。

---

## 默认来源

默认优先使用适合国内运营参考的中文来源：

- 微博：热搜榜、文娱榜、话题榜
- 百度：实时热点
- 抖音：总榜、体育榜、剧情榜
- B站：全站日榜 / RSSHub 排行榜
- 知乎：热榜
- 百度贴吧：热议榜
- 虎扑：NBA、CBA、国际足球、步行街
- 懂球帝：热门新闻、今日头条
- RSSHub：微博热搜、知乎热榜、B站排行榜等补充来源

其中 TopHub 页面和 RSSHub 路由可能会受源站反爬、限流、公共实例稳定性影响。程序已经做了容错：某个来源失败不会导致页面整体失败。

如果你在国内使用，建议后续自建 RSSHub，然后在 GitHub 仓库里配置变量：

```text
RSSHUB_BASE=https://你的-rsshub-地址
```

位置：**Settings → Secrets and variables → Actions → Variables → New repository variable**。

---

## 部署步骤

1. 新建 GitHub 仓库，例如 `topic-radar-cn`。
2. 解压本 ZIP，把所有文件上传到仓库根目录。
3. 进入仓库 **Settings → Pages**。
4. Source 选择 **GitHub Actions**。
5. 进入 **Actions → Update Topic Radar → Run workflow**，手动运行一次。
6. 运行成功后，GitHub Pages 会生成访问地址。
7. 之后会每小时自动更新一次。

---

## 主要配置文件

### `config/radar.config.json`

你最常改的是这个文件。

#### 1. 修改站点标题

```json
"settings": {
  "siteTitle": "影视体育话题雷达",
  "siteSubtitle": "自动聚合国内平台热榜与社区内容..."
}
```

#### 2. 增加影视关键词

找到 `categories` 里的 `影视`，在 `includeTerms` 中增加：

```json
"某部剧名", "某演员名", "某综艺名"
```

#### 3. 增加体育关键词

找到 `体育`，在 `includeTerms` 中增加：

```json
"世界杯", "NBA总决赛", "湖人", "中国女篮"
```

#### 4. 增加一个话题方向

例如你想单独追踪“世界杯”：

```json
{
  "label": "世界杯相关",
  "aliases": ["世界杯", "世预赛", "国足", "小组赛", "淘汰赛", "梅西", "C罗", "姆巴佩"]
}
```

放到体育分类的 `topicSeeds` 里。

#### 5. 增加来源

例如增加一个 TopHub 榜单：

```json
{
  "id": "tophub_custom",
  "name": "自定义榜单",
  "platform": "平台名",
  "channel": "榜单名",
  "categoryHint": "auto",
  "type": "html_rank",
  "weight": 1.0,
  "enabled": true,
  "url": "https://tophub.today/n/xxxx"
}
```

`categoryHint` 可选：

- `影视`：这个来源默认归入影视。
- `体育`：这个来源默认归入体育。
- `auto`：由关键词自动判断。

---

## 更新频率

`.github/workflows/update.yml` 默认每小时第 7 分钟运行一次。

GitHub Actions 的 cron 使用 UTC 时间，但“每小时”不受时区影响。

---

## 评分逻辑

热度分不是平台官方指数，而是运营参考用的相对分，主要考虑：

1. 榜单排名越靠前，分越高。
2. 来源权重越高，分越高。
3. 同一话题出现在越多平台，分越高。
4. 话题命中的相关词越多，分越高。
5. 多条相似标题会被聚合成一个话题。

---

## 常见问题

### 页面显示“数据加载失败”

通常是还没有运行过 GitHub Actions。进入 Actions 手动运行一次即可。

### 某些来源失败

国内平台反爬较强，单个来源失败是正常情况。页面下方“来源运行状态”会显示成功/失败详情。

### 想让来源更稳定

建议自建 RSSHub，并在 GitHub Actions 变量中配置 `RSSHUB_BASE`。

### 想完全去掉某个来源

把对应来源的 `enabled` 改为 `false`。

---

## 文件结构

```text
.topic-radar-cn
├── config
│   ├── radar.config.json      # 来源、关键词、分类配置
│   └── fallback-sample.json   # 无网络时的示例数据
├── public
│   ├── index.html             # 前端页面
│   ├── styles.css             # 页面样式
│   ├── app.js                 # 前端逻辑
│   └── data/radar.json        # 自动生成的数据文件
├── scripts
│   └── update.js              # 抓取、聚合、打分脚本
├── .github/workflows
│   └── update.yml             # 每小时自动更新并部署
├── package.json
└── README.md
```
