# 影视体育话题雷达（国内源版）

这是一个可部署到 GitHub Pages 的自动更新榜单，用于内容运营参考。它会自动抓取国内热榜、社区和垂类来源，识别影视 / 体育相关话题，并聚合相关词、来源样本和相对热度。

## 这版修复了什么

- 修复“榜眼数据 / 今日热榜官方数据 API 开放平台”等站点模板、广告、API宣传被当成话题的问题。
- 页面只保留两个主 Tab：影视、体育。
- 泛热榜必须命中影视或体育词库；垂类来源也会先过滤广告/API/模板文本。
- 不需要人工每次搜索 NBA、世界杯、某部剧等关键词，程序会每小时从热榜中自动发现。
- 压缩包根目录就是项目文件，不再套一层文件夹，避免上传到 GitHub 后路径错误。

## 文件结构

```text
.github/workflows/update.yml    GitHub Actions 自动更新与部署
config/radar.config.json        来源、词库、话题方向、过滤词配置
config/fallback-sample.json     外部来源不可用时的示例数据
scripts/update.js               抓取、过滤、分类、聚类、打分脚本
public/index.html               页面入口
public/app.js                   页面渲染
public/styles.css               页面样式
public/data/radar.json          自动生成的数据文件
package.json                    Node 项目配置
.nojekyll                       避免 GitHub Pages 忽略下划线等静态资源
```

## 部署步骤

1. 新建 GitHub 仓库，例如 `sports-movie-ranking`。
2. 解压本压缩包，把里面的全部文件上传到仓库根目录。
3. 注意仓库根目录应该直接看到：

```text
.github
config
scripts
public
package.json
README.md
```

不要变成：

```text
topic-radar-cn-v2/.github
```

4. 进入 `Settings → Pages`，Source 选择 `GitHub Actions`。
5. 进入 `Actions → Update Topic Radar → Run workflow`，手动运行一次。
6. 绿色对勾后访问：

```text
https://你的GitHub用户名.github.io/你的仓库名/
```

例如仓库名是 `sports-movie-ranking`，地址就是：

```text
https://你的GitHub用户名.github.io/sports-movie-ranking/
```

## 自动更新时间

默认北京时间 07:07 到 23:07 每小时更新一次。

如需全天每小时更新，把 `.github/workflows/update.yml` 里的 cron 改为：

```yaml
- cron: '7 * * * *'
```

## 如何强化某个领域

只改 `config/radar.config.json`。

### 强化 NBA

在体育 `includeTerms` 或 `NBA季后赛 / 总决赛` 的 `aliases` 中增加：

```json
"东部决赛", "西部决赛", "东决", "西决", "总决赛", "布伦森", "约基奇", "亚历山大", "文班亚马", "尼克斯", "骑士", "雷霆", "马刺"
```

### 强化影视剧

在影视 `includeTerms` 或对应 `topicSeeds` 中增加剧名、演员、节目名：

```json
"折腰", "庆余年", "藏海传", "歌手", "浪姐", "披哥", "白玉兰", "暑期档"
```

## RSSHub 可选配置

默认使用公共 RSSHub。公共实例可能限流或不稳定。你可以自建 RSSHub，然后在：

```text
Settings → Secrets and variables → Actions → Variables
```

添加变量：

```text
RSSHUB_BASE=https://你的RSSHub地址
```

不配置也可以运行，TopHub 来源仍会参与更新。
